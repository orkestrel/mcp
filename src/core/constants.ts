import type { MCPLegacyVersion, MCPModernVersion, MCPVersion } from './types.js'

// MCP protocol revisions, reserved modern `_meta` keys, and protocol error codes.
// Transport-level header names (session / version headers) belong to the HTTP
// transport, not core.

/**
 * Names the revision offered and defaulted to in the legacy `initialize` handshake.
 *
 * @remarks
 * This is deliberately a legacy revision, and the newest one supported. 2026-07-28 is stateless
 * and defines no `initialize`, so it can never be the handshake's version — a client that offers
 * it is asking to negotiate a revision with no negotiation.
 */
export const MCP_HANDSHAKE_VERSION: MCPLegacyVersion = '2025-11-25'

/** Names the older legacy revision the optional legacy decorator accepts and an adapter can pin. */
export const MCP_FALLBACK_VERSION: MCPLegacyVersion = '2025-06-18'

/** Names the modern revision offered by an unpinned client during discovery. */
export const MCP_MODERN_VERSION: MCPModernVersion = '2026-07-28'

/**
 * Lists the modern MCP protocol revisions a bare server accepts and advertises.
 *
 * @remarks
 * Frozen in discovery-advertisement order. Legacy revisions are absent because
 * only {@link SUPPORTED_LEGACY_PROTOCOL_VERSIONS} and the optional legacy
 * decorator own them.
 */
export const SUPPORTED_MODERN_PROTOCOL_VERSIONS: readonly MCPModernVersion[] = Object.freeze([
	MCP_MODERN_VERSION,
])

/** Lists the protocol revisions accepted by the optional legacy decorator. */
export const SUPPORTED_LEGACY_PROTOCOL_VERSIONS: readonly MCPLegacyVersion[] = Object.freeze([
	MCP_HANDSHAKE_VERSION,
	MCP_FALLBACK_VERSION,
])

/**
 * Lists the protocol revisions the `isMCPVersion` guard admits, spanning the modern and legacy
 * eras.
 */
export const SUPPORTED_MCP_VERSIONS: readonly MCPVersion[] = Object.freeze([
	...SUPPORTED_MODERN_PROTOCOL_VERSIONS,
	...SUPPORTED_LEGACY_PROTOCOL_VERSIONS,
])

/** Names the reserved modern `_meta` key carrying the request's protocol revision. */
export const MCP_META_VERSION = 'io.modelcontextprotocol/protocolVersion'

/** Names the reserved modern `_meta` key carrying the client's open capability record. */
export const MCP_META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'

/** Names the reserved modern `_meta` key carrying the optional client identity. */
export const MCP_META_CLIENT = 'io.modelcontextprotocol/clientInfo'

/** Names the reserved modern `_meta` key carrying the server identity on results. */
export const MCP_META_SERVER = 'io.modelcontextprotocol/serverInfo'

/** Names the reserved modern `_meta` key carrying a `subscriptions/listen` request id. */
export const MCP_META_SUBSCRIPTION = 'io.modelcontextprotocol/subscriptionId'

/**
 * Names the reserved extension key identifying the stable Tasks extension.
 *
 * @remarks
 * The ONE spelling of it in this package, and the identity of the immutable snapshot dated
 * 2026-07-28 this package implements. A client declares it per REQUEST, under
 * `_meta['io.modelcontextprotocol/clientCapabilities'].extensions`; a server advertises it
 * under `server/discover`'s `capabilities.extensions`. Both sides carry an empty object —
 * the extension defines no options, so presence is the entire declaration.
 */
export const MCP_EXTENSION_TASKS = 'io.modelcontextprotocol/tasks'

/**
 * Names the opening marker of the Base64 sentinel a standard MCP header value travels in.
 *
 * @remarks
 * The markers are LOWERCASE and exact, and this constant with {@link MCP_SENTINEL_SUFFIX} is
 * their ONE spelling in this package: {@link import('@orkestrel/mcp').encodeSentinel} builds a
 * sentinel from them and {@link import('@orkestrel/mcp').decodeSentinel} recognizes one by
 * them, so the two directions cannot drift apart.
 */
export const MCP_SENTINEL_PREFIX = '=?base64?'

/** Names the closing marker of the Base64 sentinel a standard MCP header value travels in. */
export const MCP_SENTINEL_SUFFIX = '?='

/**
 * Names the request-header prefix an `x-mcp-header` annotation projects a tool argument onto.
 *
 * @remarks
 * The full field name is this prefix followed by the annotation's own value verbatim, so
 * `x-mcp-header: 'Region'` becomes `Mcp-Param-Region`. HTTP field names are case-insensitive,
 * which is why {@link MCP_HEADER_ANNOTATION} values are unique case-insensitively within one
 * `inputSchema`.
 */
export const MCP_PARAM_PREFIX = 'Mcp-Param-'

// The Streamable-HTTP wire headers — the field names the HTTP client transport stamps and
// the server face reads back. They live here because the transport that writes them and the
// route layer that validates them are one wire contract, and a copy per environment face is
// the drift the two faces already carried.

/**
 * Names the Streamable-HTTP transport header that carries the MCP session id.
 *
 * @remarks
 * A STATEFUL server sends it on the `initialize` reply, and
 * {@link import('./transports/HTTPClientTransport.js').HTTPClientTransport} echoes it as a
 * request header on every subsequent request, so a client passes that server's session
 * validation unchanged.
 */
export const MCP_SESSION_HEADER = 'mcp-session-id'

/**
 * Names the Streamable-HTTP transport header carrying the MCP protocol version.
 *
 * @remarks
 * A modern request derives it from its own `_meta`; a legacy request echoes the revision the
 * `initialize` result negotiated on each subsequent request.
 */
export const MCP_PROTOCOL_VERSION_HEADER = 'mcp-protocol-version'

/**
 * Names the modern Streamable-HTTP request header carrying the JSON-RPC method.
 *
 * @remarks
 * It is stamped on every modern request and on no legacy request.
 */
export const MCP_METHOD_HEADER = 'mcp-method'

/**
 * Names the modern Streamable-HTTP request header carrying a named target.
 *
 * @remarks
 * The HTTP client transport stamps it only for `tools/call`, from that request's `params.name`,
 * in the Base64 sentinel form whenever the name cannot ride as plain ASCII.
 */
export const MCP_NAME_HEADER = 'mcp-name'

/**
 * Identifies the tool-schema annotation key naming the header one parameter projects into.
 *
 * @remarks
 * It is valid ONLY on a primitive property schema statically reachable from the `inputSchema`
 * root through `properties` keys alone. An occurrence anywhere else — under `items`, a
 * composition or conditional keyword, or a `$ref` target — makes the whole tool definition
 * invalid, which is what {@link import('@orkestrel/mcp').buildHeaderParameters} decides.
 */
export const MCP_HEADER_ANNOTATION = 'x-mcp-header'

/**
 * Bounds the `tools/list` pages one modern `tools/call` walks to reach its own annotations.
 *
 * @remarks
 * The HTTP POST handler reads a called tool's {@link MCP_HEADER_ANNOTATION} annotations by
 * dispatching `tools/list` fresh on every `tools/call`, following `nextCursor` until the
 * named tool is found or the answer carries no cursor. The walk is bounded because its cost
 * is paid per call: at a page size of 100 this bound reaches 800 definitions, and a consumer
 * whose replacement `tools/list` pages more finely than that pays the extra dispatches on
 * every call it serves. The built-in listing answers the whole registry on one page and
 * never reaches the second. A definition further in than the walk reaches reads as no
 * definition, so its {@link MCP_PARAM_PREFIX} headers are forwarded untouched — the same
 * answer a name no served definition annotates receives.
 */
export const MCP_LOOKUP_PAGES = 8

/** Names the MCP reserved error for required HTTP metadata that does not match the request body. */
export const MCP_HEADER_MISMATCH = -32020

/**
 * Names the MCP reserved error for an operation needing a client capability that was not
 * declared.
 *
 * @remarks
 * The GENERIC code for the whole condition, not one capability's code. This server answers
 * it in more than one place — a `tools/call` that needs `elicitation`, and a `tasks/*` request
 * whose client never declared `io.modelcontextprotocol/tasks` — and they are told apart by
 * `error.data.requiredCapabilities` alone (`{ elicitation: {} }` against
 * `{ extensions: { 'io.modelcontextprotocol/tasks': {} } }`). They are instances of the same
 * condition, so a separate numeral would describe the same fact twice. The Tasks extension's
 * own prose examples show `-32003`; the dated core schema fixes this code, and the dated
 * schema is what a peer implements against.
 */
export const MCP_MISSING_CAPABILITY = -32021

/** Names the MCP reserved error for a request naming an unsupported protocol revision. */
export const MCP_UNSUPPORTED_VERSION = -32022

/**
 * Sets the default modern result freshness lifetime in milliseconds.
 *
 * @remarks
 * `ttlMs` is required on cacheable results, while zero means immediately stale
 * rather than uncached, so the neutral usable default is one minute.
 */
export const DEFAULT_MCP_CACHE_TTL = 60_000

/**
 * Sets the secure server bounds used when the matching `limit` option leaf is absent or
 * malformed.
 *
 * @remarks
 * One MiB admits ordinary JSON-RPC requests and substantial tool arguments; 16 KiB admits
 * extension-rich modern metadata and signed multi-round state; four MiB admits substantial
 * JSON tool output without allowing an unconfigured service to serialize arbitrary process
 * memory; 64 keys admits `_meta`'s reserved keys plus many extensions, and bounds a produced
 * result's breadth by the same leaf; 128 concurrent streams admits a busy service while
 * bounding retained producers; depth 32 admits ordinary JSON documents while rejecting
 * stack-hostile nesting. Frozen so callers cannot alter the defaults observed by later
 * servers.
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

/**
 * Holds the one empty argument record every argument-less modern `tools/call` runs with.
 *
 * @remarks
 * Frozen and null-prototype, and SHARED: two calls that name no `arguments` receive the same
 * reference, so nothing a tool writes into its own `arguments` can survive into the next
 * call — the write fails instead. That failure is a tool-domain failure like any other: the
 * registry isolates it into a `success: false` result, which reaches the peer as an
 * `isError: true` tool result rather than as a protocol error, because refusing a mutation
 * of server-owned input is not a protocol fault.
 *
 * The null prototype means an inherited key is never mistaken for a supplied argument:
 * `arguments.constructor` is `undefined` here rather than a function.
 */
export const EMPTY_MCP_ARGUMENTS: Readonly<Record<string, unknown>> = Object.freeze(
	Object.create(null),
)

/** Names the JSON-RPC 2.0 reserved error for invalid JSON received (the message did not parse). */
export const JSONRPC_PARSE_ERROR = -32700

/** Names the JSON-RPC 2.0 reserved error for a payload that was not a valid Request object. */
export const JSONRPC_INVALID_REQUEST = -32600

/** Names the JSON-RPC 2.0 reserved error for a requested method that does not exist. */
export const JSONRPC_METHOD_NOT_FOUND = -32601

/** Names the JSON-RPC 2.0 reserved error for a method's invalid parameters. */
export const JSONRPC_INVALID_PARAMS = -32602

/**
 * Names the JSON-RPC 2.0 reserved error for a server that failed while handling an otherwise
 * valid request.
 *
 * @remarks
 * The code every MODERN internal fault answers with — a provider, handler, continuation,
 * capacity, stream-source, normalization, or serialization failure the server contained.
 * It is detail-free on the wire: the caught value reaches the application through the
 * server's `error` event and never through the response.
 */
export const JSONRPC_INTERNAL_ERROR = -32603

/**
 * Names the JSON-RPC 2.0 implementation-defined server error (the `-32000` to `-32099` range).
 *
 * @remarks
 * Retained for the LEGACY branch alone. A modern fault answers
 * {@link JSONRPC_INTERNAL_ERROR}; this code survives only where an old-wire peer was
 * already characterized against it.
 */
export const JSONRPC_SERVER_ERROR = -32000

// MCP CLIENT defaults — the identity an `MCPClient` reports in the `initialize`
// handshake (`clientInfo`) and the per-request deadline, when the caller supplies
// none. The egress mirror of the server's protocol-version constants above.

/**
 * Supplies the default client name reported in the MCP `initialize` handshake
 * (`clientInfo.name`).
 */
export const DEFAULT_MCP_CLIENT_NAME = '@orkestrel/mcp'

/**
 * Supplies the default client version reported in the MCP `initialize` handshake
 * (`clientInfo.version`).
 */
export const DEFAULT_MCP_CLIENT_VERSION = '1.0.0'

/**
 * Sets the default per-request deadline (ms) an `MCPClient` applies when `options.timeout`
 * is unset — a request the remote server does not answer within it rejects.
 */
export const DEFAULT_MCP_REQUEST_TIMEOUT = 30_000

/** Sets the default number of subscription frames retained while no client read is parked. */
export const DEFAULT_MCP_SUBSCRIPTION_CAPACITY = 64
