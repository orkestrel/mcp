import type {
	ClientTransportEventMap,
	ClientTransportInterface,
	JSONRPCMessage,
	JSONRPCRequest,
	JSONRPCResponse,
	MCPServerInterface,
} from '@src/core'
import type { ToolManagerInterface } from '@orkestrel/tool'
import { describe, expect, it } from 'vitest'
import {
	createMCPClient,
	createMCPServer,
	isMCPError,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_METHOD_NOT_FOUND,
	MCP_META_CAPABILITIES,
	MCP_META_CLIENT,
	MCP_META_VERSION,
	MCP_PROTOCOL_VERSION,
	MCP_UNSUPPORTED_VERSION,
} from '@src/core'
import { createTool, createToolManager } from '@orkestrel/tool'
import { createEmitter } from '@orkestrel/emitter'
import { waitForDelay } from '../../setup.js'

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
	readonly requests: readonly JSONRPCRequest[]
	readonly started: number
	readonly closed: number
}

function createLoopback(
	server: MCPServerInterface,
	gate?: (method: string) => boolean,
): LoopbackInterface {
	const emitter = createEmitter<ClientTransportEventMap>()
	const requests: JSONRPCRequest[] = []
	let started = 0
	let closed = 0
	return {
		emitter,
		session: undefined,
		get sent() {
			return requests.map((request) => request.method)
		},
		get requests() {
			return requests
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
		async send(message: JSONRPCMessage) {
			if (!('method' in message)) return
			requests.push(message)
			const answer = await server.dispatch(message)
			// This scripted peer drives only unary methods, so a held-open stream never
			// arrives here; narrow it off rather than pretending it is a message.
			if (answer === undefined || Symbol.asyncIterator in answer) return
			// `gate(method)` true → withhold the response (the request stays pending), to
			// drive the timeout / disconnect tests; otherwise emit it for id correlation.
			if (gate === undefined || !gate(message.method)) emitter.emit('message', answer)
		},
		async close() {
			closed += 1
		},
	}
}

// A minimal protocol-faithful peer for negotiation paths a conforming local MCPServer
// cannot produce. The script returns a correlated response, no response, or a transport
// failure; the peer records every real JSON-RPC request and preserves lifecycle counts.
function createFixturePeer(
	reply: (request: JSONRPCRequest, count: number) => JSONRPCResponse | Error | undefined,
): LoopbackInterface {
	const emitter = createEmitter<ClientTransportEventMap>()
	const requests: JSONRPCRequest[] = []
	let started = 0
	let closed = 0
	return {
		emitter,
		session: undefined,
		get sent() {
			return requests.map((request) => request.method)
		},
		get requests() {
			return requests
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
		async send(message) {
			if (!('method' in message)) return
			requests.push(message)
			const response = reply(message, requests.length)
			if (response instanceof Error) throw response
			if (response !== undefined) emitter.emit('message', response)
		},
		async close() {
			closed += 1
		},
	}
}

function initializeResponse(id: string | number, protocol: unknown): JSONRPCResponse {
	return {
		jsonrpc: '2.0',
		id,
		result: {
			protocolVersion: protocol,
			capabilities: {},
			serverInfo: { name: 'fixture', version: '1.0.0' },
		},
	}
}

function discoverResponse(
	id: string | number,
	versions: readonly unknown[] = ['2026-07-28', '2025-11-25'],
): JSONRPCResponse {
	return {
		jsonrpc: '2.0',
		id,
		result: {
			supportedVersions: versions,
			capabilities: { tools: {} },
			resultType: 'complete',
			ttlMs: 60_000,
			cacheScope: 'private',
		},
	}
}

function errorResponse(id: string | number, code: number, data?: unknown): JSONRPCResponse {
	return {
		jsonrpc: '2.0',
		id,
		error: {
			code,
			message: code === MCP_UNSUPPORTED_VERSION ? 'Unsupported protocol version' : 'Legacy peer',
			...(data === undefined ? {} : { data }),
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
	return createMCPServer({
		identity: { name: 'loopback', version: '1.2.3' },
		tools: toolRegistry(),
	})
}

describe('MCPClient — connect (dual-era negotiation)', () => {
	it('opens the transport, discovers modern support, and reports the newest common version', async () => {
		const loopback = createLoopback(serverWithTools())
		const client = createMCPClient({
			transport: loopback,
			identity: { name: 'tester', version: '9.9.9' },
		})

		expect(client.connected).toBe(false)
		await client.connect()

		expect(client.connected).toBe(true)
		expect(client.version).toBe('2026-07-28')
		expect(loopback.started).toBe(1)
		expect(loopback.sent).toEqual(['server/discover'])
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

	it('keeps a pinned legacy handshake unchanged, including its initialized notification', async () => {
		const loopback = createLoopback(serverWithTools())
		const client = createMCPClient({ transport: loopback, version: '2025-06-18' })

		await client.connect()

		expect(client.version).toBe('2025-06-18')
		expect(loopback.sent).toEqual(['initialize', 'notifications/initialized'])
	})

	it('rejects an unsupported legacy protocol, closes, and sends no initialized notification', async () => {
		const loopback = createFixturePeer((request) => {
			if (request.method !== 'initialize' || request.id === undefined) return undefined
			return initializeResponse(request.id, '2099-01-01')
		})
		const client = createMCPClient({ transport: loopback, version: MCP_PROTOCOL_VERSION })

		expect(client.version).toBeUndefined()
		await expect(client.connect()).rejects.toThrow(
			"MCP server negotiated unsupported protocol version '2099-01-01'",
		)
		expect(client.connected).toBe(false)
		expect(client.version).toBeUndefined()
		expect(loopback.closed).toBe(1)
		expect(loopback.sent).toEqual(['initialize'])
	})

	it('rejects an absent legacy protocol and closes before initialization completes', async () => {
		const loopback = createFixturePeer((request) => {
			if (request.method !== 'initialize' || request.id === undefined) return undefined
			return { jsonrpc: '2.0', id: request.id, result: { capabilities: {} } }
		})
		const client = createMCPClient({ transport: loopback, version: MCP_PROTOCOL_VERSION })

		await expect(client.connect()).rejects.toThrow('MCP server returned no protocol version')
		expect(client.connected).toBe(false)
		expect(client.version).toBeUndefined()
		expect(loopback.closed).toBe(1)
		expect(loopback.sent).toEqual(['initialize'])
	})

	it('rejects a malformed legacy protocol and closes before initialization completes', async () => {
		const loopback = createFixturePeer((request) => {
			if (request.method !== 'initialize' || request.id === undefined) return undefined
			return initializeResponse(request.id, 42)
		})
		const client = createMCPClient({ transport: loopback, version: MCP_PROTOCOL_VERSION })

		await expect(client.connect()).rejects.toThrow(
			'MCP server returned a malformed protocol version',
		)
		expect(client.connected).toBe(false)
		expect(client.version).toBeUndefined()
		expect(loopback.closed).toBe(1)
		expect(loopback.sent).toEqual(['initialize'])
	})
})

describe('MCPClient — modern discovery and fallback', () => {
	it('exposes discover() and stamps its request with version, capabilities, and client identity', async () => {
		const loopback = createLoopback(serverWithTools())
		const client = createMCPClient({
			transport: loopback,
			identity: { name: 'inspector', version: '2.0.0' },
			capabilities: { elicitation: {} },
		})

		const result = await client.discover()

		expect(result.supportedVersions).toEqual(['2026-07-28', '2025-11-25', '2025-06-18'])
		expect(result.resultType).toBe('complete')
		const request = loopback.requests[0]
		expect(request?.method).toBe('server/discover')
		expect(request?.params?.['_meta']).toEqual({
			[MCP_META_VERSION]: '2026-07-28',
			[MCP_META_CAPABILITIES]: { elicitation: {} },
			[MCP_META_CLIENT]: { name: 'inspector', version: '2.0.0' },
		})
	})

	it('retries -32022 exactly once with a new id and the newest mutually supported offer', async () => {
		let discoveries = 0
		const peer = createFixturePeer((request) => {
			if (request.method !== 'server/discover' || request.id === undefined) return undefined
			discoveries += 1
			if (discoveries === 1) {
				return errorResponse(request.id, MCP_UNSUPPORTED_VERSION, {
					supported: ['2025-11-25', '2025-06-18'],
				})
			}
			return discoverResponse(request.id, ['2025-11-25'])
		})
		const client = createMCPClient({ transport: peer })

		await client.connect()

		expect(client.version).toBe('2025-11-25')
		expect(peer.sent).toEqual(['server/discover', 'server/discover'])
		expect(peer.requests.map((request) => request.id)).toEqual([1, 2])
		expect(peer.requests[1]?.params?.['_meta']).toEqual({
			[MCP_META_VERSION]: '2025-11-25',
			[MCP_META_CAPABILITIES]: {},
			[MCP_META_CLIENT]: { name: 'taverna', version: '1.0.0' },
		})
	})

	it('surfaces -32022 without changing a pinned modern revision', async () => {
		const peer = createFixturePeer((request) => {
			if (request.method !== 'server/discover' || request.id === undefined) return undefined
			return errorResponse(request.id, MCP_UNSUPPORTED_VERSION, {
				supported: ['2025-11-25', '2025-06-18'],
			})
		})
		const client = createMCPClient({ transport: peer, version: '2026-07-28' })

		await expect(client.connect()).rejects.toMatchObject({ code: MCP_UNSUPPORTED_VERSION })

		expect(client.connected).toBe(false)
		expect(client.version).toBeUndefined()
		expect(peer.sent).toEqual(['server/discover'])
	})

	it('makes no third discovery attempt when the one retry also returns -32022', async () => {
		const peer = createFixturePeer((request) => {
			if (request.method !== 'server/discover' || request.id === undefined) return undefined
			return errorResponse(request.id, MCP_UNSUPPORTED_VERSION, {
				supported: ['2025-11-25'],
			})
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toMatchObject({ code: MCP_UNSUPPORTED_VERSION })

		expect(peer.sent).toEqual(['server/discover', 'server/discover'])
		expect(peer.requests.map((request) => request.id)).toEqual([1, 2])
	})

	it.each([JSONRPC_METHOD_NOT_FOUND, JSONRPC_INVALID_REQUEST])(
		'falls back to legacy initialize when discovery returns %i',
		async (code) => {
			const peer = createFixturePeer((request) => {
				if (request.id === undefined) return undefined
				if (request.method === 'server/discover') return errorResponse(request.id, code)
				if (request.method === 'initialize')
					return initializeResponse(request.id, MCP_PROTOCOL_VERSION)
				return undefined
			})
			const client = createMCPClient({ transport: peer })

			await client.connect()

			expect(client.version).toBe(MCP_PROTOCOL_VERSION)
			expect(peer.sent).toEqual(['server/discover', 'initialize', 'notifications/initialized'])
		},
	)

	it.each([
		['an unrecognized HTTP 400', 'HTTP 400 response did not contain a recognized modern error'],
		['an unrecognized HTTP 404', 'HTTP 404 response did not contain a recognized modern error'],
		['a transport send failure', 'Transport closed while sending'],
	])('falls back to legacy initialize after %s', async (_scenario, message) => {
		const peer = createFixturePeer((request) => {
			if (request.method === 'server/discover') return new Error(message)
			if (request.method === 'initialize' && request.id !== undefined) {
				return initializeResponse(request.id, MCP_PROTOCOL_VERSION)
			}
			return undefined
		})
		const client = createMCPClient({ transport: peer })

		await client.connect()

		expect(client.version).toBe(MCP_PROTOCOL_VERSION)
		expect(peer.sent).toEqual(['server/discover', 'initialize', 'notifications/initialized'])
	})

	it('surfaces a malformed result after a parseable discovery response settles the modern era', async () => {
		const peer = createFixturePeer((request) => {
			if (request.id === undefined) return undefined
			if (request.method === 'server/discover') {
				return initializeResponse(request.id, MCP_PROTOCOL_VERSION)
			}
			if (request.method === 'initialize') {
				return initializeResponse(request.id, MCP_PROTOCOL_VERSION)
			}
			return undefined
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toMatchObject({ code: JSONRPC_INVALID_PARAMS })

		expect(client.version).toBeUndefined()
		expect(peer.sent).toEqual(['server/discover'])
	})

	it('surfaces an unsupported result type from a parseable discovery response without fallback', async () => {
		const peer = createFixturePeer((request) => {
			if (request.id === undefined) return undefined
			if (request.method === 'server/discover') {
				return {
					jsonrpc: '2.0',
					id: request.id,
					result: {
						supportedVersions: ['2026-07-28'],
						capabilities: {},
						resultType: 'input_required',
						ttlMs: 60_000,
						cacheScope: 'private',
					},
				}
			}
			if (request.method === 'initialize') {
				return initializeResponse(request.id, MCP_PROTOCOL_VERSION)
			}
			return undefined
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toMatchObject({
			code: JSONRPC_INVALID_PARAMS,
			message: "MCP result type 'input_required' is not supported",
		})

		expect(client.connected).toBe(false)
		expect(peer.sent).toEqual(['server/discover'])
	})

	it('bounds a silent discovery probe and falls back when the peer sends no answer', async () => {
		const peer = createFixturePeer((request) => {
			if (request.method === 'initialize' && request.id !== undefined) {
				return initializeResponse(request.id, MCP_PROTOCOL_VERSION)
			}
			return undefined
		})
		const client = createMCPClient({ transport: peer, timeout: 5_000 })

		await client.connect()

		expect(client.version).toBe(MCP_PROTOCOL_VERSION)
		expect(peer.sent).toEqual(['server/discover', 'initialize', 'notifications/initialized'])
	})

	it('does not fall back when the modern revision is pinned', async () => {
		const peer = createFixturePeer((request) => {
			if (request.method !== 'server/discover' || request.id === undefined) return undefined
			return errorResponse(request.id, JSONRPC_METHOD_NOT_FOUND)
		})
		const client = createMCPClient({ transport: peer, version: '2026-07-28' })

		await expect(client.connect()).rejects.toMatchObject({ code: JSONRPC_METHOD_NOT_FOUND })
		expect(peer.sent).toEqual(['server/discover'])
		expect(client.connected).toBe(false)
	})

	it('surfaces a transport failure after the modern era has been settled', async () => {
		const peer = createFixturePeer((request) => {
			if (request.id === undefined) return undefined
			if (request.method === 'server/discover') return discoverResponse(request.id)
			if (request.method === 'tools/list') return new Error('Settled modern transport failed')
			return undefined
		})
		const client = createMCPClient({ transport: peer })
		await client.connect()

		await expect(client.tools()).rejects.toThrow('Settled modern transport failed')

		expect(peer.sent).toEqual(['server/discover', 'tools/list'])
		expect(client.version).toBe('2026-07-28')
	})

	it('caches a legacy era across disconnect and reconnect without probing modern again', async () => {
		const peer = createFixturePeer((request) => {
			if (request.id === undefined) return undefined
			if (request.method === 'server/discover') {
				return errorResponse(request.id, JSONRPC_METHOD_NOT_FOUND)
			}
			if (request.method === 'initialize')
				return initializeResponse(request.id, MCP_PROTOCOL_VERSION)
			return undefined
		})
		const client = createMCPClient({ transport: peer })

		await client.connect()
		await client.disconnect()
		await client.connect()

		expect(peer.sent).toEqual([
			'server/discover',
			'initialize',
			'notifications/initialized',
			'initialize',
			'notifications/initialized',
		])
		expect(client.version).toBe(MCP_PROTOCOL_VERSION)
	})

	it('stamps every modern request and sends no client notification', async () => {
		const loopback = createLoopback(serverWithTools())
		const client = createMCPClient({ transport: loopback })

		await client.connect()
		await client.tools()
		await client.call('greet', {})

		expect(loopback.sent).toEqual(['server/discover', 'tools/list', 'tools/call'])
		for (const request of loopback.requests) {
			expect(request.id).toBeDefined()
			expect(request.params?.['_meta']).toEqual({
				[MCP_META_VERSION]: '2026-07-28',
				[MCP_META_CAPABILITIES]: {},
				[MCP_META_CLIENT]: { name: 'taverna', version: '1.0.0' },
			})
		}
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

	it('a wrapped remote-erroring tool, added to a ToolManager, is isolated into a failure result', async () => {
		const client = createMCPClient({ transport: createLoopback(serverWithTools()) })
		await client.connect()
		const remote = createToolManager()
		remote.add(await client.tools())

		// The remote `boom` throws server-side (`isError`); the wrapped local tool re-throws,
		// and the local ToolManager isolates THAT into a failure result — exactly like a local
		// throw. The agent loop stays driveable.
		const result = await remote.execute({ id: 'c1', name: 'boom', arguments: {} })

		expect(result).toEqual({
			id: 'c1',
			name: 'boom',
			success: false,
			error: 'tool exploded',
		})
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

describe('MCPClient — result-type safety', () => {
	it('accepts a legacy result with no resultType', async () => {
		const client = createMCPClient({
			transport: createLoopback(serverWithTools()),
			version: MCP_PROTOCOL_VERSION,
		})
		await client.connect()

		expect(await client.call('greet', {})).toBe('hello')
	})

	it.each(['input_required', 'task', 'future'])(
		'rejects resultType %s with an MCPError that names it',
		async (resultType) => {
			const peer = createFixturePeer((request) => {
				if (request.id === undefined) return undefined
				if (request.method === 'server/discover') return discoverResponse(request.id)
				if (request.method === 'tools/list') {
					return { jsonrpc: '2.0', id: request.id, result: { tools: [], resultType } }
				}
				return undefined
			})
			const client = createMCPClient({ transport: peer })
			await client.connect()

			let caught: unknown
			try {
				await client.tools()
			} catch (error) {
				caught = error
			}

			expect(isMCPError(caught)).toBe(true)
			if (!isMCPError(caught)) throw new Error('Expected an MCPError')
			expect(caught.code).toBe(JSONRPC_INVALID_PARAMS)
			expect(caught.message).toBe(`MCP result type '${resultType}' is not supported`)
		},
	)
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

	it('preserves a remote JSON-RPC error code and data as an MCPError', async () => {
		const loopback = createLoopback(serverWithTools(), (method) => method === 'tools/list')
		const client = createMCPClient({ transport: loopback })
		await client.connect()
		const pending = client.tools()
		loopback.emitter.emit('message', {
			jsonrpc: '2.0',
			id: 2,
			error: {
				code: -32042,
				message: 'Remote failure',
				data: { retry: false },
			},
		})

		let caught: unknown
		try {
			await pending
		} catch (error) {
			caught = error
		}
		expect(isMCPError(caught)).toBe(true)
		if (!isMCPError(caught)) throw new Error('Expected an MCPError')
		expect(caught.message).toBe('Remote failure')
		expect(caught.code).toBe(-32042)
		expect(caught.context).toEqual({ retry: false })
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

	it('keeps the probe deadline scoped to discovery while another request is pending', async () => {
		const peer = createFixturePeer((request) => {
			if (request.method === 'initialize' && request.id !== undefined) {
				return initializeResponse(request.id, MCP_PROTOCOL_VERSION)
			}
			return undefined
		})
		const client = createMCPClient({ transport: peer, timeout: 200 })
		const connecting = client.connect()
		await waitForDelay()
		const listing = client.tools()

		await waitForDelay(75)
		peer.emitter.emit('message', { jsonrpc: '2.0', id: 2, result: { tools: [] } })

		await expect(listing).resolves.toEqual([])
		await connecting
		expect(peer.sent).toEqual([
			'server/discover',
			'tools/list',
			'initialize',
			'notifications/initialized',
		])
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
		expect(client.version).toBeUndefined()
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
		const error = errors[0]
		if (error === undefined) throw new Error('Expected the connect listener error')
		expect(error[1]).toBe('connect')
	})
})
