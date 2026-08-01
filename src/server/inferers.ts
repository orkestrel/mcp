import type { JSONRPCRequest, JSONRPCResponse, MCPEra, MCPVersion } from '@src/core'
import {
	JSONRPC_INVALID_PARAMS,
	JSONRPC_METHOD_NOT_FOUND,
	MCP_LEGACY_VERSION,
	MCP_HEADER_MISMATCH,
	MCP_MISSING_CAPABILITY,
	MCP_UNSUPPORTED_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
	inferEra,
	isMCPVersion,
} from '@src/core'

/**
 * Infer the legacy revision an `initialize` request negotiates.
 *
 * @remarks
 * A supported legacy request is pinned exactly. A modern, malformed, absent, or unsupported
 * request selects the newest supported legacy revision, matching the core initialize result.
 *
 * @param request - The legacy initialize request
 * @returns The negotiated legacy protocol revision
 */
export function inferLegacyVersion(request: JSONRPCRequest): MCPVersion {
	const requested = request.params?.['protocolVersion']
	if (isMCPVersion(requested) && inferEra(requested) === 'legacy') return requested
	for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
		if (isMCPVersion(version) && inferEra(version) === 'legacy') return version
	}
	return MCP_LEGACY_VERSION
}

/**
 * Infer the HTTP status for one MCP dispatch outcome without changing its JSON-RPC body.
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
