import type { MCPEra } from './types.js'

/**
 * Infer the wire era for an MCP protocol revision.
 *
 * @param version - The protocol revision to classify
 * @returns `'modern'` for `2026-07-28`, `'legacy'` for either supported legacy
 * revision, or `undefined` when the revision is unsupported
 */
export function inferEra(version: string): MCPEra | undefined {
	switch (version) {
		case '2026-07-28':
			return 'modern'
		case '2025-11-25':
		case '2025-06-18':
			return 'legacy'
		default:
			return undefined
	}
}
