import type { ToolManagerInterface, ToolResult } from '../agents/types.js'
import type { JSONRPCResponse, MCPToolDescriptor, MCPToolResult } from './types.js'
import { MCP_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from './constants.js'

// Pure dispatch builders (AGENTS §5: the dispatch branches stay exported helpers,
// not hidden privates). Each turns a piece of MCP state into the JSON-RPC `result`
// payload (or a response envelope) the server returns — independently testable.

/**
 * Build a JSON-RPC success {@link JSONRPCResponse} — the `id` echoed, the method's
 * value as `result`.
 *
 * @param id - The request's id (`null` only for a parse / invalid-request error)
 * @param result - The method's return value
 * @returns The success response envelope
 */
export function jsonRPCResult(id: string | number | null, result: unknown): JSONRPCResponse {
	return { jsonrpc: '2.0', id, result }
}

/**
 * Build a JSON-RPC error {@link JSONRPCResponse} — the `id` echoed, the failure as
 * an `error` object.
 *
 * @param id - The request's id (`null` for a parse / invalid-request error)
 * @param code - One of the reserved JSON-RPC codes (see `./constants.js`)
 * @param message - A short human description of the failure
 * @param data - An OPTIONAL machine-readable payload (omitted from the envelope when absent)
 * @returns The error response envelope
 */
export function jsonRPCError(
	id: string | number | null,
	code: number,
	message: string,
	data?: unknown,
): JSONRPCResponse {
	return {
		jsonrpc: '2.0',
		id,
		error: data === undefined ? { code, message } : { code, message, data },
	}
}

/**
 * Map a {@link ToolManagerInterface}'s definitions to MCP `tools/list` descriptors
 * — renaming `parameters` to the wire's `inputSchema`.
 *
 * @remarks
 * Each {@link import('../agents/types.js').ToolDefinition} carries through its
 * `name` and (when present) `description`; its open JSON-Schema `parameters`
 * becomes `inputSchema`, defaulting to an empty object schema (`{ type: 'object' }`)
 * when a tool declares none (MCP requires an `inputSchema`).
 *
 * @param manager - The tool registry to describe
 * @returns One {@link MCPToolDescriptor} per registered tool, in registry order
 */
export function buildToolDescriptors(manager: ToolManagerInterface): readonly MCPToolDescriptor[] {
	return manager.definitions().map((definition) => {
		const descriptor: {
			name: string
			description?: string
			inputSchema: Readonly<Record<string, unknown>>
		} = {
			name: definition.name,
			inputSchema: definition.parameters ?? { type: 'object' },
		}
		if (definition.description !== undefined) descriptor.description = definition.description
		return descriptor
	})
}

/**
 * Map an executed tool's {@link ToolResult} to an MCP {@link MCPToolResult} — the
 * value (or error) as a `text` content block.
 *
 * @remarks
 * The {@link ToolManagerInterface} already isolates a thrown tool into
 * `result.error` (so the server adds NO try/catch around `execute`): when `error`
 * is present, this builds an `isError: true` result carrying the error text, so the
 * model sees the failure as a tool result it can react to rather than a protocol
 * error; otherwise it serializes `result.value` (via `JSON.stringify`) into one
 * `text` block.
 *
 * @param result - The tool's execution outcome
 * @returns The MCP tool-call result
 */
export function buildToolResult(result: ToolResult): MCPToolResult {
	if (result.error !== undefined) {
		return { content: [{ type: 'text', text: result.error }], isError: true }
	}
	// A content block must carry a string `text`; `JSON.stringify(undefined)` is the value
	// `undefined` (which serializes away), so a value-less result becomes an empty text block.
	const text = result.value === undefined ? '' : JSON.stringify(result.value)
	return { content: [{ type: 'text', text }] }
}

/**
 * Build the MCP `initialize` result — the negotiated protocol version, the
 * advertised capabilities, and the server identity.
 *
 * @remarks
 * Version negotiation echoes the client's `requested` version when it is one of the
 * {@link SUPPORTED_PROTOCOL_VERSIONS}, else falls back to {@link MCP_PROTOCOL_VERSION}.
 * `capabilities.tools` is an empty object — this server advertises the tools
 * capability with no sub-options (no list-changed notification yet).
 *
 * @param name - The server name (echoed in `serverInfo`)
 * @param version - The server version (echoed in `serverInfo`)
 * @param requested - The client's requested protocol version (negotiated when supported)
 * @returns The `initialize` result payload
 */
export function initializeResult(
	name: string,
	version: string,
	requested?: string,
): Readonly<Record<string, unknown>> {
	const protocolVersion =
		requested !== undefined && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
			? requested
			: MCP_PROTOCOL_VERSION
	return {
		protocolVersion,
		capabilities: { tools: {} },
		serverInfo: { name, version },
	}
}
