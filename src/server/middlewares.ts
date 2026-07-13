import type { Middleware } from '../http/types.js'
import type { MCPSessionOptions } from './types.js'
import { isInitializeRequest, parseJSONRPCMessage } from '@src/core'
import { createSession } from '../http/middlewares.js'
import { bindStreamingAbort, openSSEStream } from '../http/helpers.js'
import { DEFAULT_MCP_PATH, MCP_SESSION_HEADER, MCP_SESSION_STATE } from './constants.js'
import { readLastEventId, rejectUnknownSession } from './helpers.js'
import { MCPSession } from './MCPSession.js'

/**
 * Create the MCP session {@link Middleware} — the plug-and-play stateful layer that fronts a
 * session-agnostic {@link import('./factories.js').createMCPRoutes}. Compose it via
 * `server.use(createMCPSession())`, mirroring `createRateLimiter` / `createTokenGuard` /
 * `createCors`.
 *
 * @remarks
 * It BUILDS ON the generic {@link import('../http/middlewares.js').createSession} HTTP primitive
 * — sessions are a first-class, reusable spine mechanism and MCP is its first consumer. The
 * generic resolve / mint / validate-or-reject / `DELETE`-end / idle-TTL machinery (the closure
 * session store, the lazy eviction, the `mcp-session-id` header round-trip) all come from
 * `createSession`; this factory only CONFIGURES it for the MCP wire and adds the ONE
 * MCP-specific piece on top — the resumable server→client `GET` SSE stream.
 *
 * The `createSession` configuration:
 *
 * - `header` is {@link MCP_SESSION_HEADER} (`'mcp-session-id'`), `key` is {@link
 *   MCP_SESSION_STATE}, and `create` builds a fresh {@link import('./MCPSession.js').MCPSession}
 *   (its folded replay log bounded by `options.capacity`). `ttl` is the session idle lifetime.
 * - `mint` returns `true` ONLY for a `POST` whose (cached) body parses to an `initialize`
 *   request — so `initialize` MINTS a session (the id returned in the response header) while
 *   any other unsessioned request does not silently open one. The mint predicate awaits
 *   `context.body()`, which is CACHED, so the downstream route re-reads the same body.
 * - `require` is `true` with `onMissing` = {@link rejectUnknownSession}: a non-`initialize`
 *   request (POST, GET, or DELETE) carrying no VALID session id is a transport-level **404**
 *   with a JSON-RPC error body. (A `DELETE` carrying a valid id is the generic session-END —
 *   `createSession` drops it and answers **204**.)
 *
 * It OWNS a single request `path` (default {@link DEFAULT_MCP_PATH}); a request to any other
 * path passes straight through. For its `path` it delegates to `createSession`, and in the
 * delegate's `next` callback adds the MCP-specific behavior:
 *
 * - **`GET {path}`** — open the resumable server→client SSE stream. `createSession` has already
 *   resolved + validated the session (a missing / unknown / evicted id never reaches here — it
 *   was the **404**) and set it on `context.state`; read it back ({@link MCP_SESSION_STATE},
 *   narrowed with `instanceof MCPSession`, no `as`), `openSSEStream`, read `Last-Event-ID`
 *   ({@link readLastEventId}) and REPLAY every event strictly after it (`session.replay`, an
 *   unknown / evicted cursor replays nothing) onto the stream FIRST, THEN `session.attach(stream)`
 *   (so future `push`es reach it), THEN bind a client disconnect → `session.detach`. Long-lived
 *   — never `end()`ed here. Short-circuits.
 * - **`POST {path}`** — the mint-on-`initialize` / validate-or-404 already ran in `createSession`
 *   (the resolved session is on `context.state`), so this just `await next()`s and the route
 *   dispatches the validated request.
 *
 * The resolved session is set on `context.state` under {@link MCP_SESSION_STATE}, so an
 * in-request handler reads it (`context.state.get(MCP_SESSION_STATE)`) and `push`es a
 * server-initiated message to the session's `GET {path}` stream.
 *
 * It is MECHANISM, not policy, and ADDITIVE: omit it entirely for the stateless default
 * ({@link import('./factories.js').createMCPRoutes}'s only behavior). The `path` MUST match the
 * `createMCPRoutes` `path` it fronts. The WebSocket transport is inherently one session per
 * connection (the socket IS the session), so this middleware does not apply to it.
 *
 * @param options - Optional `path` (default {@link DEFAULT_MCP_PATH}), `ttl` (session idle
 *   lifetime, ms), `capacity` (the folded per-session replay-log bound), and `clock` (the
 *   deterministic epoch-ms clock threaded to `createSession`); see {@link MCPSessionOptions}
 * @returns A {@link Middleware} that mints / validates sessions + serves the resumable GET / DELETE
 *
 * @example
 * ```ts
 * import { createMCPServer, createToolManager } from '@src/core'
 * import { createMCPRoutes, createMCPSession, createServer } from '@src/server'
 *
 * const mcp = createMCPServer({ name: 'docs', version: '1.0.0', tools: createToolManager() })
 * const server = createServer()
 * server.use(createMCPSession({ ttl: 60_000 })) // stateful: mint + validate + resumable GET / DELETE
 * server.route(createMCPRoutes(mcp)) // the route stays session-agnostic
 * await server.start()
 * ```
 */
export function createMCPSession(options?: MCPSessionOptions): Middleware {
	const path = options?.path ?? DEFAULT_MCP_PATH
	const capacity = options?.capacity
	// The MCP session layer IS the generic `createSession` HTTP primitive configured for the MCP
	// wire: the `mcp-session-id` header + `mcp:session` state key, an `MCPSession` (folded replay
	// log) per id, mint-only-on-`initialize`, and require-or-404 (the JSON-RPC unknown-session
	// body). `createSession` owns the store + lazy idle-TTL eviction + the header round-trip; this
	// factory adds ONLY the resumable GET stream below. (No duplicated session machinery.)
	const session = createSession<MCPSession>({
		header: MCP_SESSION_HEADER,
		ttl: options?.ttl,
		key: MCP_SESSION_STATE,
		clock: options?.clock,
		create: (id) => new MCPSession(id, { capacity }),
		// Mint a session only for an `initialize` POST. The predicate awaits the CACHED body
		// (`context.body()`), so the route re-reads the same value; a malformed / non-message /
		// non-`initialize` body simply does not mint (it returns `false`) — a fresh client without
		// a valid session is then the require-404, while a malformed body carrying a VALID session
		// resolves that session and reaches the route's canonical `-32700` (the session branch wins
		// before `mint` is consulted, so the route still owns transport-level parse failures).
		mint: async (context) => {
			if (context.method !== 'POST') return false
			try {
				const request = parseJSONRPCMessage(await context.body())
				return request !== undefined && isInitializeRequest(request)
			} catch {
				return false
			}
		},
		require: true,
		onMissing: rejectUnknownSession,
	})
	return async (context, next) => {
		// The middleware OWNS only its MCP path — anything else passes straight through.
		if (context.url.pathname !== path) {
			await next()
			return
		}
		// Delegate the generic resolve / mint-on-initialize / validate-or-404 / DELETE-end to
		// `createSession`; its `next` callback runs ONLY once a session was resolved or minted (a
		// missing / unknown id short-circuited as the 404, a DELETE as the 204). There we add the
		// MCP-specific GET resumable stream; a POST just proceeds to the route dispatch.
		await session(context, async () => {
			if (context.method === 'GET') {
				// Resumable server→client SSE channel. `createSession` set the validated session on
				// `context.state`; read it back, narrowing with `instanceof` (no `as`, §14) — it is
				// always present here (an unknown session was the 404), the guard is the type bridge.
				const resolved = context.state.get(MCP_SESSION_STATE)
				if (!(resolved instanceof MCPSession)) {
					await next()
					return
				}
				const stream = openSSEStream(context)
				const lastEventId = readLastEventId(context)
				if (lastEventId !== undefined) {
					// Replay every event STRICTLY AFTER the client's last-seen id BEFORE attaching, so the
					// missed events arrive in order ahead of any live push (an unknown / evicted cursor
					// replays nothing — the session's spec-sane choice).
					for (const entry of resolved.replay(lastEventId)) {
						stream.write({ id: entry.id, data: JSON.stringify(entry.message) })
					}
				}
				resolved.attach(stream)
				bindStreamingAbort(context, () => resolved.detach(stream))
				return
			}
			// A validated POST (mint-on-initialize / session-echo already passed) — dispatch it.
			await next()
		})
	}
}
