import type { MiddlewareHandler } from '@orkestrel/server'
import type { MCPSessionEntry, MCPSessionOptions, MCPSessionState } from './types.js'
import { isInitializeRequest, parseJSONRPCMessage } from '@src/core'
import { openStream } from '@orkestrel/server'
import { DEFAULT_MCP_PATH, MCP_SESSION_HEADER } from './constants.js'
import { readLastEventId, readSessionHeader, rejectUnknownSession } from './helpers.js'
import { MCPSession } from './MCPSession.js'

/**
 * Create the native MCP session {@link MiddlewareHandler} — the plug-and-play stateful layer
 * that fronts a session-agnostic {@link import('./factories.js').createMCPRoutes}. Compose it
 * via `router.use(createMCPSession())` (or the equivalent middleware seam), mirroring any
 * other closure-scoped stateful middleware. Has NO dependency on `@orkestrel/middleware` — the
 * session store, mint-on-`initialize`, and resumable stream are all native to this package.
 *
 * @remarks
 * Owns a closure `Map<string, MCPSessionEntry>` keyed by session id, and a single request
 * `path` (default {@link DEFAULT_MCP_PATH}); a request to any other path passes straight
 * through (`next()`).
 *
 * - **`POST {path}`.** Buffers `const text = await request.text()` (so the downstream route
 *   can re-read it via a freshly-built forwarded `Request`). Resolves a session via {@link
 *   readSessionHeader}: a VALID id touches the entry and sets `context.state.session`; an
 *   ABSENT / unknown id whose (guarded) body parses to an `initialize` request ({@link
 *   isInitializeRequest}) MINTS a fresh {@link MCPSession} (`crypto.randomUUID()`, `capacity`)
 *   and sets `context.state.session`; neither → {@link rejectUnknownSession} (`404`). It then
 *   FORWARDS a fresh `Request` carrying the buffered `text` (`next(forwarded)`) — never the
 *   already-consumed original — so the route re-reads the same body, and stamps the response
 *   with {@link MCP_SESSION_HEADER}.
 * - **`GET {path}`.** Resolves the session the same way (no mint — only `initialize` mints);
 *   an invalid / unknown id is the same `404`. A valid session opens the resumable
 *   server→client stream via `@orkestrel/server`'s {@link import('@orkestrel/server').openStream}:
 *   replays every event after the client's `Last-Event-ID` ({@link readLastEventId}) BEFORE
 *   attaching the stream for live pushes, then attaches; a client disconnect (`request.signal`)
 *   detaches it. Long-lived — never `end()`ed here.
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
 *   defaults to `Date.now`); see {@link MCPSessionOptions}
 * @returns A {@link MiddlewareHandler} that mints / validates sessions + serves the resumable
 *   `GET` / `DELETE`
 *
 * @example
 * ```ts
 * import { createMCPServer, createToolManager } from '@src/core'
 * import { createMCPRoutes, createMCPSession } from '@src/server'
 *
 * const mcp = createMCPServer({ name: 'docs', version: '1.0.0', tools: createToolManager() })
 * router.use(createMCPSession({ ttl: 60_000 })) // stateful: mint + validate + resumable GET / DELETE
 * router.add(createMCPRoutes(mcp)) // the route stays session-agnostic
 * ```
 */
export function createMCPSession<TState extends MCPSessionState>(
	options?: MCPSessionOptions,
): MiddlewareHandler<TState> {
	const path = options?.path ?? DEFAULT_MCP_PATH
	const capacity = options?.capacity
	const ttl = options?.ttl
	const clock = options?.clock ?? Date.now
	const store = new Map<string, MCPSessionEntry>()

	return async (request, context, next) => {
		if (context.url.pathname !== path) return next()
		sweep()

		if (context.method === 'GET') {
			const entry = resolve(request)
			if (entry === undefined) return rejectUnknownSession()
			const stream = openStream()
			// A comment write flushes the response headers immediately (the underlying node:http
			// response only sends headers on its first `write`/`end`) — without it a client's fetch
			// hangs waiting for headers until the first replay/push write, which may never come.
			stream.comment('open')
			const lastEventId = readLastEventId(request)
			if (lastEventId !== undefined) {
				// Replay every event STRICTLY AFTER the client's last-seen id BEFORE attaching, so the
				// missed events arrive in order ahead of any live push.
				for (const e of entry.session.replay(lastEventId)) {
					stream.write({ id: e.id, data: JSON.stringify(e.message) })
				}
			}
			entry.session.attach(stream)
			if (request.signal.aborted) entry.session.detach(stream)
			else
				request.signal.addEventListener('abort', () => entry.session.detach(stream), { once: true })
			return stream.response
		}

		if (context.method === 'DELETE') {
			const id = readSessionHeader(request)
			if (id === undefined || !store.has(id)) return rejectUnknownSession()
			store.delete(id)
			return new Response(null, { status: 204 })
		}

		// POST — buffer the body once so the downstream route can re-read it via a forwarded
		// Request; only `initialize` mints a fresh session when no valid id is present.
		const text = await request.text()
		let entry = resolve(request)
		if (entry === undefined) {
			let parsed: unknown
			try {
				parsed = parseJSONRPCMessage(JSON.parse(text))
			} catch {
				parsed = undefined
			}
			if (parsed !== undefined && isInitializeRequest(parsed)) {
				const session = new MCPSession(crypto.randomUUID(), { capacity })
				entry = { session, touched: clock() }
				store.set(session.id, entry)
			} else {
				return rejectUnknownSession()
			}
		}
		context.state.session = entry.session
		const forwarded = new Request(context.url, {
			method: 'POST',
			headers: request.headers,
			body: text,
		})
		const response = await next(forwarded)
		response.headers.set(MCP_SESSION_HEADER, entry.session.id)
		return response
	}

	// Resolve + touch the session named by the request's `mcp-session-id` header, or
	// `undefined` when the header is absent or names an unknown / evicted session.
	function resolve(request: Request): MCPSessionEntry | undefined {
		const id = readSessionHeader(request)
		if (id === undefined) return undefined
		const entry = store.get(id)
		if (entry === undefined) return undefined
		entry.touched = clock()
		return entry
	}

	// Lazy idle-TTL sweep — no background timer (the rate-limiter lazy-window idiom): drop
	// every session not touched within `ttl` on the next access. Omitted entirely (a no-op)
	// when `ttl` is unset — sessions then live until an explicit `DELETE`.
	function sweep(): void {
		if (ttl === undefined) return
		const cutoff = clock() - ttl
		for (const [id, entry] of store) {
			if (entry.touched <= cutoff) store.delete(id)
		}
	}
}
