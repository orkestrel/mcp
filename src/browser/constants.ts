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
