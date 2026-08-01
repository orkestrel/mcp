import type { JSONRPCMessage, MCPInputState, MCPRequestContext } from './types.js'
import { isNumber, isRecord, isString, isUndefined } from '@orkestrel/contract'
import { MCP_META_CAPABILITIES, MCP_META_CLIENT, MCP_META_VERSION } from './constants.js'
import { isJSONRPCMessage, isModernRequest } from './validators.js'

/**
 * Narrow an already-parsed value to a {@link JSONRPCMessage}, or `undefined` when
 * it is not one.
 *
 * @remarks
 * Total (§14) — a non-message returns `undefined`, never throws. The input must
 * ALREADY be `JSON.parse`d: the raw-string parse (which can throw on malformed
 * JSON) happens in `MCPServer.handle` inside a try/catch that maps a parse failure
 * to a `-32700` response. Sound with {@link isJSONRPCMessage}: a guard-valid input
 * is returned unchanged, and every non-`undefined` output satisfies the guard.
 *
 * @param value - The already-parsed value to narrow
 * @returns The value as a {@link JSONRPCMessage}, or `undefined`
 *
 * @example
 * ```ts
 * parseJSONRPCMessage({ jsonrpc: '2.0', method: 'ping', id: 1 }) // the request
 * parseJSONRPCMessage({ method: 'ping' }) // undefined — missing jsonrpc
 * ```
 */
export function parseJSONRPCMessage(value: unknown): JSONRPCMessage | undefined {
	return isJSONRPCMessage(value) ? value : undefined
}

/**
 * Parse the reserved modern request metadata into an {@link MCPRequestContext}.
 *
 * @remarks
 * This is the validity step after {@link isModernRequest}: a defined result can
 * only come from a guard-positive request, while a guard-positive request returns
 * `undefined` exactly when its required modern metadata is malformed. The version
 * must be a string but need not be supported; unsupported strings belong to the
 * dedicated protocol-version error path. Client identity is optional, but when
 * present it must carry string `name` and `version` members. Total over hostile and
 * malformed input.
 *
 * @param value - The already-parsed request candidate to coerce
 * @returns The validated modern request context, or `undefined`
 */
export function parseRequestContext(value: unknown): MCPRequestContext | undefined {
	try {
		if (!isModernRequest(value)) return undefined
		const metadata = value.params?.['_meta']
		if (!isRecord(metadata)) return undefined
		const version = metadata[MCP_META_VERSION]
		const capabilities = metadata[MCP_META_CAPABILITIES]
		if (!isString(version) || !isRecord(capabilities)) return undefined
		const client = metadata[MCP_META_CLIENT]
		if (client === undefined) return { version, capabilities }
		if (!isRecord(client)) return undefined
		const name = client['name']
		const clientVersion = client['version']
		if (!isString(name) || !isString(clientVersion)) return undefined
		return {
			version,
			capabilities,
			identity: { name, version: clientVersion },
		}
	} catch {
		return undefined
	}
}

/**
 * Parse the verified value embedded in an opaque signed `requestState` token.
 *
 * @remarks
 * This parser does not verify the HMAC; {@link import('@orkestrel/server').verifyToken}
 * performs that boundary first and returns the JSON string parsed here. The protected
 * payload binds the authenticated principal, token lifetime, originating request id,
 * server-assigned input key, tool name, and optional consumer state. Total over malformed
 * or hostile input.
 *
 * @param value - The HMAC-verified token value to parse
 * @returns The protected input state, or `undefined` when malformed
 *
 * @example
 * ```ts
 * parseMCPInputState('{"principal":"user-1","ttl":1000,"origin":1,"key":"k","name":"reply"}')
 * // { principal: 'user-1', ttl: 1000, origin: 1, key: 'k', name: 'reply' }
 * ```
 */
export function parseMCPInputState(value: unknown): MCPInputState | undefined {
	try {
		if (!isString(value)) return undefined
		const parsed: unknown = JSON.parse(value)
		if (!isRecord(parsed)) return undefined
		const principal = parsed['principal']
		const ttl = parsed['ttl']
		const origin = parsed['origin']
		const key = parsed['key']
		const name = parsed['name']
		const state = parsed['state']
		if (!isString(principal) || !isNumber(ttl) || !Number.isFinite(ttl)) return undefined
		if (!isString(origin) && !isNumber(origin)) return undefined
		if (!isString(key) || !isString(name)) return undefined
		if (!isUndefined(state) && !isString(state)) return undefined
		return {
			principal,
			ttl,
			origin,
			key,
			name,
			...(isString(state) ? { state } : {}),
		}
	} catch {
		return undefined
	}
}
