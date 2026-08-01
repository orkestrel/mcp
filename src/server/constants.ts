// The MCP HTTP-transport constants (AGENTS §5 constants file) — the wire-level header
// names, the default mount path, and the folded event-log bounds. The HEADER names are
// the Streamable-HTTP transport's session /
// protocol-version headers. `createMCPSession` owns the optional session id, while
// `createMCPRoutes` validates a present protocol version on every POST. The
// transport-agnostic dispatch core deliberately does NOT carry these — header names
// belong to the HTTP transport, here.

/**
 * The Streamable-HTTP transport header that carries the MCP session id. When a {@link
 * import('./middlewares.js').createMCPSession} middleware is mounted, it SETS this header on
 * the `initialize` response (the minted id) and READS it on every subsequent request
 * (validating the session); the stateless `createMCPRoutes` default neither sets nor reads it.
 */
export const MCP_SESSION_HEADER = 'mcp-session-id'

/**
 * The Streamable-HTTP transport header carrying the negotiated MCP protocol version
 * on every post-initialize client request.
 *
 * @remarks
 * Required by MCP 2025-06-18 after initialization. Both HTTP client transports
 * capture the initialize result's `protocolVersion` and send it on subsequent
 * requests; `createMCPRoutes` rejects a present unsupported value before dispatch.
 */
export const MCP_PROTOCOL_VERSION_HEADER = 'mcp-protocol-version'

/** The modern Streamable-HTTP request header carrying the JSON-RPC method name. */
export const MCP_METHOD_HEADER = 'mcp-method'

/** The modern Streamable-HTTP request header carrying a named method's target. */
export const MCP_NAME_HEADER = 'mcp-name'

/** The reverse-proxy response header controlling buffering of an SSE response. */
export const SSE_BUFFERING_HEADER = 'x-accel-buffering'

/** The `X-Accel-Buffering` value that disables reverse-proxy buffering. */
export const SSE_BUFFERING_DISABLED = 'no'

/** The default request path `createMCPRoutes` mounts the transport's `POST` route at. */
export const DEFAULT_MCP_PATH = '/mcp'

/**
 * The default interval in milliseconds between SSE keepalive comments on held-open MCP
 * responses.
 *
 * @remarks
 * Fifteen seconds is infrequent enough to avoid chatty idle connections while bounding dead
 * client detection and staying comfortably inside common intermediary idle windows.
 */
export const DEFAULT_MCP_KEEPALIVE_INTERVAL = 15_000

/** The comment text written by the held-open MCP response keepalive. */
export const SSE_KEEPALIVE_COMMENT = 'keepalive'

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
