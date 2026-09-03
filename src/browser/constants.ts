// The MCP browser-transport constants — the server-identity defaults the browser-face
// bootstrap falls back to. The Streamable-HTTP wire headers and the WebSocket subprotocol
// live in `@src/core` beside the transports that write them.

// Scope-server identity defaults — `src/core`'s `createMCPServer` REQUIRES
// `name`/`version`, but `ScopeServerOptions` (this face's bootstrap) makes them optional
// (mirroring the CLIENT identity defaults, `DEFAULT_MCP_CLIENT_NAME` /
// `DEFAULT_MCP_CLIENT_VERSION`, `src/core/constants.ts`), so `createScopeServer` falls
// back to these when a caller omits them.

/** Supplies the default server name `createScopeServer` reports (`initialize`'s `serverInfo.name`) when `options.name` is omitted. */
export const DEFAULT_MCP_SERVER_NAME = '@orkestrel/mcp'

/** Supplies the default server version `createScopeServer` reports (`initialize`'s `serverInfo.version`) when `options.version` is omitted. */
export const DEFAULT_MCP_SERVER_VERSION = '1.0.0'
