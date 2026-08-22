import type {
	JSONRPCNotification,
	JSONRPCResponse,
	MCPMethodHandler,
	MCPMethodOptions,
	MCPServerInterface,
	MCPStream,
	MCPSubscriptionFilter,
	MCPTransportInterface,
} from '@src/core'
import type { MemoryTransportInterface } from '../../setup.js'
import {
	bindClient,
	bindServer,
	buildDiscoverResult,
	buildInitializeResult,
	buildCallOutcome,
	buildCancelledNotification,
	buildJSONRPCError,
	buildJSONRPCResult,
	buildMethodOptions,
	buildModernResult,
	buildProgressNotification,
	buildSubscriptionAcknowledgement,
	buildSubscriptionFilter,
	buildSubscriptionResult,
	buildToolDescriptors,
	buildToolCall,
	createDuplexClientTransport,
	createMCPClient,
	createMCPLegacy,
	createMCPServer,
	decodeBoundedMessage,
	DEFAULT_MCP_CACHE_TTL,
	digestJSON,
	JSONRPC_PARSE_ERROR,
	extractContentText,
	MCP_EXTENSION_TASKS,
	MCP_META_CAPABILITIES,
	MCP_META_SERVER,
	MCP_META_SUBSCRIPTION,
	MCP_META_VERSION,
	matchesResultType,
	matchesSubscriptionNotification,
	MCPStreamController,
	MCPTextStreamController,
	readCancelledId,
	sendStream,
	serializeJSON,
	stampSubscriptionNotification,
} from '@src/core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createTool, createToolManager } from '@orkestrel/tool'
import * as MCP from '@src/core'
import { waitForAbort, waitForDelay } from '@orkestrel/test'
import {
	createJSONRPCNotification,
	createJSONRPCRequest,
	createMemoryTransport,
	modernRequest,
	probeOwnership,
	TestTaskManager,
} from '../../setup.js'

// An in-memory MCPTransportInterface double (a real duplex channel, no
// mocks): `listen`/`closed` each hold THE SINGLE handler (replace semantics, per the
// port's own contract), `send` records every outbound string (optionally rejecting
// when `failSend` is set), `deliver` drives inbound data, and `close` drives closure.
function createMemoryTransportPair(): readonly [
	MemoryTransportInterface,
	MemoryTransportInterface,
] {
	const server = createMemoryTransport()
	const client = createMemoryTransport()
	server.connect(client)
	client.connect(server)
	return [server, client]
}

// Held-open fixtures (an INERT data-driven stub, not a reimplementation
// of anything the package owns): `replay` is a real MCPStream over supplied messages,
// so each stream test names only the sequence its scenario needs.
const PROGRESS: JSONRPCNotification = Object.freeze({
	jsonrpc: '2.0',
	method: 'notifications/progress',
})
const TERMINAL: JSONRPCResponse = Object.freeze({ jsonrpc: '2.0', id: 1, result: { done: true } })

async function* replay(
	messages: readonly JSONRPCNotification[],
	response: JSONRPCResponse,
): MCPStream {
	for (const message of messages) yield message
	return response
}

// The registered handler form of it — a held-open modern method for the seam tests.
async function held(): Promise<MCPStream> {
	return replay([PROGRESS, PROGRESS], TERMINAL)
}

// A held-open producer parked on an event that will never arrive — the exact shape the
// standing ruling is about. It wakes only on its request signal, and records the method it
// belonged to from its `finally`, so a test can see whether anybody ended the exchange.
async function* parked(options: MCPMethodOptions, ended: string[]): MCPStream {
	try {
		yield PROGRESS
		await waitForAbort(options.signal)
		return TERMINAL
	} finally {
		ended.push('demo/parked')
	}
}

// A modern request — the reserved metadata key is what selects the modern era.
// The pure dispatch builders (exported, independently testable). Each
// turns a piece of MCP state into the JSON-RPC result payload (or envelope) the
// server returns.

describe('buildJSONRPCResult', () => {
	it('builds a success envelope echoing the id', () => {
		expect(buildJSONRPCResult(1, { ok: true })).toEqual({
			jsonrpc: '2.0',
			id: 1,
			result: { ok: true },
		})
	})

	it('carries the legacy result arm, which has no resultType', () => {
		expect(buildJSONRPCResult(1, { tools: [] })).toEqual({
			jsonrpc: '2.0',
			id: 1,
			result: { tools: [] },
		})
	})
})

describe('buildJSONRPCError', () => {
	it('builds an error envelope without data when none is given', () => {
		expect(buildJSONRPCError(1, -32601, 'Method not found')).toEqual({
			jsonrpc: '2.0',
			id: 1,
			error: { code: -32601, message: 'Method not found' },
		})
	})

	it('includes data when supplied', () => {
		expect(buildJSONRPCError(1, -32000, 'Server error', { detail: 'x' })).toEqual({
			jsonrpc: '2.0',
			id: 1,
			error: { code: -32000, message: 'Server error', data: { detail: 'x' } },
		})
	})

	// The id member is ABSENT when none could be read, not present-and-null, so a
	// modern peer never receives the `id: null` the base specification would have sent.
	it('omits the id member entirely when none could be read', () => {
		const envelope = buildJSONRPCError(undefined, -32700, 'Parse error')

		expect(envelope).toEqual({
			jsonrpc: '2.0',
			error: { code: -32700, message: 'Parse error' },
		})
		expect(Object.hasOwn(envelope, 'id')).toBe(false)
		expect(JSON.stringify(envelope)).not.toContain('id')
	})

	it('keeps an empty-string id, which is a legal id rather than an absent one', () => {
		const envelope = buildJSONRPCError('', -32600, 'Invalid Request')

		expect(Object.hasOwn(envelope, 'id')).toBe(true)
		expect(envelope.id).toBe('')
	})

	it('omits an unreadable id from the built envelope entirely', () => {
		const anonymous = buildJSONRPCError(undefined, -32_700, 'Parse error')
		const correlated = buildJSONRPCError('abc', -32_600, 'Invalid Request')

		expect(Object.hasOwn(anonymous, 'id')).toBe(false)
		expect(JSON.stringify(anonymous)).toBe(
			'{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error"}}',
		)
		expect(correlated.id).toBe('abc')
	})
})

// The resolution site. A caller may have no signal to offer; a dispatched method
// always has one to observe, so absence is resolved ONCE here rather than cased on by
// every handler, elicitation, principal, and subscription producer downstream.
describe('buildMethodOptions', () => {
	it('resolves the request lifetime alone when the caller supplied no signal', () => {
		const lifetime = new AbortController()
		const resolved = buildMethodOptions({}, lifetime.signal)

		expect(resolved.signal).toBe(lifetime.signal)
		expect(resolved.signal.aborted).toBe(false)
	})

	it('omits caller rather than carrying an undefined one', () => {
		const resolved = buildMethodOptions({}, new AbortController().signal)

		expect(Object.hasOwn(resolved, 'caller')).toBe(false)
		expect(Object.keys(resolved)).toEqual(['signal'])
	})

	// The resolved signal is WIDER than the caller's on purpose: a producer must learn both
	// that its caller left and that the answer it was producing has finished.
	it('composes the caller’s signal with the lifetime, honouring either abort', () => {
		const caller = new AbortController()
		const lifetime = new AbortController()
		const fromCaller = buildMethodOptions({ signal: caller.signal }, lifetime.signal)
		const fromLifetime = buildMethodOptions(
			{ signal: new AbortController().signal },
			lifetime.signal,
		)

		expect(fromCaller.signal).not.toBe(caller.signal)
		expect(fromCaller.signal.aborted).toBe(false)
		caller.abort()
		expect(fromCaller.signal.aborted).toBe(true)
		expect(fromLifetime.signal.aborted).toBe(false)
		lifetime.abort()
		expect(fromLifetime.signal.aborted).toBe(true)
	})

	it('carries the unverified caller by identity, without inspecting or copying it', () => {
		const caller = Object.freeze({ subject: 'someone' })

		expect(buildMethodOptions({ caller }, new AbortController().signal).caller).toBe(caller)
	})

	it('resolves a distinct signal per call, so one request cannot abort another', () => {
		expect(buildMethodOptions({}, new AbortController().signal).signal).not.toBe(
			buildMethodOptions({}, new AbortController().signal).signal,
		)
	})
})

describe('buildToolDescriptors', () => {
	it('maps definitions, renaming parameters to inputSchema', () => {
		const manager = createToolManager()
		manager.add(
			createTool({
				name: 'sum',
				description: 'Add',
				parameters: { type: 'object', properties: { a: { type: 'number' } } },
				execute: () => 0,
			}),
		)

		expect(buildToolDescriptors(manager)).toEqual([
			{
				name: 'sum',
				description: 'Add',
				inputSchema: { type: 'object', properties: { a: { type: 'number' } } },
			},
		])
	})

	it('defaults inputSchema to an empty object schema when a tool declares none', () => {
		const manager = createToolManager()
		manager.add(createTool({ name: 'echo', execute: () => 0 }))

		expect(buildToolDescriptors(manager)).toEqual([
			{ name: 'echo', inputSchema: { type: 'object' } },
		])
	})

	it('returns an empty list for an empty registry', () => {
		expect(buildToolDescriptors(createToolManager())).toEqual([])
	})
})

describe('modern execution helpers', () => {
	it('exposes public ownership mechanisms while retaining the private result builder', () => {
		expect('buildCallResult' in MCP).toBe(false)
		expect('MCPProgressReporter' in MCP).toBe(true)
		expect('snapshotJSON' in MCP).toBe(true)
		expect('snapshotToolResult' in MCP).toBe(true)
	})
	it('serializes object keys canonically and hashes equivalent bounded JSON identically', async () => {
		const limits = { bytes: 128, keys: 4, depth: 4 }

		expect(serializeJSON({ beta: 2, alpha: [1, true] }, limits)).toBe('{"alpha":[1,true],"beta":2}')
		expect(await digestJSON({ beta: 2, alpha: [1, true] }, limits)).toBe(
			await digestJSON({ alpha: [1, true], beta: 2 }, limits),
		)
		expect(await digestJSON({ alpha: Number.NaN }, limits)).toBeUndefined()
	})

	it('serializes the exact JSON string and number population at byte boundaries', () => {
		const value = {
			astral: '😀',
			control: '\n',
			exponent: 1e21,
			lone: '\ud800',
			negative: -0,
			slash: '/',
		}
		const serialized =
			'{"astral":"😀","control":"\\n","exponent":1e+21,"lone":"\\ud800","negative":0,"slash":"/"}'
		const bytes = new TextEncoder().encode(serialized).byteLength

		expect(serializeJSON(value, { bytes, keys: 6, depth: 1 })).toBe(serialized)
		expect(serializeJSON(value, { bytes: bytes - 1, keys: 6, depth: 1 })).toBeUndefined()
	})

	it('captures each data descriptor once and serializes that owned snapshot', () => {
		let reads = 0
		const value = new Proxy(
			{ value: 'first' },
			{
				getOwnPropertyDescriptor(target, property) {
					if (property !== 'value') return Reflect.getOwnPropertyDescriptor(target, property)
					reads += 1
					return {
						configurable: true,
						enumerable: true,
						value: reads === 1 ? 'first' : 'changed',
						writable: true,
					}
				},
			},
		)

		expect(serializeJSON(value, { bytes: 64, keys: 1, depth: 1 })).toBe('{"value":"first"}')
		expect(reads).toBe(1)
	})

	it('rejects non-exact arrays and invalid serializer limits without throwing', () => {
		const sparse = Array.from({ length: 2 })
		const extra = [1]
		Object.defineProperty(extra, 'extra', { enumerable: true, value: true })
		const hidden = [1]
		Object.defineProperty(hidden, '0', { enumerable: false, value: 1 })

		for (const value of [sparse, extra, hidden]) {
			expect(serializeJSON(value, { bytes: 64, keys: 4, depth: 1 })).toBeUndefined()
		}
		for (const limits of [
			{ bytes: Number.NaN, depth: 1 },
			{ bytes: 64, depth: 1.5 },
			{ bytes: 64, depth: 1, keys: -1 },
		]) {
			expect(serializeJSON({}, limits)).toBeUndefined()
		}
	})

	it('preflights array bounds and active cycles before repeated reflection', () => {
		let keyReads = 0
		const bounded = new Proxy([1], {
			ownKeys(target) {
				keyReads += 1
				return Reflect.ownKeys(target)
			},
		})

		expect(serializeJSON(bounded, { bytes: 64, keys: 0, depth: 1 })).toBeUndefined()
		expect(keyReads).toBe(0)

		let cycleReads = 0
		const target: unknown[] = []
		const cycle = new Proxy(target, {
			ownKeys(value) {
				cycleReads += 1
				return Reflect.ownKeys(value)
			},
		})
		target.push(cycle)

		expect(serializeJSON(cycle, { bytes: 128, keys: 2, depth: 2 })).toBeUndefined()
		expect(cycleReads).toBe(1)
	})

	it('preflights a wide record after one key snapshot and before descriptors', () => {
		let keyReads = 0
		let descriptorReads = 0
		const value = new Proxy(
			{ alpha: 1, beta: 2 },
			{
				ownKeys(target) {
					keyReads += 1
					return Reflect.ownKeys(target)
				},
				getOwnPropertyDescriptor(target, property) {
					descriptorReads += 1
					return Reflect.getOwnPropertyDescriptor(target, property)
				},
			},
		)

		expect(serializeJSON(value, { bytes: 64, keys: 1, depth: 1 })).toBeUndefined()
		expect(keyReads).toBe(1)
		expect(descriptorReads).toBe(0)
	})

	it('builds the canonical Tool call and official progress notification', () => {
		expect(
			buildToolCall(
				createJSONRPCRequest({
					id: 7,
					method: 'tools/call',
					params: { name: 'echo', arguments: { value: 1 } },
				}),
				{ subject: 'caller' },
			),
		).toEqual({
			id: '7',
			name: 'echo',
			arguments: { value: 1 },
			caller: { subject: 'caller' },
		})
		expect(
			buildProgressNotification('token', { progress: 2, total: 4, message: 'halfway' }),
		).toEqual({
			jsonrpc: '2.0',
			method: 'notifications/progress',
			params: { progressToken: 'token', progress: 2, total: 4, message: 'halfway' },
		})
	})
})

describe('buildModernResult', () => {
	it('stamps tools/list with both required cache fields, preserving zero as immediately stale', () => {
		const identity = { name: 'server', version: '1.0.0' }

		expect(buildModernResult({ tools: [] }, identity, 0, 'public')).toEqual({
			tools: [],
			resultType: 'complete',
			ttlMs: 0,
			cacheScope: 'public',
			_meta: { [MCP_META_SERVER]: identity },
		})
	})

	it('stamps tools/call with resultType and neither cache field', () => {
		const identity = { name: 'server', version: '1.0.0' }
		const modern = buildModernResult(
			{ content: [{ type: 'text', text: '7' }], structuredContent: 7 },
			identity,
		)

		expect(modern).toEqual({
			content: [{ type: 'text', text: '7' }],
			structuredContent: 7,
			resultType: 'complete',
			_meta: { [MCP_META_SERVER]: identity },
		})
		expect(Object.hasOwn(modern, 'ttlMs')).toBe(false)
		expect(Object.hasOwn(modern, 'cacheScope')).toBe(false)
	})

	it('defaults a supplied cache lifetime to private scope and preserves existing metadata', () => {
		const identity = { name: 'server', version: '1.0.0' }

		expect(buildModernResult({ tools: [], _meta: { extension: true } }, identity, 10)).toEqual({
			tools: [],
			resultType: 'complete',
			ttlMs: 10,
			cacheScope: 'private',
			_meta: { extension: true, [MCP_META_SERVER]: identity },
		})
	})
})

describe('subscription helpers', () => {
	it('intersects requested notification families with exact server support', () => {
		expect(
			buildSubscriptionFilter(
				{
					toolsListChanged: true,
					promptsListChanged: true,
					resourcesListChanged: false,
					resourceSubscriptions: ['resource://two', 'resource://one'],
				},
				{
					toolsListChanged: true,
					resourcesListChanged: true,
					resourceSubscriptions: ['resource://one'],
				},
			),
		).toEqual({ toolsListChanged: true, resourceSubscriptions: ['resource://one'] })
	})

	it('matches only acknowledged notification families and resource URIs', () => {
		const filter = { toolsListChanged: true, resourceSubscriptions: ['resource://one'] }

		expect(
			matchesSubscriptionNotification(
				{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
				filter,
			),
		).toBe(true)
		expect(
			matchesSubscriptionNotification(
				{ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' },
				filter,
			),
		).toBe(false)
		expect(
			matchesSubscriptionNotification(
				{
					jsonrpc: '2.0',
					method: 'notifications/resources/updated',
					params: { uri: 'resource://one' },
				},
				filter,
			),
		).toBe(true)
		expect(
			matchesSubscriptionNotification(
				{
					jsonrpc: '2.0',
					method: 'notifications/resources/updated',
					params: { uri: 'resource://two' },
				},
				filter,
			),
		).toBe(false)
	})

	it('stamps notifications while preserving metadata and overriding an offered stream id', () => {
		expect(
			stampSubscriptionNotification(
				{
					jsonrpc: '2.0',
					method: 'notifications/tools/list_changed',
					params: { _meta: { extension: true, [MCP_META_SUBSCRIPTION]: 'wrong' } },
				},
				'listen-1',
			),
		).toEqual({
			jsonrpc: '2.0',
			method: 'notifications/tools/list_changed',
			params: { _meta: { extension: true, [MCP_META_SUBSCRIPTION]: 'listen-1' } },
		})
	})

	it('builds the exact acknowledgement and graceful closing result', () => {
		const identity = { name: 'server', version: '1.0.0' }

		expect(buildSubscriptionAcknowledgement({ toolsListChanged: true }, 7)).toEqual({
			jsonrpc: '2.0',
			method: 'notifications/subscriptions/acknowledged',
			params: {
				notifications: { toolsListChanged: true },
				_meta: { [MCP_META_SUBSCRIPTION]: 7 },
			},
		})
		expect(buildSubscriptionResult(7, identity)).toEqual({
			jsonrpc: '2.0',
			id: 7,
			result: {
				resultType: 'complete',
				_meta: { [MCP_META_SUBSCRIPTION]: 7, [MCP_META_SERVER]: identity },
			},
		})
	})
})

describe('buildDiscoverResult', () => {
	it('builds the mandatory discovery result with safe cache defaults', () => {
		const identity = { name: 'server', version: '1.0.0' }

		expect(buildDiscoverResult({ identity, tools: createToolManager() })).toEqual({
			supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
			capabilities: { tools: {} },
			resultType: 'complete',
			ttlMs: DEFAULT_MCP_CACHE_TTL,
			cacheScope: 'private',
			_meta: { [MCP_META_SERVER]: identity },
		})
	})

	it('carries configured instructions, zero ttl, and public scope', () => {
		const identity = { name: 'server', version: '1.0.0' }

		expect(
			buildDiscoverResult({
				identity,
				tools: createToolManager(),
				instructions: 'Use carefully',
				cache: { ttl: 0, scope: 'public' },
			}),
		).toEqual({
			supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
			capabilities: { tools: {} },
			instructions: 'Use carefully',
			resultType: 'complete',
			ttlMs: 0,
			cacheScope: 'public',
			_meta: { [MCP_META_SERVER]: identity },
		})
	})

	// An advertisement is a promise a client may act on, so the extension key appears only
	// for a server that configured the extension it would be naming.
	it('advertises the tasks extension only for a server that configured it', () => {
		const identity = { name: 'server', version: '1.0.0' }
		const plain = buildDiscoverResult({ identity, tools: createToolManager() })
		const configured = buildDiscoverResult({
			identity,
			tools: createToolManager(),
			task: {
				tasks: new TestTaskManager(),
				defer: () => undefined,
			},
		})

		expect(configured.capabilities).toEqual({
			tools: {},
			extensions: { [MCP_EXTENSION_TASKS]: {} },
		})
		expect(plain.capabilities).toEqual({ tools: {} })
		expect(Object.hasOwn(plain.capabilities, 'extensions')).toBe(false)
	})
})

describe('buildInitializeResult', () => {
	it('uses the newest supported legacy revision when none requested', () => {
		expect(buildInitializeResult('s', '1.0.0')).toEqual({
			protocolVersion: '2025-11-25',
			capabilities: { tools: {} },
			serverInfo: { name: 's', version: '1.0.0' },
		})
	})

	it('echoes either supported legacy revision', () => {
		expect(buildInitializeResult('s', '1.0.0', '2025-11-25')['protocolVersion']).toBe('2025-11-25')
		expect(buildInitializeResult('s', '1.0.0', '2025-06-18')['protocolVersion']).toBe('2025-06-18')
	})

	it('answers a modern initialize request with the newest legacy revision', () => {
		expect(buildInitializeResult('s', '1.0.0', '2026-07-28')['protocolVersion']).toBe('2025-11-25')
	})

	it('falls back when the requested revision requires unsupported batching', () => {
		expect(buildInitializeResult('s', '1.0.0', '2025-03-26')['protocolVersion']).toBe('2025-11-25')
	})

	it('falls back to the newest legacy revision for an unsupported requested version', () => {
		expect(buildInitializeResult('s', '1.0.0', '1999-01-01')['protocolVersion']).toBe('2025-11-25')
	})
})

// bindServer — pipes an MCPTransportInterface into a REAL MCPServer over a REAL
// ToolManager (no mocks). Covers the round trip, the notification
// no-reply path, unbind detaching without closing, a `send` throw surfacing on
// `server.emitter`'s `error` event (never unhandled), and the transport's own
// `closed` signal deactivating the binder.
describe('bindServer', () => {
	function server() {
		const tools = createToolManager()
		tools.add(createTool({ name: 'add', execute: (a) => Number(a['x']) + Number(a['y']) }))
		return createMCPServer({ identity: { name: 'demo', version: '1.0.0' }, tools })
	}

	it('serves a legacy initialize and tools/call through the decorator over a real duplex pair', async () => {
		const [serverTransport, clientTransport] = createMemoryTransportPair()
		const unbindServer = bindServer(createMCPLegacy(server()), serverTransport)
		const client = createMCPClient({
			transport: createDuplexClientTransport(clientTransport),
			version: '2025-06-18',
		})
		const unbindClient = bindClient(client, clientTransport)

		await client.connect()
		expect(client.version).toBe('2025-06-18')
		expect(await client.call('add', { x: 2, y: 3 })).toEqual({ resultType: 'complete', value: 5 })
		await client.disconnect()
		unbindClient()
		unbindServer()
	})

	it('CONTROL — a bare server answers modern-shaped initialize with -32601 over a real duplex pair', async () => {
		const [serverTransport, clientTransport] = createMemoryTransportPair()
		const unbindServer = bindServer(server(), serverTransport)

		const legacy = new Promise<string>((resolve) => clientTransport.listen(resolve))
		await clientTransport.send(
			JSON.stringify(
				createJSONRPCRequest({
					method: 'initialize',
					params: { protocolVersion: '2025-06-18' },
				}),
			),
		)
		expect(JSON.parse(await legacy)).toMatchObject({ error: { code: -32601 } })

		const modern = new Promise<string>((resolve) => clientTransport.listen(resolve))
		await clientTransport.send(
			JSON.stringify(
				createJSONRPCRequest({
					method: 'initialize',
					params: {
						_meta: {
							[MCP_META_VERSION]: '2026-07-28',
							[MCP_META_CAPABILITIES]: {},
						},
					},
				}),
			),
		)
		expect(JSON.parse(await modern)).toMatchObject({ error: { code: -32601 } })
		unbindServer()
	})

	it('dispatches an inbound request string and sends the reply string out', async () => {
		const mcp = server()
		const transport = createMemoryTransport()
		bindServer(mcp, transport)

		transport.deliver(JSON.stringify(modernRequest('ping')))
		await waitForDelay()

		expect(transport.sent).toEqual([
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				result: {
					resultType: 'complete',
					_meta: { [MCP_META_SERVER]: { name: 'demo', version: '1.0.0' } },
				},
			}),
		])
	})

	it('sends nothing for a notification (no id → no reply)', async () => {
		const mcp = server()
		const transport = createMemoryTransport()
		bindServer(mcp, transport)

		transport.deliver(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
		await waitForDelay()

		expect(transport.sent).toEqual([])
	})

	it('unbind detaches inbound delivery WITHOUT closing the transport', async () => {
		const mcp = server()
		const transport = createMemoryTransport()
		const unbind = bindServer(mcp, transport)
		unbind()

		transport.deliver(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 1 })))
		await waitForDelay()

		expect(transport.sent).toEqual([])
		expect(transport.closedCalls).toBe(0)
	})

	it('a send throw surfaces on server.emitter error, never as an unhandled rejection', async () => {
		const mcp = server()
		const transport = createMemoryTransport()
		transport.fail(new Error('boom'))
		const seen: unknown[] = []
		mcp.emitter.on('error', (error) => seen.push(error))
		bindServer(mcp, transport)

		transport.deliver(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 1 })))
		await waitForDelay()
		await Promise.resolve()

		expect(seen).toEqual([transport.failSend])
	})

	it('a throwing error listener is swallowed, not rethrown into the binder', async () => {
		const mcp = server()
		const transport = createMemoryTransport()
		transport.fail(new Error('boom'))
		mcp.emitter.on('error', () => {
			throw new Error('listener bug')
		})
		bindServer(mcp, transport)

		transport.deliver(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 1 })))
		await waitForDelay()
		await Promise.resolve()

		// Reaching here (no unhandled rejection failing the run) is the assertion.
		expect(transport.sent).toEqual([])
	})

	it('closing the transport deactivates the binder (further inbound is ignored)', async () => {
		const mcp = server()
		const transport = createMemoryTransport()
		bindServer(mcp, transport)
		await transport.close()

		transport.deliver(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 1 })))
		await waitForDelay()

		expect(transport.sent).toEqual([])
	})

	it('rebind after unbind on the SAME transport replies exactly once per request (no double dispatch)', async () => {
		const mcp = server()
		const transport = createMemoryTransport()
		const unbind = bindServer(mcp, transport)
		unbind()
		bindServer(mcp, transport)

		transport.deliver(JSON.stringify(modernRequest('ping')))
		await waitForDelay()

		expect(transport.sent).toEqual([
			JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				result: {
					resultType: 'complete',
					_meta: { [MCP_META_SERVER]: { name: 'demo', version: '1.0.0' } },
				},
			}),
		])
	})

	it('pumps a held-open reply onto the transport, notifications first and the response last', async () => {
		const mcp = server()
		mcp.methods.add('demo/stream', held)
		const transport = createMemoryTransport()
		bindServer(mcp, transport)

		transport.deliver(JSON.stringify(modernRequest('demo/stream')))
		await waitForDelay()

		expect(transport.sent).toEqual([
			JSON.stringify(PROGRESS),
			JSON.stringify(PROGRESS),
			JSON.stringify(TERMINAL),
		])
	})

	it('routes a mid-stream send failure to server.emitter error, never as an unhandled rejection', async () => {
		const mcp = server()
		mcp.methods.add('demo/stream', held)
		const transport = createMemoryTransport()
		transport.fail(new Error('stream send boom'))
		const seen: unknown[] = []
		mcp.emitter.on('error', (error) => seen.push(error))
		bindServer(mcp, transport)

		transport.deliver(JSON.stringify(modernRequest('demo/stream')))
		await waitForDelay()
		await Promise.resolve()

		expect(seen).toEqual([transport.failSend])
		expect(transport.sent).toEqual([])
	})
})

// sendStream — the held-open leaf `handle` and `bindServer` compose. It consumes the stream
// MANUALLY, because the terminating response is the `return` value and `for await` discards
// it; these tests pin exactly that distinction. It takes a serialized CONTROLLED stream, so
// each case wraps its source the way dispatch does — the translation entity's own lifecycle
// proofs live in its mirrored test file.
function controlled(source: MCPStream): MCPTextStreamController {
	const closure = new AbortController()
	return new MCPTextStreamController(new MCPStreamController(source, closure.signal, closure))
}

describe('sendStream', () => {
	it('writes every message in order and the terminating response last', async () => {
		const transport = createMemoryTransport()

		await sendStream(controlled(replay([PROGRESS, PROGRESS], TERMINAL)), transport)

		expect(transport.sent).toEqual([
			JSON.stringify(PROGRESS),
			JSON.stringify(PROGRESS),
			JSON.stringify(TERMINAL),
		])
	})

	it('writes only the terminating response for a stream that yields nothing', async () => {
		const transport = createMemoryTransport()

		await sendStream(controlled(replay([], TERMINAL)), transport)

		expect(transport.sent).toEqual([JSON.stringify(TERMINAL)])
	})

	it('rejects with the transport failure rather than swallowing it', async () => {
		const transport = createMemoryTransport()
		transport.fail(new Error('send boom'))

		await expect(sendStream(controlled(replay([PROGRESS], TERMINAL)), transport)).rejects.toBe(
			transport.failSend,
		)
	})
})

// ── The standing ruling: whoever is handed a controlled exchange ends it ─────
//
// It fired after repeated defects at one seam, the last arriving by the opposite mechanism
// from the earlier ones: cancellation was not blocked, it was never ISSUED, because no signal
// fires when nobody aborts anything. So the claim under test is about a POPULATION of pumps,
// and `probeOwnership` is the shared instrument that measures all of them the same way — the
// live subscription SLOT, which an abandoned exchange holds forever.
//
// The negative control is drawn from OUTSIDE that population on purpose: a hand-written
// consumer the ruling does not cover, which reads one message and returns. Another failure
// mode of `sendStream` would be inside the population and would only prove the instrument
// discriminates among pumps it already handles.

describe('exchange ownership — the instrument and its outside-population control', () => {
	it('reports a hand-written consumer that reads one message and walks away as LEAKING', async () => {
		const outcome = await probeOwnership(async (stream) => {
			await stream.next()
		})

		expect(outcome.released).toBe(false)
		expect(outcome.failure).toBeUndefined()
	})

	it('reports an exchange the consumer explicitly ended as RELEASED', async () => {
		const outcome = await probeOwnership(async (stream) => {
			await stream.next()
			await stream[Symbol.asyncDispose]()
		})

		expect(outcome.released).toBe(true)
	})
})

describe('sendStream — ends the exchange on every exit', () => {
	it('releases a parked producer when the transport send throws mid-stream', async () => {
		const failure = new Error('send boom')
		const outcome = await probeOwnership(async (stream) => {
			const transport = createMemoryTransport()
			transport.fail(failure)
			await sendStream(new MCPTextStreamController(stream), transport)
		})

		expect(outcome.failure).toBe(failure)
		expect(outcome.released).toBe(true)
	})

	it('releases the exchange when the consumer of the pump abandons it after one message', async () => {
		const transport = createMemoryTransport()
		transport.fail(new Error('send boom'))
		const closure = new AbortController()
		const stream = new MCPStreamController(
			replay([PROGRESS, PROGRESS], TERMINAL),
			closure.signal,
			closure,
		)

		await expect(sendStream(new MCPTextStreamController(stream), transport)).rejects.toThrow(
			'send boom',
		)

		expect(closure.signal.aborted).toBe(true)
	})

	it('ends the exchange on the normal exit too, after the terminating response', async () => {
		const transport = createMemoryTransport()
		const closure = new AbortController()
		const stream = new MCPStreamController(replay([PROGRESS], TERMINAL), closure.signal, closure)

		await sendStream(new MCPTextStreamController(stream), transport)

		expect(transport.sent).toEqual([JSON.stringify(PROGRESS), JSON.stringify(TERMINAL)])
		expect(closure.signal.aborted).toBe(true)
	})
})

describe('decodeBoundedMessage', () => {
	const limits = Object.freeze({ bytes: 128, depth: 8 })

	it('decodes a well-formed message inside the bound', () => {
		const message = JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 1 }))

		expect(decodeBoundedMessage(message, limits)).toEqual({
			jsonrpc: '2.0',
			method: 'ping',
			id: 1,
		})
	})

	it('refuses a well-formed message ABOVE the bound', () => {
		const message = JSON.stringify(
			createJSONRPCRequest({ method: 'ping', id: 1, params: { pad: 'x'.repeat(256) } }),
		)

		expect(message.length).toBeGreaterThan(limits.bytes)
		expect(decodeBoundedMessage(message, limits)).toBeUndefined()
	})

	it('answers undefined for malformed JSON and for a value that is not a message', () => {
		expect(decodeBoundedMessage('{', limits)).toBeUndefined()
		expect(decodeBoundedMessage('"plain"', limits)).toBeUndefined()
		expect(decodeBoundedMessage('{"jsonrpc":"1.0","method":"ping","id":1}', limits)).toBeUndefined()
	})
})

describe('readCancelledId', () => {
	it('reads the request id an inbound cancellation names', () => {
		expect(readCancelledId(buildCancelledNotification(7, 'caller left'))).toBe(7)
		expect(readCancelledId(buildCancelledNotification('call-a'))).toBe('call-a')
	})

	it('cancels nothing for another notification, a request, or a malformed requestId', () => {
		expect(readCancelledId(createJSONRPCNotification('notifications/progress'))).toBeUndefined()
		expect(
			readCancelledId(
				createJSONRPCRequest({
					method: 'notifications/cancelled',
					id: 1,
					params: { requestId: 2 },
				}),
			),
		).toBeUndefined()
		expect(
			readCancelledId(createJSONRPCNotification('notifications/cancelled', { requestId: null })),
		).toBeUndefined()
		expect(readCancelledId(createJSONRPCNotification('notifications/cancelled'))).toBeUndefined()
	})
})

describe('bindServer — exchange ownership and inbound cancellation', () => {
	function server() {
		const tools = createToolManager()
		tools.add(createTool({ name: 'add', execute: (a) => Number(a['x']) + Number(a['y']) }))
		return createMCPServer({ identity: { name: 'demo', version: '1.0.0' }, tools })
	}

	function boundedServer() {
		const tools = createToolManager()
		return createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools,
			limit: { message: 240 },
		})
	}

	it('ends an in-flight exchange when the transport closes mid-pump', async () => {
		const mcp = server()
		const ended: string[] = []
		mcp.methods.add('demo/parked', async (_request, options) => parked(options, ended))
		const transport = createMemoryTransport()
		bindServer(mcp, transport)

		transport.deliver(JSON.stringify(modernRequest('demo/parked')))
		await waitForDelay()
		expect(transport.sent).toEqual([JSON.stringify(PROGRESS)])
		expect(ended).toEqual([])

		await transport.close()
		await waitForDelay()

		expect(ended).toEqual(['demo/parked'])
		expect(transport.sent).toEqual([JSON.stringify(PROGRESS)])
	})

	it.each(['unbind→close', 'close→unbind'])('%s ends every in-flight exchange', async (order) => {
		const mcp = server()
		const ended: string[] = []
		mcp.methods.add('demo/parked', async (_request, options) => parked(options, ended))
		const transport = createMemoryTransport()
		const unbind = bindServer(mcp, transport)

		transport.deliver(JSON.stringify(modernRequest('demo/parked')))
		await waitForDelay()
		expect(ended).toEqual([])

		if (order === 'unbind→close') {
			unbind()
			await transport.close()
		} else {
			await transport.close()
			unbind()
		}
		await waitForDelay()

		expect(ended).toEqual(['demo/parked'])
		expect(transport.sent).toEqual([JSON.stringify(PROGRESS)])
	})

	it('leaves no abandoned exchange when the pump fails and the catch reports it', async () => {
		const mcp = server()
		const ended: string[] = []
		mcp.methods.add('demo/parked', async (_request, options) => parked(options, ended))
		const transport = createMemoryTransport()
		transport.fail(new Error('stream send boom'))
		const seen: unknown[] = []
		mcp.emitter.on('error', (error) => seen.push(error))
		bindServer(mcp, transport)

		transport.deliver(JSON.stringify(modernRequest('demo/parked')))
		await waitForDelay()

		expect(seen).toEqual([transport.failSend])
		expect(ended).toEqual(['demo/parked'])
	})

	it('never decodes an inbound message above the server own bound, and handle still answers -32700', async () => {
		const mcp = boundedServer()
		const transport = createMemoryTransport()
		bindServer(mcp, transport)
		const oversized = JSON.stringify(
			createJSONRPCRequest({ method: 'ping', id: 1, params: { pad: 'x'.repeat(512) } }),
		)

		expect(oversized.length).toBeGreaterThan(mcp.limit.message)
		transport.deliver(oversized)
		await waitForDelay()

		expect(transport.sent).toEqual([
			JSON.stringify(buildJSONRPCError(undefined, JSONRPC_PARSE_ERROR, 'Parse error')),
		])
	})

	// The control that separates "the bound is real" from "the bound is never hit": a
	// WELL-FORMED cancellation above the bound. The binder must not decode it, so the request
	// it names keeps running — while the identical cancellation under the bound cancels.
	it('refuses to decode a well-formed cancellation above the bound, and honours one below it', async () => {
		const mcp = boundedServer()
		const ended: string[] = []
		mcp.methods.add('demo/parked', async (_request, options) => parked(options, ended))
		const transport = createMemoryTransport()
		bindServer(mcp, transport)
		transport.deliver(JSON.stringify(modernRequest('demo/parked')))
		await waitForDelay()

		const padded = buildCancelledNotification(1, 'y'.repeat(512))
		expect(JSON.stringify(padded).length).toBeGreaterThan(mcp.limit.message)
		transport.deliver(JSON.stringify(padded))
		await waitForDelay()
		expect(ended).toEqual([])

		transport.deliver(JSON.stringify(buildCancelledNotification(1)))
		await waitForDelay()

		expect(ended).toEqual(['demo/parked'])
	})

	it('aborts the request an inbound cancellation names, and writes no response for it', async () => {
		const mcp = server()
		const observed: string[] = []
		mcp.methods.add('demo/slow', async (request, options) => {
			await waitForAbort(options.signal)
			observed.push('aborted')
			return buildJSONRPCResult(request.id, { late: true })
		})
		const transport = createMemoryTransport()
		bindServer(mcp, transport)

		transport.deliver(JSON.stringify(modernRequest('demo/slow')))
		await waitForDelay()
		expect(observed).toEqual([])

		transport.deliver(JSON.stringify(buildCancelledNotification(1)))
		await waitForDelay()

		expect(observed).toEqual(['aborted'])
		expect(transport.sent).toEqual([])
	})

	it('releases a held-open answer that was cancelled rather than pumping it', async () => {
		const mcp = server()
		const ended: string[] = []
		mcp.methods.add('demo/parked', async (_request, options) => parked(options, ended))
		const transport = createMemoryTransport()
		const seen: unknown[] = []
		mcp.emitter.on('error', (error) => seen.push(error))
		bindServer(mcp, transport)

		transport.deliver(JSON.stringify(modernRequest('demo/parked')))
		await waitForDelay()
		transport.deliver(JSON.stringify(buildCancelledNotification(1)))
		await waitForDelay()

		expect(ended).toEqual(['demo/parked'])
		expect(transport.sent).toEqual([JSON.stringify(PROGRESS)])
		// A cancellation is not a fault, so nothing reaches the operator's error feed.
		expect(seen).toEqual([])
	})

	it('a cancellation naming a request that is not live is a silent no-op', async () => {
		const mcp = server()
		const transport = createMemoryTransport()
		bindServer(mcp, transport)

		transport.deliver(JSON.stringify(buildCancelledNotification('never-issued')))
		await waitForDelay()

		expect(transport.sent).toEqual([])
	})

	// The registry is closure-private, so the observable is the signal the binder SUPPLIES:
	// a controller still in the map when the carrier dies is aborted, and one already retired
	// is not. Ten thousand completed requests, then one still in flight — the in-flight request
	// is the control proving the instrument can see an abort at all.
	it('retires each live-request entry on exit, so a closed carrier aborts only what is still running', async () => {
		const real = server()
		const signals: AbortSignal[] = []
		let release: (() => void) | undefined
		const stub: MCPServerInterface = {
			emitter: real.emitter,
			identity: real.identity,
			methods: real.methods,
			limit: real.limit,
			dispatch: real.dispatch.bind(real),
			async handle(_message, options) {
				const signal = options?.signal
				if (signal === undefined) throw new Error('the binder must supply a request signal')
				signals.push(signal)
				if (signals.length > 10_000) {
					await new Promise<void>((resolve) => {
						release = resolve
					})
				}
				return undefined
			},
		}
		const transport = createMemoryTransport()
		bindServer(stub, transport)
		for (let index = 0; index < 10_000; index += 1) {
			transport.deliver(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: index })))
		}
		await waitForDelay()
		transport.deliver(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 'still-running' })))
		await waitForDelay()
		expect(signals).toHaveLength(10_001)

		await transport.close()

		expect(signals.slice(0, 10_000).filter((signal) => signal.aborted)).toEqual([])
		expect(signals[10_000]?.aborted).toBe(true)
		release?.()
		await waitForDelay()
	})
})

// bindClient — completes the inbound wiring for a REAL MCPClient constructed over
// createDuplexClientTransport (no mocks). Covers the connect handshake
// round trip, a malformed inbound message being dropped (never throwing), unbind
// detaching without closing, and the transport's `closed` signal reaching
// client.transport.emitter.
describe('bindClient', () => {
	function client(transport: MCPTransportInterface) {
		return createMCPClient({ transport: createDuplexClientTransport(transport) })
	}

	it('completes a connect handshake round trip over the duplex transport', async () => {
		const transport = createMemoryTransport()
		const mcp = client(transport)
		bindClient(mcp, transport)

		const connecting = mcp.connect()
		await waitForDelay()
		expect(transport.sent).toHaveLength(1)
		const probe: { id: number; method: string } = JSON.parse(transport.sent[0] ?? '{}')
		expect(probe.method).toBe('server/discover')
		transport.deliver(
			JSON.stringify({
				jsonrpc: '2.0',
				id: probe.id,
				error: { code: -32601, message: 'Method not found: server/discover' },
			}),
		)
		await waitForDelay()
		expect(transport.sent).toHaveLength(2)
		const initialize: { id: number; method: string } = JSON.parse(transport.sent[1] ?? '{}')
		expect(initialize.method).toBe('initialize')
		transport.deliver(
			JSON.stringify({
				jsonrpc: '2.0',
				id: initialize.id,
				result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {} },
			}),
		)
		await connecting

		expect(mcp.connected).toBe(true)
		// notifications/initialized fires as the last, un-replied write.
		expect(transport.sent).toHaveLength(3)
	})

	it('drops a malformed inbound message rather than throwing', () => {
		const transport = createMemoryTransport()
		const mcp = client(transport)
		bindClient(mcp, transport)

		expect(() => transport.deliver('not json')).not.toThrow()
		expect(() => transport.deliver(JSON.stringify({ not: 'a message' }))).not.toThrow()
	})

	it('unbind detaches inbound delivery WITHOUT closing the transport', async () => {
		const transport = createMemoryTransport()
		const mcp = client(transport)
		const unbind = bindClient(mcp, transport)
		unbind()

		const seen: unknown[] = []
		mcp.transport.emitter.on('message', (message) => seen.push(message))
		transport.deliver(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))

		expect(seen).toEqual([])
		expect(transport.closedCalls).toBe(0)
	})

	it('closing the transport reaches client.transport.emitter close', async () => {
		const transport = createMemoryTransport()
		const mcp = client(transport)
		bindClient(mcp, transport)
		let closed = 0
		mcp.transport.emitter.on('close', () => {
			closed += 1
		})

		await transport.close()

		expect(closed).toBe(1)
	})

	it('rebind after unbind on the SAME transport delivers exactly one message emit per reply', async () => {
		const transport = createMemoryTransport()
		const mcp = client(transport)
		const unbind = bindClient(mcp, transport)
		unbind()
		bindClient(mcp, transport)

		const seen: unknown[] = []
		mcp.transport.emitter.on('message', (message) => seen.push(message))
		transport.deliver(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
		await Promise.resolve()

		expect(seen).toHaveLength(1)
	})

	it('a client whose duplex transport was NOT bound stays pending rather than resolving or throwing', async () => {
		const transport = createMemoryTransport()
		const mcp = client(transport)
		// No bindClient(mcp, transport) — the inbound half is never wired.

		let settled = false
		const connecting = mcp.connect().then(
			() => {
				settled = true
			},
			() => {
				settled = true
			},
		)
		// Wait beyond the former 50ms discovery-probe bound: without an inbound binding there
		// is no peer signal that can justify settling the connection attempt.
		await waitForDelay(75)
		await Promise.resolve()

		expect(settled).toBe(false)
		expect(transport.sent).toHaveLength(1) // the outbound discovery request was still written

		// Bind now so the pending connect can be settled and the test doesn't hang.
		bindClient(mcp, transport)
		const sentRequest: { id: number } = JSON.parse(transport.sent[0] ?? '{}')
		transport.deliver(
			JSON.stringify({
				jsonrpc: '2.0',
				id: sentRequest.id,
				result: {
					supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
					capabilities: { tools: {} },
					resultType: 'complete',
					ttlMs: 60_000,
					cacheScope: 'private',
				},
			}),
		)
		await connecting
		expect(settled).toBe(true)
	})
})

// The client binder keeps NO live-request registry, and the asymmetry is real
// rather than an omission: it starts no work, so an inbound cancellation has nothing here to
// reach. It is delivered as the ordinary message it is, and `MCPClient` — which does own its
// pending entries — decides what to do with it.
describe('bindClient — no registry, and why', () => {
	it('delivers an inbound cancellation as a message instead of consuming it as a control frame', async () => {
		const transport = createMemoryTransport()
		const client = createMCPClient({ transport: createDuplexClientTransport(transport) })
		const delivered: unknown[] = []
		client.transport.emitter.on('message', (message) => delivered.push(message))
		bindClient(client, transport)

		transport.deliver(JSON.stringify(buildCancelledNotification('call-1', 'peer left')))
		await waitForDelay()

		expect(delivered).toEqual([buildCancelledNotification('call-1', 'peer left')])
		expect(transport.sent).toEqual([])
	})
})

describe('buildCancelledNotification', () => {
	it('names the cancelled request and carries no id of its own', () => {
		// `requestId` is the wire spelling, and the absent `id` is what makes this a
		// notification: nothing will ever answer it, which is why it is advisory.
		expect(buildCancelledNotification(7)).toEqual({
			jsonrpc: '2.0',
			method: 'notifications/cancelled',
			params: { requestId: 7 },
		})
	})

	it('carries an optional reason and keeps a string id verbatim', () => {
		expect(buildCancelledNotification('req-1', 'operator stopped')).toEqual({
			jsonrpc: '2.0',
			method: 'notifications/cancelled',
			params: { requestId: 'req-1', reason: 'operator stopped' },
		})
	})

	it('omits the reason key entirely rather than sending an empty one', () => {
		const notification = buildCancelledNotification(1, undefined)

		expect(Object.hasOwn(notification.params ?? {}, 'reason')).toBe(false)
	})
})

describe('matchesResultType', () => {
	it('admits the arms tools/call may answer with', () => {
		expect(matchesResultType('tools/call', 'complete')).toBe(true)
		expect(matchesResultType('tools/call', 'task')).toBe(true)
		expect(matchesResultType('tools/call', 'input_required')).toBe(true)
	})

	it('admits only complete for every other method', () => {
		expect(matchesResultType('tools/list', 'complete')).toBe(true)
		expect(matchesResultType('tools/list', 'task')).toBe(false)
		expect(matchesResultType('server/discover', 'input_required')).toBe(false)
	})

	it('is a whitelist — an unknown arm is refused even on tools/call', () => {
		expect(matchesResultType('tools/call', 'future')).toBe(false)
		expect(matchesResultType('tools/call', undefined)).toBe(false)
		expect(matchesResultType('tools/call', null)).toBe(false)
		expect(matchesResultType('tools/call', 7)).toBe(false)
		expect(matchesResultType('tools/call', { resultType: 'complete' })).toBe(false)
	})
})

describe('extractContentText', () => {
	it('joins every text block and stays total over anything else', () => {
		expect(
			extractContentText({
				content: [
					{ type: 'text', text: 'first' },
					{ type: 'image', data: 'ignored' },
					{ type: 'text', text: 'second' },
				],
			}),
		).toBe('first\nsecond')
		expect(extractContentText({ content: [] })).toBe('')
		expect(extractContentText({ content: 'not an array' })).toBe('')
		expect(extractContentText('not a result')).toBe('')
		expect(extractContentText(undefined)).toBe('')
	})
})

describe('buildCallOutcome', () => {
	it('prefers the structured value over the rendered text', () => {
		expect(
			buildCallOutcome('search', {
				resultType: 'complete',
				content: [{ type: 'text', text: 'Found 3 results' }],
				structuredContent: { count: 3 },
			}),
		).toEqual({ resultType: 'complete', value: { count: 3 } })
	})

	it('treats an explicit null as the value it is', () => {
		expect(
			buildCallOutcome('nothing', {
				resultType: 'complete',
				content: [{ type: 'text', text: '"ignored"' }],
				structuredContent: null,
			}),
		).toEqual({ resultType: 'complete', value: null })
	})

	it('parses the text when there is no structured value, raw when it is not JSON', () => {
		expect(buildCallOutcome('echo', { content: [{ type: 'text', text: '{"a":1}' }] })).toEqual({
			resultType: 'complete',
			value: { a: 1 },
		})
		expect(buildCallOutcome('echo', { content: [{ type: 'text', text: 'words' }] })).toEqual({
			resultType: 'complete',
			value: 'words',
		})
		expect(buildCallOutcome('echo', { content: [] })).toEqual({
			resultType: 'complete',
			value: undefined,
		})
	})

	it('carries a valid task arm through, frozen', () => {
		const task = {
			resultType: 'task',
			taskId: 'task-1',
			status: 'working',
			createdAt: '2026-07-28T00:00:00Z',
			lastUpdatedAt: '2026-07-28T00:00:00Z',
			ttlMs: null,
		}

		const outcome = buildCallOutcome('slow', task)

		expect(outcome).toEqual(task)
		expect(Object.isFrozen(outcome)).toBe(true)
	})

	it('refuses a task or input arm whose payload does not match its schema', () => {
		expect(() => buildCallOutcome('slow', { resultType: 'task', taskId: 'x' })).toThrow(
			'MCP server returned a malformed task result',
		)
		expect(() => buildCallOutcome('secured', { resultType: 'input_required' })).toThrow(
			'MCP server returned a malformed input request',
		)
	})

	it('throws a remote failure with its text, or names the tool when it carried none', () => {
		expect(() =>
			buildCallOutcome('boom', {
				isError: true,
				content: [{ type: 'text', text: 'tool exploded' }],
			}),
		).toThrow('tool exploded')
		expect(() => buildCallOutcome('boom', { isError: true, content: [] })).toThrow(
			"MCP tool 'boom' failed",
		)
	})
})

describe('the resolved method options', () => {
	it('requires a signal where the caller-facing options make it optional', () => {
		expectTypeOf<MCPMethodOptions['signal']>().toEqualTypeOf<AbortSignal>()
		expectTypeOf<Parameters<MCPMethodHandler>[1]>().toEqualTypeOf<MCPMethodOptions>()
	})

	it('hands the seam a signal that is never absent', () => {
		const resolved: MCPMethodOptions = buildMethodOptions({}, new AbortController().signal)

		expect(resolved.signal.aborted).toBe(false)
	})
})

describe('the subscription filter contract', () => {
	it('pins the subscription filter keys to their wire spellings', () => {
		expectTypeOf<keyof MCPSubscriptionFilter>().toEqualTypeOf<
			'toolsListChanged' | 'promptsListChanged' | 'resourcesListChanged' | 'resourceSubscriptions'
		>()

		const honoured = buildSubscriptionFilter(
			{ toolsListChanged: true, promptsListChanged: true, resourceSubscriptions: ['resource://a'] },
			{ toolsListChanged: true, resourceSubscriptions: ['resource://a'] },
		)

		expect(Object.keys(honoured).sort()).toEqual(['resourceSubscriptions', 'toolsListChanged'])
	})
})
