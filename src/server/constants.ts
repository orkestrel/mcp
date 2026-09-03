// The MCP server-environment transport constants — the reverse-proxy buffering header, the
// default mount path, the folded event-log bounds, and the stdio client transport's default
// write-delivery bound. The Streamable-HTTP wire header names and the WebSocket subprotocol
// live in `@src/core` beside the transports that write them: `createMCPSession` reads the
// session id from there, `createMCPRoutes` validates a present protocol version on every POST
// against the same spelling the client wrote, and `createWebSocketServer` echoes the same
// subprotocol token the browser face offers.

/** Names the reverse-proxy response header controlling buffering of an SSE response. */
export const SSE_BUFFERING_HEADER = 'x-accel-buffering'

/** Names the `X-Accel-Buffering` value that disables reverse-proxy buffering. */
export const SSE_BUFFERING_DISABLED = 'no'

/** Names the default request path `createMCPRoutes` mounts the transport's `POST` route at. */
export const DEFAULT_MCP_PATH = '/mcp'

/**
 * Sets the default interval in milliseconds between SSE keepalive comments on held-open MCP
 * responses.
 *
 * @remarks
 * Fifteen seconds is infrequent enough to avoid chatty idle connections while bounding dead
 * client detection and staying comfortably inside common intermediary idle windows.
 */
export const DEFAULT_MCP_KEEPALIVE_INTERVAL = 15_000

/** Names the comment text written by the held-open MCP response keepalive. */
export const SSE_KEEPALIVE_COMMENT = 'keepalive'

/**
 * Sets the default capacity of a session's FOLDED resumable event log (the per-{@link
 * import('./MCPSession.js').MCPSession} replay log) — the maximum number of pushed
 * server→client messages retained for replay before the OLDEST is evicted.
 *
 * @remarks
 * Bounds the replay log's memory: only the most-recent {@link DEFAULT_MCP_SESSION_CAPACITY}
 * pushes are retained, so a client reconnecting with a `Last-Event-ID` older than that window
 * replays nothing (its cursor fell off the back). Override through the `session` group of
 * `createMCPSession`'s options (`session.capacity`) for a deeper / shallower window.
 */
export const DEFAULT_MCP_SESSION_CAPACITY = 1024

/**
 * Sets the default per-event idle lifetime (ms) of a session's folded resumable event log — an
 * entry older than this is lazily evicted on the next access (no background timer), bounding
 * how far back a reconnecting client may replay.
 *
 * @remarks
 * Five minutes — a generous reconnection window for a dropped SSE stream without retaining
 * stale pushes indefinitely. The session's own idle TTL is the `createMCPSession` `ttl` knob;
 * this bounds the replay log paired with it.
 */
export const DEFAULT_MCP_SESSION_TTL = 300_000

/**
 * Sets the default bound in milliseconds on one unconfirmed write to a stdio client transport's
 * child `stdin` — the `delivery` a `createStdioClientTransport` caller who supplies none gets.
 *
 * @remarks
 * Ten seconds. The load-bearing property is the ordering, not the magnitude: this bound stays
 * BELOW {@link import('@orkestrel/mcp').DEFAULT_MCP_REQUEST_TIMEOUT}, so a write the child never
 * reads fails as an undeliverable message while the request that carried it is still open,
 * rather than being masked by that request's own deadline expiring first. Override per
 * transport with `delivery`; an explicit `0` there removes the bound.
 */
export const DEFAULT_MCP_DELIVERY = 10_000
