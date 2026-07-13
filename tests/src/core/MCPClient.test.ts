import type {
	ClientTransportEventMap,
	ClientTransportInterface,
	JSONRPCMessage,
	MCPServerInterface,
	ToolManagerInterface,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	createEmitter,
	createMCPClient,
	createMCPServer,
	createTool,
	createToolManager,
} from '@src/core'

// MCPClient ↔ a REAL MCPServer over an in-process LOOPBACK transport (AGENTS §16 — a
// real server + real ToolManager, no mocks of the unit under test). The loopback's
// `send` dispatches each message through the server's `dispatch` and emits the response
// back on its `message` event, so the full `initialize` / `tools/list` / `tools/call`
// path runs in-process and deterministically. The OVER-FETCH JSON/SSE wire path is
// pinned in tests/src/server/mcp/HTTPClientTransport.test.ts; the LIVE model round-trip
// in tests/src/ollama/mcp.test.ts. Here: the handshake, tool discovery + local-tool
// wrapping (the wrapped `execute` calls back over the loopback), the content round-trip
// + a remote-error → local throw, id correlation, the per-request timeout, and
// disconnect rejecting pending requests.

// An in-process loopback ClientTransport over a real MCPServer: each sent message is
// dispatched through the server and its response (if any) emitted on `message` — a real
// transport, not a mock. `gate` optionally WITHHOLDS the response for a chosen method
// (so a request stays pending), to drive the timeout / disconnect paths. `sent` records
// every method sent, for the correlation / handshake assertions.
interface LoopbackInterface extends ClientTransportInterface {
	readonly sent: readonly string[]
	readonly started: number
	readonly closed: number
}

function createLoopback(
	server: MCPServerInterface,
	gate?: (method: string) => boolean,
): LoopbackInterface {
	const emitter = createEmitter<ClientTransportEventMap>()
	const sent: string[] = []
	let started = 0
	let closed = 0
	return {
		emitter,
		session: undefined,
		get sent() {
			return sent
		},
		get started() {
			return started
		},
		get closed() {
			return closed
		},
		async start() {
			started += 1
		},
		async send(message: JSONRPCMessage | readonly JSONRPCMessage[]) {
			const messages = Array.isArray(message) ? message : [message]
			for (const one of messages) {
				if ('method' in one) sent.push(one.method)
				const response = await server.dispatch(one)
				// `gate(method)` true → withhold the response (the request stays pending), to
				// drive the timeout / disconnect tests; otherwise emit it for id correlation.
				if (
					response !== undefined &&
					(gate === undefined || !('method' in one) || !gate(one.method))
				) {
					emitter.emit('message', response)
				}
			}
		},
		async close() {
			closed += 1
		},
	}
}

// A real ToolManager carrying a deterministic `echo` (returns a structured value),
// a `greet` (a plain string), and a `boom` (throws — the manager isolates it into a
// result error, which the server maps to an `isError` tool result).
function toolRegistry(): ToolManagerInterface {
	const tools = createToolManager()
	tools.add(
		createTool({
			name: 'echo',
			description: 'Echo the arguments back',
			parameters: { type: 'object', properties: { value: { type: 'string' } } },
			execute: (args) => ({ echoed: args['value'] }),
		}),
	)
	tools.add(createTool({ name: 'greet', execute: () => 'hello' }))
	tools.add(
		createTool({
			name: 'boom',
			execute: () => {
				throw new Error('tool exploded')
			},
		}),
	)
	return tools
}

function serverWithTools(): MCPServerInterface {
	return createMCPServer({ name: 'loopback', version: '1.2.3', tools: toolRegistry() })
}

describe('MCPClient — connect (the initialize handshake)', () => {
	it('opens the transport, handshakes, and reports connected', async () => {
		const loopback = createLoopback(serverWithTools())
		const client = createMCPClient({ transport: loopback, name: 'tester', version: '9.9.9' })

		expect(client.connected).toBe(false)
		await client.connect()

		expect(client.connected).toBe(true)
		expect(loopback.started).toBe(1)
		// The handshake sends `initialize` then the `notifications/initialized` notification.
		expect(loopback.sent).toEqual(['initialize', 'notifications/initialized'])
	})

	it('fires the connect event and is idempotent', async () => {
		const loopback = createLoopback(serverWithTools())
		const client = createMCPClient({ transport: loopback })
		let connects = 0
		client.on('connect', () => {
			connects += 1
		})

		await client.connect()
		await client.connect() // second connect is a no-op

		expect(connects).toBe(1)
		expect(loopback.started).toBe(1)
		expect(client.connected).toBe(true)
	})

	it('exposes the injected transport', () => {
		const loopback = createLoopback(serverWithTools())
		const client = createMCPClient({ transport: loopback })
		expect(client.transport).toBe(loopback)
	})
})

describe('MCPClient — tools() (discovery + local-tool wrapping)', () => {
	it('lists the remote tools as local Tools, mapping inputSchema → parameters', async () => {
		const client = createMCPClient({ transport: createLoopback(serverWithTools()) })
		await client.connect()

		const tools = await client.tools()

		expect(tools.map((tool) => tool.name)).toEqual(['echo', 'greet', 'boom'])
		const echo = tools.find((tool) => tool.name === 'echo')
		expect(echo?.description).toBe('Echo the arguments back')
		// The server renamed `parameters` → `inputSchema`; the client maps it back.
		expect(echo?.parameters).toEqual({ type: 'object', properties: { value: { type: 'string' } } })
		// `greet` declared no parameters → the server defaulted `{ type: 'object' }`.
		const greet = tools.find((tool) => tool.name === 'greet')
		expect(greet?.parameters).toEqual({ type: 'object' })
	})

	it("the wrapped tool's execute calls back over the transport and returns the remote value", async () => {
		const client = createMCPClient({ transport: createLoopback(serverWithTools()) })
		await client.connect()
		const tools = await client.tools()
		const echo = tools.find((tool) => tool.name === 'echo')

		// Running the LOCAL tool drives a remote `tools/call` round-trip.
		const value = await echo?.execute({ value: 'pong' })

		expect(value).toEqual({ echoed: 'pong' })
	})

	it('a wrapped remote-erroring tool, added to a ToolManager, is isolated into a result error', async () => {
		const client = createMCPClient({ transport: createLoopback(serverWithTools()) })
		await client.connect()
		const remote = createToolManager()
		remote.add(await client.tools())

		// The remote `boom` throws server-side (`isError`); the wrapped local tool re-throws,
		// and the local ToolManager isolates THAT into a result error — exactly like a local
		// throw. The agent loop stays driveable.
		const result = await remote.execute({ id: 'c1', name: 'boom', arguments: {} })

		expect(result.value).toBeUndefined()
		expect(result.error).toContain('tool exploded')
	})
})

describe('MCPClient — call() (the content round-trip)', () => {
	it('returns a structured value parsed from the result content', async () => {
		const client = createMCPClient({ transport: createLoopback(serverWithTools()) })
		await client.connect()

		expect(await client.call('echo', { value: 'x' })).toEqual({ echoed: 'x' })
	})

	it('returns a plain string value (parsed from its JSON text block)', async () => {
		const client = createMCPClient({ transport: createLoopback(serverWithTools()) })
		await client.connect()

		// `greet` returns the string 'hello'; the server JSON-stringifies it to '"hello"',
		// and the client JSON-parses it back to the string.
		expect(await client.call('greet', {})).toBe('hello')
	})

	it('throws when the remote tool fails (isError), carrying the error text', async () => {
		const client = createMCPClient({ transport: createLoopback(serverWithTools()) })
		await client.connect()

		await expect(client.call('boom', {})).rejects.toThrow('tool exploded')
	})

	it('rejects a tools/call for an unknown remote tool (the manager not-found error)', async () => {
		const client = createMCPClient({ transport: createLoopback(serverWithTools()) })
		await client.connect()

		// The remote ToolManager resolves an unknown name to an `isError` not-found result,
		// so the client throws.
		await expect(client.call('absent', {})).rejects.toThrow(/not found/)
	})
})

describe('MCPClient — id correlation', () => {
	it('routes each response to its own pending request across concurrent calls', async () => {
		const client = createMCPClient({ transport: createLoopback(serverWithTools()) })
		await client.connect()

		// Three concurrent calls; each must resolve to ITS OWN result, proving the id-keyed
		// correlation routes responses correctly (not first-come-first-served).
		const [a, b, c] = await Promise.all([
			client.call('echo', { value: 'a' }),
			client.call('echo', { value: 'b' }),
			client.call('greet', {}),
		])

		expect(a).toEqual({ echoed: 'a' })
		expect(b).toEqual({ echoed: 'b' })
		expect(c).toBe('hello')
	})

	it('surfaces a server-initiated notification on the notification event', async () => {
		const loopback = createLoopback(serverWithTools())
		const client = createMCPClient({ transport: loopback })
		await client.connect()
		const seen: JSONRPCMessage[] = []
		client.on('notification', (message) => seen.push(message))

		// A message that is NOT a response to a pending request (here a server-pushed
		// notification injected straight onto the transport) is surfaced, not dropped.
		loopback.emitter.emit('message', { jsonrpc: '2.0', method: 'notifications/progress' })

		expect(seen).toHaveLength(1)
		expect(seen[0]).toEqual({ jsonrpc: '2.0', method: 'notifications/progress' })
	})
})

describe('MCPClient — per-request timeout', () => {
	it('rejects a request the server never answers, after the deadline', async () => {
		// Gate `tools/list` so its response is withheld — the request stays pending until the
		// tiny per-request deadline fires (§16 short timers).
		const loopback = createLoopback(serverWithTools(), (method) => method === 'tools/list')
		const client = createMCPClient({ transport: loopback, timeout: 30 })
		await client.connect() // `initialize` is NOT gated, so connect succeeds

		await expect(client.tools()).rejects.toThrow(/timed out/)
	})
})

describe('MCPClient — disconnect', () => {
	it('rejects every pending request and closes the transport', async () => {
		// Gate `tools/call` so the call stays pending; disconnect must reject it.
		const loopback = createLoopback(serverWithTools(), (method) => method === 'tools/call')
		const client = createMCPClient({ transport: loopback, timeout: 5_000 })
		await client.connect()

		const pending = client.call('greet', {})
		await client.disconnect()

		expect(client.connected).toBe(false)
		expect(loopback.closed).toBe(1)
		await expect(pending).rejects.toThrow(/disconnected/)
	})

	it('fires the disconnect event and is idempotent', async () => {
		const loopback = createLoopback(serverWithTools())
		const client = createMCPClient({ transport: loopback })
		let disconnects = 0
		client.on('disconnect', () => {
			disconnects += 1
		})
		await client.connect()

		await client.disconnect()
		await client.disconnect() // second disconnect is a no-op

		expect(disconnects).toBe(1)
		expect(loopback.closed).toBe(1)
	})
})

describe('MCPClient — §13 observer safety', () => {
	it('a throwing connect listener cannot corrupt connect, and routes to the error handler', async () => {
		const loopback = createLoopback(serverWithTools())
		const errors: (readonly [unknown, string])[] = []
		// The emitter's `error` handler receives (error, event) — never a domain event.
		const client = createMCPClient({
			transport: loopback,
			error: (error, event) => errors.push([error, event]),
		})
		client.on('connect', () => {
			throw new Error('observer boom')
		})

		// The throwing observer must not prevent connect from completing.
		await client.connect()

		expect(client.connected).toBe(true)
		expect(errors).toHaveLength(1)
		expect(errors[0][1]).toBe('connect')
	})
})
