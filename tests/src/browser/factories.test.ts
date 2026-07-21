import type { MCPSessionState } from '@src/server'
import type { NodeWebSocketInterface } from '@orkestrel/websocket'
import { describe, expect, it, vi } from 'vitest'
import { bindClient, bindServer, createDuplexClientTransport, createMCPClient } from '@src/core'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { createNodeWebSocket } from '@orkestrel/websocket'
import {
	createHTTPClientTransport,
	createMessagePortTransport,
	createWebSocketClientTransport,
} from '@src/browser'
import {
	createMCPRoutes,
	createMCPSession,
	createWebSocketServer,
	MCP_SESSION_HEADER,
	MCP_WEBSOCKET_SUBPROTOCOL,
} from '@src/server'
import { isString } from '@orkestrel/contract'
import { createJSONRPCRequest, waitForDelay } from '../../setup.js'
import { createCalculatorServer, createTeardown, postJSON, startServer } from '../../setupServer.js'
import type { StartedServerInterface } from '../../setupServer.js'

// src/browser/factories.ts + src/browser/transports — the browser-face CLIENT
// transports (`createWebSocketClientTransport` over the native `WebSocket` global,
// `createHTTPClientTransport` over native `fetch`), proven against THIS repo's own
// Node-face servers (`createWebSocketServer` / `createMCPRoutes`, both `@src/server`)
// on a real ephemeral-port HTTP server (AGENTS §16 — no mocks). Node ≥ 22 supplies
// global `WebSocket` / `fetch`, so the browser face is testable in plain Vitest.

interface AppState extends MCPSessionState {}

const { track } = createTeardown((handle: StartedServerInterface) => handle.stop())
const { track: trackSession } = createTeardown((handle: StartedServerInterface<AppState>) =>
	handle.stop(),
)

// ── WebSocket: the browser client against the Node-face WS server ────────────

async function startWsMCP(): Promise<StartedServerInterface> {
	const dispatcher = createDispatcher<unknown>()
	const server = createServer<unknown>({ dispatcher, state: () => undefined })
	server.upgrade(createWebSocketServer(createCalculatorServer()))
	return track(await startServer(server))
}

// A raw (non-MCP) WS upgrade server that hands the caller the live NodeWebSocket the
// moment it opens — for the malformed-inbound-frame scenario, where the peer writes a
// frame that is not valid JSON-RPC (something no well-behaved MCP server ever sends).
async function startRawWsServer(
	onOpen: (ws: NodeWebSocketInterface) => void,
): Promise<StartedServerInterface> {
	const dispatcher = createDispatcher<unknown>()
	const server = createServer<unknown>({ dispatcher, state: () => undefined })
	server.upgrade((request, socket, head) => {
		const upgrade = request.headers['upgrade']
		if (!isString(upgrade) || upgrade.toLowerCase() !== 'websocket') return false
		const key = request.headers['sec-websocket-key']
		if (!isString(key)) return false
		const ws = createNodeWebSocket({ socket, key, head })
		onOpen(ws)
		return true
	})
	return track(await startServer(server))
}

describe('createWebSocketClientTransport — the browser client against the Node-face WS server', () => {
	it('connect → tools/list → tools/call(add): a value round-trips over real WebSocket frames', async () => {
		const handle = await startWsMCP()
		const client = createMCPClient({
			transport: createWebSocketClientTransport({
				url: `${handle.base}/mcp`,
				protocols: MCP_WEBSOCKET_SUBPROTOCOL,
			}),
		})

		await client.connect()
		expect(client.connected).toBe(true)

		const tools = await client.tools()
		expect(tools.map((tool) => tool.name)).toEqual(['add', 'boom'])

		const value = await client.call('add', {})
		expect(value).toBe(5)

		await client.disconnect()
		expect(client.connected).toBe(false)
	})

	it('a remote erroring tool throws locally (isError → throw)', async () => {
		const handle = await startWsMCP()
		const client = createMCPClient({
			transport: createWebSocketClientTransport({
				url: `${handle.base}/mcp`,
				protocols: MCP_WEBSOCKET_SUBPROTOCOL,
			}),
		})
		await client.connect()
		await expect(client.call('boom', {})).rejects.toThrow(/kaboom/)
		await client.disconnect()
	})

	it('queues sends issued before open and flushes them, in order, once the socket opens', async () => {
		const handle = await startWsMCP()
		const transport = createWebSocketClientTransport({
			url: `${handle.base}/mcp`,
			protocols: MCP_WEBSOCKET_SUBPROTOCOL,
		})
		const received: unknown[] = []
		transport.emitter.on('message', (message) => received.push(message))

		// Issue two requests WITHOUT awaiting `start()` first — both are queued pre-open.
		const starting = transport.start()
		await transport.send(createJSONRPCRequest({ method: 'ping', id: 1 }))
		await transport.send(createJSONRPCRequest({ method: 'ping', id: 2 }))
		await starting

		await waitForDelay(50)
		expect(received.map((message) => (message as { id: number }).id)).toEqual([1, 2])

		await transport.close()
	})

	it('a server-initiated close fires the transport close event exactly once', async () => {
		let serverSocket: NodeWebSocketInterface | undefined
		const handle = await startRawWsServer((ws) => {
			serverSocket = ws
		})
		const transport = createWebSocketClientTransport({ url: `${handle.base}/mcp` })
		let closeCount = 0
		transport.emitter.on('close', () => {
			closeCount += 1
		})
		await transport.start()

		serverSocket?.close()
		await waitForDelay(50)

		expect(closeCount).toBe(1)
	})

	it('a malformed inbound frame surfaces on error and does not throw', async () => {
		const handle = await startRawWsServer((ws) => {
			ws.send('not valid json-rpc')
		})
		const transport = createWebSocketClientTransport({ url: `${handle.base}/mcp` })
		const errors: unknown[] = []
		transport.emitter.on('error', (error) => errors.push(error))

		// Reaching this line without an unhandled throw IS the proof; the assertion below
		// confirms the fault was observed rather than silently dropped.
		await transport.start()
		await waitForDelay(50)

		expect(errors.length).toBeGreaterThan(0)
		await transport.close()
	})
})

// ── HTTP: the browser client against the Node-face streamable-HTTP session server ─

async function startHttpMCP(): Promise<StartedServerInterface<AppState>> {
	const dispatcher = createDispatcher<AppState>()
	dispatcher.add(createMCPRoutes<AppState>(createCalculatorServer()))
	const server = createServer<AppState>({ dispatcher, state: () => ({}) })
	server.use(createMCPSession<AppState>())
	return trackSession(await startServer(server))
}

async function startBrokenHttpServer(): Promise<StartedServerInterface> {
	const dispatcher = createDispatcher<unknown>()
	dispatcher.add([
		{
			method: 'POST',
			path: '/mcp',
			name: 'broken',
			handler: () =>
				new Response('not valid json', {
					status: 500,
					headers: { 'content-type': 'application/json' },
				}),
		},
	])
	const server = createServer<unknown>({ dispatcher, state: () => undefined })
	return track(await startServer(server))
}

describe('createHTTPClientTransport — the browser client against the Node-face streamable-HTTP session server', () => {
	it('connect → tools/list → tools/call(add): a value round-trips over fetch + SSE', async () => {
		const handle = await startHttpMCP()
		const client = createMCPClient({
			transport: createHTTPClientTransport({ url: `${handle.base}/mcp` }),
		})

		await client.connect()
		expect(client.connected).toBe(true)

		const tools = await client.tools()
		expect(tools.map((tool) => tool.name)).toEqual(['add', 'boom'])

		const value = await client.call('add', {})
		expect(value).toBe(5)

		await client.disconnect()
	})

	it('captures the mcp-session-id on initialize and reuses it across two sequential requests', async () => {
		const handle = await startHttpMCP()
		const transport = createHTTPClientTransport({ url: `${handle.base}/mcp` })
		expect(transport.session).toBeUndefined()

		await transport.send(createJSONRPCRequest())
		const session = transport.session
		expect(session).toBeDefined()

		// Verify directly with the server: a second request WITHOUT the header would 404
		// (createMCPSession validates it) — the transport threads it automatically.
		const responses: unknown[] = []
		transport.emitter.on('message', (message) => responses.push(message))
		await transport.send(createJSONRPCRequest({ method: 'tools/list', id: 2 }))
		expect(transport.session).toBe(session)
		expect(responses).toHaveLength(1)

		// A raw request confirms the id genuinely gates access — without it the same
		// non-initialize call is rejected.
		const denied = await postJSON(
			handle.base,
			createJSONRPCRequest({ method: 'tools/list', id: 3 }),
		)
		expect(denied.status).toBe(404)

		const allowed = await postJSON(
			handle.base,
			createJSONRPCRequest({ method: 'tools/list', id: 4 }),
			{ headers: { [MCP_SESSION_HEADER]: session ?? '' } },
		)
		expect(allowed.status).toBe(200)
	})

	it('decodes the Streamable-HTTP SSE reply leg (the default framing this client requests)', async () => {
		const handle = await startHttpMCP()
		const transport = createHTTPClientTransport({ url: `${handle.base}/mcp` })
		const messages: unknown[] = []
		transport.emitter.on('message', (message) => messages.push(message))

		await transport.send(createJSONRPCRequest()) // initialize, mints the session
		await transport.send(createJSONRPCRequest({ method: 'ping', id: 2 }))

		expect(messages).toHaveLength(2)
		expect(messages[1]).toEqual({ jsonrpc: '2.0', id: 2, result: {} })
	})

	it('a server error response surfaces on the error event rather than hanging', async () => {
		const handle = await startBrokenHttpServer()
		const transport = createHTTPClientTransport({ url: `${handle.base}/mcp` })
		const errors: unknown[] = []
		transport.emitter.on('error', (error) => errors.push(error))

		await transport.send(createJSONRPCRequest())

		expect(errors).toHaveLength(1)
	})
})

// ── MessagePort: a genuinely SYMMETRIC MCPTransportInterface, both sides driven by
// the SAME class over one REAL `new MessageChannel()` (Node ≥ 22 global, AGENTS §16 —
// no mocks) — port1 bound to a REAL server (`bindServer`), port2 driving a REAL
// client (`bindClient` + `createDuplexClientTransport`) ──────────────────────────

describe('createMessagePortTransport — a symmetric MCPTransportInterface over a real MessageChannel', () => {
	it('connect → tools/list → tools/call(add): a value round-trips over port1/port2', async () => {
		const { port1, port2 } = new MessageChannel()
		const server = createCalculatorServer()
		bindServer(server, createMessagePortTransport({ port: port1 }))

		const clientTransport = createMessagePortTransport({ port: port2 })
		const client = createMCPClient({ transport: createDuplexClientTransport(clientTransport) })
		bindClient(client, clientTransport)

		await client.connect()
		expect(client.connected).toBe(true)

		const tools = await client.tools()
		expect(tools.map((tool) => tool.name)).toEqual(['add', 'boom'])

		const value = await client.call('add', {})
		expect(value).toBe(5)

		await client.disconnect()
	})

	it('a remote erroring tool throws locally (isError → throw)', async () => {
		const { port1, port2 } = new MessageChannel()
		const server = createCalculatorServer()
		bindServer(server, createMessagePortTransport({ port: port1 }))

		const clientTransport = createMessagePortTransport({ port: port2 })
		const client = createMCPClient({ transport: createDuplexClientTransport(clientTransport) })
		bindClient(client, clientTransport)
		await client.connect()

		await expect(client.call('boom', {})).rejects.toThrow(/kaboom/)
		await client.disconnect()
	})

	it('a non-string postMessage payload is ignored — no crash, no reply', async () => {
		const { port1, port2 } = new MessageChannel()
		const transport = createMessagePortTransport({ port: port1 })
		const received: string[] = []
		transport.listen((message) => received.push(message))

		port2.postMessage({ not: 'a string' })
		port2.postMessage('sentinel')
		await vi.waitFor(() => expect(received).toEqual(['sentinel']))
	})

	it('a string postMessage payload IS delivered to the registered listen handler', async () => {
		const { port1, port2 } = new MessageChannel()
		const transport = createMessagePortTransport({ port: port1 })
		const received: string[] = []
		transport.listen((message) => received.push(message))

		port2.postMessage('a plain string message')
		await vi.waitFor(() => expect(received).toEqual(['a plain string message']))
	})

	it('close() closes the port — a subsequent postMessage from the peer is undelivered', async () => {
		const { port1, port2 } = new MessageChannel()
		const transport = createMessagePortTransport({ port: port1 })
		const received: string[] = []
		transport.listen((message) => received.push(message))

		await transport.close()
		port2.postMessage('after close')
		await waitForDelay(50)

		expect(received).toEqual([])
	})

	it('close() fires the registered closed handler exactly once, even called twice', async () => {
		const { port1 } = new MessageChannel()
		const transport = createMessagePortTransport({ port: port1 })
		let closedCalls = 0
		transport.closed(() => {
			closedCalls += 1
		})

		await transport.close()
		await transport.close()

		expect(closedCalls).toBe(1)
	})

	it('listen/closed are single-handler-replace — a second registration replaces, never adds', async () => {
		const { port1, port2 } = new MessageChannel()
		const transport = createMessagePortTransport({ port: port1 })
		const first: string[] = []
		const second: string[] = []
		transport.listen((message) => first.push(message))
		transport.listen((message) => second.push(message))

		port2.postMessage('one')
		await vi.waitFor(() => expect(second).toEqual(['one']))
		expect(first).toEqual([])
	})

	it('a messageerror event does not close the transport — later well-formed messages still arrive', async () => {
		const { port1, port2 } = new MessageChannel()
		const transport = createMessagePortTransport({ port: port1 })
		const received: string[] = []
		let closedCalls = 0
		transport.listen((message) => received.push(message))
		transport.closed(() => {
			closedCalls += 1
		})

		// Dispatch a genuine `messageerror` event directly on port1 — the real native
		// event this transport's listener is registered for (a `MessagePort` is a real
		// `EventTarget`, so this is a real event dispatch, not a mock of the transport).
		port1.dispatchEvent(new MessageEvent('messageerror', { data: null }))
		port2.postMessage('still works')
		await vi.waitFor(() => expect(received).toEqual(['still works']))

		expect(closedCalls).toBe(0)
	})
})
