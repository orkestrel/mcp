import type { ToolManagerInterface, ToolResult } from '@orkestrel/agent'
import type {
	JSONRPCResponse,
	MCPClientInterface,
	MCPServerInterface,
	MCPToolDescriptor,
	MCPToolResult,
	MCPTransportInterface,
} from './types.js'
import { MCP_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from './constants.js'
import { parseJSONRPCMessage } from './parsers.js'

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
 * Each {@link import('@orkestrel/agent').ToolDefinition} carries through its
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

// The environment-agnostic PORT binders — the keystone that lets an
// {@link MCPServerInterface} / {@link MCPClientInterface} run over ANY
// {@link MCPTransportInterface} (a Node stdio pair, a browser MessagePort, a Web
// Worker `self`) with no per-environment dispatch/correlation wiring duplicated at
// each face. Both are TOTAL: a `send` throw or rejection is caught and never
// escapes as an unhandled rejection.

/**
 * Pipe an {@link MCPTransportInterface} into an {@link MCPServerInterface} — every
 * inbound message runs through `server.handle`, and a defined reply is written back
 * via `transport.send`.
 *
 * @remarks
 * `server.handle` already turns a malformed message into a serialized `-32700` /
 * `-32600` reply and a notification into `undefined` (no reply), so this binder adds
 * no parsing of its own. A `transport.send` throw or rejection is caught and routed
 * to `server.emitter`'s `error` event (never rethrown, never an unhandled rejection);
 * a listener on that event that itself throws is swallowed (the end of the line —
 * the caller's own bug, never this binder's). The returned unbind DETACHES this
 * binder (further inbound messages and the transport's `closed` signal are ignored)
 * WITHOUT closing the transport — closing is the caller's decision.
 *
 * `listen`/`closed` are REPLACE semantics (§ port contract): the returned unbind
 * DETACHES by replacing this binder's own handlers with no-ops, so a subsequent
 * `bindServer` call on the SAME transport is never double-dispatched by a stale
 * subscription left behind — an unbind→rebind cycle yields exactly one reply per
 * request.
 *
 * @param server - The transport-agnostic server to dispatch inbound messages over
 * @param transport - The duplex channel to pipe the server over
 * @returns Detach this binder from the transport (does not close it)
 *
 * @example
 * ```ts
 * const unbind = bindServer(server, transport)
 * // ... later, detach without closing:
 * unbind()
 * ```
 */
export function bindServer(
	server: MCPServerInterface,
	transport: MCPTransportInterface,
): () => void {
	let active = true
	transport.listen((message) => {
		if (!active) return
		void (async () => {
			try {
				const response = await server.handle(message)
				if (response !== undefined) await transport.send(response)
			} catch (error) {
				try {
					server.emitter.emit('error', error)
				} catch {
					// A throwing `error` listener is the caller's own bug — the end of the line.
				}
			}
		})()
	})
	transport.closed(() => {
		active = false
	})
	return () => {
		active = false
		transport.listen(() => {})
		transport.closed(() => {})
	}
}

/**
 * Pipe an {@link MCPTransportInterface} into an {@link MCPClientInterface} — every
 * inbound message is decoded and delivered onto the client's OWN transport
 * (`client.transport.emitter`'s `message` / `close` events), resolving/rejecting the
 * client's correlated pending requests exactly as a direct reply would.
 *
 * @remarks
 * The client's outbound writes flow through `client.transport.send` — its existing,
 * unmodified request/response correlation — so `client` must have been constructed
 * with a {@link import('./types.js').ClientTransportInterface} that itself carries
 * the SAME `transport` (see {@link import('./factories.js').createDuplexClientTransport},
 * the additive factory that adapts an {@link MCPTransportInterface} into that shape);
 * this binder then completes the inbound half by decoding each message and pushing it
 * onto `client.transport.emitter` (an {@link import('@orkestrel/emitter').EmitterInterface}
 * exposes `emit`, so no client modification is needed). A malformed / non-JSON-RPC
 * inbound message is DROPPED (§14, total — never throws); a delivery fault is routed to
 * `client.transport.emitter`'s `error` event (never rethrown). The returned unbind
 * DETACHES this binder (further inbound messages and the transport's `closed` signal are
 * ignored) WITHOUT closing the transport.
 *
 * `listen`/`closed` are REPLACE semantics (§ port contract): the returned unbind
 * DETACHES by replacing this binder's own handlers with no-ops, so a subsequent
 * `bindClient` call on the SAME transport is never double-dispatched by a stale
 * subscription left behind — an unbind→rebind cycle delivers exactly one `message`
 * emit per inbound reply.
 *
 * @param client - The transport-agnostic client whose transport to deliver messages onto
 * @param transport - The duplex channel to pipe the client over
 * @returns Detach this binder from the transport (does not close it)
 *
 * @example
 * ```ts
 * const client = createMCPClient({ transport: createDuplexClientTransport(transport) })
 * const unbind = bindClient(client, transport)
 * await client.connect()
 * // ... later, detach without closing:
 * unbind()
 * ```
 */
export function bindClient(
	client: MCPClientInterface,
	transport: MCPTransportInterface,
): () => void {
	let active = true
	transport.listen((message) => {
		if (!active) return
		let parsed: unknown
		try {
			parsed = JSON.parse(message)
		} catch {
			return
		}
		const decoded = parseJSONRPCMessage(parsed)
		if (decoded === undefined) return
		try {
			client.transport.emitter.emit('message', decoded)
		} catch (error) {
			try {
				client.transport.emitter.emit('error', error)
			} catch {
				// A throwing `error` listener is the caller's own bug — the end of the line.
			}
		}
	})
	transport.closed(() => {
		if (!active) return
		active = false
		try {
			client.transport.emitter.emit('close')
		} catch {
			// A throwing `close` listener is the caller's own bug — the end of the line.
		}
	})
	return () => {
		active = false
		transport.listen(() => {})
		transport.closed(() => {})
	}
}
