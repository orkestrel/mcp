// The MCP browser-transport constants (AGENTS §5 constants file) — the wire-level
// header name the browser-face HTTP client transport echoes, matching the Node
// face's `MCP_SESSION_HEADER` (`src/server/constants.ts`) byte-for-byte. The browser
// face imports nothing from `src/server` (peer environment faces, per AGENTS §2), so
// the literal is declared once here too — the SAME string, not a shared symbol.

/**
 * The Streamable-HTTP transport header that carries the MCP session id. The browser
 * face's {@link import('./transports/HTTPClientTransport.js').HTTPClientTransport}
 * ECHOES this header exactly like the Node face's `HTTPClientTransport`
 * (`src/server`), so the same client interoperates with an `MCPSession`-based
 * server unchanged.
 */
export const MCP_SESSION_HEADER = 'mcp-session-id'

// `serveMCP` server-identity defaults — `src/core`'s `createMCPServer` REQUIRES
// `name`/`version`, but `ServeMCPOptions` (this face's bootstrap) makes both optional
// (mirroring the CLIENT identity defaults, `DEFAULT_MCP_CLIENT_NAME` /
// `DEFAULT_MCP_CLIENT_VERSION`, `src/core/constants.ts`), so `serveMCPScope` falls
// back to these when a caller omits them.

/** The default server name `serveMCPScope` reports (`initialize`'s `serverInfo.name`) when `options.name` is omitted. */
export const DEFAULT_MCP_SERVER_NAME = 'taverna'

/** The default server version `serveMCPScope` reports (`initialize`'s `serverInfo.version`) when `options.version` is omitted. */
export const DEFAULT_MCP_SERVER_VERSION = '1.0.0'

// The WebSocket subprotocol constant, declared here independently of the Node face's
// `MCP_WEBSOCKET_SUBPROTOCOL` (`src/server/constants.ts`) — peer environment faces share
// no import (AGENTS §2), so the same value is declared twice. The browser face's
// `WebSocketClientTransport` defaults to this value when `protocols` is omitted, matching
// `createWebSocketServer`'s unconditional echo.

/**
 * The WebSocket subprotocol `createWebSocketClientTransport` requests by default —
 * `'mcp'`, matching `createWebSocketServer`'s unconditional `Sec-WebSocket-Protocol:
 * mcp` echo. Per RFC 6455 §4.1 a client MUST fail the connection if the server returns
 * a subprotocol it did not request; Node ≥ 22 (undici) enforces this strictly, so the
 * default bakes the correct value in. Override `WebSocketClientTransportOptions.protocols`
 * only when connecting to a foreign server that speaks a different subprotocol (or `[]`
 * for no subprotocol negotiation at all).
 */
export const MCP_WEBSOCKET_SUBPROTOCOL = 'mcp'
