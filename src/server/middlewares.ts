import type { JSONRPCMessage } from '@src/core'
import type { MiddlewareHandler } from '@orkestrel/server'
import type { MCPSessionEntry, MCPSessionMiddlewareOptions, MCPSessionState } from './types.js'
import {
	MCP_HEADER_MISMATCH,
	MCP_PROTOCOL_VERSION_HEADER,
	MCP_SESSION_HEADER,
	buildJSONRPCError,
	isInitializeRequest,
	isModernRequest,
	parseJSONRPCMessage,
} from '@src/core'
import { parseJSON } from '@orkestrel/contract'
import { createStream } from '@orkestrel/server'
import { DEFAULT_MCP_PATH, SSE_BUFFERING_DISABLED, SSE_BUFFERING_HEADER } from './constants.js'
import {
	allowsOrigin,
	readLastEventId,
	readSessionHeader,
	rejectUnknownSession,
} from './helpers.js'
import { inferLegacyVersion, inferSessionHeaderIssue } from './inferers.js'
import { MCPSession } from './MCPSession.js'
import { HTTPDisconnect } from './HTTPDisconnect.js'

/**
 * Creates the native MCP session {@link MiddlewareHandler} — the plug-and-play stateful layer
 * that fronts a session-agnostic {@link import('./factories.js').createMCPRoutes}. Compose it
 * with `router.use(createMCPSession())` (or the equivalent middleware seam), mirroring any
 * other closure-scoped stateful middleware. Has NO dependency on `@orkestrel/middleware` — the
 * session store, mint-on-`initialize`, and resumable stream are all native to this package.
 *
 * @remarks
 * Owns a closure `Map<string, MCPSessionEntry>` keyed by session id, and a single request
 * `path` (default {@link DEFAULT_MCP_PATH}); a request to any other path passes straight
 * through (`next()`).
 *
 * A modern-shaped POST also passes straight through with `next()`, ignoring any session id.
 * The remaining behavior is the legacy session layer:
 *
 * - **`POST {path}`.** Buffers `const text = await request.text()` (so the downstream route
 *   can re-read it from a freshly-built forwarded `Request`). Resolves a session through {@link
 *   readSessionHeader}: a VALID id touches the entry and sets `context.state.session`; an
 *   ABSENT / unknown id whose (guarded) body parses to an `initialize` request ({@link
 *   isInitializeRequest}) MINTS a fresh {@link MCPSession} (`crypto.randomUUID()`, `capacity`)
 *   and sets `context.state.session`; neither → {@link rejectUnknownSession} (`404`). The
 *   minted entry pins the negotiated legacy revision, which is supplied to a later headerless
 *   live-session request. It then
 *   FORWARDS a fresh `Request` carrying the buffered `text` (`next(forwarded)`) — never the
 *   already-consumed original — so the route re-reads the same body, and stamps the response
 *   with {@link MCP_SESSION_HEADER}. The entry's `touched` instant is read AFTER that
 *   downstream response, because it means the LAST ACCESS: a request slower than `ttl` would
 *   otherwise store a session that is already expired, and the write-back RE-ASKS the store, so
 *   a `DELETE` arriving while the request was suspended is not undone.
 * - **`GET {path}`.** Resolves the session the same way (no mint — only `initialize` mints);
 *   an invalid / unknown id is the same `404`. A valid session opens the resumable
 *   server→client stream through `@orkestrel/server`'s {@link import('@orkestrel/server').createStream}:
 *   replays every event after the client's `Last-Event-ID` ({@link readLastEventId}) BEFORE
 *   attaching the stream for live pushes, then attaches; cancellation of the streamed response
 *   body composes with `request.signal` and detaches it. Long-lived — never `end()`ed here.
 * - **`DELETE {path}`.** Resolves the session; a valid id deletes it from the store and answers
 *   `204`; an invalid / unknown id is the same `404`.
 *
 * It is MECHANISM, not policy, and ADDITIVE: omit it entirely for the stateless default
 * ({@link import('./factories.js').createMCPRoutes}'s only behavior). The `path` MUST match the
 * `createMCPRoutes` `path` it fronts. The WebSocket transport is inherently one session per
 * connection (the socket IS the session), so this middleware does not apply to it.
 *
 * @typeParam TState - The consumer's `TState`, which MUST extend {@link MCPSessionState} so
 *   the resolved session can be threaded through `context.state.session`
 * @param options - Optional `path` (default {@link DEFAULT_MCP_PATH}), `ttl` (idle-session
 *   sweep window, ms — omit for sessions that live until an explicit `DELETE`), `capacity`
 *   (the folded per-session replay-log bound), and `clock` (the deterministic epoch-ms clock;
 *   defaults to `Date.now`), plus the shared `origin` validation options; see
 *   {@link MCPSessionMiddlewareOptions}
 * @returns A {@link MiddlewareHandler} that mints / validates sessions + serves the resumable
 *   `GET` / `DELETE`
 *
 * @example
 * ```ts
 * import { createMCPLegacy, createMCPServer } from '@orkestrel/mcp'
 * import { createMCPRoutes, createMCPSession } from '@orkestrel/mcp/server'
 * import { createToolManager } from '@orkestrel/tool'
 *
 * const mcp = createMCPServer({ identity: { name: 'docs', version: '1.0.0' }, tools: createToolManager() })
 * router.use(createMCPSession({ ttl: 60_000 })) // stateful: mint + validate + resumable GET / DELETE
 * // The route stays session-agnostic:
 * router.add(createMCPRoutes(createMCPLegacy(mcp))) // answers `initialize` too; pass `mcp` alone for modern-only
 * ```
 */
export function createMCPSession<TState extends MCPSessionState>(
	options?: MCPSessionMiddlewareOptions,
): MiddlewareHandler<TState> {
	const path = options?.path ?? DEFAULT_MCP_PATH
	const capacity = options?.capacity
	const ttl = options?.ttl
	const clock = options?.clock ?? Date.now
	const origin = options?.origin
	const store = new Map<string, MCPSessionEntry>()

	return async (request, context, next) => {
		if (context.url.pathname !== path) return next()
		if (!allowsOrigin(request, origin)) return new Response(null, { status: 403 })
		let parsed: JSONRPCMessage | undefined
		let text: string | undefined
		if (context.method === 'POST') {
			// Reading the body is the only step here that can throw. The JSON boundary itself is
			// `parseJSON`, which answers `undefined` rather than throwing, so it sits outside.
			try {
				text = await request.text()
			} catch {
				text = undefined
			}
			parsed = text === undefined ? undefined : parseJSONRPCMessage(parseJSON(text))
			if (text !== undefined && parsed !== undefined && isModernRequest(parsed)) {
				return next(
					new Request(context.url, {
						method: 'POST',
						headers: request.headers,
						body: text,
						signal: request.signal,
					}),
				)
			}
		}
		if (ttl !== undefined) {
			const cutoff = clock() - ttl
			for (const [id, entry] of store) {
				if (entry.touched <= cutoff) store.delete(id)
			}
		}

		if (context.method === 'DELETE') {
			const id = readSessionHeader(request)
			if (id === undefined || !store.delete(id)) return rejectUnknownSession()
			return new Response(null, { status: 204 })
		}

		let entry: MCPSessionEntry | undefined
		const id = readSessionHeader(request)
		if (id !== undefined) {
			const current = store.get(id)
			if (current !== undefined) {
				entry = { session: current.session, touched: clock(), version: current.version }
				store.set(id, entry)
			}
		}

		if (context.method === 'GET') {
			if (entry === undefined) return rejectUnknownSession()
			const session = entry.session
			const stream = createStream()
			const disconnect = new HTTPDisconnect(request.signal, options?.keepalive)
			stream.response.headers.set(SSE_BUFFERING_HEADER, SSE_BUFFERING_DISABLED)
			// A comment write flushes the response headers immediately (the underlying node:http
			// response only sends headers on its first `write`/`end`) — without it a client's fetch
			// hangs waiting for headers until the first replay/push write, which may never come.
			stream.comment('open')
			const lastEventId = readLastEventId(request)
			if (lastEventId !== undefined) {
				// Replay every event STRICTLY AFTER the client's last-seen id BEFORE attaching, so the
				// missed events arrive in order ahead of any live push.
				for (const e of session.replay(lastEventId)) {
					stream.write({ id: e.id, data: JSON.stringify(e.message) })
				}
			}
			session.attach(stream)
			if (disconnect.signal.aborted) session.detach(stream)
			else disconnect.signal.addEventListener('abort', () => session.detach(stream), { once: true })
			return disconnect.bridge(stream)
		}

		if (context.method !== 'POST' || text === undefined) return next()

		// POST — only `initialize` mints a fresh session when no valid id is present.
		let created: MCPSessionEntry | undefined
		if (entry === undefined) {
			if (parsed !== undefined && isInitializeRequest(parsed)) {
				const session = new MCPSession(
					crypto.randomUUID(),
					capacity !== undefined ? { capacity } : {},
				)
				created = { session, touched: clock(), version: inferLegacyVersion(parsed) }
				entry = created
			} else {
				return rejectUnknownSession()
			}
		}
		if (!Reflect.set(context.state, 'session', entry.session)) {
			throw new Error('MCP session state is not writable')
		}
		const headers = new Headers(request.headers)
		if (parsed === undefined || !isInitializeRequest(parsed)) {
			const issue = inferSessionHeaderIssue(request, entry.version)
			if (issue?.reason === 'missing') {
				headers.set(MCP_PROTOCOL_VERSION_HEADER, entry.version)
			} else if (issue !== undefined) {
				const requestId = parsed !== undefined && 'method' in parsed ? parsed.id : undefined
				return Response.json(buildJSONRPCError(requestId, MCP_HEADER_MISMATCH, issue.message), {
					status: 400,
				})
			}
		}
		const forwarded = new Request(context.url, {
			method: 'POST',
			headers,
			body: text,
			signal: request.signal,
		})
		const response = await next(forwarded)
		if (created !== undefined) {
			if (!response.ok) return response
			// `touched` is the instant of the LAST ACCESS, so it is read AFTER the suspension. The
			// mint stamp was taken before a whole `initialize` round trip that the middleware has no
			// bound on: a handshake slower than `ttl` used to insert a session that was already
			// expired, and the first request for the id this response advertises swept it away.
			store.set(created.session.id, { ...created, touched: clock() })
		} else if (store.get(entry.session.id) === entry) {
			// The same correction on the resolved-existing path — plus a RE-ASK. `store.get` is
			// consulted again because a `DELETE` (or the sweep of a sibling request) may have removed
			// this entry while this request was suspended, and a blind write-back would resurrect a
			// session whose owner already ended it.
			store.set(entry.session.id, { ...entry, touched: clock() })
		}
		response.headers.set(MCP_SESSION_HEADER, entry.session.id)
		return response
	}
}
