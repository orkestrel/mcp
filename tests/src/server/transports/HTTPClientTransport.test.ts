import type { MCPClientInterface, MCPServerInterface } from '@src/core'
import type { StartedServerInterface } from '../../../../setupServer.js'
import { describe, expect, it } from 'vitest'
import { createMCPClient, createMCPServer, createTool, createToolManager } from '@src/core'
import {
	createErrorBoundary,
	createHTTPClientTransport,
	createMCPRoutes,
	createServer,
	createTokenGuard,
	signToken,
} from '@src/server'
import { createTeardown, startServer } from '../../../../setupServer.js'

// src/server/mcp/HTTPClientTransport.ts — the HTTP CLIENT transport, proven END-TO-END
// against the SHIPPED server transport (`createMCPRoutes`) over a REAL `node:http` server
// + a REAL MCPServer over a REAL ToolManager (AGENTS §16 — no mocks, no live model). An
// `MCPClient` driving `createHTTPClientTransport` connects, discovers, and calls the
// remote tools over `fetch`, exercising BOTH reply framings the server can choose: the
// plain JSON body (`streaming: false`) and the Streamable-HTTP SSE `data:` event
// (`streaming: true`, decoded via the core SSEParser inside the transport). Also: a
// remote tool error → a local throw, and a token guard mounted IN FRONT (the transport's
// `headers` carry the bearer). The in-process correlation / timeout / disconnect contract
// is pinned in tests/src/core/mcp/MCPClient.test.ts; the LIVE model round-trip in
// tests/src/ollama/mcp.test.ts.

const { track } = createTeardown((handle: StartedServerInterface) => handle.stop())

// A real MCPServer over a real ToolManager: an `add` tool (a fixed structured value),
// a `greet` tool (a plain string), and a `boom` tool that throws (→ an `isError` result).
function mcpServer(): MCPServerInterface {
	const tools = createToolManager()
	tools.add(
		createTool({
			name: 'add',
			description: 'Add two numbers',
			parameters: {
				type: 'object',
				properties: { a: { type: 'number' }, b: { type: 'number' } },
			},
			execute: (args) => Number(args['a']) + Number(args['b']),
		}),
	)
	tools.add(createTool({ name: 'greet', execute: () => 'hi' }))
	tools.add(
		createTool({
			name: 'boom',
			execute: () => {
				throw new Error('remote kaboom')
			},
		}),
	)
	return createMCPServer({ name: 'remote', version: '4.5.6', tools })
}

// Stand up the shipped MCP HTTP transport over a real server, then build an MCPClient
// pointed at it via the HTTP client transport. `streaming` picks the server's reply
// framing (SSE vs JSON); `guardSecret` mounts a token guard in front (the client sends
// the bearer through the transport's `headers`).
async function connectClient(options?: {
	readonly streaming?: boolean
	readonly guardSecret?: string
}): Promise<{ readonly client: MCPClientInterface; readonly handle: StartedServerInterface }> {
	const server = createServer()
	server.use(createErrorBoundary())
	if (options?.guardSecret !== undefined) {
		server.use(createTokenGuard({ secret: options.guardSecret }))
	}
	server.route(createMCPRoutes(mcpServer(), { streaming: options?.streaming }))
	const handle = track(await startServer(server))
	const headers =
		options?.guardSecret !== undefined
			? { authorization: `Bearer ${signToken('client', { secret: options.guardSecret })}` }
			: undefined
	const client = createMCPClient({
		transport: createHTTPClientTransport({ url: `${handle.base}/mcp`, headers }),
	})
	await client.connect()
	return { client, handle }
}

describe('HTTPClientTransport — JSON reply path (streaming: false)', () => {
	it('connect → tools() → call() round-trips over a plain JSON body', async () => {
		const { client } = await connectClient({ streaming: false })

		expect(client.connected).toBe(true)
		const tools = await client.tools()
		expect(tools.map((tool) => tool.name)).toEqual(['add', 'greet', 'boom'])
		// The server renamed `parameters` → `inputSchema`; the client maps it back.
		const add = tools.find((tool) => tool.name === 'add')
		expect(add?.parameters).toEqual({
			type: 'object',
			properties: { a: { type: 'number' }, b: { type: 'number' } },
		})

		expect(await client.call('add', { a: 2, b: 5 })).toBe(7)
		expect(await client.call('greet', {})).toBe('hi')
	})

	it('a remote tool failure throws locally', async () => {
		const { client } = await connectClient({ streaming: false })
		await expect(client.call('boom', {})).rejects.toThrow('remote kaboom')
	})
})

describe('HTTPClientTransport — SSE reply path (streaming: true)', () => {
	it('connect → tools() → call() round-trips over a decoded SSE data: event', async () => {
		// The server `Accept`s the transport's `text/event-stream` and frames each reply as a
		// Streamable-HTTP SSE event; the transport decodes it via the core SSEParser. The
		// JSON-RPC envelope — and thus the client's behavior — is identical to the JSON path.
		const { client } = await connectClient({ streaming: true })

		expect(client.connected).toBe(true)
		const tools = await client.tools()
		expect(tools.map((tool) => tool.name)).toEqual(['add', 'greet', 'boom'])

		expect(await client.call('add', { a: 10, b: 1 })).toBe(11)
	})

	it('a remote tool failure throws locally over the SSE path too', async () => {
		const { client } = await connectClient({ streaming: true })
		await expect(client.call('boom', {})).rejects.toThrow('remote kaboom')
	})
})

describe('HTTPClientTransport — policy composes in front', () => {
	it('carries a bearer through headers to reach a guarded server', async () => {
		// The transport's `headers` thread an Authorization bearer; the guard mounted IN FRONT
		// of the MCP route passes it, so the whole handshake + call round-trips.
		const { client } = await connectClient({ guardSecret: 'topsecret', streaming: false })

		expect(client.connected).toBe(true)
		expect(await client.call('add', { a: 3, b: 4 })).toBe(7)
	})

	it('rejects (no connect) when the bearer is missing against a guarded server', async () => {
		const server = createServer()
		server.use(createErrorBoundary())
		server.use(createTokenGuard({ secret: 'topsecret' }))
		server.route(createMCPRoutes(mcpServer()))
		const handle = track(await startServer(server))
		// No `headers` → the guard 401s the POST; the transport surfaces no `message`, so the
		// client's `initialize` never resolves and `connect` rejects on its deadline.
		const client = createMCPClient({
			transport: createHTTPClientTransport({ url: `${handle.base}/mcp` }),
			timeout: 200,
		})

		await expect(client.connect()).rejects.toThrow(/timed out/)
		expect(client.connected).toBe(false)
	})
})

describe('HTTPClientTransport — lifecycle', () => {
	it('exposes session undefined for the stateless v1 server and closes cleanly', async () => {
		const { client } = await connectClient({ streaming: false })

		// The stateless v1 server sends no `mcp-session-id`, so the transport's session stays
		// undefined (reserved for the later sessions tier).
		expect(client.transport.session).toBeUndefined()
		await client.disconnect()
		expect(client.connected).toBe(false)
	})
})
