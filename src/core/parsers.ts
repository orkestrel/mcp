import type {
	JSONRPCMessage,
	MCPInputState,
	MCPJSONLimitOptions,
	MCPRequestContext,
} from './types.js'
import {
	isInteger,
	isJSONValue,
	isNumber,
	isRecord,
	isString,
	isUndefined,
} from '@orkestrel/contract'
import { snapshotJSON } from './cloners.js'
import {
	DEFAULT_MCP_LIMITS,
	MCP_META_CAPABILITIES,
	MCP_META_CLIENT,
	MCP_META_VERSION,
} from './constants.js'
import {
	isJSONRPCId,
	isJSONRPCMessage,
	isMCPClientCapabilities,
	isMCPElicitSchema,
	isMCPIdentity,
	isMCPLoggingLevel,
	isMCPMetaObject,
	isModernRequest,
} from './validators.js'

/**
 * Narrows an already-parsed value to a {@link JSONRPCMessage}, or `undefined` when
 * it is not one.
 *
 * @remarks
 * Total — a non-message returns `undefined`, never throws. The input must
 * ALREADY be `JSON.parse`d: the raw-string parse (which can throw on malformed
 * JSON) happens in `MCPServer.handle` inside a try/catch that maps a parse failure
 * to a `-32700` response.
 *
 * A defined result is an OWNED CANONICAL SNAPSHOT, never the input reference: it is
 * rebuilt from the canonical text and deeply frozen, so `-0` arrives as `0`. Every record
 * was SERIALIZED with its keys sorted, but the rebuilt object enumerates its own keys the
 * way JavaScript does, so an integer-like `'9'` still precedes `'10'`: the result's key
 * order is neither promised nor generally the canonical one. A caller who needs canonical
 * BYTES takes them from `serializeJSON`/`snapshotJSON` rather than re-stringifying this
 * result. Identity is not preserved and is not promised.
 *
 * The parser's sound partner is the COMPOSITE `isJSONRPCMessage(value) &&
 * isBoundedJSON(value, limits)`, and against it both halves of the soundness law
 * hold by construction:
 *
 * - Every non-`undefined` result satisfies {@link isJSONRPCMessage}, because the guard
 *   is applied to the exact frozen reference returned.
 * - Every input satisfying the composite is admitted rather than rejected, because
 *   `isBoundedJSON` is this parser's own admission test — the same canonical
 *   serializer under the same `limits` — so the two cannot disagree about the bound.
 *
 * {@link isJSONRPCMessage} ALONE is not that partner. It is clone-backed and so already
 * exact about shape, but it carries no size or depth bound — so guard-valid values
 * exist that this parser rejects: a message nested deeper than `limits.depth`, and one
 * whose canonical text exceeds `limits.bytes`. Those are named causes, NOT a complete
 * boundary. Among values `isJSONRPCMessage` already admits, the admitted set is exactly
 * what canonical serialization accepts under `limits`, so a caller who needs that line
 * tests it with `isBoundedJSON` rather than inferring it from this list.
 *
 * @param value - The already-parsed value to narrow
 * @param limits - Canonical byte and nesting-depth bounds; defaults to the MCP content
 *   and depth limits, which impose no key-count cap unless the caller supplies one
 * @returns The value as a {@link JSONRPCMessage}, or `undefined`
 *
 * @example
 * ```ts
 * parseJSONRPCMessage({ jsonrpc: '2.0', method: 'ping', id: 1 }) // the request
 * parseJSONRPCMessage({ method: 'ping' }) // undefined — missing jsonrpc
 * ```
 */
export function parseJSONRPCMessage(
	value: unknown,
	limits: MCPJSONLimitOptions = {
		bytes: DEFAULT_MCP_LIMITS.content,
		depth: DEFAULT_MCP_LIMITS.depth,
	},
): JSONRPCMessage | undefined {
	const snapshot = snapshotJSON(value, limits)
	return snapshot !== undefined && isJSONRPCMessage(snapshot[0]) ? snapshot[0] : undefined
}

/**
 * Parses the reserved modern request metadata into an {@link MCPRequestContext}.
 *
 * @remarks
 * This is the validity step after {@link isModernRequest}: a defined result can
 * only come from a guard-positive request, while a guard-positive request returns
 * `undefined` when its required modern metadata is malformed — and also when the
 * request falls outside the bound this parser INHERITS by routing through
 * {@link parseJSONRPCMessage} under the same `limits`. The version
 * must be a string but need not be supported; unsupported strings belong to the
 * dedicated protocol-version error path. Client identity is optional, but when
 * present it must carry string `name` and `version` members. Total over hostile and
 * malformed input.
 *
 * @param value - The already-parsed request candidate to coerce
 * @param limits - Canonical byte and nesting-depth bounds, forwarded to
 *   {@link parseJSONRPCMessage}; defaults to the MCP content and depth limits
 * @returns The validated modern request context, or `undefined`
 */
export function parseRequestContext(
	value: unknown,
	limits: MCPJSONLimitOptions = {
		bytes: DEFAULT_MCP_LIMITS.content,
		depth: DEFAULT_MCP_LIMITS.depth,
	},
): MCPRequestContext | undefined {
	try {
		const request = parseJSONRPCMessage(value, limits)
		if (request === undefined || !('method' in request) || !isModernRequest(request))
			return undefined
		const metadata = request.params?.['_meta']
		if (!isMCPMetaObject(metadata)) return undefined
		const version = metadata[MCP_META_VERSION]
		const capabilities = metadata[MCP_META_CAPABILITIES]
		if (!isString(version) || !isMCPClientCapabilities(capabilities)) return undefined
		const level = metadata['io.modelcontextprotocol/logLevel']
		if (!isUndefined(level) && !isMCPLoggingLevel(level)) return undefined
		const progress = metadata['progressToken']
		if (!isUndefined(progress) && !isString(progress) && !isInteger(progress)) return undefined
		const client = metadata[MCP_META_CLIENT]
		if (client === undefined) return Object.freeze({ version, capabilities })
		if (!isMCPIdentity(client)) return undefined
		return Object.freeze({ version, capabilities, identity: client })
	} catch {
		return undefined
	}
}

/**
 * Parses the opened value carried by an opaque `requestState` continuation.
 *
 * @remarks
 * This parser does not open the opaque continuation carrier; the configured
 * continuation port performs that boundary first. The protected
 * payload binds the authenticated principal, absolute expiry, ORIGINAL request id, version,
 * method, server-assigned key, tool name, argument digest, the exact issued elicitation
 * schema, and optional application state. Every member is required except application state:
 * a payload missing its schema cannot have its accepted response enforced, so it is refused
 * rather than admitted unenforced. Total over malformed or hostile input.
 *
 * @param value - The opened canonical continuation value to parse
 * @returns The protected input state, or `undefined` when malformed
 *
 * @example
 * ```ts
 * parseMCPInputState('{"principal":"user-1","expiry":2000,"id":1,"version":"2026-07-28","method":"tools/call","key":"k","name":"reply","digest":"abc","schema":{"type":"object","properties":{}}}')
 * ```
 */
export function parseMCPInputState(value: unknown): MCPInputState | undefined {
	try {
		if (!isString(value)) return undefined
		const parsed: unknown = JSON.parse(value)
		if (!isRecord(parsed)) return undefined
		const principal = parsed['principal']
		const expiry = parsed['expiry']
		const id = parsed['id']
		const version = parsed['version']
		const method = parsed['method']
		const key = parsed['key']
		const name = parsed['name']
		const digest = parsed['digest']
		const schema = parsed['schema']
		const state = parsed['state']
		if (
			!isString(principal) ||
			principal.length === 0 ||
			!isNumber(expiry) ||
			!Number.isFinite(expiry)
		) {
			return undefined
		}
		if (!isJSONRPCId(id)) return undefined
		if (!isString(version) || !isString(method) || !isString(key) || !isString(name)) {
			return undefined
		}
		if (!isString(digest) || (!isUndefined(state) && !isJSONValue(state))) return undefined
		if (!isMCPElicitSchema(schema)) return undefined
		return {
			principal,
			expiry,
			id,
			version,
			method,
			key,
			name,
			digest,
			schema,
			...(isUndefined(state) ? {} : { state }),
		}
	} catch {
		return undefined
	}
}
