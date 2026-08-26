import type {
	MCPClientTransportEventMap,
	MCPClientTransportInterface,
	JSONRPCMessage,
	MCPClientInterface,
	MCPClientOptions,
	MCPLegacyClientTransportOptions,
	MCPDispatcherInterface,
	MCPServerInterface,
	MCPServerOptions,
	MCPTransportInterface,
} from './types.js'
import { Emitter } from '@orkestrel/emitter'
import { MCPClient } from './MCPClient.js'
import { MCPLegacy } from './MCPLegacy.js'
import { MCPLegacyClientTransport } from './MCPLegacyClientTransport.js'
import { MCPServer } from './MCPServer.js'

/**
 * Creates a transport-agnostic Model Context Protocol server — exposes a live
 * {@link import('@orkestrel/tool').ToolManagerInterface} and an optional
 * {@link import('./types.js').MCPResourceManagerInterface},
 * {@link import('./types.js').MCPPromptManagerInterface}, and
 * {@link import('./types.js').MCPCompletionManagerInterface} over JSON-RPC 2.0.
 *
 * @remarks
 * Pump raw message strings through `handle` (parse → dispatch → serialize) from a
 * transport, or call the typed `dispatch` directly with an already-parsed request.
 * The server is provider-agnostic — JSON-RPC plus the tool registry, with no HTTP
 * and no model. The {@link import('@orkestrel/tool').ToolManagerInterface} already
 * isolates a thrown tool into a `success: false` result (surfaced as an MCP
 * `isError: true` tool result), so a misbehaving tool never crashes a dispatch. Subscribe to the
 * `request` event through `server.emitter.on('request', …)` for tracing.
 *
 * @param options - `identity` (the server identity), `tools` (the live tool
 *   registry), optional `resources` (the consumer-owned resource registry), optional
 *   `prompts` (the consumer-owned prompt registry), optional `completion` (the host-owned
 *   prompt and resource-template completion provider),
 *   optional `instructions`, and the reserved `on`
 *   {@link import('@orkestrel/emitter').EmitterHooks} (see {@link MCPServerOptions})
 * @returns A working {@link MCPServerInterface}
 *
 * @example
 * ```ts
 * import { createMCPServer } from '@orkestrel/mcp'
 * import { createTool, createToolManager } from '@orkestrel/tool'
 *
 * const tools = createToolManager()
 * tools.add(createTool({ name: 'add', execute: (a) => Number(a.x) + Number(a.y) }))
 *
 * const server = createMCPServer({ identity: { name: 'calculator', version: '1.0.0' }, tools })
 * server.emitter.on('request', (method, id) => log(method, id))
 *
 * // A transport pumps message strings through `handle`:
 * const reply = await server.handle('{"jsonrpc":"2.0","method":"tools/list","id":1,"params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}')
 * // reply → '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"add","inputSchema":{"type":"object"}}],"resultType":"complete","ttlMs":60000,"cacheScope":"private","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"calculator","version":"1.0.0"}}}}'
 * ```
 */
export function createMCPServer(options: MCPServerOptions): MCPServerInterface {
	return new MCPServer(options)
}

/**
 * Decorates one MCP server with the fixed legacy method translation.
 *
 * @param server - The sole modern dispatcher and handshake identity source
 * @returns A dispatcher accepting both modern and legacy invocations
 */
export function createMCPLegacy(server: MCPServerInterface): MCPDispatcherInterface {
	return new MCPLegacy({ dispatcher: server, identity: server.identity })
}

/**
 * Creates a transport-agnostic Model Context Protocol CLIENT — connects to a REMOTE
 * MCP server over an injected {@link import('./types.js').MCPClientTransportInterface},
 * negotiates the modern revision through `server/discover`, and exposes the server's tools as local
 * {@link import('@orkestrel/tool').ToolInterface}s an agent can run.
 *
 * @remarks
 * The egress mirror of {@link createMCPServer}: where the server exposes a local tool
 * registry over MCP, the client USES a remote server's tools. `connect()` discovers,
 * validates, and exposes the negotiated modern protocol; a legacy peer requires
 * {@link createMCPLegacyClientTransport}. `tools()` lists + wraps the remote
 * tools (each `execute` calls back over the wire),
 * and `call(name, args)` runs a remote `tools/call` (a remote tool failure throws
 * locally, so an agent's {@link import('@orkestrel/tool').ToolManagerInterface}
 * isolates it). The transport is injected — a concrete one (the HTTP transport over
 * `fetch`) lives in the published server environment; the client itself is provider-agnostic. Subscribe
 * to `connect` / `disconnect` / `notification` through `client.emitter.on(...)`.
 *
 * @param options - `transport` (the carrier; REQUIRED), an optional `identity`
 *   (the client identity), `timeout` (the per-request deadline), and the reserved `on`
 *   {@link import('@orkestrel/emitter').EmitterHooks} (see {@link MCPClientOptions})
 * @returns A working {@link MCPClientInterface}
 *
 * @example
 * ```ts
 * import { createMCPClient } from '@orkestrel/mcp'
 * import { createHTTPClientTransport } from '@orkestrel/mcp/server'
 *
 * const client = createMCPClient({
 * 	transport: createHTTPClientTransport({ url: 'http://localhost:3000/mcp' }),
 * })
 * await client.connect()
 * agent.context.tools.add(await client.tools()) // give the agent the remote tools
 * const value = await client.call('search', { query: 'mcp' })
 * ```
 */
export function createMCPClient(options: MCPClientOptions): MCPClientInterface {
	return new MCPClient(options)
}

/**
 * Decorates one client transport with explicit legacy handshake and era translation.
 *
 * @param transport - The transport connected to a legacy MCP peer
 * @param options - Optional legacy handshake identity, capabilities, revision, and deadline
 * @returns A modern-facing client transport over the legacy peer
 *
 * @example
 * ```ts
 * const transport = createMCPLegacyClientTransport(legacyTransport)
 * const client = createMCPClient({ transport })
 * await client.connect()
 * client.version // '2026-07-28'
 * ```
 */
export function createMCPLegacyClientTransport(
	transport: MCPClientTransportInterface,
	options?: MCPLegacyClientTransportOptions,
): MCPClientTransportInterface {
	return new MCPLegacyClientTransport(transport, options)
}

/**
 * Adapts an {@link MCPTransportInterface} (the environment-agnostic duplex message
 * channel) into a {@link MCPClientTransportInterface} — the additive bridge that lets
 * `createMCPClient` run over the new port without any change to `MCPClient`'s
 * existing shape.
 *
 * @remarks
 * Hand the RESULT to `createMCPClient({ transport })`, then pass the SAME
 * `transport` to {@link import('./helpers.js').bindClient} to complete the inbound
 * wiring: `send` serializes each outbound {@link JSONRPCMessage} and writes it through
 * `transport.send`; `close` closes the underlying
 * `transport`; `start` is a no-op (the duplex channel is already open by the time
 * it is handed in — there is no separate connect step at this layer); `session` is
 * always `undefined` (session correlation is a higher-level concern the duplex port
 * does not carry); and `duplex` is always `true`, because carrying frames in both
 * directions at any moment is exactly what the adapted port is — a claim DRIVEN over a real
 * `MessageChannel` and a real scope pair (a client-initiated `notifications/cancelled`
 * observed arriving at the peer) rather than read back off this literal. The literal is
 * true of the PORT, and stays true only while the port has a peer: close the far half and
 * this transport still declares `true` while carrying nothing, which is the one thing a
 * per-carrier declaration cannot express. Inbound delivery (`emitter`'s `message` / `close` events) is
 * `bindClient`'s job, not this factory's — the returned object exposes a `message`-
 * capable emitter for `bindClient` to push onto.
 *
 * @param transport - The duplex channel to adapt
 * @returns A {@link MCPClientTransportInterface} `createMCPClient` can drive
 *
 * @example
 * ```ts
 * const client = createMCPClient({ transport: createDuplexClientTransport(transport) })
 * const unbind = bindClient(client, transport)
 * await client.connect()
 * ```
 */
export function createDuplexClientTransport(
	transport: MCPTransportInterface,
): MCPClientTransportInterface {
	const emitter = new Emitter<MCPClientTransportEventMap>()
	return {
		emitter,
		session: undefined,
		// The adapted port is a duplex channel by construction — that is the whole of what
		// `MCPTransportInterface` is — so a client frame written at any moment reaches the peer.
		duplex: true,
		async start(): Promise<void> {
			// The duplex channel is already open by the time it is handed in — no separate
			// connect step at this layer.
		},
		async send(message: JSONRPCMessage): Promise<void> {
			await transport.send(JSON.stringify(message))
		},
		async close(): Promise<void> {
			await transport.close()
		},
	}
}
