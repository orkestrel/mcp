import type {
	MCPClientInterface,
	MCPClientOptions,
	MCPServerInterface,
	MCPServerOptions,
} from './types.js'
import { MCPClient } from './MCPClient.js'
import { MCPServer } from './MCPServer.js'

/**
 * Create a transport-agnostic Model Context Protocol server — exposes a live
 * {@link import('@orkestrel/agent').ToolManagerInterface} over JSON-RPC 2.0
 * (`initialize` / `ping` / `tools/list` / `tools/call`).
 *
 * @remarks
 * Pump raw message strings through `handle` (parse → dispatch → serialize) from a
 * transport, or call the typed `dispatch` directly with an already-parsed request.
 * The server is provider-agnostic — JSON-RPC plus the tool registry, with no HTTP
 * and no model. The {@link import('@orkestrel/agent').ToolManagerInterface} already
 * isolates a thrown tool into a result error (surfaced as an MCP `isError: true`
 * tool result), so a misbehaving tool never crashes a dispatch. Subscribe to the
 * `request` event via `server.emitter.on('request', …)` for tracing.
 *
 * @param options - `name` / `version` (the server identity), `tools` (the live
 *   registry to expose), an optional `description`, and the reserved `on`
 *   {@link import('@orkestrel/emitter').EmitterHooks} (see {@link MCPServerOptions})
 * @returns A working {@link MCPServerInterface}
 *
 * @example
 * ```ts
 * import { createMCPServer, createTool, createToolManager } from '@src/core'
 *
 * const tools = createToolManager()
 * tools.add(createTool({ name: 'add', execute: (a) => Number(a.x) + Number(a.y) }))
 *
 * const server = createMCPServer({ name: 'calculator', version: '1.0.0', tools })
 * server.emitter.on('request', (method, id) => log(method, id))
 *
 * // A transport pumps message strings through `handle`:
 * const reply = await server.handle('{"jsonrpc":"2.0","method":"tools/list","id":1}')
 * // reply → '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"add","inputSchema":{"type":"object"}}]}}'
 * ```
 */
export function createMCPServer(options: MCPServerOptions): MCPServerInterface {
	return new MCPServer(options)
}

/**
 * Create a transport-agnostic Model Context Protocol CLIENT — connects to a REMOTE
 * MCP server over an injected {@link import('./types.js').ClientTransportInterface},
 * runs the `initialize` handshake, and exposes the server's tools as local
 * {@link import('@orkestrel/agent').ToolInterface}s an agent can run.
 *
 * @remarks
 * The egress mirror of {@link createMCPServer}: where the server exposes a local tool
 * registry over MCP, the client USES a remote server's tools. `connect()` handshakes,
 * `tools()` lists + wraps the remote tools (each `execute` calls back over the wire),
 * and `call(name, args)` runs a remote `tools/call` (a remote tool failure throws
 * locally, so an agent's {@link import('@orkestrel/agent').ToolManagerInterface}
 * isolates it). The transport is injected — a concrete one (the HTTP transport over
 * `fetch`) lives in `@src/server`; the client itself is provider-agnostic. Subscribe
 * to `connect` / `disconnect` / `notification` via `client.on(...)` (or
 * `client.emitter.on(...)`).
 *
 * @param options - `transport` (the carrier; REQUIRED), `name` / `version` (the client
 *   identity), `timeout` (the per-request deadline), and the reserved `on`
 *   {@link import('@orkestrel/emitter').EmitterHooks} (see {@link MCPClientOptions})
 * @returns A working {@link MCPClientInterface}
 *
 * @example
 * ```ts
 * import { createMCPClient } from '@src/core'
 * import { createHTTPClientTransport } from '@src/server'
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
