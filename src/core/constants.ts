import type { MCPVersion } from './types.js'

// MCP protocol revisions, reserved modern `_meta` keys, and protocol error codes.
// Transport-level header names (session / version headers) belong to the HTTP
// transport, not core.

/**
 * The revision offered and defaulted to in the legacy `initialize` handshake.
 *
 * @remarks
 * This is deliberately a legacy revision, and the newest one supported. 2026-07-28 is stateless
 * and defines no `initialize`, so it can never be the handshake's version — a client that offers
 * it is asking to negotiate a revision with no negotiation.
 */
export const MCP_PROTOCOL_VERSION: MCPVersion = '2025-11-25'

/** The legacy fallback anchor used when an initialize request cannot be accepted as modern. */
export const MCP_LEGACY_VERSION: MCPVersion = '2025-06-18'

/** The modern revision offered by an unpinned client during discovery. */
export const MCP_MODERN_VERSION: MCPVersion = '2026-07-28'

/**
 * The MCP protocol revisions this server can negotiate.
 *
 * @remarks
 * `initialize` echoes the client's requested `protocolVersion` when it appears in
 * this list. Frozen in client-preference and discovery-advertisement order. The
 * package does not advertise `2025-03-26` because that revision mandates JSON-RPC
 * batching, while this package accepts only individual JSON-RPC messages.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly MCPVersion[] = Object.freeze([
	'2026-07-28',
	'2025-11-25',
	'2025-06-18',
])

/** Reserved modern `_meta` key carrying the request's protocol revision. */
export const MCP_META_VERSION = 'io.modelcontextprotocol/protocolVersion'

/** Reserved modern `_meta` key carrying the client's open capability record. */
export const MCP_META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'

/** Reserved modern `_meta` key carrying the optional client identity. */
export const MCP_META_CLIENT = 'io.modelcontextprotocol/clientInfo'

/** Reserved modern `_meta` key carrying the server identity on results. */
export const MCP_META_SERVER = 'io.modelcontextprotocol/serverInfo'

/** Reserved modern `_meta` key carrying a `subscriptions/listen` request id. */
export const MCP_META_SUBSCRIPTION = 'io.modelcontextprotocol/subscriptionId'

/** MCP reserved error: required HTTP metadata does not match the request body. */
export const MCP_HEADER_MISMATCH = -32020

/** MCP reserved error: an operation needs a client capability that was not declared. */
export const MCP_MISSING_CAPABILITY = -32021

/** MCP reserved error: a request names an unsupported protocol revision. */
export const MCP_UNSUPPORTED_VERSION = -32022

/**
 * Default modern result freshness lifetime in milliseconds.
 *
 * @remarks
 * `ttlMs` is required on cacheable results, while zero means immediately stale
 * rather than uncached, so the neutral usable default is one minute.
 */
export const DEFAULT_MCP_CACHE_TTL = 60_000

/**
 * Secure server bounds used when the matching `limit` option leaf is absent or malformed.
 *
 * @remarks
 * One MiB admits ordinary JSON-RPC requests and substantial tool arguments; 16 KiB admits
 * extension-rich modern metadata and signed multi-round state; four MiB admits substantial
 * JSON tool output without allowing an unconfigured service to serialize arbitrary process
 * memory; 64 metadata keys admits the reserved keys plus many extensions; 128 concurrent
 * streams admits a busy service while bounding retained producers; depth 32 admits ordinary
 * JSON documents while rejecting stack-hostile nesting. Frozen so callers cannot alter the
 * defaults observed by later servers.
 */
export const DEFAULT_MCP_LIMITS = Object.freeze({
	message: 1_048_576,
	metadata: 16_384,
	keys: 64,
	state: 16_384,
	content: 4_194_304,
	subscriptions: 128,
	depth: 32,
})

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

/** The maximum discovery-probe deadline used when a client deadline is configured. */
export const DEFAULT_MCP_PROBE_TIMEOUT = 50
