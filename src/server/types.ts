// The MCP server-transport surface — the source of truth (AGENTS §2). Two transports
// for the Model Context Protocol over the server spine: the Streamable HTTP transport
// (route handlers via `createMCPRoutes` + the `fetch` egress `createHTTPClientTransport`)
// and the WebSocket transport (an ingress `createWebSocketServer` over the spine's
// `upgrade` seam + the egress `createWebSocketClientTransport` over `node:http(s)`).
//
// The HTTP transport mounts a transport-agnostic `MCPServerInterface` (the `@src/core` MCP
// dispatch core) on a spine `Server` via `createMCPRoutes`, pumping each POST body through
// `mcp.dispatch`. It is MECHANISM, never policy — auth / CORS / rate-limiting compose IN
// FRONT as ordinary middleware (`createTokenGuard` / `createCors` / `createRateLimiter`),
// not baked in here. `createMCPRoutes` is STATELESS — a single `POST {path}`. Statefulness is
// a SEPARATE, plug-and-play middleware: `server.use(createMCPSession())` mounts the session
// layer IN FRONT (mirroring `createRateLimiter` — a closure owning the session `Map` + lazy
// TTL), minting + validating a session id (the `mcp-session-id` header), serving a `DELETE
// {path}` session-end AND a resumable `GET {path}` server→client SSE channel (each `MCPSession`
// folds in its own replay log; `session.push` appends + fans out; a reconnect with
// `Last-Event-ID` replays the missed events). The middleware sets the resolved session as the
// `context.state.session` property (the `MCPSessionState` slice) so an in-request handler can
// `push` to it. The request/response streaming surface is the spine's generic SSE seam
// (`openStream`), reused
// for a Streamable-HTTP SSE response when the client `Accept`s `text/event-stream` AND for the
// long-lived resumable GET stream.
//
// The WebSocket transport composes the lean RFC 6455 `NodeWebSocket` wrapper (D2) over the
// spine's generic `upgrade` seam (D3): `createWebSocketServer` returns an `UpgradeHandler`
// that claims an MCP WebSocket upgrade and pumps each decoded JSON-RPC request through
// `mcp.dispatch`; `createWebSocketClientTransport` opens an upgrade `GET`, validates the
// handshake accept, and bridges the masked client frames as a `ClientTransportInterface` an
// `MCPClient` drives. Both transports speak the SAME transport-agnostic `MCPServerInterface`
// / `ClientTransportInterface` the HTTP pair does — the wire framing differs, the dispatch
// core does not.

import type { JSONRPCMessage } from '@src/core'
import type { StreamInterface } from '@orkestrel/server'
import type { MCPSession } from './MCPSession.js'

/**
 * Options for `createMCPRoutes` — the path the transport is mounted at and whether an SSE
 * response is allowed. `createMCPRoutes` is STATELESS; sessions are a separate middleware
 * ({@link import('./middlewares.js').createMCPSession}), composed via `server.use`.
 *
 * @remarks
 * - `path` — the request path the single `POST` route answers; defaults to
 *   {@link import('./constants.js').DEFAULT_MCP_PATH} (`'/mcp'`). `GET` / `DELETE` to this
 *   path get the spine's automatic `405` unless a {@link
 *   import('./middlewares.js').createMCPSession} middleware (which owns the same `path`) is
 *   mounted IN FRONT to serve them.
 * - `streaming` — when `true` (the DEFAULT) the transport MAY answer with a
 *   Server-Sent-Events response (one `data:` event carrying the JSON-RPC reply, then
 *   the stream ends) whenever the client's `Accept` header includes
 *   `text/event-stream`; when `false` it always answers with a plain JSON body. Either
 *   mode carries the SAME JSON-RPC response envelope — the choice is purely the wire
 *   framing the Streamable-HTTP spec lets the client negotiate.
 */
export interface HTTPTransportOptions {
	readonly path?: string
	readonly streaming?: boolean
}

/**
 * Options for `createMCPSession` — the path the session middleware owns, the session idle
 * time-to-live, and the per-session resumable event-log bound.
 *
 * @remarks
 * - `path` — the request path the session middleware OWNS (must match the `createMCPRoutes`
 *   `path` it fronts); a request to any other path passes straight through. Defaults to
 *   {@link import('./constants.js').DEFAULT_MCP_PATH} (`'/mcp'`).
 * - `ttl` — the session idle lifetime in milliseconds: a session not accessed within `ttl`
 *   is treated as ABSENT and lazily evicted on the next access (no background timer — the
 *   `createRateLimiter` lazy-window idiom). Omit it for sessions that live until an explicit
 *   `DELETE`.
 * - `capacity` — the FOLDED event-log bound per session: the maximum number of pushed
 *   server→client messages retained for replay before the OLDEST is evicted, paired with a
 *   per-event idle lifetime ({@link import('./constants.js').DEFAULT_MCP_SESSION_TTL}) that
 *   bounds how far a reconnecting client may replay. Omit it for the {@link
 *   import('./constants.js').DEFAULT_MCP_SESSION_CAPACITY} default. (The session `ttl` bounds
 *   the session; this `capacity` bounds its replay log — independent knobs.)
 * - `clock` — the `() => number` epoch-ms clock {@link import('./middlewares.js').createMCPSession}
 *   uses directly for its own session-touch / TTL-sweep bookkeeping; defaults to `Date.now`. The
 *   deterministic clock a TTL test advances explicitly instead of racing a real idle window
 *   against wall-clock (AGENTS §16). Production never sets it.
 */
export interface MCPSessionOptions {
	readonly path?: string
	readonly ttl?: number
	readonly capacity?: number
	readonly clock?: () => number
}

/**
 * One MCP transport session — the per-session entity a {@link
 * import('./middlewares.js').createMCPSession} middleware owns (the {@link
 * import('./MCPSession.js').MCPSession} entity), carrying the resumable server→client push
 * channel with its bounded replay log FOLDED IN.
 *
 * @remarks
 * - `id` — the opaque session id (a `crypto.randomUUID()`), echoed in the `mcp-session-id`
 *   header. The app reads it off `context.state.session` (the {@link MCPSessionState} slice
 *   {@link import('./middlewares.js').createMCPSession} sets) to address a push.
 * - `attach(stream)` — register an OPEN server→client SSE stream (a resumable `GET {path}`)
 *   so future {@link push}es reach it; `detach(stream)` unregisters it (the middleware calls
 *   it when the client disconnects).
 * - `push(message)` — APPEND `message` to the session's folded replay log (assigning a
 *   monotone event id, RETURNED) and FAN it out to every attached stream as one `id:`-tagged
 *   SSE event — the server-initiated push primitive an in-request handler calls. A push with
 *   no attached stream is still logged, so a later-connecting / reconnecting client replays it.
 * - `replay(afterId)` — the missed-events list (every retained log entry STRICTLY AFTER
 *   `afterId`, in append order) the resumable `GET {path}` handler writes ahead of live pushes;
 *   an unknown / evicted cursor replays NOTHING (the spec-sane resume).
 */
export interface MCPSessionInterface {
	readonly id: string
	attach(stream: StreamInterface): void
	detach(stream: StreamInterface): void
	push(message: JSONRPCMessage): string
	replay(afterId: string): readonly EventStoreEntry[]
}

/**
 * The `context.state` slice a {@link import('./middlewares.js').createMCPSession}
 * middleware sets on a validated / minted request — a consumer's `TState` extends
 * this so the downstream route handler can read `context.state.session` to `push`
 * a server-initiated message onto the session's resumable stream.
 *
 * @remarks
 * `session` is set on `initialize` (the minted session) and on every validated
 * non-`initialize` `POST` (the resolved one); absent when the request never
 * reached a resolved session (the middleware short-circuits those as a `404`
 * before calling `next`).
 */
export interface MCPSessionState {
	session?: MCPSessionInterface
}

/**
 * One entry of an {@link MCPSessionInterface}'s folded replay log — a single pushed {@link
 * JSONRPCMessage} tagged with the monotone event `id` the session assigned and the `timestamp`
 * it was appended at (for the lazy-TTL replay window).
 *
 * @remarks
 * - `id` — the session-assigned, monotonically-increasing event id (a base36 string), the
 *   value a resumable client echoes back as its `Last-Event-ID` to replay from here.
 * - `message` — the server→client {@link JSONRPCMessage} that was pushed.
 * - `timestamp` — the epoch-ms instant the entry was appended, read by the TTL eviction.
 *
 * A plain value record (no behavior, §4.5) — the unit {@link MCPSessionInterface.replay}
 * returns.
 */
export interface EventStoreEntry {
	readonly id: string
	readonly message: JSONRPCMessage
	readonly timestamp: number
}

/**
 * The closure store entry a {@link import('./middlewares.js').createMCPSession} middleware
 * keeps per minted session — the live {@link MCPSession} entity plus the epoch-ms instant it
 * was last touched (the lazy-TTL sweep's idle clock, independent of the session's own
 * replay-log TTL).
 *
 * @remarks
 * - `session` — the live {@link MCPSession} entity the store keys by session id.
 * - `touched` — the epoch-ms instant of the last access; mutated (not replaced) on every
 *   resolved request so the middleware's lazy sweep can evict an idle entry past `ttl`.
 */
export interface MCPSessionEntry {
	readonly session: MCPSession
	touched: number
}

/**
 * Options for `createHTTPClientTransport` — the remote MCP server's URL and any extra
 * request headers.
 *
 * @remarks
 * - `url` — the absolute URL of the remote server's Streamable-HTTP endpoint (the
 *   `POST` target every JSON-RPC message is written to, e.g.
 *   `http://localhost:3000/mcp`). REQUIRED.
 * - `headers` — extra request headers merged onto every `POST` (e.g. an
 *   `Authorization` bearer for a guarded server). The transport always sets
 *   `content-type: application/json` and an `Accept` of both `application/json` and
 *   `text/event-stream` (so the server may answer with either framing); a key supplied
 *   here is merged on top.
 * - `fetch` — the `fetch` implementation to issue each `POST` with; defaults to
 *   `globalThis.fetch`. Injectable for a test double or a non-global `fetch`.
 * - `timeout` — an optional per-request timeout in milliseconds; when set, each
 *   `fetch` call is issued with `signal: AbortSignal.timeout(timeout)`. Omit for no
 *   transport-level deadline.
 */
export interface HTTPClientTransportOptions {
	readonly url: string
	readonly headers?: Readonly<Record<string, string>>
	readonly fetch?: typeof fetch
	readonly timeout?: number
}

/**
 * Options for `createWebSocketServer` — where the WebSocket upgrade is accepted and the
 * subprotocol negotiated.
 *
 * @remarks
 * - `path` — the request path the upgrade handler CLAIMS; defaults to
 *   {@link import('./constants.js').DEFAULT_MCP_PATH} (`'/mcp'`, the same path the HTTP
 *   transport mounts at). A protocol-upgrade request to any OTHER path is DECLINED
 *   (the handler returns `false`, so the spine fans it to the next handler or destroys it).
 * - `subprotocol` — the WebSocket subprotocol echoed in the `101` handshake's
 *   `Sec-WebSocket-Protocol`; defaults to {@link import('./constants.js').MCP_WEBSOCKET_SUBPROTOCOL}
 *   (`'mcp'`). It is echoed unconditionally (the client requests it), so an MCP WebSocket
 *   endpoint is distinguishable from another WebSocket on the same path.
 *
 * Auth / origin policy is deliberately ABSENT: like the HTTP transport, the WebSocket
 * transport is MECHANISM — compose a guard IN FRONT (a `Server.upgrade` handler registered
 * before this one can decline an unauthenticated upgrade).
 */
export interface WebSocketServerOptions {
	readonly path?: string
	readonly subprotocol?: string
}

/**
 * Options for `createWebSocketClientTransport` — the remote MCP WebSocket endpoint and any
 * extra handshake headers.
 *
 * @remarks
 * - `url` — the absolute URL of the remote server's WebSocket endpoint. Accepts a `ws://` /
 *   `wss://` URL OR an `http://` / `https://` one (a `ws(s)` scheme is converted to `http(s)`
 *   for the underlying `node:http(s)` upgrade request; either reaches the same endpoint).
 *   REQUIRED.
 * - `headers` — extra request headers merged onto the upgrade `GET` (e.g. an `Authorization`
 *   bearer for a guarded server). The transport always sets `Connection: Upgrade`,
 *   `Upgrade: websocket`, a random `Sec-WebSocket-Key`, `Sec-WebSocket-Version: 13`, and
 *   `Sec-WebSocket-Protocol: mcp`; a header supplied here is merged on top.
 */
export interface WebSocketClientTransportOptions {
	readonly url: string
	readonly headers?: Readonly<Record<string, string>>
}

/**
 * Options for `createStdioClientTransport` — the child process to spawn as a
 * stdio-framed MCP server (newline-delimited JSON-RPC over `stdin`/`stdout`).
 *
 * @remarks
 * - `command` — the executable to spawn (e.g. `'node'`, `'./my-mcp-server'`). REQUIRED.
 * - `args` — the command-line arguments passed to `command`; defaults to none.
 * - `env` — the environment variables for the spawned child, passed straight to
 *   `node:child_process`'s `spawn`; when OMITTED the child inherits the full
 *   `process.env` (the `spawn` default), when PROVIDED it REPLACES the inherited
 *   environment entirely (`spawn` semantics) — a caller wanting to extend rather
 *   than replace spreads `process.env` into `env` themselves.
 */
export interface StdioClientTransportOptions {
	readonly command: string
	readonly args?: readonly string[]
	readonly env?: Readonly<Record<string, string>>
}

/**
 * Options for `createStdioServer` — the injectable stdin/stdout streams the server
 * transport reads newline-delimited JSON-RPC requests from and writes responses to.
 *
 * @remarks
 * - `input` — the readable stream carrying newline-delimited JSON-RPC requests;
 *   defaults to `process.stdin`. Injectable for a test double.
 * - `output` — the writable stream newline-delimited JSON-RPC responses are written
 *   to; defaults to `process.stdout`. Injectable for a test double.
 */
export interface StdioServerOptions {
	readonly input?: NodeJS.ReadableStream
	readonly output?: NodeJS.WritableStream
}

/**
 * The result of folding one more chunk of raw stdio bytes into a newline-framed
 * buffer — every COMPLETE line extracted (newline-terminated in the wire bytes) plus
 * the trailing partial line carried forward as the new `remainder`.
 *
 * @remarks
 * A plain value record (no behavior, §4.5) {@link import('./helpers.js').extractLines}
 * returns; the caller threads `remainder` back in as the next call's `buffer`.
 */
export interface LineExtraction {
	readonly lines: readonly string[]
	readonly remainder: string
}
