// The MCP browser-transport constants — the server-identity defaults the browser-face
// bootstrap falls back to, and the WebSocket subprotocol its client transport requests. The
// Streamable-HTTP wire headers live in `@src/core` beside the transport that stamps them.

// Scope-server identity defaults — `src/core`'s `createMCPServer` REQUIRES
// `name`/`version`, but `ScopeServerOptions` (this face's bootstrap) makes them optional
// (mirroring the CLIENT identity defaults, `DEFAULT_MCP_CLIENT_NAME` /
// `DEFAULT_MCP_CLIENT_VERSION`, `src/core/constants.ts`), so `createScopeServer` falls
// back to these when a caller omits them.

/** Supplies the default server name `createScopeServer` reports (`initialize`'s `serverInfo.name`) when `options.name` is omitted. */
export const DEFAULT_MCP_SERVER_NAME = '@orkestrel/mcp'

/** Supplies the default server version `createScopeServer` reports (`initialize`'s `serverInfo.version`) when `options.version` is omitted. */
export const DEFAULT_MCP_SERVER_VERSION = '1.0.0'

// The WebSocket subprotocol constant, declared here independently of the Node face's
// `MCP_WEBSOCKET_SUBPROTOCOL` (`src/server/constants.ts`) — peer environment faces share
// no import, so the same value is declared on each face. The browser face's
// `WebSocketClientTransport` defaults to this value when `protocols` is omitted, and
// `createWebSocketServer` selects it from the client's offer.

/**
 * Names the WebSocket subprotocol `createWebSocketClientTransport` requests by default —
 * `'mcp'`, which `createWebSocketServer` selects when the client offers it. Per RFC 6455
 * §4.1 a client MUST fail the connection if the server returns
 * a subprotocol it did not request; Node ≥ 22 (undici) enforces this strictly, so the
 * default bakes the correct value in. Override `WebSocketClientTransportOptions.protocols`
 * only when connecting to a foreign server that speaks a different subprotocol (or `[]`
 * for no subprotocol negotiation at all).
 */
export const MCP_WEBSOCKET_SUBPROTOCOL = 'mcp'
