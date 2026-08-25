import type { JSONRPCMessage, MCPEra, MCPModernVersion } from './types.js'
import { isMCPLegacyVersion, isMCPModernVersion, isModernRequest } from './validators.js'
import { isRecord, isString } from '@orkestrel/contract'
import { MCP_META_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from './constants.js'

/**
 * Infers the wire era for an MCP protocol revision.
 *
 * @remarks
 * The era is READ from the two era guards rather than restated here, so a revision added
 * to {@link SUPPORTED_PROTOCOL_VERSIONS} or {@link SUPPORTED_LEGACY_PROTOCOL_VERSIONS}
 * carries its era with it and no third list can disagree with those two.
 *
 * @param version - The protocol revision to classify
 * @returns `'modern'` for a revision a bare server accepts, `'legacy'` for a revision the
 * optional decorator accepts, or `undefined` when the revision is unsupported
 */
export function inferEra(version: string): MCPEra | undefined {
	if (isMCPModernVersion(version)) return 'modern'
	if (isMCPLegacyVersion(version)) return 'legacy'
	return undefined
}

/**
 * Infers the newest supported modern protocol revision present in a peer's offer.
 *
 * @param offered - The protocol revisions offered by the peer
 * @returns The newest locally supported modern revision, or `undefined`
 */
export function inferVersion(offered: readonly string[]): MCPModernVersion | undefined {
	for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
		if (offered.includes(version)) return version
	}
	return undefined
}

/**
 * Infers the protocol version an outbound message announces itself with — the ONE
 * projection every HTTP client transport stamps `mcp-protocol-version` from.
 *
 * @remarks
 * This is deliberately the SAME read the server's own expectation performs
 * ({@link import('@orkestrel/mcp/server').inferHeaderIssue}): a modern request's reserved
 * `_meta` version, accepted whenever it is a string. It is NOT
 * {@link import('./parsers.js').parseRequestContext}, and the difference is the whole
 * point. That parser answers a different question — is the modern metadata WELL FORMED —
 * and refuses a request whose capability declaration or logging level is malformed. Such a
 * request is still modern (era is fixed by key presence) and the server still demands the
 * header for it, so projecting through the parser withholds a header the peer requires and
 * earns `-32602` instead of the `-32602` the malformed metadata itself deserves.
 *
 * A non-modern message projects nothing: a legacy request's version comes from the
 * `initialize` handshake the transport captured, not from the message.
 *
 * Header NAMES stay with the transports that own the wire (see `constants.ts`); core owns
 * the value this projection derives, which is the part the browser and Node faces disagreed about.
 *
 * @param message - The outbound message about to be written
 * @returns The version to announce, or `undefined` when the message announces none
 *
 * @example
 * ```ts
 * inferRequestVersion({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } })
 * ```
 */
export function inferRequestVersion(message: JSONRPCMessage): string | undefined {
	if (!isModernRequest(message)) return undefined
	const metadata = isRecord(message.params?.['_meta']) ? message.params['_meta'] : undefined
	const version = metadata?.[MCP_META_VERSION]
	return isString(version) ? version : undefined
}
