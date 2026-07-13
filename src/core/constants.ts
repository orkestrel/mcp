// MCP protocol revisions + the reserved JSON-RPC 2.0 error codes. The negotiated
// protocol version is the current rev unless the client requests a SUPPORTED prior
// one (see `initializeResult` in ./helpers.js). Transport-level header names
// (session / version headers) belong to the HTTP transport sub-chunk, NOT here.

/** The MCP protocol revision this server implements (the default negotiated version). */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

/**
 * The MCP protocol revisions this server can negotiate — the current
 * {@link MCP_PROTOCOL_VERSION} plus a prior rev a client may still request.
 *
 * @remarks
 * `initialize` echoes the client's requested `protocolVersion` when it appears in
 * this list, else falls back to {@link MCP_PROTOCOL_VERSION}. Frozen so the list is
 * an immutable contract.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = Object.freeze([
	'2025-06-18',
	'2025-03-26',
])

/** JSON-RPC 2.0 reserved error: invalid JSON was received (the message did not parse). */
export const JSONRPC_PARSE_ERROR = -32700

/** JSON-RPC 2.0 reserved error: the payload was not a valid Request object. */
export const JSONRPC_INVALID_REQUEST = -32600

/** JSON-RPC 2.0 reserved error: the requested method does not exist. */
export const JSONRPC_METHOD_NOT_FOUND = -32601

/** JSON-RPC 2.0 reserved error: the method's parameters were invalid. */
export const JSONRPC_INVALID_PARAMS = -32602

/** JSON-RPC 2.0 implementation-defined server error (the `-32000` to `-32099` range). */
export const JSONRPC_SERVER_ERROR = -32000

// MCP CLIENT defaults — the identity an `MCPClient` reports in the `initialize`
// handshake (`clientInfo`) and the per-request deadline, when the caller supplies
// none. The egress mirror of the server's protocol-version constants above.

/** The default client name reported in the MCP `initialize` handshake (`clientInfo.name`). */
export const DEFAULT_MCP_CLIENT_NAME = 'taverna'

/** The default client version reported in the MCP `initialize` handshake (`clientInfo.version`). */
export const DEFAULT_MCP_CLIENT_VERSION = '1.0.0'

/**
 * The default per-request deadline (ms) an `MCPClient` applies when `options.timeout`
 * is unset — a request the remote server does not answer within it rejects.
 */
export const DEFAULT_MCP_REQUEST_TIMEOUT = 30_000
