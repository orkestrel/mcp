import type {
	JSONRPCInvocation,
	JSONRPCResponse,
	MCPEra,
	MCPLegacyVersion,
	MCPVersion,
} from '@src/core'
import type { MCPHeaderIssue } from './types.js'
import {
	JSONRPC_INVALID_PARAMS,
	JSONRPC_METHOD_NOT_FOUND,
	MCP_HEADER_MISMATCH,
	MCP_META_VERSION,
	MCP_MISSING_CAPABILITY,
	MCP_HANDSHAKE_VERSION,
	MCP_UNSUPPORTED_VERSION,
	isInitializeRequest,
	isMCPLegacyVersion,
	isModernRequest,
} from '@src/core'
import { isRecord, isString } from '@orkestrel/contract'
import { MCP_METHOD_HEADER, MCP_NAME_HEADER, MCP_PROTOCOL_VERSION_HEADER } from './constants.js'

/**
 * Infers the first required MCP HTTP header that is missing or mismatched.
 *
 * @remarks
 * A modern request derives its protocol, method, and tools/call-only name expectations from
 * the JSON-RPC body. A legacy request body requires a protocol header after initialization,
 * while a supplied legacy session version additionally diagnoses a header that disagrees with
 * the active session. Messages name the expected value but never echo the client-supplied one.
 *
 * @param request - The HTTP request carrying the headers
 * @param reference - The parsed invocation body, or the active legacy session version
 * @returns The first header issue, or `undefined` when the applicable headers agree
 *
 * @example
 * ```ts
 * const issue = inferHeaderIssue(request, rpcRequest)
 * issue?.header // 'Mcp-Method' when that field is absent or mismatched
 * ```
 */
export function inferHeaderIssue(
	request: Request,
	reference: JSONRPCInvocation | MCPVersion,
): MCPHeaderIssue | undefined {
	const protocol = request.headers.get(MCP_PROTOCOL_VERSION_HEADER)
	if (isString(reference)) {
		if (protocol === null) {
			return {
				header: 'MCP-Protocol-Version',
				reason: 'missing',
				message: `Required MCP-Protocol-Version header is missing; the active session uses '${reference}'.`,
			}
		}
		if (protocol !== reference) {
			return {
				header: 'MCP-Protocol-Version',
				reason: 'mismatched',
				message: `MCP-Protocol-Version header does not match the active session version '${reference}'.`,
			}
		}
		return undefined
	}
	if (!isModernRequest(reference)) {
		if (isInitializeRequest(reference) || protocol !== null) return undefined
		return {
			header: 'MCP-Protocol-Version',
			reason: 'missing',
			message: `Required MCP-Protocol-Version header is missing; this server offers '${MCP_HANDSHAKE_VERSION}'.`,
		}
	}
	const message = reference
	const metadata = isRecord(message.params?.['_meta']) ? message.params['_meta'] : undefined
	const version = metadata?.[MCP_META_VERSION]
	if (!isString(version)) return undefined
	if (protocol === null) {
		return {
			header: 'MCP-Protocol-Version',
			reason: 'missing',
			message: `Required MCP-Protocol-Version header is missing; the request body version is '${version}'.`,
		}
	}
	if (protocol !== version) {
		return {
			header: 'MCP-Protocol-Version',
			reason: 'mismatched',
			message: `MCP-Protocol-Version header does not match the request body version '${version}'.`,
		}
	}
	const method = request.headers.get(MCP_METHOD_HEADER)
	if (method === null) {
		return {
			header: 'Mcp-Method',
			reason: 'missing',
			message: `Required Mcp-Method header is missing; the request body method is '${message.method}'.`,
		}
	}
	if (method !== message.method) {
		return {
			header: 'Mcp-Method',
			reason: 'mismatched',
			message: `Mcp-Method header does not match the request body method '${message.method}'.`,
		}
	}
	if (message.method !== 'tools/call') return undefined
	const name = message.params?.['name']
	if (!isString(name)) return undefined
	const header = request.headers.get(MCP_NAME_HEADER)
	if (header === null) {
		return {
			header: 'Mcp-Name',
			reason: 'missing',
			message: `Required Mcp-Name header is missing; the request body tool name is '${name}'.`,
		}
	}
	if (header !== name) {
		return {
			header: 'Mcp-Name',
			reason: 'mismatched',
			message: `Mcp-Name header does not match the request body tool name '${name}'.`,
		}
	}
	return undefined
}

/**
 * Infers the legacy revision an `initialize` request negotiates.
 *
 * @remarks
 * A supported legacy request is pinned exactly. A modern, malformed, absent, or unsupported
 * request selects the newest supported legacy revision. The read is deliberately the SAME one
 * {@link import('@orkestrel/mcp').buildInitializeResult} performs — `isMCPLegacyVersion` over
 * the requested revision — because the session version this pins and the version that result
 * echoes must be the one value. Routing through `inferVersion` cannot do it: that inferer is
 * modern-only, so it answers `undefined` for every legacy offer and the session would pin
 * `2025-11-25` while the handshake echoed `2025-06-18`, which the client's own protocol
 * header then contradicts.
 *
 * @param request - The legacy initialize invocation
 * @returns The negotiated legacy protocol revision
 */
export function inferLegacyVersion(request: JSONRPCInvocation): MCPLegacyVersion {
	const requested = request.params?.['protocolVersion']
	return isMCPLegacyVersion(requested) ? requested : MCP_HANDSHAKE_VERSION
}

/**
 * Infers the HTTP status for one MCP dispatch outcome without changing its JSON-RPC body.
 *
 * @remarks
 * Notifications are accepted with `202`. Legacy response envelopes retain uniform `200`
 * status semantics, including in-band errors. Modern header/capability/version/parameter
 * failures map to `400`, method-not-found maps to `404`, and every other modern result maps
 * to `200`.
 *
 * @param response - The dispatch response, or `undefined` for a notification
 * @param era - The structurally selected request era
 * @returns The HTTP response status
 */
export function inferStatus(response: JSONRPCResponse | undefined, era: MCPEra): number {
	if (response === undefined) return 202
	if (era === 'legacy' || response.error === undefined) return 200
	if (response.error.code === JSONRPC_METHOD_NOT_FOUND) return 404
	if (
		response.error.code === MCP_HEADER_MISMATCH ||
		response.error.code === MCP_MISSING_CAPABILITY ||
		response.error.code === MCP_UNSUPPORTED_VERSION ||
		response.error.code === JSONRPC_INVALID_PARAMS
	) {
		return 400
	}
	return 200
}
