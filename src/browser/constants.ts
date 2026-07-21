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
