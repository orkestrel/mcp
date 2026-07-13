// The MCP HTTP-transport constants (AGENTS §5 constants file) — the wire-level header
// names, the default mount path, the session `context.state` key, and the folded
// event-log bounds. The HEADER names are the Streamable-HTTP transport's session /
// protocol-version headers: they go LIVE when a `createMCPSession` middleware is mounted
// (it mints the session id into `MCP_SESSION_HEADER` on `initialize` and reads it back on
// subsequent requests); the stateless `createMCPRoutes` default neither sets nor reads
// them. The transport-agnostic dispatch core (`src/core/mcp`) deliberately does NOT carry
// these — header names belong to the HTTP transport, here.

/**
 * The Streamable-HTTP transport header that carries the MCP session id. When a {@link
 * import('./middlewares.js').createMCPSession} middleware is mounted, it SETS this header on
 * the `initialize` response (the minted id) and READS it on every subsequent request
 * (validating the session); the stateless `createMCPRoutes` default neither sets nor reads it.
 */
export const MCP_SESSION_HEADER = 'mcp-session-id'

/**
 * The `context.state` key under which a {@link import('./middlewares.js').createMCPSession}
 * middleware stashes the resolved {@link import('./types.js').MCPSessionInterface} for the
 * current request — so an in-request handler can read it (`context.state.get(MCP_SESSION_STATE)`)
 * and `push` a server-initiated message to the session's resumable `GET {path}` stream. Mirrors
 * the http spine's {@link import('../http/constants.js').TOKEN_STATE} pattern. Set on an
 * `initialize` POST (the minted session) and on every validated non-`initialize` POST (the
 * resolved one); absent on the stateless path.
 */
export const MCP_SESSION_STATE = 'mcp:session'

/**
 * The Streamable-HTTP transport header that carries the negotiated MCP protocol version
 * on a subsequent request. The version is negotiated in the `initialize` JSON-RPC result
 * body; a stateful transport MAY additionally read this header to pin the per-request
 * protocol version (optional — the result body remains the source of truth).
 */
export const MCP_PROTOCOL_VERSION_HEADER = 'mcp-protocol-version'

/** The default request path `createMCPRoutes` mounts the transport's `POST` route at. */
export const DEFAULT_MCP_PATH = '/mcp'

/**
 * The WebSocket subprotocol the MCP-over-WebSocket transports negotiate — sent by the
 * client in `Sec-WebSocket-Protocol`, echoed by the server in its `101` handshake.
 *
 * @remarks
 * `createWebSocketServer` echoes it in the upgrade response and `createWebSocketClientTransport`
 * requests it, so an MCP WebSocket endpoint is distinguishable from any other WebSocket on the
 * same path. The default WebSocket upgrade path is {@link DEFAULT_MCP_PATH} (the same `'/mcp'`
 * the HTTP transport mounts at) — the upgrade is selected by the `Upgrade: websocket` header,
 * not a separate path.
 */
export const MCP_WEBSOCKET_SUBPROTOCOL = 'mcp'

/**
 * The default capacity of a session's FOLDED resumable event log (the per-{@link
 * import('./MCPSession.js').MCPSession} replay log) — the maximum number of pushed
 * server→client messages retained for replay before the OLDEST is evicted.
 *
 * @remarks
 * Bounds the replay log's memory: only the most-recent {@link DEFAULT_MCP_SESSION_CAPACITY}
 * pushes are retained, so a client reconnecting with a `Last-Event-ID` older than that window
 * replays nothing (its cursor fell off the back). Override per `createMCPSession`'s `capacity`
 * for a deeper / shallower window.
 */
export const DEFAULT_MCP_SESSION_CAPACITY = 1024

/**
 * The default per-event idle lifetime (ms) of a session's folded resumable event log — an
 * entry older than this is lazily evicted on the next access (no background timer), bounding
 * how far back a reconnecting client may replay.
 *
 * @remarks
 * Five minutes — a generous reconnection window for a dropped SSE stream without retaining
 * stale pushes indefinitely. The session's own idle TTL is the `createMCPSession` `ttl` knob;
 * this bounds the replay log paired with it.
 */
export const DEFAULT_MCP_SESSION_TTL = 300_000
