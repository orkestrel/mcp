import type { MCPMessageTransportEventMap, JSONRPCMessage, JSONRPCNotification } from '@src/core'
import { startErrorPeer } from '../../setupServer.js'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
	bindClient,
	bindServer,
	createDuplexClientTransport,
	createMCPClient,
	createMCPServer,
	isMCPError,
	isMCPToolError,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_METHOD_NOT_FOUND,
	MCP_META_CAPABILITIES,
	MCP_META_CLIENT,
	MCP_META_SUBSCRIPTION,
	MCP_META_VERSION,
	MCP_HANDSHAKE_VERSION,
	MCP_UNSUPPORTED_VERSION,
	SUPPORTED_MODERN_PROTOCOL_VERSIONS,
} from '@src/core'
import { createHTTPClientTransport } from '@src/server'
import { createTool, createToolManager } from '@orkestrel/tool'
import { createSignal, requireValue, waitForCondition, waitForDelay } from '@orkestrel/test'
import { isRecord } from '@orkestrel/contract'
import {
	createAbortTools,
	recordAbortTimeout,
	NATIVE_ABORT_TIMEOUT,
	RECORDED_ABORT_DEADLINES,
	createDispatchPeer,
	createFixturePeer,
	buildClientHandshakeResponse,
	buildPeerDiscovery,
	buildPeerCallResponse,
	createCallPeer,
	readPeerRequestId,
	createWritePeer,
	buildPeerProgress,
	buildPeerError,
	createPeerTools,
	createPeerServer,
	MCPFixtureCell,
	createForgedResponsePeer,
	createAccessorSignal,
	createMemoryTransport,
	createInputServer,
	createLoopbackTransport,
	createSubscriptionServer,
	TestTaskManager,
} from '../../setup.js'

describe('MCPClient — connect (modern negotiation)', () => {
	it('retries a failed negotiation with no accepted version and a second transport start', async () => {
		const peer = createFixturePeer({
			reply: (request, count) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return count === 1
					? buildPeerDiscovery(request.id, ['1999-01-01'])
					: buildPeerDiscovery(request.id)
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toMatchObject({ code: MCP_UNSUPPORTED_VERSION })
		expect(client.version).toBeUndefined()
		expect(client.connected).toBe(false)
		expect(peer.started).toBe(1)

		await client.connect()

		expect(peer.started).toBe(2)
		expect(client.connected).toBe(true)
		expect(client.version).toBe('2026-07-28')
		await client.disconnect()
	})

	it('owes no close after the transport closes during an in-flight negotiation', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.id === undefined) return undefined
				return buildPeerDiscovery(request.id)
			},
			send: { park: () => true },
		})
		const client = createMCPClient({ transport: peer })
		const opening = client.connect()
		const rejected = opening.catch((error: unknown) => error)
		try {
			await waitForCondition('discovery starts', () => peer.sent.includes('server/discover'))
			await peer.close()
			peer.emitter.emit('close')
			await expect(rejected).resolves.toMatchObject({
				message: 'MCP client disconnected',
				cause: { message: 'MCP transport closed' },
			})
			await client.disconnect()

			expect(client.version).toBeUndefined()
			expect(client.connected).toBe(false)
			expect(peer.closed).toBe(1)
			expect(peer.live).toBe(0)
			expect(peer.lifecycle).toEqual(['start', 'close'])
		} finally {
			peer.release()
			await client.disconnect()
		}
	})

	it('rejects an invalid runtime pin synchronously during construction', () => {
		const peer = createFixturePeer({ reply: () => undefined })
		const options: unknown = { transport: peer, version: '2020-01-01' }
		const failure = new MCPFixtureCell<unknown>(undefined)

		try {
			Reflect.apply(createMCPClient, undefined, [options])
		} catch (error) {
			failure.value = error
		}

		expect(isMCPError(failure.value)).toBe(true)
		expect(failure.value).toMatchObject({
			code: MCP_UNSUPPORTED_VERSION,
			context: { supported: SUPPORTED_MODERN_PROTOCOL_VERSIONS, requested: '2020-01-01' },
		})
		expect(peer.started).toBe(0)
		expect(peer.sent).toEqual([])
	})

	it('opens the transport, discovers modern support, and reports the newest common version', async () => {
		const loopback = createDispatchPeer(createPeerServer())
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
		const loopback = createDispatchPeer(createPeerServer())
		const client = createMCPClient({ transport: loopback })
		const connects = new MCPFixtureCell(0)
		client.emitter.on('connect', () => {
			connects.value += 1
		})

		await client.connect()
		await client.connect() // second connect is a no-op

		expect(connects.value).toBe(1)
		expect(loopback.started).toBe(1)
		expect(client.connected).toBe(true)
	})

	it('exposes the injected transport', () => {
		const loopback = createDispatchPeer(createPeerServer())
		const client = createMCPClient({ transport: loopback })
		expect(client.transport).toBe(loopback)
	})
})

describe('MCPClient — modern discovery', () => {
	it('exposes discover() and stamps its request with version, capabilities, and client identity', async () => {
		const loopback = createDispatchPeer(createPeerServer())
		const client = createMCPClient({
			transport: loopback,
			identity: { name: 'inspector', version: '2.0.0' },
			capabilities: { elicitation: {} },
		})

		const result = await client.discover()

		expect(result.supportedVersions).toEqual(['2026-07-28'])
		expect(result.resultType).toBe('complete')
		const request = loopback.requests[0]
		expect(request?.method).toBe('server/discover')
		expect(request?.params?.['_meta']).toEqual({
			[MCP_META_VERSION]: '2026-07-28',
			[MCP_META_CAPABILITIES]: { elicitation: {} },
			[MCP_META_CLIENT]: { name: 'inspector', version: '2.0.0' },
		})
	})

	it('does not retry a modern request with a legacy-only offer', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return buildPeerError(request.id, MCP_UNSUPPORTED_VERSION, {
					supported: ['2025-11-25', '2025-06-18'],
				})
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toMatchObject({ code: MCP_UNSUPPORTED_VERSION })

		expect(client.version).toBeUndefined()
		expect(peer.sent).toEqual(['server/discover'])
		expect(peer.requests.map((request) => request.id)).toEqual([1])
	})

	it('surfaces -32022 without changing a pinned modern revision', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return buildPeerError(request.id, MCP_UNSUPPORTED_VERSION, {
					supported: ['2025-11-25', '2025-06-18'],
				})
			},
		})
		const client = createMCPClient({ transport: peer, version: '2026-07-28' })

		await expect(client.connect()).rejects.toMatchObject({ code: MCP_UNSUPPORTED_VERSION })

		expect(client.connected).toBe(false)
		expect(client.version).toBeUndefined()
		expect(peer.sent).toEqual(['server/discover'])
	})

	it('rejects a discovery result that does not advertise the pinned modern revision', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return buildPeerDiscovery(request.id, [MCP_HANDSHAKE_VERSION])
			},
		})
		const client = createMCPClient({ transport: peer, version: '2026-07-28' })

		await expect(client.connect()).rejects.toMatchObject({
			code: MCP_UNSUPPORTED_VERSION,
			context: { supported: [], requested: '2026-07-28' },
		})

		expect(client.connected).toBe(false)
		expect(client.version).toBeUndefined()
		expect(peer.closed).toBe(1)
		expect(peer.sent).toEqual(['server/discover'])
	})

	it('makes no further discovery attempt when the one retry also returns -32022', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return buildPeerError(request.id, MCP_UNSUPPORTED_VERSION, {
					supported: ['2025-11-25'],
				})
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toMatchObject({ code: MCP_UNSUPPORTED_VERSION })

		expect(peer.sent).toEqual(['server/discover'])
		expect(peer.requests.map((request) => request.id)).toEqual([1])
	})

	it('surfaces a server-state discovery error without era guidance', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return {
					jsonrpc: '2.0',
					id: request.id,
					error: { code: -32000, message: 'Bad Request: Server not initialized' },
				}
			},
		})
		const client = createMCPClient({ transport: peer })
		const caught = new MCPFixtureCell<unknown>(undefined)

		try {
			await client.connect()
		} catch (error) {
			caught.value = error
		}

		expect(isMCPError(caught.value)).toBe(true)
		if (!isMCPError(caught.value)) throw new Error('Expected an MCPError')
		expect(caught.value.name).toBe('MCPError')
		expect(caught.value.code).toBe(-32000)
		expect(caught.value.message).toBe('Bad Request: Server not initialized')
		expect(caught.value.context).toBeUndefined()
		expect(client.version).toBeUndefined()
		expect(peer.sent).toEqual(['server/discover'])
	})

	it('names the legacy adapter only for discovery method-not-found', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return buildPeerError(request.id, JSONRPC_METHOD_NOT_FOUND)
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toMatchObject({
			code: JSONRPC_METHOD_NOT_FOUND,
			message: expect.stringContaining('createMCPLegacyClientTransport'),
		})

		expect(client.version).toBeUndefined()
		expect(peer.sent).toEqual(['server/discover'])
	})

	it.each([
		['an auth-shaped HTTP refusal', 'HTTP 401 Unauthorized: bearer required'],
		['an unrecognized HTTP 400', 'HTTP 400 response did not contain a recognized modern error'],
		['an unrecognized HTTP 404', 'HTTP 404 response did not contain a recognized modern error'],
		['a transport send failure', 'Transport closed while sending'],
	])('surfaces %s without era guidance', async (_scenario, message) => {
		const cause = new Error('Transport refused the discovery request')
		const failure = new Error(message, { cause })
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method === 'server/discover') return failure
				return undefined
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toBe(failure)
		expect(failure.cause).toBe(cause)

		expect(client.version).toBeUndefined()
		expect(peer.sent).toEqual(['server/discover'])
	})

	it('surfaces a malformed result after a parseable discovery response settles the modern era', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.id === undefined) return undefined
				if (request.method === 'server/discover') {
					return buildClientHandshakeResponse(request.id, MCP_HANDSHAKE_VERSION)
				}
				if (request.method === 'initialize') {
					return buildClientHandshakeResponse(request.id, MCP_HANDSHAKE_VERSION)
				}
				return undefined
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toMatchObject({ code: JSONRPC_INVALID_PARAMS })

		expect(client.version).toBeUndefined()
		expect(peer.sent).toEqual(['server/discover'])
	})

	it.each([
		['a mistyped known capability', { capabilities: { tools: { listChanged: 'yes' } } }],
		['an unprefixed extension key', { capabilities: { extensions: { feature: {} } } }],
		[
			'a non-object extension value',
			{ capabilities: { extensions: { 'vendor.example/feature': true } } },
		],
		['non-JSON metadata', { _meta: { value: undefined } }],
		['a malformed metadata key', { _meta: { 'vendor.example/bad/key': true } }],
		[
			'a malformed reserved server identity',
			{ _meta: { 'io.modelcontextprotocol/serverInfo': 7 } },
		],
	])('rejects discovery carrying %s', async (_scenario, fields) => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return buildPeerDiscovery(request.id, ['2026-07-28'], fields)
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.discover()).rejects.toMatchObject({ code: JSONRPC_INVALID_PARAMS })
	})

	it('owns an inbound response before routing and rejects a forged post-validation arm', async () => {
		const transport = createForgedResponsePeer()
		const client = createMCPClient({ transport })

		await expect(client.discover()).resolves.toMatchObject({
			supportedVersions: ['2026-07-28'],
		})
	})

	it.each([
		['a non-string advertised version', ['2026-07-28', 7], 60_000],
		['a fractional TTL', ['2026-07-28'], 1.5],
		['a negative TTL', ['2026-07-28'], -1],
		['a non-finite TTL', ['2026-07-28'], Number.POSITIVE_INFINITY],
	])('rejects discovery carrying %s', async (_scenario, versions, ttl) => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return buildPeerDiscovery(request.id, versions, { ttlMs: ttl })
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.discover()).rejects.toMatchObject({ code: JSONRPC_INVALID_PARAMS })
	})

	it('filters unknown string revisions and freezes the retained discovery snapshot', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return buildPeerDiscovery(request.id, ['2099-01-01', '2026-07-28'])
			},
		})
		const client = createMCPClient({ transport: peer })

		const result = await client.discover()

		expect(result.supportedVersions).toEqual(['2026-07-28'])
		expect(Object.isFrozen(result.supportedVersions)).toBe(true)
		expect(Object.isFrozen(result.capabilities)).toBe(true)
		expect(Object.isFrozen(result)).toBe(true)
	})

	it('accepts a zero TTL and owns frozen metadata independently of later mutation', async () => {
		const metadata = { 'vendor.example/trace': { id: 'trace-1' } }
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return buildPeerDiscovery(request.id, ['2026-07-28'], { _meta: metadata, ttlMs: 0 })
			},
		})
		const client = createMCPClient({ transport: peer })

		const result = await client.discover()
		metadata['vendor.example/trace'].id = 'mutated'

		expect(result.ttlMs).toBe(0)
		expect(result['_meta']).toEqual({ 'vendor.example/trace': { id: 'trace-1' } })
		expect(Object.isFrozen(result['_meta'])).toBe(true)
	})

	it('owns an inbound discovery response once before later validation', async () => {
		const snapshots = new MCPFixtureCell(0)
		const result = new Proxy(
			{
				supportedVersions: ['2026-07-28'],
				capabilities: {},
				resultType: 'complete',
				ttlMs: 60_000,
				cacheScope: 'private',
			},
			{
				ownKeys(target) {
					snapshots.value += 1
					if (snapshots.value > 1) throw new Error('hostile snapshot')
					return Reflect.ownKeys(target)
				},
			},
		)
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return { jsonrpc: '2.0', id: request.id, result }
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.discover()).resolves.toMatchObject({
			supportedVersions: ['2026-07-28'],
		})
		expect(snapshots.value).toBe(1)
	})

	it('accepts and returns an exact open custom server capability', async () => {
		const custom = { enabled: true }
		const capabilities = {
			custom,
			tools: { listChanged: true },
			extensions: { 'vendor.example/feature': { enabled: true } },
		}
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return buildPeerDiscovery(request.id, ['2026-07-28'], { capabilities })
			},
		})
		const client = createMCPClient({ transport: peer })

		const result = await client.discover()
		custom.enabled = false

		expect(result.capabilities).toMatchObject({
			custom: { enabled: true },
			tools: { listChanged: true },
			extensions: { 'vendor.example/feature': { enabled: true } },
		})
	})

	it('surfaces an unsupported result type from a parseable discovery response without fallback', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
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
					return buildClientHandshakeResponse(request.id, MCP_HANDSHAKE_VERSION)
				}
				return undefined
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toMatchObject({
			code: JSONRPC_INVALID_PARAMS,
			message: "MCP result type 'input_required' is not supported",
		})

		expect(client.connected).toBe(false)
		expect(peer.sent).toEqual(['server/discover'])
	})

	it('bounds a silent discovery probe and surfaces its timeout', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method === 'initialize' && request.id !== undefined) {
					return buildClientHandshakeResponse(request.id, MCP_HANDSHAKE_VERSION)
				}
				return undefined
			},
		})
		const client = createMCPClient({ transport: peer, timeout: 30 })

		await expect(client.connect()).rejects.toThrow(
			"MCP request 'server/discover' timed out after 30ms",
		)

		expect(client.version).toBeUndefined()
		expect(peer.sent).toEqual(['server/discover'])
	})

	it('always gives discovery a deadline without delaying a modern HTTP peer', async () => {
		const peer = await startErrorPeer()
		const unconfigured = createMCPClient({
			transport: createHTTPClientTransport({ url: `${peer.base}/silent` }),
		})
		const modern = createMCPClient({
			transport: createHTTPClientTransport({ url: `${peer.base}/modern` }),
		})
		const configured = createMCPClient({
			transport: createHTTPClientTransport({ url: `${peer.base}/silent` }),
			timeout: 30,
		})
		try {
			const hanging = unconfigured.connect().then(
				() => 'connected',
				() => 'rejected',
			)
			await peer.held('/silent')
			const observed = await Promise.race([hanging, waitForDelay(20).then(() => 'pending')])
			expect(observed).toBe('pending')
			await unconfigured.disconnect()
			await expect(hanging).resolves.toBe('rejected')
			peer.release('/silent')

			await modern.connect()
			expect(modern.version).toBe('2026-07-28')

			await expect(configured.connect()).rejects.toThrow(
				"MCP request 'server/discover' timed out after 30ms",
			)
			expect(peer.requests.map((request) => request.method)).toEqual([
				'server/discover',
				'server/discover',
				'server/discover',
			])
		} finally {
			peer.release('/silent')
			await Promise.allSettled([
				unconfigured.disconnect(),
				modern.disconnect(),
				configured.disconnect(),
			])
			await peer.stop()
		}
	})

	it('applies the configured 15_000ms deadline to the negotiation probe', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return buildPeerDiscovery(request.id, ['2026-07-28'])
			},
		})
		const client = createMCPClient({ transport: peer, timeout: 15_000 })
		// Scope the recorder to negotiation and forward every call to the real host primitive. The
		// 14,999ms control proves the recorder distinguishes the deadline the client supplies.
		RECORDED_ABORT_DEADLINES.splice(0)
		AbortSignal.timeout = recordAbortTimeout
		try {
			void AbortSignal.timeout(14_999)
			await client.connect()
			expect(RECORDED_ABORT_DEADLINES).toEqual([14_999, 15_000])
		} finally {
			AbortSignal.timeout = NATIVE_ABORT_TIMEOUT
			await client.disconnect()
		}
	})

	it('does not fall back when the modern revision is pinned', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return buildPeerError(request.id, JSONRPC_METHOD_NOT_FOUND)
			},
		})
		const client = createMCPClient({ transport: peer, version: '2026-07-28' })

		await expect(client.connect()).rejects.toMatchObject({ code: JSONRPC_METHOD_NOT_FOUND })
		expect(peer.sent).toEqual(['server/discover'])
		expect(client.connected).toBe(false)
	})

	it('surfaces a transport failure after the modern era has been settled', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.id === undefined) return undefined
				if (request.method === 'server/discover') return buildPeerDiscovery(request.id)
				if (request.method === 'tools/list') return new Error('Settled modern transport failed')
				return undefined
			},
		})
		const client = createMCPClient({ transport: peer })
		await client.connect()

		await expect(client.tools()).rejects.toThrow('Settled modern transport failed')

		expect(peer.sent).toEqual(['server/discover', 'tools/list'])
		expect(client.version).toBe('2026-07-28')
	})

	it('stamps every modern request and sends no client notification', async () => {
		const loopback = createDispatchPeer(createPeerServer())
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
				[MCP_META_CLIENT]: { name: '@orkestrel/mcp', version: '1.0.0' },
			})
		}
	})
})

describe('MCPClient — tools() (discovery + local-tool wrapping)', () => {
	it('lists the remote tools as local Tools, mapping inputSchema → parameters', async () => {
		const client = createMCPClient({ transport: createDispatchPeer(createPeerServer()) })
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
		const client = createMCPClient({ transport: createDispatchPeer(createPeerServer()) })
		await client.connect()
		const tools = await client.tools()
		const echo = tools.find((tool) => tool.name === 'echo')

		// Running the LOCAL tool drives a remote `tools/call` round-trip.
		const value = await echo?.execute({ value: 'pong' }, { signal: new AbortController().signal })

		expect(value).toEqual({ echoed: 'pong' })
	})

	it('a wrapped remote-erroring tool, added to a ToolManager, is isolated into a failure result', async () => {
		const client = createMCPClient({ transport: createDispatchPeer(createPeerServer()) })
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
	it('places input continuation state and responses as top-level tools/call params', async () => {
		const peer = createCallPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? buildPeerCallResponse(request.id, {
						resultType: 'complete',
						content: [{ type: 'text', text: 'done' }],
					})
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const args = { operation: 'release', nested: { approved: false } }
		const responses = { confirmation: { action: 'accept', content: { approved: true } } }

		await client.call('NAME', args, { input: { state: 'protected-state', responses } })
		await client.call('NAME', args)

		const calls = peer.requests.filter((request) => request.method === 'tools/call')
		const continued = calls[0]
		const plain = calls[1]
		if (continued === undefined || plain === undefined) {
			throw new Error('Expected the peer to receive the continued and plain calls')
		}
		const sent = continued.params
		const bare = plain.params
		if (sent === undefined || bare === undefined) {
			throw new Error('Expected both tools/call requests to carry params')
		}
		const carried = sent['arguments']
		const reserved = sent['_meta']
		if (!isRecord(carried) || !isRecord(reserved)) {
			throw new Error('Expected the recorded arguments and reserved metadata to be records')
		}

		expect(carried).toBe(args)
		expect(sent['name']).toBe('NAME')
		expect(sent['requestState']).toBe('protected-state')
		expect(sent['inputResponses']).toBe(responses)
		// The pair rides at the TOP level and nowhere else. A subset match over `params` admits
		// an implementation that ALSO buries the pair under `arguments` or under the reserved
		// `_meta`, and either one changes what a peer reads while the top-level keys still look
		// right, so each wrong home is refused by name.
		expect(Object.hasOwn(carried, 'requestState')).toBe(false)
		expect(Object.hasOwn(carried, 'inputResponses')).toBe(false)
		expect(Object.hasOwn(reserved, 'requestState')).toBe(false)
		expect(Object.hasOwn(reserved, 'inputResponses')).toBe(false)
		// The caller's own object is read, never written: identity alone cannot see an
		// implementation that placed the pair by mutating `args` in place, because the recorded
		// arguments and the caller's object are then the same object carrying the same keys.
		expect(Object.hasOwn(args, 'requestState')).toBe(false)
		expect(Object.hasOwn(args, 'inputResponses')).toBe(false)
		expect(args).toEqual({ operation: 'release', nested: { approved: false } })
		expect(Object.hasOwn(bare, 'requestState')).toBe(false)
		expect(Object.hasOwn(bare, 'inputResponses')).toBe(false)
	})

	// A peer may issue a round with NO `requestState`, and SEP-2322 requires the retry to
	// answer that round while omitting the parameter. So `state` is optional and the parameter
	// rides exactly when a caller supplies one: an absent state must leave the key off the
	// wire rather than send `undefined`, an empty string, or a carrier this client invented.
	it('omits requestState from a retry the peer sealed no state for', async () => {
		const peer = createCallPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? buildPeerCallResponse(request.id, {
						resultType: 'complete',
						content: [{ type: 'text', text: 'done' }],
					})
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const responses = { confirmation: { action: 'accept' } }

		await client.call('NAME', {}, { input: { responses } })

		const sent = peer.requests.filter((request) => request.method === 'tools/call')[0]?.params
		if (sent === undefined) throw new Error('Expected the peer to receive the retry')

		expect(sent['inputResponses']).toBe(responses)
		expect(Object.hasOwn(sent, 'requestState')).toBe(false)
	})

	it('continues an input-required call with protected state and responses', async () => {
		const client = createMCPClient({
			transport: createDispatchPeer(createInputServer(createPeerTools())),
			capabilities: { elicitation: {} },
		})
		await client.connect()
		const args = { value: 'unchanged' }

		const first = await client.call('echo', args)

		expect(first.resultType).toBe('input_required')
		if (
			first.resultType !== 'input_required' ||
			first.requestState === undefined ||
			first.inputRequests === undefined
		) {
			throw new Error('Expected input requests and protected state')
		}
		const key = Object.keys(first.inputRequests)[0]
		if (key === undefined) throw new Error('Expected an input request key')
		const second = await client.call('echo', args, {
			input: {
				state: first.requestState,
				responses: { [key]: { action: 'accept', content: { approved: true } } },
			},
		})

		expect(second).toEqual({ resultType: 'complete', value: { echoed: 'unchanged' } })
	})

	it('keeps changed retry arguments under the server digest refusal', async () => {
		const client = createMCPClient({
			transport: createDispatchPeer(createInputServer(createPeerTools())),
			capabilities: { elicitation: {} },
		})
		await client.connect()
		const first = await client.call('echo', { value: 'original' })
		if (
			first.resultType !== 'input_required' ||
			first.requestState === undefined ||
			first.inputRequests === undefined
		) {
			throw new Error('Expected input requests and protected state')
		}
		const key = Object.keys(first.inputRequests)[0]
		if (key === undefined) throw new Error('Expected an input request key')
		const answers = { [key]: { action: 'accept', content: { approved: true } } }

		// The refusal is read by its MESSAGE, not by `-32602` alone: the required-together gate
		// earlier in the same retry ingress answers that identical code, so the code on its own
		// cannot say which gate ran.
		await expect(
			client.call(
				'echo',
				{ value: 'altered' },
				{ input: { state: first.requestState, responses: answers } },
			),
		).rejects.toMatchObject({
			code: JSONRPC_INVALID_PARAMS,
			message: 'Invalid params: request state could not be verified for this retry',
		})

		// The same protected state, replayed with the ORIGINAL arguments, still completes. That
		// is what makes the refusal above the digest binding rather than a state the failed
		// retry had spent or a carrier the server could not recover at all.
		expect(
			await client.call(
				'echo',
				{ value: 'original' },
				{ input: { state: first.requestState, responses: answers } },
			),
		).toEqual({ resultType: 'complete', value: { echoed: 'original' } })
	})

	it('returns a structured value on the complete arm', async () => {
		const client = createMCPClient({ transport: createDispatchPeer(createPeerServer()) })
		await client.connect()

		expect(await client.call('echo', { value: 'x' })).toEqual({
			resultType: 'complete',
			value: { echoed: 'x' },
		})
	})

	it('returns a plain string value', async () => {
		const client = createMCPClient({ transport: createDispatchPeer(createPeerServer()) })
		await client.connect()

		// `greet` returns the string 'hello'; the server carries it verbatim as
		// `structuredContent` beside its serialized text block.
		expect(await client.call('greet', {})).toEqual({ resultType: 'complete', value: 'hello' })
	})

	it('throws when the remote tool fails (isError), carrying the error text', async () => {
		const client = createMCPClient({ transport: createDispatchPeer(createPeerServer()) })
		await client.connect()

		await expect(client.call('boom', {})).rejects.toThrow('tool exploded')
		const refusal: unknown = await client.call('boom', {}).catch((error: unknown) => error)
		expect(isMCPToolError(refusal)).toBe(true)
		expect(isMCPError(refusal)).toBe(false)
		expect(refusal).toMatchObject({ message: 'tool exploded', code: 'TOOL' })
	})

	it('rejects a tools/call for an unknown remote tool (the manager not-found error)', async () => {
		const client = createMCPClient({ transport: createDispatchPeer(createPeerServer()) })
		await client.connect()

		// The remote ToolManager resolves an unknown name to an `isError` not-found result,
		// so the client throws.
		await expect(client.call('absent', {})).rejects.toThrow(/not found/)
	})
})

describe('MCPClient — result-type safety', () => {
	it.each(['input_required', 'task', 'future'])(
		'rejects resultType %s with an MCPError that names it',
		async (resultType) => {
			const peer = createFixturePeer({
				reply: (request) => {
					if (request.id === undefined) return undefined
					if (request.method === 'server/discover') return buildPeerDiscovery(request.id)
					if (request.method === 'tools/list') {
						return { jsonrpc: '2.0', id: request.id, result: { tools: [], resultType } }
					}
					return undefined
				},
			})
			const client = createMCPClient({ transport: peer })
			await client.connect()

			const caught = new MCPFixtureCell<unknown>(undefined)
			try {
				await client.tools()
			} catch (error) {
				caught.value = error
			}

			expect(isMCPError(caught.value)).toBe(true)
			if (!isMCPError(caught.value)) throw new Error('Expected an MCPError')
			expect(caught.value.code).toBe(JSONRPC_INVALID_PARAMS)
			expect(caught.value.message).toBe(`MCP result type '${resultType}' is not supported`)
		},
	)
})

describe('MCPClient — id correlation', () => {
	it('routes each response to its own pending request across concurrent calls', async () => {
		const client = createMCPClient({ transport: createDispatchPeer(createPeerServer()) })
		await client.connect()

		// Three concurrent calls; each must resolve to ITS OWN result, proving the id-keyed
		// correlation routes responses correctly (not first-come-first-served).
		const [a, b, c] = await Promise.all([
			client.call('echo', { value: 'a' }),
			client.call('echo', { value: 'b' }),
			client.call('greet', {}),
		])

		expect(a).toEqual({ resultType: 'complete', value: { echoed: 'a' } })
		expect(b).toEqual({ resultType: 'complete', value: { echoed: 'b' } })
		expect(c).toEqual({ resultType: 'complete', value: 'hello' })
	})

	it('surfaces a server-initiated notification on the notification event', async () => {
		const loopback = createDispatchPeer(createPeerServer())
		const client = createMCPClient({ transport: loopback })
		await client.connect()
		const seen: JSONRPCMessage[] = []
		client.emitter.on('notification', (message) => seen.push(message))

		// A message that is NOT a response to a pending request (here a server-pushed
		// notification injected straight onto the transport) is surfaced, not dropped.
		loopback.emitter.emit('message', { jsonrpc: '2.0', method: 'notifications/progress' })

		expect(seen).toHaveLength(1)
		expect(seen[0]).toEqual({ jsonrpc: '2.0', method: 'notifications/progress' })
	})

	it('preserves a remote JSON-RPC error code and data as an MCPError', async () => {
		const loopback = createDispatchPeer(createPeerServer(), (method) => method === 'tools/list')
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

		const caught = new MCPFixtureCell<unknown>(undefined)
		try {
			await pending
		} catch (error) {
			caught.value = error
		}
		expect(isMCPError(caught.value)).toBe(true)
		if (!isMCPError(caught.value)) throw new Error('Expected an MCPError')
		expect(caught.value.message).toBe('Remote failure')
		expect(caught.value.code).toBe(-32042)
		expect(caught.value.context).toEqual({ retry: false })
	})

	it('settles id-less errors over real HTTP without weakening correlated isolation', async () => {
		const peer = await startErrorPeer()
		const connectingClient = createMCPClient({
			transport: createHTTPClientTransport({ url: `${peer.base}/connect` }),
		})
		const connecting = connectingClient.connect().then(
			() => 'connected',
			(error: unknown) => error,
		)
		try {
			const outcome = await Promise.race([connecting, waitForDelay(200).then(() => 'pending')])
			expect(isMCPError(outcome)).toBe(true)
			if (!isMCPError(outcome)) throw new Error('Expected an MCPError')
			expect(outcome.code).toBe(-32000)
			expect(outcome.message).toBe(
				'MCP server returned an error without a request id: Bad Request: Server not initialized',
			)
			expect(peer.requests.map((request) => request.method)).toEqual(['server/discover'])

			const idlessClient = createMCPClient({
				transport: createHTTPClientTransport({ url: `${peer.base}/idless` }),
			})
			const firstIdless = idlessClient.discover()
			await peer.held('/idless')
			const secondIdless = idlessClient.discover()
			const failures = await Promise.all([
				firstIdless.then(
					() => undefined,
					(error: unknown) => error,
				),
				secondIdless.then(
					() => undefined,
					(error: unknown) => error,
				),
			])
			for (const failure of failures) {
				expect(isMCPError(failure)).toBe(true)
				if (!isMCPError(failure)) throw new Error('Expected an MCPError')
				expect(failure.code).toBe(-32000)
				expect(failure.message).toContain('without a request id')
				expect(failure.message).toContain('Bad Request: Server not initialized')
			}
			peer.release('/idless')

			const correlatedClient = createMCPClient({
				transport: createHTTPClientTransport({ url: `${peer.base}/correlated` }),
			})
			const retained = correlatedClient.discover()
			await peer.held('/correlated')
			const correlatedFailure = new MCPFixtureCell<unknown>(undefined)
			try {
				await correlatedClient.discover()
			} catch (error) {
				correlatedFailure.value = error
			}
			expect(isMCPError(correlatedFailure.value)).toBe(true)
			if (!isMCPError(correlatedFailure.value)) throw new Error('Expected an MCPError')
			expect(correlatedFailure.value.code).toBe(-32041)
			expect(correlatedFailure.value.message).toBe('Correlated failure')
			peer.release('/correlated')
			await expect(retained).resolves.toMatchObject({ resultType: 'complete' })
		} finally {
			peer.release('/idless')
			peer.release('/correlated')
			await connectingClient.disconnect()
			await connecting
			await peer.stop()
		}
	})
})

describe('MCPClient — per-request timeout', () => {
	it('rejects a request the server never answers, after the deadline', async () => {
		// Gate `tools/list` so its response is withheld — the request stays pending until the
		// tiny per-request deadline fires (short timers).
		const loopback = createDispatchPeer(createPeerServer(), (method) => method === 'tools/list')
		const client = createMCPClient({ transport: loopback, timeout: 30 })
		await client.connect() // `initialize` is NOT gated, so connect succeeds

		await expect(client.tools()).rejects.toThrow(/timed out/)
	})

	it('keeps the probe deadline scoped to discovery while another request is pending', async () => {
		const peer = createFixturePeer({
			reply: () => undefined,
		})
		const client = createMCPClient({ transport: peer, timeout: 200 })
		const connecting = client.connect()
		await waitForDelay()
		const listing = client.tools()

		await waitForDelay(75)
		peer.emitter.emit('message', { jsonrpc: '2.0', id: 2, result: { tools: [] } })

		await expect(listing).resolves.toEqual([])
		await expect(connecting).rejects.toThrow("MCP request 'server/discover' timed out after 200ms")
		expect(peer.sent).toEqual(['server/discover', 'tools/list'])
	})
})

describe('MCPClient — disconnect', () => {
	it('rejects every pending request and closes the transport', async () => {
		// Gate `tools/call` so the call stays pending; disconnect must reject it.
		const loopback = createDispatchPeer(createPeerServer(), (method) => method === 'tools/call')
		const client = createMCPClient({ transport: loopback, timeout: 5_000 })
		await client.connect()

		const pending = client.call('greet', {})
		await client.disconnect()

		expect(client.connected).toBe(false)
		expect(client.version).toBeUndefined()
		expect(loopback.closed).toBe(1)
		await expect(pending).rejects.toThrow(/disconnected/)
	})

	it('rejects a request on a client that is not connected', async () => {
		const loopback = createDispatchPeer(createPeerServer())
		const client = createMCPClient({ transport: loopback, timeout: 5_000 })
		await client.connect()
		await client.disconnect()
		const issued = loopback.sent.length

		// Both session-bound requests, because each reaches the same guard and a reader who
		// learns it from `call` must find `tools` answering the same way.
		const called: unknown = await client.call('greet', {}).catch((reason: unknown) => reason)
		const listed: unknown = await client.tools().catch((reason: unknown) => reason)

		expect(isMCPError(called) && called.code).toBe(-32600)
		expect(isMCPError(listed) && listed.code).toBe(-32600)
		// Nothing was written: a refusal that still sent the frame would leave the peer holding
		// a request this client has already given up on.
		expect(loopback.sent.length).toBe(issued)
	})

	it('rejects a request on a client that has never connected', async () => {
		const loopback = createDispatchPeer(createPeerServer())
		const client = createMCPClient({ transport: loopback, timeout: 5_000 })

		const called: unknown = await client.call('greet', {}).catch((reason: unknown) => reason)

		expect(isMCPError(called) && called.code).toBe(-32600)
		expect(loopback.sent).toEqual([])
	})

	it('rejects a task request on a client that is not connected', async () => {
		const loopback = createDispatchPeer(createPeerServer())
		const client = createMCPClient({ transport: loopback, timeout: 5_000 })
		await client.connect()
		await client.disconnect()
		const issued = loopback.sent.length

		// The task client issues through the same request function `call` and `tools` use, so
		// the refusal lives at that door rather than at each caller's own.
		const detail: unknown = await client.tasks.task('missing').catch((reason: unknown) => reason)
		const updated: unknown = await client.tasks
			.update('missing', {})
			.catch((reason: unknown) => reason)
		const aborted: unknown = await client.tasks.abort('missing').catch((reason: unknown) => reason)

		expect(isMCPError(detail) && detail.code).toBe(-32600)
		expect(isMCPError(updated) && updated.code).toBe(-32600)
		expect(isMCPError(aborted) && aborted.code).toBe(-32600)
		expect(loopback.sent.length).toBe(issued)
	})

	it('rejects a subscription opened on a client that is not connected', async () => {
		const loopback = createDispatchPeer(createPeerServer())
		const client = createMCPClient({ transport: loopback, timeout: 5_000 })
		await client.connect()
		await client.disconnect()
		const issued = loopback.sent.length
		const controller = new AbortController()

		// A subscription writes its own request rather than going through the request door, so
		// it carries the same refusal at its own entry — delivered on the first `next()`,
		// because that is when a stream's body runs.
		const stream = client.listen(undefined, { signal: controller.signal })
		const refused: unknown = await stream.next().catch((reason: unknown) => reason)

		expect(isMCPError(refused) && refused.code).toBe(-32600)
		expect(loopback.sent.length).toBe(issued)
	})

	it('rejects requests issued after transport loss inside a connect listener', async () => {
		const loopback = createDispatchPeer(createPeerServer())
		const client = createMCPClient({ transport: loopback, timeout: 1_000 })
		const called = new MCPFixtureCell<Promise<unknown> | undefined>(undefined)
		const detailed = new MCPFixtureCell<Promise<unknown> | undefined>(undefined)
		const opened = new MCPFixtureCell<Promise<unknown> | undefined>(undefined)
		const written = new MCPFixtureCell(0)
		// `connect` is emitted while the attempt that produced it is still the published one, so
		// the connection this listener loses leaves that attempt standing. The refusal exempts
		// the negotiation's own requests, and this is the vector that tells an exemption scoped
		// to the CURRENT attempt from one that admits any retained attempt at all.
		client.emitter.once('connect', () => {
			loopback.emitter.emit('close')
			written.value = loopback.sent.length
			called.value = client.call('greet', {})
			detailed.value = client.tasks.task('missing')
			opened.value = client.listen(undefined, { signal: new AbortController().signal }).next()
		})

		await client.connect()

		// Each reading is asserted as it arrives: a request that passed the refusal reports its
		// 1000 ms deadline, and a subscription that passed it parks on a response no transport
		// is left to carry, so reading the parked one last would hide the two that answered.
		const call = await requireValue(called.value, 'the connect listener must have issued the call')
			.then(() => undefined)
			.catch((reason: unknown) => reason)
		expect(isMCPError(call) && call.code).toBe(-32600)
		const task = await requireValue(
			detailed.value,
			'the connect listener must have issued the task',
		)
			.then(() => undefined)
			.catch((reason: unknown) => reason)
		expect(isMCPError(task) && task.code).toBe(-32600)
		const subscription = await requireValue(
			opened.value,
			'the connect listener must have opened the subscription',
		)
			.then(() => undefined)
			.catch((reason: unknown) => reason)
		expect(isMCPError(subscription) && subscription.code).toBe(-32600)
		// Nothing reached the wire after the loss: a refusal that still wrote the frame would
		// leave the peer holding a request this client has already given up on.
		expect(loopback.sent.length).toBe(written.value)
	})

	it('settles requests issued after disconnect inside a connect listener', async () => {
		const deadline = 1_000
		const loopback = createDispatchPeer(createPeerServer())
		const client = createMCPClient({ transport: loopback, timeout: deadline })
		const closing = new MCPFixtureCell<Promise<void> | undefined>(undefined)
		const called = new MCPFixtureCell<Promise<unknown> | undefined>(undefined)
		const detailed = new MCPFixtureCell<Promise<unknown> | undefined>(undefined)
		const opened = new MCPFixtureCell<Promise<unknown> | undefined>(undefined)
		// An immediate `-32600` is NOT this contract. `disconnect` defers its teardown through
		// the microtask queue, so at this instant the transport is open and the attempt that
		// emitted `connect` is still the published one — these requests are issued onto a live
		// connection. What answers them is the teardown's own drain, which rejects every
		// request it finds pending. A transport LOSS is the other reading: it invalidates the
		// attempt synchronously, and the test above is where every later request refuses.
		client.emitter.once('connect', () => {
			closing.value = client.disconnect()
			called.value = client.call('greet', {})
			detailed.value = client.tasks.task('missing')
			opened.value = client.listen(undefined, { signal: new AbortController().signal }).next()
		})

		await client.connect()

		// Each reading is asserted as it arrives, against the interval this client's requests
		// are bounded by: a request the drain missed would report that deadline instead, and a
		// subscription the drain missed would park on a response nothing is left to carry.
		const started = performance.now()
		await expect(
			requireValue(closing.value, 'the connect listener must have disconnected'),
		).resolves.toBeUndefined()
		const call = await requireValue(called.value, 'the connect listener must have issued the call')
			.then(() => undefined)
			.catch((reason: unknown) => reason)
		expect(call instanceof Error && call.message).toBe('MCP client disconnected')
		const task = await requireValue(
			detailed.value,
			'the connect listener must have issued the task',
		)
			.then(() => undefined)
			.catch((reason: unknown) => reason)
		expect(task instanceof Error && task.message).toBe('MCP client disconnected')
		const subscription = await requireValue(
			opened.value,
			'the connect listener must have opened the subscription',
		)
			.then(() => undefined)
			.catch((reason: unknown) => reason)
		expect(subscription instanceof Error && subscription.message).toBe('MCP client disconnected')
		expect(performance.now() - started).toBeLessThan(deadline)
	})

	it('answers the discovery probe on a client that has never connected', async () => {
		const loopback = createDispatchPeer(createPeerServer())
		const client = createMCPClient({ transport: loopback })

		// The control the refusal must not reach. `discover` is the round trip a connection is
		// built out of, so a guard that refused it would refuse `connect` itself.
		await expect(client.discover()).resolves.toMatchObject({ resultType: 'complete' })
	})

	it('fires the disconnect event and is idempotent', async () => {
		const loopback = createDispatchPeer(createPeerServer())
		const client = createMCPClient({ transport: loopback })
		const disconnects = new MCPFixtureCell(0)
		client.emitter.on('disconnect', () => {
			disconnects.value += 1
		})
		await client.connect()

		await client.disconnect()
		await client.disconnect() // second disconnect is a no-op

		expect(disconnects.value).toBe(1)
		expect(loopback.closed).toBe(1)
	})
})

// The ORDERING seam: `connect` / `disconnect` install their state only AFTER an await, so
// every interleaving that reaches the gap sees a client that is neither connected nor
// connecting. These drive the gap directly, including the two-attempts-alive interleavings
// where a session's owner and the client's own openness are no longer the same fact.
//
// The membership rule is now "a site that reads or writes which attempt owns the open
// session", and the boundary controls are drawn from outside THAT: `discover()` (no entry
// guard, installs nothing, decides no ownership) and the failing-close `tools()` round trip
// (the same adverse peer the ownership instruments use, on a path that claims nothing). A
// green control proves the driver reports the ABSENCE of joining and of close activity rather
// than only their presence. `closes nothing when disconnect is called before any connect` is
// no longer a control: its early return now READS the owner, which puts it inside the
// population it would have to bound. It stays as a behavioral test.
describe('MCPClient — connect/disconnect ordering', () => {
	it('joins a concurrent connect into one handshake and one connect event', async () => {
		const loopback = createDispatchPeer(createPeerServer())
		const client = createMCPClient({ transport: loopback })
		const connects = new MCPFixtureCell(0)
		client.emitter.on('connect', () => {
			connects.value += 1
		})

		await Promise.all([client.connect(), client.connect()])

		expect(loopback.started).toBe(1)
		expect(loopback.sent).toEqual(['server/discover'])
		expect(connects.value).toBe(1)
		expect(client.connected).toBe(true)
		expect(client.version).toBe('2026-07-28')
	})

	it('aborts an in-flight connect when disconnect is awaited, closing the transport once', async () => {
		// The peer answers nothing, and the default 30-second deadline has not fired when
		// `disconnect` settles the pending discovery request.
		const peer = createFixturePeer({ reply: () => undefined })
		const client = createMCPClient({ transport: peer })

		const connecting = client.connect()
		await waitForDelay()
		await client.disconnect()

		expect(peer.closed).toBe(1)
		expect(peer.lifecycle).toEqual(['start', 'close'])
		await expect(connecting).rejects.toThrow('MCP client disconnected')
		expect(client.connected).toBe(false)
		expect(client.version).toBeUndefined()
	})

	it('closes the transport when a modern negotiation rejects', async () => {
		// The peer advertises only a revision this client does not know, so discovery parses
		// but negotiation finds no common version — a modern-path failure exit.
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return buildPeerDiscovery(request.id, ['1999-01-01'])
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toMatchObject({ code: MCP_UNSUPPORTED_VERSION })

		expect(peer.closed).toBe(1)
		expect(peer.lifecycle).toEqual(['start', 'close'])
		expect(client.connected).toBe(false)
		expect(client.version).toBeUndefined()
	})

	it('waits for an in-flight disconnect before starting a reconnect', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return buildPeerDiscovery(request.id)
			},
			close: { hold: () => true },
		})
		const client = createMCPClient({ transport: peer })
		await client.connect()

		// Neither is awaited: the reconnect is issued while the close is still suspended.
		const disconnecting = client.disconnect()
		const reconnecting = client.connect()
		await waitForDelay()

		// The transport has not closed yet, so it must not have been started again either.
		expect(peer.lifecycle).toEqual(['start'])

		peer.release()
		await disconnecting
		await reconnecting

		expect(peer.lifecycle).toEqual(['start', 'close', 'start'])
		expect(client.connected).toBe(true)
	})

	it('runs two concurrent discover() calls as two independent requests', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return buildPeerDiscovery(request.id)
			},
		})
		const client = createMCPClient({ transport: peer })

		const [first, second] = await Promise.all([client.discover(), client.discover()])

		expect(peer.sent).toEqual(['server/discover', 'server/discover'])
		expect(peer.requests.map((request) => request.id)).toEqual([1, 2])
		expect(first).toEqual(second)
	})

	it("closes the transport once when a disconnect lands during a failing attempt's own close", async () => {
		// The narrowest window in the whole seam: the failing attempt is ALREADY inside its own
		// `close()` when the disconnect arrives. Nothing the client publishes can be re-read
		// across that suspension — the attempt must have claimed the transport before it
		// suspended, or the teardown closes a transport that is already closing.
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return buildPeerDiscovery(request.id, ['1999-01-01'])
			},
			close: { hold: () => true },
		})
		const client = createMCPClient({ transport: peer })

		const connecting = client.connect()
		await waitForDelay(20)
		const disconnecting = client.disconnect()
		await waitForDelay(20)
		peer.release()
		await disconnecting
		await expect(connecting).rejects.toMatchObject({ code: MCP_UNSUPPORTED_VERSION })

		expect(peer.started).toBe(1)
		expect(peer.lifecycle).toEqual(['start', 'close'])
		expect(peer.closed).toBe(1)
	})

	it('settles a superseded connect that was retrying discovery after an unsupported version', async () => {
		// `-32022` sends the negotiation back for ONE retry, and the disconnect lands inside
		// that rejection. The retry is a fresh wire write and a fresh pending entry created
		// AFTER the teardown drained `#pending`, so an unbounded client would have nothing left
		// to settle it: the bound below turns a hang into a failure rather than a stalled suite.
		const peer = createFixturePeer({
			reply: (request, count) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				if (count > 1) return undefined
				void client.disconnect()
				return buildPeerError(request.id, MCP_UNSUPPORTED_VERSION, { supported: ['2025-11-25'] })
			},
		})
		const client = createMCPClient({ transport: peer })
		const connecting = client.connect()
		const settled: string[] = []
		void connecting.then(
			() => settled.push('resolved'),
			(error: unknown) => settled.push(error instanceof Error ? error.message : String(error)),
		)

		await waitForDelay(50)

		expect(settled).toEqual(['MCP client disconnected'])
		expect(peer.sent).toEqual(['server/discover'])
		expect(peer.lifecycle).toEqual(['start', 'close'])
		expect(client.connected).toBe(false)
	}, 2_000)

	it('fires no disconnect event for a client that was never connected', async () => {
		// The same interleaving as the double close, read through the PUBLIC events instead of
		// the transport: `disconnect` is the counterpart of `connect`, so an attempt that never
		// announced a connection must not announce losing one.
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return buildPeerDiscovery(request.id, ['1999-01-01'])
			},
			close: { hold: () => true },
		})
		const client = createMCPClient({ transport: peer })
		const events: string[] = []
		client.emitter.on('connect', () => events.push('connect'))
		client.emitter.on('disconnect', () => events.push('disconnect'))

		const connecting = client.connect()
		await waitForDelay(20)
		const disconnecting = client.disconnect()
		await waitForDelay(20)
		peer.release()
		await disconnecting
		await connecting.catch(() => undefined)

		expect(events).toEqual([])
	})

	it('installs nothing when a modern negotiation is superseded after a successful discovery', async () => {
		// The MODERN install window: discovery SUCCEEDS, and the disconnect lands between that
		// answer and the resumption that would write `version` / `connected` / `connect`. Only
		// the re-ask immediately above the install stands between a closed transport and a
		// client reporting itself connected over it.
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				void client.disconnect()
				return buildPeerDiscovery(request.id)
			},
		})
		const client = createMCPClient({ transport: peer })
		const events: string[] = []
		client.emitter.on('connect', () => events.push('connect'))
		client.emitter.on('disconnect', () => events.push('disconnect'))

		await expect(client.connect()).rejects.toThrow('MCP client disconnected')

		expect(client.connected).toBe(false)
		expect(client.version).toBeUndefined()
		expect(events).toEqual([])
		expect(peer.lifecycle).toEqual(['start', 'close'])
		expect(peer.closed).toBe(1)
	})

	it('closes a negotiation superseded while the transport was still opening, once and after it opened', async () => {
		// The disconnect arrives while `start()` is still suspended, so the teardown finds
		// NOTHING open and closes nothing. The attempt therefore still owns the transport its
		// own `start()` is about to hand it, and closes it the moment that open completes —
		// one close, after the open, with no wire write in between.
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return buildPeerDiscovery(request.id)
			},
			start: { hold: () => true },
		})
		const client = createMCPClient({ transport: peer })

		const connecting = client.connect()
		await waitForDelay()
		await client.disconnect()
		peer.release()

		await expect(connecting).rejects.toThrow('MCP client disconnected')
		expect(peer.lifecycle).toEqual(['start', 'close'])
		expect(peer.closed).toBe(1)
		expect(peer.sent).toEqual([])
		expect(client.connected).toBe(false)
	})

	it('opens one transport when the transport re-enters connect synchronously from start', async () => {
		// The single-flight gate is published through a resolved-promise hop precisely so it is
		// in place before the injected `start()` runs. A transport re-entering at `start()`'s
		// FIRST statement is the only observer that can tell a published gate from one assigned
		// after the call: it must join the attempt already in flight, not open a second one.
		const depth = new MCPFixtureCell(0)
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return buildPeerDiscovery(request.id)
			},
			start: {
				enter: () => {
					if (depth.value >= 3) return
					depth.value += 1
					void client.connect()
				},
			},
		})
		const client = createMCPClient({ transport: peer })

		await client.connect()

		expect(peer.started).toBe(1)
		expect(peer.lifecycle).toEqual(['start'])
		expect(peer.sent).toEqual(['server/discover'])
		expect(client.connected).toBe(true)
		expect(client.version).toBe('2026-07-28')
	})

	it('closes nothing when disconnect is called before any connect', async () => {
		const peer = createFixturePeer({ reply: () => undefined })
		const client = createMCPClient({ transport: peer })

		await client.disconnect()

		expect(peer.lifecycle).toEqual([])
		expect(peer.closed).toBe(0)
		expect(peer.started).toBe(0)
		expect(client.connected).toBe(false)
	})

	it('makes a second disconnect await the close already in flight', async () => {
		// `hold` suspends the teardown's `close()`, so the second caller arrives while the first
		// teardown owns the shutdown and has ALREADY cleared every claim it held. Nothing left in
		// the client's own state can tell that caller a close is still running — only the
		// published teardown can — so it has to be handed THAT promise rather than a resolved
		// one, or `await client.disconnect()` returns while the transport is still closing.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? buildPeerDiscovery(request.id)
					: undefined,
			close: { hold: () => true },
		})
		const client = createMCPClient({ transport: peer })
		await client.connect()

		const joined = new MCPFixtureCell(false)
		const first = client.disconnect()
		const second = client.disconnect().then(() => {
			joined.value = true
		})
		await waitForDelay(20)

		expect(joined.value).toBe(false)
		expect(peer.lifecycle).toEqual(['start'])

		peer.release()
		await Promise.all([first, second])

		expect(joined.value).toBe(true)
		expect(peer.lifecycle).toEqual(['start', 'close'])
		expect(peer.closed).toBe(1)
	}, 2_000)

	it('publishes the teardown before running it, so a caller sees one coherent transition', async () => {
		// `disconnect()` hands back a promise for work that has not started yet: the teardown is
		// published FIRST and runs a hop later, exactly as `connect()` publishes its attempt ahead
		// of `#negotiate`. A teardown running inside the caller's own synchronous stretch would
		// have closed the transport and unpublished `connected` before the caller could observe
		// either the promise it was given or the state it still had.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? buildPeerDiscovery(request.id)
					: undefined,
		})
		const client = createMCPClient({ transport: peer })
		await client.connect()

		const closing = client.disconnect()

		expect(client.connected).toBe(true)
		expect(peer.lifecycle).toEqual(['start'])

		await closing

		expect(client.connected).toBe(false)
		expect(peer.lifecycle).toEqual(['start', 'close'])
	})

	it("surfaces a failing close from an attempt's own unwind and keeps that session reachable", async () => {
		// The attempt-side twin of the teardown's close fault, and distinct failures owed to
		// distinct audiences: the caller gets the negotiation's error (why the connection did not
		// happen), the `error` event gets the transport fault (a session that is still open).
		// Ownership survives the fault, so `disconnect` can still reach that session.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? buildPeerDiscovery(request.id, ['1999-01-01'])
					: undefined,
			close: { fault: () => true },
		})
		const client = createMCPClient({ transport: peer })
		const faults: string[] = []
		client.emitter.on('error', (error: unknown) =>
			faults.push(error instanceof Error ? error.message : String(error)),
		)

		await expect(client.connect()).rejects.toMatchObject({ code: MCP_UNSUPPORTED_VERSION })

		expect(faults).toEqual(['transport close failed'])
		expect(peer.closed).toBe(1)
		expect(client.connected).toBe(false)

		await expect(client.disconnect()).rejects.toThrow('transport close failed')

		expect(peer.closed).toBe(2)
	}, 2_000)

	it('joins two reconnects issued while a superseded attempt is still opening', async () => {
		// Two callers outwaiting the SAME superseded attempt resume together. The first to resume
		// opens the next session; the second has to find that session and join it. Both opening is
		// exactly how two sessions end up with one owner, and only one of them is ever closed.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? buildPeerDiscovery(request.id)
					: undefined,
			start: { hold: () => true },
		})
		const client = createMCPClient({ transport: peer })
		const settled: string[] = []
		void client.connect().then(
			() => settled.push('resolved'),
			(error: unknown) => settled.push(error instanceof Error ? error.message : String(error)),
		)

		await waitForDelay()
		await client.disconnect()
		const first = client.connect()
		const second = client.connect()
		await waitForDelay()

		// The superseded attempt's own `start()` completes, so it closes what it opened.
		peer.release()
		await waitForDelay()
		// Exactly one new attempt is opening, and the second caller is waiting on it.
		peer.release()
		await Promise.all([first, second])

		expect(settled).toEqual(['MCP client disconnected'])
		expect(peer.lifecycle).toEqual(['start', 'close', 'start'])
		expect(peer.started).toBe(2)
		expect(client.connected).toBe(true)
	}, 2_000)

	it('waits for a superseded attempt to settle before opening the next session', async () => {
		// The admission rule that keeps one session to one owner. A teardown does NOT wait for the
		// attempt it supersedes, so the only thing between that attempt and a second live one is
		// the next `connect()` outwaiting it. Here the superseded attempt is still inside
		// `start()`: nothing was open when the teardown ran, so it closed nothing and the attempt
		// still owes that close. An attempt opening beside it would leave two sessions with one
		// owner, and exactly one of them would ever be closed.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? buildPeerDiscovery(request.id)
					: undefined,
			start: { hold: () => true },
		})
		const client = createMCPClient({ transport: peer })
		const settled: string[] = []
		void client.connect().then(
			() => settled.push('resolved'),
			(error: unknown) => settled.push(error instanceof Error ? error.message : String(error)),
		)

		await waitForDelay()
		await client.disconnect()
		const reconnecting = client.connect()
		await waitForDelay()

		expect(peer.lifecycle).toEqual([])
		expect(peer.started).toBe(0)

		// The superseded attempt's own `start()` completes, so it closes what it opened.
		peer.release()
		await waitForDelay()

		expect(settled).toEqual(['MCP client disconnected'])
		expect(peer.lifecycle).toEqual(['start', 'close'])

		// Only now does the next attempt open anything.
		peer.release()
		await reconnecting

		expect(peer.lifecycle).toEqual(['start', 'close', 'start'])
		expect(client.connected).toBe(true)
	}, 2_000)

	it('lists remote tools over a peer whose close fails, deciding no ownership at all', async () => {
		// The boundary control for the ownership instruments in this block. Their membership rule
		// is "a site that reads or writes which attempt owns the open session"; `tools()` — the
		// request, the descriptor mapping, the content round trip — is drawn from OUTSIDE it, and
		// runs here on the same failing-close peer those instruments use. Green proves that peer
		// does not by itself manufacture an ownership signal, and that this driver can report the
		// ABSENCE of close activity rather than only its presence.
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.id === undefined) return undefined
				if (request.method === 'server/discover') return buildPeerDiscovery(request.id)
				if (request.method === 'tools/list') {
					return {
						jsonrpc: '2.0',
						id: request.id,
						result: {
							tools: [
								{ name: 'search', description: 'Find things', inputSchema: { type: 'object' } },
							],
						},
					}
				}
				return undefined
			},
			close: { fault: () => true },
		})
		const client = createMCPClient({ transport: peer })
		const events: string[] = []
		client.emitter.on('error', () => events.push('error'))
		client.emitter.on('disconnect', () => events.push('disconnect'))
		await client.connect()

		const tools = await client.tools()

		expect(tools.map((tool) => tool.name)).toEqual(['search'])
		expect(tools[0]?.description).toBe('Find things')
		expect(tools[0]?.parameters).toEqual({ type: 'object' })
		expect(events).toEqual([])
		expect(peer.closed).toBe(0)
		expect(client.connected).toBe(true)
	})

	it('reports a failing teardown close, still announces the loss, and closes again on a retry', async () => {
		// A transport whose shutdown FAILS. The close did NOT happen, so the client's ownership of
		// that session has to survive the fault: `disconnect` is the only path that can try
		// again, and a client that discarded its claim leaves a real session open for the
		// process's life with no public way left to reach it.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? buildPeerDiscovery(request.id)
					: undefined,
			close: { fault: () => true },
		})
		const client = createMCPClient({ transport: peer })
		const events: string[] = []
		client.emitter.on('disconnect', () => events.push('disconnect'))
		await client.connect()

		await expect(client.disconnect()).rejects.toThrow('transport close failed')

		// The announcement is owed and the fault does not swallow it.
		expect(events).toEqual(['disconnect'])
		expect(peer.closed).toBe(1)
		expect(client.connected).toBe(false)

		await expect(client.disconnect()).rejects.toThrow('transport close failed')

		expect(peer.closed).toBe(2)
		expect(peer.lifecycle).toEqual(['start', 'close', 'close'])
		// Still exactly one announcement: `disconnect` answers the `connect` this client fired.
		expect(events).toEqual(['disconnect'])
	}, 2_000)

	it('closes a connection a faulted teardown still owes before the next connect opens', async () => {
		// The OTHER door onto the retry rule. `disconnect` reads the claim a faulted close restored
		// and closes again; `connect` is the entry point that reaches the same rule and never asked.
		// A caller that opens here leaves the un-closed connection with no token and no public path,
		// which is precisely what the retained claim exists to prevent — so the reading that decides
		// this is `live`, not the attempt counts, which cannot tell one closed connection from two
		// close attempts over an open one.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? buildPeerDiscovery(request.id)
					: undefined,
			close: { fault: (count) => count === 1 },
		})
		const client = createMCPClient({ transport: peer })
		await client.connect()

		expect(peer.live).toBe(1)

		await expect(client.disconnect()).rejects.toThrow('transport close failed')

		expect(peer.live).toBe(1)

		// The debt is settled through the same slot `disconnect` publishes, and only then does this
		// caller open: one close for the owed connection, then one start for the new one.
		await client.connect()

		expect(client.connected).toBe(true)
		expect(peer.live).toBe(1)
		expect(peer.lifecycle).toEqual(['start', 'close', 'close', 'start'])

		await client.disconnect()

		expect(peer.live).toBe(0)
		expect(peer.lifecycle).toEqual(['start', 'close', 'close', 'start', 'close'])
	}, 2_000)

	it('closes a connection a faulted attempt-side close still owes before the next connect opens', async () => {
		// The attempt-side twin: the failing close belongs to a negotiation's own unwind rather than
		// to a teardown, and the claim it restores is owed equally. Same rule, second door.
		const peer = createFixturePeer({
			reply: (request, count) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				return count === 1
					? buildPeerDiscovery(request.id, ['1999-01-01'])
					: buildPeerDiscovery(request.id)
			},
			close: { fault: (count) => count === 1 },
		})
		const client = createMCPClient({ transport: peer })
		const faults: string[] = []
		client.emitter.on('error', (error: unknown) =>
			faults.push(error instanceof Error ? error.message : String(error)),
		)

		await expect(client.connect()).rejects.toMatchObject({ code: MCP_UNSUPPORTED_VERSION })

		expect(faults).toEqual(['transport close failed'])
		expect(peer.live).toBe(1)

		await client.connect()

		expect(client.connected).toBe(true)
		expect(peer.live).toBe(1)
		expect(peer.lifecycle).toEqual(['start', 'close', 'close', 'start'])

		await client.disconnect()

		expect(peer.live).toBe(0)
	}, 2_000)

	it('closes an owed connection for a caller that arrived during the faulting teardown', async () => {
		// The narrow arrival: the caller is already waiting on the teardown when its close faults, so
		// it resumes into a client that owes a close it never saw fail. Re-reading the claim after
		// the wait is what keeps it from opening beside that connection.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? buildPeerDiscovery(request.id)
					: undefined,
			close: { fault: (count) => count === 1 },
		})
		const client = createMCPClient({ transport: peer })
		await client.connect()

		const closing = client.disconnect()
		const reconnecting = client.connect()

		await expect(closing).rejects.toThrow('transport close failed')
		await reconnecting

		expect(client.connected).toBe(true)
		expect(peer.live).toBe(1)
		expect(peer.lifecycle).toEqual(['start', 'close', 'close', 'start'])
	}, 2_000)

	it('rejects a teardown whose close never returns instead of wedging every later caller', async () => {
		// A socket that accepts the shutdown and never drains — no fault, no resolution. Neither the
		// drain, nor a request deadline, nor the supersession signal can reach that await, and the
		// teardown stays published while it hangs, so an unbounded client holds `disconnect` AND
		// every later `connect` for the process's life. The bound below turns that hang into a
		// failure rather than a stalled suite. The connection is still open and still owed, so the
		// next `connect` tries the close again and reports the same fault instead of opening beside
		// it.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? buildPeerDiscovery(request.id)
					: undefined,
			close: { hold: () => true },
		})
		const client = createMCPClient({ transport: peer, timeout: 30 })
		await client.connect()

		await expect(client.disconnect()).rejects.toThrow('MCP transport close timed out after 30ms')

		expect(client.connected).toBe(false)
		expect(peer.live).toBe(1)

		await expect(client.connect()).rejects.toThrow('MCP transport close timed out after 30ms')

		expect(client.connected).toBe(false)
		expect(peer.started).toBe(1)
		expect(peer.live).toBe(1)
	}, 2_000)

	it('settles an attempt whose own close never returns, on a path no injected start can reach', async () => {
		// The remaining transport await, and the one the supersession signal does not cover: a modern
		// negotiation that finds no common revision unwinds into its own `close()`, and that close
		// never returns. No `start()` seam is involved — a peer that answers discovery and then
		// never drains reaches it — so the attempt is left unsettled on a path the opening step does
		// not own. The caller is owed the negotiation's error and the observer is owed the transport
		// fault; the connection stays owned, so `disconnect` can still try it.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? buildPeerDiscovery(request.id, ['1999-01-01'])
					: undefined,
			close: { hold: () => true },
		})
		const client = createMCPClient({ transport: peer, timeout: 30 })
		const faults: string[] = []
		client.emitter.on('error', (error: unknown) =>
			faults.push(error instanceof Error ? error.message : String(error)),
		)

		await expect(client.connect()).rejects.toMatchObject({ code: MCP_UNSUPPORTED_VERSION })

		expect(faults).toEqual(['MCP transport close timed out after 30ms'])
		expect(client.connected).toBe(false)
		expect(peer.live).toBe(1)

		await expect(client.disconnect()).rejects.toThrow('MCP transport close timed out after 30ms')

		expect(peer.live).toBe(1)
	}, 2_000)

	it('joins a close that outran its deadline instead of shutting one connection down twice', async () => {
		// A deadline says the shutdown did not ANSWER. It never says the shutdown did not HAPPEN —
		// only the close itself can say that, by rejecting. Here close #1 is still running when the
		// client stops waiting for it and every later close is prompt, so a client that reads the
		// deadline as a fault issues a SECOND close over the same connection, watches that one
		// succeed, and opens a new connection while the first close is still in flight. `closed`
		// counts the calls the transport actually received and `started` says whether anything
		// opened beside them; the peer's `overclose` marker is what the first close's late landing
		// would then produce, because it would be decrementing a connection already in use.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? buildPeerDiscovery(request.id)
					: undefined,
			close: { hold: (count) => count === 1 },
		})
		const client = createMCPClient({ transport: peer, timeout: 30 })
		await client.connect()

		await expect(client.disconnect()).rejects.toThrow('MCP transport close timed out after 30ms')

		// The retry waits on the close already running rather than starting a second one, so it
		// reports the same unanswered shutdown and opens nothing.
		await expect(client.connect()).rejects.toThrow('MCP transport close timed out after 30ms')

		expect(peer.closed).toBe(1)
		expect(peer.started).toBe(1)
		expect(peer.live).toBe(1)

		// And when that one close finally lands, it ends the connection it was given.
		peer.release()
		await waitForDelay()

		expect(peer.live).toBe(0)
		expect(peer.lifecycle).toEqual(['start', 'close'])
	}, 2_000)

	it('recovers when a close that outran its deadline finally succeeds', async () => {
		// The same deadline, the opposite answer: close #1 resolves — successfully — after the
		// client stopped waiting for it, so the connection IS closed and nothing is owed. A second
		// close over an ended connection is what a real transport rejects, which this peer does; a
		// client that issues one is then permanently bricked, because the debt it records can never
		// be cleared and every later `connect` and `disconnect` rejects on it.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? buildPeerDiscovery(request.id)
					: undefined,
			close: { hold: (count) => count === 1, fault: (count) => count > 1 },
		})
		const client = createMCPClient({ transport: peer, timeout: 30 })
		await client.connect()

		await expect(client.disconnect()).rejects.toThrow('MCP transport close timed out after 30ms')

		peer.release()
		await waitForDelay()

		expect(peer.live).toBe(0)

		await client.connect()

		expect(client.connected).toBe(true)
		expect(peer.closed).toBe(1)
		expect(peer.started).toBe(2)
		expect(peer.live).toBe(1)
		expect(peer.lifecycle).toEqual(['start', 'close', 'start'])
	}, 2_000)

	it('issues a fresh close when the one it stopped waiting for finally rejects', async () => {
		// The remaining answer a retained close can give, and the one that keeps the debt: it rejects,
		// long after the deadline. A rejection is the only report that the connection did NOT end, so
		// the claim must survive it AND the dead close must stop being joinable — a client that
		// discharged the claim here would open beside a connection nothing ever closed, and one that
		// kept joining the settled close would rethrow that same fault at every later caller.
		const peer = createFixturePeer({
			reply: (request) =>
				request.method === 'server/discover' && request.id !== undefined
					? buildPeerDiscovery(request.id)
					: undefined,
			close: { hold: (count) => count === 1, fault: (count) => count === 1 },
		})
		const client = createMCPClient({ transport: peer, timeout: 30 })
		await client.connect()

		await expect(client.disconnect()).rejects.toThrow('MCP transport close timed out after 30ms')

		peer.release()
		await waitForDelay()

		// The close answered: it failed, so the connection is still open and still owed.
		expect(peer.live).toBe(1)

		await client.connect()

		expect(client.connected).toBe(true)
		expect(peer.closed).toBe(2)
		expect(peer.live).toBe(1)
		expect(peer.lifecycle).toEqual(['start', 'close', 'close', 'start'])
	}, 2_000)

	it('closes nothing for a transport whose start opened and then rejected', async () => {
		// The obligation the client cannot enforce, recorded where a reader meets it. A `start()`
		// that acquires and then rejects hands back an error and no connection: the claim is made
		// only when the open COMPLETES, so nothing is owned, nothing is closed, and no client-side
		// mechanism can reach what only the transport knows it opened. `MCPMessageTransportInterface`
		// therefore obliges an implementation to release what it acquired before it rejects; this
		// peer deliberately does not, so the strand it leaves shows up as a live connection the
		// client never owned. This is a CONTRACT test, not a defect proof — it passes before and
		// after the fix, because the remedy is documentation on the transport, not code here.
		const peer = createFixturePeer({
			reply: () => undefined,
			start: { fault: () => true },
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toThrow('transport start failed')

		expect(client.connected).toBe(false)
		expect(peer.closed).toBe(0)
		expect(peer.sent).toEqual([])
		// Only the transport can undo what only the transport did.
		expect(peer.live).toBe(1)

		// The client is not wedged by it either: it owes nothing, so the next attempt opens again.
		await expect(client.connect()).rejects.toThrow('transport start failed')

		expect(peer.started).toBe(2)
		expect(peer.closed).toBe(0)
	}, 2_000)
})

// The `send` obligation `MCPMessageTransportInterface` states and `MCPClient` cannot enforce:
// a failing `send` REJECTS, it never throws synchronously. Both tests here are CONTRACT tests
// like the `start` one above — they pass before and after the documentation, because the remedy
// is a sentence on the transport, not machinery in `#request`. Every transport this package
// ships declares `async send`, so no shipped path reaches the violating shape and building
// coordination against it would be defending a requirement nobody had written down.
//
// The pair is the instrument: the conforming half asserts silence, and silence is only evidence
// once the same scenario one keyword away has been shown to break it.
describe('MCPMessageTransportInterface — a failing send rejects, never throws', () => {
	it('strands nothing when a non-async send REJECTS, so a later abort writes nothing', async () => {
		const peer = createWritePeer(false)
		const client = createMCPClient({ transport: peer, timeout: 5_000 })
		await client.connect()
		const caller = new AbortController()

		const pending = client.call('slow', {}, { signal: caller.signal })
		await expect(pending).rejects.toThrow('write failed')
		// The rejection reached `#settle`, so the entry is gone and the caller's listener with
		// it: the abort finds nothing in flight and there is nothing to tell the peer about.
		caller.abort()
		await waitForDelay()

		expect(peer.sent).toEqual(['server/discover', 'tools/call'])
	})

	it('records what a synchronously throwing send costs: a frame naming an undelivered request', async () => {
		const peer = createWritePeer(true)
		const client = createMCPClient({ transport: peer, timeout: 5_000 })
		await client.connect()
		const caller = new AbortController()

		const pending = client.call('slow', {}, { signal: caller.signal })
		// The caller is told, because the executor's throw rejects the promise it was building.
		await expect(pending).rejects.toThrow('write failed')
		// But the throw produced no promise for the write's failure handler to attach to, so the
		// pending entry set one statement earlier never passed through `#settle`. The request
		// still looks in flight to a client that has already given up on it.
		caller.abort()
		await waitForDelay()

		expect(peer.sent).toEqual(['server/discover', 'tools/call', 'notifications/cancelled'])
		const named = peer.requests
			.filter((request) => request.method === 'notifications/cancelled')
			.map((request) => request.params?.['requestId'])
		expect(named).toEqual([readPeerRequestId(peer, 2)])
	})
})

describe('MCPClient — observer safety', () => {
	it('a throwing connect listener cannot corrupt connect, and routes to the error handler', async () => {
		const loopback = createDispatchPeer(createPeerServer())
		const errors: Array<readonly [unknown, string]> = []
		// The emitter's `error` handler receives (error, event) — never a domain event.
		const client = createMCPClient({
			transport: loopback,
			error: (error, event) => errors.push([error, event]),
		})
		client.emitter.on('connect', () => {
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

describe('MCPClient — discovery requires resultType', () => {
	it('refuses a modern discovery result that carries no resultType', async () => {
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.method !== 'server/discover' || request.id === undefined) return undefined
				// Well formed in every other respect — only the mandatory modern discriminator
				// is missing, which is the whole of the claim.
				return {
					jsonrpc: '2.0',
					id: request.id,
					result: {
						supportedVersions: ['2026-07-28'],
						capabilities: { tools: {} },
						ttlMs: 60_000,
						cacheScope: 'private',
					},
				}
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.discover()).rejects.toMatchObject({
			code: JSONRPC_INVALID_PARAMS,
			message: 'MCP server returned a malformed discovery result',
		})
	})

	it('fails CLOSED on connect rather than degrading a bad modern peer to legacy', async () => {
		// This peer would answer `initialize` perfectly well, so a client that read the
		// refusal as "not a modern peer" would negotiate legacy and report success. The era
		// is already settled to modern by the time discovery is validated, so it cannot.
		const peer = createFixturePeer({
			reply: (request) => {
				if (request.id === undefined) return undefined
				if (request.method === 'server/discover') {
					return {
						jsonrpc: '2.0',
						id: request.id,
						result: {
							supportedVersions: ['2026-07-28'],
							capabilities: {},
							ttlMs: 60_000,
							cacheScope: 'private',
						},
					}
				}
				return buildClientHandshakeResponse(request.id, MCP_HANDSHAKE_VERSION)
			},
		})
		const client = createMCPClient({ transport: peer })

		await expect(client.connect()).rejects.toMatchObject({ code: JSONRPC_INVALID_PARAMS })

		expect(client.connected).toBe(false)
		expect(client.version).toBeUndefined()
		expect(peer.sent).toEqual(['server/discover'])
	})

	it('CONTROL — a different method omitting resultType is not refused', async () => {
		// `tools/list` answering without the discriminator is a legacy-shaped result the
		// response path still admits; the discovery rule must not fire for it.
		const peer = createCallPeer((request) =>
			request.method === 'tools/list' && request.id !== undefined
				? { jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'echo' }] } }
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		const tools = await client.tools()

		expect(tools.map((tool) => tool.name)).toEqual(['echo'])
	})
})

describe('MCPClient — call() result polymorphism', () => {
	it('answers the task arm when the server deferred the call', async () => {
		const task = {
			resultType: 'task',
			taskId: 'task-1',
			status: 'working',
			createdAt: '2026-07-28T00:00:00Z',
			lastUpdatedAt: '2026-07-28T00:00:00Z',
			ttlMs: null,
			pollIntervalMs: 500,
		}
		const peer = createCallPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? buildPeerCallResponse(request.id, task)
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		const outcome = await client.call('slow', {})

		expect(outcome).toEqual(task)
		if (outcome.resultType !== 'task') throw new Error('Expected the task arm')
		expect(outcome.taskId).toBe('task-1')
		expect(outcome.pollIntervalMs).toBe(500)
	})

	it('answers the input_required arm when the call needs another round trip', async () => {
		const peer = createCallPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? buildPeerCallResponse(request.id, {
						resultType: 'input_required',
						requestState: 'opaque-state',
					})
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		const outcome = await client.call('secured', {})

		if (outcome.resultType !== 'input_required') throw new Error('Expected the input arm')
		expect(outcome.requestState).toBe('opaque-state')
	})

	it('CONTROL — an unknown resultType is refused even on tools/call', async () => {
		// The class the arm narrowing structurally cannot handle. Carrying it would
		// hand a caller an arm whose meaning this client invented.
		const peer = createCallPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? buildPeerCallResponse(request.id, { resultType: 'future', content: [] })
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		await expect(client.call('echo', {})).rejects.toMatchObject({
			code: JSONRPC_INVALID_PARAMS,
			message: "MCP result type 'future' is not supported",
		})
	})

	it('refuses a task arm whose payload is malformed', async () => {
		const peer = createCallPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? buildPeerCallResponse(request.id, {
						resultType: 'task',
						taskId: 'task-1',
						status: 'flying',
					})
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		await expect(client.call('slow', {})).rejects.toMatchObject({
			code: JSONRPC_INVALID_PARAMS,
			message: 'MCP server returned a malformed task result',
		})
	})

	it('refuses an input arm carrying neither requests nor state', async () => {
		const peer = createCallPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? buildPeerCallResponse(request.id, { resultType: 'input_required' })
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		await expect(client.call('secured', {})).rejects.toMatchObject({
			code: JSONRPC_INVALID_PARAMS,
			message: 'MCP server returned a malformed input request',
		})
	})

	it('a wrapped tool throws rather than handing an agent a deferred answer', async () => {
		const peer = createCallPeer((request) => {
			if (request.id === undefined) return undefined
			if (request.method === 'tools/list') {
				return { jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'slow' }] } }
			}
			return buildPeerCallResponse(request.id, {
				resultType: 'task',
				taskId: 'task-1',
				status: 'working',
				createdAt: '2026-07-28T00:00:00Z',
				lastUpdatedAt: '2026-07-28T00:00:00Z',
				ttlMs: null,
			})
		})
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const remote = createToolManager()
		remote.add(await client.tools())

		// An agent's registry isolates the throw into a failure result — where returning
		// `undefined` would have read as a tool that succeeded and produced nothing.
		const result = await remote.execute({ id: 'c1', name: 'slow', arguments: {} })

		expect(result).toEqual({
			id: 'c1',
			name: 'slow',
			success: false,
			error: "MCP tool 'slow' answered 'task' and has no inline value",
		})
	})
})

describe('MCPClient — call() prefers structuredContent', () => {
	it('returns the structured value rather than re-parsing the rendered text', async () => {
		// The real MCP idiom: `content` is a rendering for a model to read and
		// `structuredContent` is the value. Re-deriving one from the other is a guess that
		// is right only while the server serialized exactly the value and nothing else.
		const peer = createCallPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? buildPeerCallResponse(request.id, {
						resultType: 'complete',
						content: [{ type: 'text', text: 'Found 3 results' }],
						structuredContent: { count: 3 },
					})
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		expect(await client.call('search', {})).toEqual({
			resultType: 'complete',
			value: { count: 3 },
		})
	})

	it('prefers an explicit null structured value over the text blocks', async () => {
		// `null` is a value the tool returned, not an absence — the distinction a presence
		// check keeps and an `undefined` check would lose.
		const peer = createCallPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? buildPeerCallResponse(request.id, {
						resultType: 'complete',
						content: [{ type: 'text', text: '"ignored"' }],
						structuredContent: null,
					})
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		expect(await client.call('nothing', {})).toEqual({ resultType: 'complete', value: null })
	})

	it('falls back to the parsed text when the peer sent no structured value', async () => {
		const peer = createCallPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? buildPeerCallResponse(request.id, {
						resultType: 'complete',
						content: [{ type: 'text', text: '{"echoed":"x"}' }],
					})
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		expect(await client.call('echo', {})).toEqual({
			resultType: 'complete',
			value: { echoed: 'x' },
		})
	})

	it('falls back to the raw text when it is not JSON', async () => {
		const peer = createCallPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? buildPeerCallResponse(request.id, {
						resultType: 'complete',
						content: [{ type: 'text', text: 'plain words' }],
					})
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		expect(await client.call('echo', {})).toEqual({
			resultType: 'complete',
			value: 'plain words',
		})
	})

	it('carries a value-less success as an undefined value', async () => {
		const peer = createCallPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? buildPeerCallResponse(request.id, { resultType: 'complete', content: [] })
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		expect(await client.call('quiet', {})).toEqual({ resultType: 'complete', value: undefined })
	})

	it('still throws a remote isError before reading any structured value', async () => {
		const peer = createCallPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? buildPeerCallResponse(request.id, {
						resultType: 'complete',
						content: [{ type: 'text', text: 'tool exploded' }],
						structuredContent: { swallowed: true },
						isError: true,
					})
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()

		await expect(client.call('boom', {})).rejects.toThrow('tool exploded')
		const refusal: unknown = await client.call('boom', {}).catch((error: unknown) => error)
		expect(isMCPToolError(refusal)).toBe(true)
	})
})

describe('MCPClient — wrapped tool context', () => {
	it('omits wrapped annotations when the wire descriptor has empty annotations', async () => {
		const peer = createCallPeer((request) =>
			request.method === 'tools/list' && request.id !== undefined
				? {
						jsonrpc: '2.0',
						id: request.id,
						result: {
							tools: [{ name: 'inspect', inputSchema: { type: 'object' }, annotations: {} }],
						},
					}
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		try {
			await client.connect()
			const [tool] = await client.tools()
			expect(tool?.name).toBe('inspect')
			expect(tool?.annotations).toBeUndefined()
		} finally {
			await client.disconnect()
		}
	})

	it('maps readOnlyHint while ignoring an unconsumed malformed openWorldHint', async () => {
		const peer = createCallPeer((request) =>
			request.method === 'tools/list' && request.id !== undefined
				? {
						jsonrpc: '2.0',
						id: request.id,
						result: {
							tools: [
								{
									name: 'inspect',
									inputSchema: { type: 'object' },
									annotations: { readOnlyHint: true, openWorldHint: 'yes' },
								},
							],
						},
					}
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		try {
			await client.connect()
			const [tool] = await client.tools()
			expect(tool?.name).toBe('inspect')
			expect(tool?.annotations).toEqual({ pure: true })
		} finally {
			await client.disconnect()
		}
	})

	it('forwards a wrapped tool context signal to the server and preserves the connection after abort', async () => {
		const probe = createAbortTools()
		const serverSide = createMemoryTransport()
		const clientSide = createMemoryTransport()
		serverSide.connect(clientSide)
		clientSide.connect(serverSide)
		const server = createMCPServer({
			identity: { name: 'abort', version: '1' },
			tools: probe.tools,
		})
		const unbindServer = bindServer(server, serverSide)
		const client = createMCPClient({
			transport: createDuplexClientTransport(clientSide),
			timeout: 100,
		})
		const unbindClient = bindClient(client, clientSide)
		const controller = new AbortController()
		try {
			await client.connect()
			const tools = await client.tools()
			const tool = requireValue(
				tools.find((candidate) => candidate.name === 'wait'),
				'Missing wait tool',
			)
			const pending = Promise.resolve(tool.execute({}, { signal: controller.signal }))
			const rejected = pending.catch((error: unknown) => error)
			const signal = await probe.entered
			expect(signal.aborted).toBe(false)
			controller.abort()
			expect(await rejected).toMatchObject({ message: expect.stringMatching(/aborted/) })
			expect(signal.aborted).toBe(true)
			await probe.aborted
			expect(await client.call('echo', { value: 'usable' })).toEqual({
				resultType: 'complete',
				value: 'usable',
			})
		} finally {
			probe.release()
			controller.abort()
			await client.disconnect()
			unbindClient()
			unbindServer()
		}
	})

	it('carries title and inverse-projected annotations while advertising the authored summary', async () => {
		const tools = createToolManager()
		tools.add(
			createTool({
				name: 'inspect',
				title: 'Inspect record',
				description: 'Full description',
				summary: 'Short description',
				annotations: { pure: false, consequential: true, untrusted: true },
				execute: () => 1,
			}),
		)
		const server = createMCPServer({ identity: { name: 'metadata', version: '1' }, tools })
		const client = createMCPClient({ transport: createLoopbackTransport(server) })
		try {
			await client.connect()
			const [tool] = await client.tools()
			expect(tool?.title).toBe('Inspect record')
			expect(tool?.description).toBe('Short description')
			expect(tool?.summary).toBeUndefined()
			expect(tool?.annotations).toEqual({ pure: false, consequential: true })
		} finally {
			await client.disconnect()
		}
	})
})

describe('MCPClient — per-request cancellation', () => {
	it('rejects the caller and tells a duplex peer which request was cancelled', async () => {
		const peer = createCallPeer(() => undefined)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const controller = new AbortController()

		const pending = client.call('slow', {}, { signal: controller.signal })
		const id = readPeerRequestId(peer, 2)
		controller.abort()

		await expect(pending).rejects.toThrow("MCP request 'tools/call' was aborted")
		const cancelled = peer.requests.find((request) => request.method === 'notifications/cancelled')
		expect(cancelled?.params).toEqual({ requestId: id })
		// It carries no id, so nothing will ever answer it.
		expect(cancelled?.id).toBeUndefined()
	})

	it('carries a string abort reason on the wire and omits a non-string one', async () => {
		const peer = createCallPeer(() => undefined)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const spoken = new AbortController()
		const silent = new AbortController()

		const first = client.call('slow', {}, { signal: spoken.signal })
		const second = client.call('slow', {}, { signal: silent.signal })
		const ids = [readPeerRequestId(peer, 2), readPeerRequestId(peer, 3)]
		spoken.abort('operator stopped')
		silent.abort(new Error('not a wire string'))

		await expect(first).rejects.toThrow(/was aborted/)
		await expect(second).rejects.toThrow(/was aborted/)
		const frames = peer.requests.filter((request) => request.method === 'notifications/cancelled')
		expect(frames[0]?.params).toEqual({ requestId: ids[0], reason: 'operator stopped' })
		expect(frames[1]?.params).toEqual({ requestId: ids[1] })
	})

	it('CONTROL — a duplex:false carrier settles the caller and sends ZERO frames', async () => {
		// Drawn from outside the frame's population: a carrier with no client-to-server
		// notification channel at all. The dated revision defines none over Streamable HTTP,
		// where closing the response stream is itself the cancellation signal.
		const peer = createCallPeer(() => undefined, false)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const controller = new AbortController()

		const pending = client.call('slow', {}, { signal: controller.signal })
		controller.abort()

		await expect(pending).rejects.toThrow("MCP request 'tools/call' was aborted")
		expect(peer.sent).toEqual(['server/discover', 'tools/call'])
	})

	it('refuses an already-aborted caller before anything is written', async () => {
		const peer = createCallPeer(() => undefined)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const controller = new AbortController()
		controller.abort()

		await expect(client.call('slow', {}, { signal: controller.signal })).rejects.toThrow(
			"MCP request 'tools/call' was aborted",
		)

		// Nothing went out, so there is no id the peer could be told about.
		expect(peer.sent).toEqual(['server/discover'])
	})

	it('sends nothing when the request is already over — a task is not the request', async () => {
		const peer = createCallPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? buildPeerCallResponse(request.id, {
						resultType: 'task',
						taskId: 'task-1',
						status: 'working',
						createdAt: '2026-07-28T00:00:00Z',
						lastUpdatedAt: '2026-07-28T00:00:00Z',
						ttlMs: null,
					})
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const controller = new AbortController()

		const outcome = await client.call('slow', {}, { signal: controller.signal })
		controller.abort()
		await waitForDelay()

		expect(outcome.resultType).toBe('task')
		// The request ended when the task handle was written; the task itself is untouched,
		// and no cancellation of any kind reaches the wire.
		expect(peer.sent).toEqual(['server/discover', 'tools/call'])
	})

	it('discards a response that arrives after the abort, silently', async () => {
		// Cancellation is ADVISORY: every receiver obligation is `SHOULD`/`MAY` and the spec says
		// to IGNORE a late answer. It is not a fault, and it is not a notification either.
		const peer = createCallPeer(() => undefined)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const notifications: JSONRPCMessage[] = []
		const errors: unknown[] = []
		client.emitter.on('notification', (message) => notifications.push(message))
		client.emitter.on('error', (error) => errors.push(error))
		const controller = new AbortController()

		const pending = client.call('slow', {}, { signal: controller.signal })
		const id = readPeerRequestId(peer, 2)
		controller.abort()
		await expect(pending).rejects.toThrow(/was aborted/)

		peer.emitter.emit('message', buildPeerCallResponse(id, { resultType: 'complete', content: [] }))
		await waitForDelay()

		expect(notifications).toEqual([])
		expect(errors).toEqual([])
	})

	it('cancels one request and leaves the connection and its siblings alone', async () => {
		const peer = createCallPeer((request, count) => {
			if (request.method !== 'tools/call' || request.id === undefined) return undefined
			// The FIRST call is left hanging for the abort; the next answers normally.
			return count === 2
				? undefined
				: buildPeerCallResponse(request.id, { resultType: 'complete', structuredContent: 'second' })
		})
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const controller = new AbortController()

		const cancelled = client.call('slow', {}, { signal: controller.signal })
		controller.abort()
		await expect(cancelled).rejects.toThrow(/was aborted/)

		expect(client.connected).toBe(true)
		expect(await client.call('quick', {})).toEqual({ resultType: 'complete', value: 'second' })
	})

	it('cancels every request one controller is driving', async () => {
		const peer = createCallPeer(() => undefined)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const controller = new AbortController()

		const first = client.call('a', {}, { signal: controller.signal })
		const second = client.call('b', {}, { signal: controller.signal })
		const ids = [readPeerRequestId(peer, 2), readPeerRequestId(peer, 3)]
		controller.abort()

		await expect(first).rejects.toThrow(/was aborted/)
		await expect(second).rejects.toThrow(/was aborted/)
		const named = peer.requests
			.filter((request) => request.method === 'notifications/cancelled')
			.map((request) => request.params?.['requestId'])
		expect(named).toEqual(ids)
	})
})

describe('MCPClient — request-scoped progress', () => {
	it('stamps the progress token only where a caller is listening, and routes the frames', async () => {
		const peer = createCallPeer(() => undefined)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const seen: unknown[] = []
		const notifications: JSONRPCMessage[] = []
		client.emitter.on('notification', (message) => notifications.push(message))

		const pending = client.call('slow', {}, { progress: (progress) => seen.push(progress) })
		const id = readPeerRequestId(peer, 2)
		expect(peer.requests[1]?.params?.['_meta']).toEqual({
			[MCP_META_VERSION]: '2026-07-28',
			[MCP_META_CAPABILITIES]: {},
			[MCP_META_CLIENT]: { name: '@orkestrel/mcp', version: '1.0.0' },
			progressToken: id,
		})

		peer.emitter.emit('message', buildPeerProgress(id, 1))
		peer.emitter.emit('message', buildPeerProgress(id, 2))
		peer.emitter.emit(
			'message',
			buildPeerCallResponse(id, { resultType: 'complete', structuredContent: 'done' }),
		)

		await expect(pending).resolves.toEqual({ resultType: 'complete', value: 'done' })
		expect(seen).toEqual([
			{ progressToken: id, progress: 1 },
			{ progressToken: id, progress: 2 },
		])
		// A claimed frame is NOT also published as a notification.
		expect(notifications).toEqual([])
	})

	it('claims stale-stamped progress for the active call before subscription routing', async () => {
		const peer = createCallPeer(() => undefined)
		const client = createMCPClient({ transport: peer, timeout: 5_000 })
		await client.connect()
		const seen: unknown[] = []
		const notifications: JSONRPCMessage[] = []
		client.emitter.on('notification', (message) => notifications.push(message))

		const pending = client.call('slow', {}, { progress: (progress) => seen.push(progress) })
		const id = readPeerRequestId(peer, 2)
		peer.emitter.emit('message', {
			jsonrpc: '2.0',
			method: 'notifications/progress',
			params: {
				progressToken: id,
				progress: 1,
				_meta: { [MCP_META_SUBSCRIPTION]: 9_999 },
			},
		})
		await waitForDelay()

		expect(seen).toEqual([
			{
				progressToken: id,
				progress: 1,
				_meta: { [MCP_META_SUBSCRIPTION]: 9_999 },
			},
		])
		expect(notifications).toEqual([])
		await client.disconnect()
		await expect(pending).rejects.toThrow(/disconnected/)
	})

	it('stamps the token on the watched request and not on its unwatched sibling', async () => {
		// One assertion over BOTH shapes, so the claim cannot be satisfied by a client that
		// stamps nothing at all: the watched request must carry the token AND the unwatched
		// one must not.
		const peer = createCallPeer((request) =>
			request.method === 'tools/call' && request.id !== undefined
				? buildPeerCallResponse(request.id, { resultType: 'complete', structuredContent: 1 })
				: undefined,
		)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const stamp = {
			[MCP_META_VERSION]: '2026-07-28',
			[MCP_META_CAPABILITIES]: {},
			[MCP_META_CLIENT]: { name: '@orkestrel/mcp', version: '1.0.0' },
		}

		await client.call('watched', {}, { progress: () => undefined })
		await client.call('unwatched', {})

		expect(peer.requests[1]?.params?.['_meta']).toEqual({
			...stamp,
			progressToken: readPeerRequestId(peer, 2),
		})
		expect(peer.requests[2]?.params?.['_meta']).toEqual(stamp)
	})

	it('claims a frame naming an in-flight request and leaves one naming nothing', async () => {
		const peer = createCallPeer(() => undefined)
		const client = createMCPClient({ transport: peer, timeout: 5_000 })
		await client.connect()
		const seen: unknown[] = []
		const notifications: JSONRPCMessage[] = []
		client.emitter.on('notification', (message) => notifications.push(message))

		const pending = client.call('slow', {}, { progress: (progress) => seen.push(progress) })
		const id = readPeerRequestId(peer, 2)
		// The instrument first: a frame naming THIS request is claimed.
		peer.emitter.emit('message', buildPeerProgress(id, 1))
		// The control: a token this client never minted names no request, so it stays an
		// ordinary server notification.
		peer.emitter.emit('message', buildPeerProgress(9_999, 2))
		await waitForDelay()

		expect(seen).toEqual([{ progressToken: id, progress: 1 }])
		expect(notifications).toHaveLength(1)
		await client.disconnect()
		await expect(pending).rejects.toThrow(/disconnected/)
	})

	it('claims a well-formed frame and leaves a malformed one', async () => {
		const peer = createCallPeer(() => undefined)
		const client = createMCPClient({ transport: peer, timeout: 5_000 })
		await client.connect()
		const seen: unknown[] = []
		const notifications: JSONRPCMessage[] = []
		client.emitter.on('notification', (message) => notifications.push(message))

		const pending = client.call('slow', {}, { progress: (progress) => seen.push(progress) })
		const id = readPeerRequestId(peer, 2)
		peer.emitter.emit('message', buildPeerProgress(id, 1))
		// The same token, the same in-flight request — only the payload is not a progress
		// payload, so the handler must not be handed it.
		peer.emitter.emit('message', {
			jsonrpc: '2.0',
			method: 'notifications/progress',
			params: { progressToken: id, progress: 'soon' },
		})
		await waitForDelay()

		expect(seen).toEqual([{ progressToken: id, progress: 1 }])
		expect(notifications).toHaveLength(1)
		await client.disconnect()
		await expect(pending).rejects.toThrow(/disconnected/)
	})

	it('contains a throwing progress handler on the client error channel', async () => {
		const peer = createCallPeer(() => undefined)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const errors: unknown[] = []
		client.emitter.on('error', (error) => errors.push(error))

		const pending = client.call(
			'slow',
			{},
			{
				progress: () => {
					throw new Error('handler boom')
				},
			},
		)
		const id = readPeerRequestId(peer, 2)
		peer.emitter.emit('message', buildPeerProgress(id, 1))
		peer.emitter.emit(
			'message',
			buildPeerCallResponse(id, { resultType: 'complete', structuredContent: 'done' }),
		)

		await expect(pending).resolves.toEqual({ resultType: 'complete', value: 'done' })
		expect(errors).toHaveLength(1)
		expect(errors[0]).toBeInstanceOf(Error)
	})
})

// Every test here proves the instrument BEFORE it proves the release, in the same run and on
// the same request: a progress frame must reach the handler, an abort must reach the wire, and
// the caller's signal must show its listener, WHILE the request is live. Without that half
// these read identically against a client that registered nothing in the first place — which is
// the failure mode a release test is most likely to have and least likely to show.
//
// The abort listener needs its OWN instrument, and for a while it had none. The wire reading —
// "did aborting after the exit write a cancellation frame" — cannot see it: `#abortRequest`
// checks `#pending` before writing anything, so a released listener and an unreleased one
// produce the same silence, and deleting the release from `#settle` left this whole suite
// green. What the release actually buys is on the CALLER's signal, which outlives the request
// and may be driving several calls: without it a long-lived `AbortController` accumulates one
// bound listener per `call` for the client's life. `createSignal` counts them.
describe('MCPClient — every registration is released on every exit', () => {
	it('releases both on the exit nobody enumerates: a rejecting transport.send', async () => {
		const peer = createFixturePeer({
			// The subject's write is PARKED, so its pending entry exists and can be observed
			// live; releasing the park lets the scripted failure land and take the exit.
			send: { park: (method, count) => method === 'tools/call' && count === 2 },
			reply: (request, count) => {
				if (request.id === undefined) return undefined
				if (request.method === 'server/discover') return buildPeerDiscovery(request.id)
				if (request.method !== 'tools/call') return undefined
				return count === 2 ? new Error('write failed') : undefined
			},
		})
		const client = createMCPClient({ transport: peer, timeout: 5_000 })
		await client.connect()
		const seen: unknown[] = []
		const subject = createSignal()
		const sibling = new AbortController()

		const pending = client.call(
			'slow',
			{},
			{ signal: subject.signal, progress: (progress) => seen.push(progress) },
		)
		const id = readPeerRequestId(peer, 2)
		const live = client.call('other', {}, { signal: sibling.signal })
		// LIVE: every registration is real while the write is still in flight.
		peer.emitter.emit('message', buildPeerProgress(id, 1))
		await waitForDelay()
		expect(seen).toEqual([{ progressToken: id, progress: 1 }])
		expect(subject.count).toBe(1)

		peer.release()
		await expect(pending).rejects.toThrow('write failed')

		// RELEASED: the entry is gone, so neither registration answers any more — and the
		// caller's own signal is as clean as the client found it. Read BEFORE anything aborts,
		// because a `once` listener that fires removes itself and would hide the difference.
		expect(subject.count).toBe(0)
		peer.emitter.emit('message', buildPeerProgress(id, 2))
		await waitForDelay()
		subject.controller.abort()
		await waitForDelay()
		// The wire instrument still works after the exit — the sibling's abort proves it.
		sibling.abort()
		await expect(live).rejects.toThrow(/was aborted/)

		expect(seen).toEqual([{ progressToken: id, progress: 1 }])
		const named = peer.requests
			.filter((request) => request.method === 'notifications/cancelled')
			.map((request) => request.params?.['requestId'])
		expect(named).toEqual([readPeerRequestId(peer, 3)])
	})

	it('releases both on the other exit nobody enumerates: disconnect mid-flight', async () => {
		const peer = createCallPeer(() => undefined)
		const client = createMCPClient({ transport: peer, timeout: 5_000 })
		await client.connect()
		const seen: unknown[] = []
		const subject = createSignal()
		const probe = new AbortController()

		const pending = client.call(
			'slow',
			{},
			{ signal: subject.signal, progress: (progress) => seen.push(progress) },
		)
		const id = readPeerRequestId(peer, 2)
		const probed = client.call('other', {}, { signal: probe.signal })
		// LIVE, every instrument: the frame reaches the handler, an abort reaches the wire, and
		// the caller's signal carries the listener this request registered on it.
		peer.emitter.emit('message', buildPeerProgress(id, 1))
		await waitForDelay()
		probe.abort()
		await expect(probed).rejects.toThrow(/was aborted/)
		expect(seen).toEqual([{ progressToken: id, progress: 1 }])
		expect(subject.count).toBe(1)

		await client.disconnect()
		await expect(pending).rejects.toThrow(/disconnected/)

		// RELEASED by the drain, which knows nothing about any of the registrations.
		expect(subject.count).toBe(0)
		peer.emitter.emit('message', buildPeerProgress(id, 2))
		await waitForDelay()
		subject.controller.abort()
		await waitForDelay()

		expect(seen).toEqual([{ progressToken: id, progress: 1 }])
		const named = peer.requests
			.filter((request) => request.method === 'notifications/cancelled')
			.map((request) => request.params?.['requestId'])
		expect(named).toEqual([readPeerRequestId(peer, 3)])
	})

	it('releases both when the request simply answers', async () => {
		const peer = createCallPeer(() => undefined)
		const client = createMCPClient({ transport: peer, timeout: 5_000 })
		await client.connect()
		const seen: unknown[] = []
		const subject = createSignal()
		const sibling = new AbortController()

		const pending = client.call(
			'quick',
			{},
			{ signal: subject.signal, progress: (progress) => seen.push(progress) },
		)
		const id = readPeerRequestId(peer, 2)
		const live = client.call('other', {}, { signal: sibling.signal })
		peer.emitter.emit('message', buildPeerProgress(id, 1))
		await waitForDelay()
		expect(seen).toEqual([{ progressToken: id, progress: 1 }])
		expect(subject.count).toBe(1)

		peer.emitter.emit(
			'message',
			buildPeerCallResponse(id, { resultType: 'complete', structuredContent: 'done' }),
		)
		await expect(pending).resolves.toEqual({ resultType: 'complete', value: 'done' })

		expect(subject.count).toBe(0)
		peer.emitter.emit('message', buildPeerProgress(id, 2))
		await waitForDelay()
		subject.controller.abort()
		await waitForDelay()
		sibling.abort()
		await expect(live).rejects.toThrow(/was aborted/)

		expect(seen).toEqual([{ progressToken: id, progress: 1 }])
		const named = peer.requests
			.filter((request) => request.method === 'notifications/cancelled')
			.map((request) => request.params?.['requestId'])
		expect(named).toEqual([readPeerRequestId(peer, 3)])
	})

	it('releases both on the request deadline', async () => {
		const peer = createCallPeer(() => undefined)
		const client = createMCPClient({ transport: peer, timeout: 50 })
		await client.connect()
		const seen: unknown[] = []
		const subject = createSignal()
		const probe = new AbortController()

		const pending = client.call(
			'slow',
			{},
			{ signal: subject.signal, progress: (progress) => seen.push(progress) },
		)
		const id = readPeerRequestId(peer, 2)
		const probed = client.call('other', {}, { signal: probe.signal })
		peer.emitter.emit('message', buildPeerProgress(id, 1))
		await waitForDelay()
		probe.abort()
		await expect(probed).rejects.toThrow(/was aborted/)
		expect(seen).toEqual([{ progressToken: id, progress: 1 }])
		expect(subject.count).toBe(1)

		await expect(pending).rejects.toThrow(/timed out/)

		expect(subject.count).toBe(0)
		peer.emitter.emit('message', buildPeerProgress(id, 2))
		await waitForDelay()
		subject.controller.abort()
		await waitForDelay()

		expect(seen).toEqual([{ progressToken: id, progress: 1 }])
		const named = peer.requests
			.filter((request) => request.method === 'notifications/cancelled')
			.map((request) => request.params?.['requestId'])
		expect(named).toEqual([readPeerRequestId(peer, 3)])
	})
})

describe('MCPClient — an uncorrelated response is discarded', () => {
	it('never publishes a response nobody is waiting for as a notification', async () => {
		const loopback = createDispatchPeer(createPeerServer())
		const client = createMCPClient({ transport: loopback })
		await client.connect()
		const seen: JSONRPCMessage[] = []
		client.emitter.on('notification', (message) => seen.push(message))

		// A response is an ANSWER to a request this client issued. With nothing pending it
		// answers a request that already settled — by its deadline, an abort, or a drain —
		// and the protocol says to ignore it, not to announce it as a server message.
		loopback.emitter.emit('message', { jsonrpc: '2.0', id: 4_242, result: { ok: true } })
		loopback.emitter.emit('message', {
			jsonrpc: '2.0',
			id: 4_243,
			error: { code: -32_000, message: 'late' },
		})

		expect(seen).toEqual([])
	})
})

describe('MCPClient — subscriptions/listen', () => {
	it('sends the method and an empty notifications member when the filter is undefined', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const server = createSubscriptionServer(() => source.readable)
		const transport = createLoopbackTransport(server)
		const client = createMCPClient({ transport })
		await client.connect()

		const stream = client.listen(undefined, { signal: new AbortController().signal })
		const acknowledgement = await stream.next()
		const request = transport.messages.find((message) => message.method === 'subscriptions/listen')

		expect(request?.method).toBe('subscriptions/listen')
		expect(request?.params?.['notifications']).toEqual({})
		expect(acknowledgement).toEqual({
			done: false,
			value: {
				jsonrpc: '2.0',
				method: 'notifications/subscriptions/acknowledged',
				params: {
					notifications: {},
					_meta: { [MCP_META_SUBSCRIPTION]: 2 },
				},
			},
		})
		await stream.return({ resultType: 'complete', _meta: { [MCP_META_SUBSCRIPTION]: 2 } })
		expect(transport.messages.map((message) => message.method)).toEqual([
			'server/discover',
			'subscriptions/listen',
			'notifications/cancelled',
		])
	})

	it('yields stamped frames in order as owned snapshots and returns the validated result', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const server = createSubscriptionServer(() => source.readable)
		const transport = createLoopbackTransport(server)
		const client = createMCPClient({ transport })
		await client.connect()
		const stream = client.listen(
			{ promptsListChanged: true, resourceSubscriptions: ['resource://one'] },
			{ signal: new AbortController().signal },
		)
		const writer = source.writable.getWriter()

		expect((await stream.next()).value).toMatchObject({
			method: 'notifications/subscriptions/acknowledged',
		})
		const prompts = { jsonrpc: '2.0' as const, method: 'notifications/prompts/list_changed' }
		const resource = {
			jsonrpc: '2.0' as const,
			method: 'notifications/resources/updated',
			params: { uri: 'resource://one', detail: { revision: 1 } },
		}
		await writer.write(prompts)
		await writer.write(resource)
		resource.params.uri = 'resource://mutated'
		resource.params.detail.revision = 2

		expect(await stream.next()).toEqual({
			done: false,
			value: {
				jsonrpc: '2.0',
				method: 'notifications/prompts/list_changed',
				params: { _meta: { [MCP_META_SUBSCRIPTION]: 2 } },
			},
		})
		expect(await stream.next()).toEqual({
			done: false,
			value: {
				jsonrpc: '2.0',
				method: 'notifications/resources/updated',
				params: {
					uri: 'resource://one',
					detail: { revision: 1 },
					_meta: { [MCP_META_SUBSCRIPTION]: 2 },
				},
			},
		})
		await writer.close()
		expect(await stream.next()).toEqual({
			done: true,
			value: {
				resultType: 'complete',
				_meta: {
					[MCP_META_SUBSCRIPTION]: 2,
					'io.modelcontextprotocol/serverInfo': {
						name: 'subscription-server',
						version: '1.0.0',
					},
				},
			},
		})
	})

	// END TO END, with nothing replaced: a consumer's durable store, a consumer's producer, the
	// server's built-in stream, a real in-process transport, and a real client. The identifier a
	// producer names is what decides delivery, and the agreed set was fixed by a store read that
	// happened once, before the first frame existed.
	it('carries a task transition to a subscribed client, filtered and stamped', async () => {
		const tasks = new TestTaskManager()
		tasks.seed('task-alpha')
		tasks.seed('task-beta')
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const server = createSubscriptionServer(() => source.readable, {}, tasks)
		const transport = createLoopbackTransport(server)
		const client = createMCPClient({ transport })
		await client.connect()
		const stream = client.listen(
			{ taskIds: ['task-alpha', 'task-beta'] },
			{ signal: new AbortController().signal },
		)
		const writer = source.writable.getWriter()

		const acknowledgement = await stream.next()
		// Read after the acknowledgement resolved the set and before any frame is produced —
		// the reading every delivery below is compared against. The positive control proving
		// this counter can move at all is in tests/src/core/MCPServer.test.ts.
		const resolved = tasks.reads.count
		for (const taskId of ['task-alpha', 'task-gamma', 'task-beta']) {
			await writer.write({
				jsonrpc: '2.0',
				method: 'notifications/tasks',
				params: {
					taskId,
					status: 'working',
					createdAt: '1970-01-01T00:00:01.000Z',
					lastUpdatedAt: '1970-01-01T00:00:02.000Z',
					ttlMs: null,
				},
			})
		}
		await writer.close()

		expect(acknowledgement.value).toEqual({
			jsonrpc: '2.0',
			method: 'notifications/subscriptions/acknowledged',
			params: {
				notifications: { taskIds: ['task-alpha', 'task-beta'] },
				_meta: { [MCP_META_SUBSCRIPTION]: 2 },
			},
		})
		expect((await stream.next()).value).toEqual({
			jsonrpc: '2.0',
			method: 'notifications/tasks',
			params: {
				taskId: 'task-alpha',
				status: 'working',
				createdAt: '1970-01-01T00:00:01.000Z',
				lastUpdatedAt: '1970-01-01T00:00:02.000Z',
				ttlMs: null,
				_meta: { [MCP_META_SUBSCRIPTION]: 2 },
			},
		})
		// `task-gamma` was produced between the two, and the client never sees it: the next read
		// is `task-beta`, so the frame naming an identifier outside the agreed set was dropped.
		expect((await stream.next()).value).toMatchObject({
			method: 'notifications/tasks',
			params: { taskId: 'task-beta', _meta: { [MCP_META_SUBSCRIPTION]: 2 } },
		})
		expect(await stream.next()).toEqual({
			done: true,
			value: {
				resultType: 'complete',
				_meta: {
					[MCP_META_SUBSCRIPTION]: 2,
					'io.modelcontextprotocol/serverInfo': {
						name: 'subscription-server',
						version: '1.0.0',
					},
				},
			},
		})
		expect(tasks.reads.count).toBe(resolved)
	})

	it('keeps concurrent subscriptions isolated by their stamped request ids', async () => {
		const prompts = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const resources = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const server = createSubscriptionServer((filter) =>
			filter.promptsListChanged === true ? prompts.readable : resources.readable,
		)
		const transport = createLoopbackTransport(server)
		const client = createMCPClient({ transport })
		await client.connect()
		const signal = new AbortController()
		const promptStream = client.listen({ promptsListChanged: true }, { signal: signal.signal })
		const resourceStream = client.listen(
			{ resourceSubscriptions: ['resource://two'] },
			{ signal: signal.signal },
		)

		const promptAcknowledgement = await Promise.race([
			promptStream.next(),
			waitForDelay(50).then(() => 'timed out'),
		])
		const resourceAcknowledgement = await Promise.race([
			resourceStream.next(),
			waitForDelay(50).then(() => 'timed out'),
		])
		expect(promptAcknowledgement).not.toBe('timed out')
		expect(resourceAcknowledgement).not.toBe('timed out')
		await prompts.writable.getWriter().write({
			jsonrpc: '2.0',
			method: 'notifications/prompts/list_changed',
		})
		await resources.writable.getWriter().write({
			jsonrpc: '2.0',
			method: 'notifications/resources/updated',
			params: { uri: 'resource://two' },
		})

		expect((await promptStream.next()).value).toMatchObject({
			method: 'notifications/prompts/list_changed',
			params: { _meta: { [MCP_META_SUBSCRIPTION]: 2 } },
		})
		expect((await resourceStream.next()).value).toMatchObject({
			method: 'notifications/resources/updated',
			params: { _meta: { [MCP_META_SUBSCRIPTION]: 3 } },
		})
		signal.abort()
	})

	it('keeps an unstamped notification on the client notification event', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const transport = createLoopbackTransport(createSubscriptionServer(() => source.readable))
		const client = createMCPClient({ transport })
		await client.connect()
		const stream = client.listen(undefined, { signal: new AbortController().signal })
		await stream.next()
		const seen: JSONRPCMessage[] = []
		client.emitter.on('notification', (message) => seen.push(message))
		const notification = { jsonrpc: '2.0' as const, method: 'notifications/custom' }

		transport.receive(notification)

		expect(seen).toEqual([notification])
		await stream.return({ resultType: 'complete', _meta: { [MCP_META_SUBSCRIPTION]: 2 } })
	})

	it('drops a late stamped frame after its subscription has closed', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const transport = createLoopbackTransport(createSubscriptionServer(() => source.readable))
		const client = createMCPClient({ transport })
		await client.connect()
		const stream = client.listen(undefined, { signal: new AbortController().signal })
		const acknowledgement = await Promise.race([
			stream.next(),
			waitForDelay(50).then(() => 'timed out'),
		])
		expect(acknowledgement).not.toBe('timed out')
		await source.writable.getWriter().close()
		await stream.next()
		const seen: JSONRPCMessage[] = []
		client.emitter.on('notification', (message) => seen.push(message))

		transport.receive({
			jsonrpc: '2.0',
			method: 'notifications/tools/list_changed',
			params: { _meta: { [MCP_META_SUBSCRIPTION]: 2 } },
		})

		expect(seen).toEqual([])
	})

	it('discards stale-stamped frames that no active call or subscription claims', async () => {
		const peer = createCallPeer(() => undefined)
		const client = createMCPClient({ transport: peer })
		await client.connect()
		const seen: JSONRPCMessage[] = []
		client.emitter.on('notification', (message) => seen.push(message))

		peer.emitter.emit('message', {
			jsonrpc: '2.0',
			method: 'notifications/custom',
			params: { _meta: { [MCP_META_SUBSCRIPTION]: 9_999 } },
		})
		peer.emitter.emit('message', {
			jsonrpc: '2.0',
			method: 'notifications/progress',
			params: {
				progressToken: 8_888,
				progress: 1,
				_meta: { [MCP_META_SUBSCRIPTION]: 9_999 },
			},
		})
		await waitForDelay()

		expect(seen).toEqual([])
	})

	it('rejects a peer subscription error with MCPError', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const transport = createLoopbackTransport(createSubscriptionServer(() => source.readable))
		const client = createMCPClient({ transport })
		await client.connect()
		const stream = client.listen(undefined, { signal: new AbortController().signal })
		await stream.next()
		const parked = stream.next()

		await source.writable.getWriter().abort(new Error('producer failed'))

		await expect(parked).rejects.toMatchObject({ code: -32_603 })
		await expect(parked).rejects.toSatisfy(isMCPError)
	})

	it('rejects a malformed subscription terminal with MCPError', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const transport = createLoopbackTransport(createSubscriptionServer(() => source.readable))
		const client = createMCPClient({ transport })
		await client.connect()
		const stream = client.listen(undefined, { signal: new AbortController().signal })
		await stream.next()
		const parked = stream.next()

		transport.receive({ jsonrpc: '2.0', id: 2, result: { resultType: 'complete', _meta: {} } })

		await expect(parked).rejects.toMatchObject({ code: JSONRPC_INVALID_PARAMS })
		await expect(parked).rejects.toSatisfy(isMCPError)
	})

	it('rejects the first read of a pre-aborted stream without sending', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const transport = createLoopbackTransport(createSubscriptionServer(() => source.readable))
		const client = createMCPClient({ transport })
		await client.connect()
		const controller = new AbortController()
		const reason = new Error('already stopped')
		controller.abort(reason)
		const stream = client.listen(undefined, { signal: controller.signal })

		await expect(stream.next()).rejects.toBe(reason)
		expect(transport.messages.map((message) => message.method)).toEqual(['server/discover'])
	})

	it('snapshots an accessor signal before a later read aborts it', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const transport = createLoopbackTransport(createSubscriptionServer(() => source.readable))
		const client = createMCPClient({ transport })
		await client.connect()
		const captured = new AbortController()
		const replacement = new AbortController()
		const reason = new Error('captured signal stopped')
		const reads = new MCPFixtureCell(0)
		const options = createAccessorSignal(captured, replacement, reason, reads)
		const stream = client.listen({ toolsListChanged: true }, options)

		void options.signal
		const [read] = await Promise.allSettled([stream.next()])

		expect(read).toEqual({ status: 'rejected', reason })
		expect(reads.value).toBe(2)
		expect(transport.messages.map((message) => message.method)).toEqual(['server/discover'])
	})

	it('rejects a parked read with the abort reason and sends notifications/cancelled', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const transport = createLoopbackTransport(createSubscriptionServer(() => source.readable))
		const client = createMCPClient({ transport })
		await client.connect()
		const controller = new AbortController()
		const stream = client.listen(undefined, { signal: controller.signal })
		await stream.next()
		const parked = stream.next()
		const reason = new Error('subscription stopped')

		controller.abort(reason)

		await expect(parked).rejects.toBe(reason)
		expect(transport.messages.map((message) => message.method)).toEqual([
			'server/discover',
			'subscriptions/listen',
			'notifications/cancelled',
		])
	})

	it('fails loudly when the subscription frame queue reaches capacity', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const transport = createLoopbackTransport(createSubscriptionServer(() => source.readable))
		const client = createMCPClient({ transport })
		await client.connect()
		const stream = client.listen(
			{ promptsListChanged: true },
			{
				signal: new AbortController().signal,
				capacity: 1,
			},
		)
		await stream.next()
		const writer = source.writable.getWriter()
		await writer.write({ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' })
		await writer.write({ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' })
		await waitForDelay()

		await expect(stream.next()).rejects.toThrow('subscription frame queue overflow')
	})

	// A subscription carries no request deadline: the configured `timeout` bounds a correlated
	// request, and a stream that outlives it is the guide's claim rather than an accident. The
	// read is parked BEFORE the wait, so a deadline registered on this subscription would settle
	// it while nothing was written, and the frame that follows would arrive too late.
	it('delivers to a read parked past the configured request deadline', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const transport = createLoopbackTransport(createSubscriptionServer(() => source.readable))
		const client = createMCPClient({ transport, timeout: 25 })
		await client.connect()
		const stream = client.listen(
			{ promptsListChanged: true },
			{ signal: new AbortController().signal },
		)
		await stream.next()
		const parked = Promise.allSettled([stream.next()])

		await waitForDelay(50)
		await source.writable
			.getWriter()
			.write({ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' })

		expect(await parked).toEqual([
			{
				status: 'fulfilled',
				value: {
					done: false,
					value: {
						jsonrpc: '2.0',
						method: 'notifications/prompts/list_changed',
						params: { _meta: { [MCP_META_SUBSCRIPTION]: 2 } },
					},
				},
			},
		])
	})

	it('rejects a parked subscription read when the client disconnects', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const transport = createLoopbackTransport(createSubscriptionServer(() => source.readable))
		const client = createMCPClient({ transport })
		await client.connect()
		const stream = client.listen(undefined, { signal: new AbortController().signal })
		await stream.next()
		const parked = stream.next()

		await client.disconnect()

		await expect(parked).rejects.toThrow('MCP client disconnected')
	})

	it('rejects a parked subscription read when the transport closes', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const transport = createLoopbackTransport(createSubscriptionServer(() => source.readable))
		const client = createMCPClient({ transport })
		await client.connect()
		const stream = client.listen(undefined, { signal: new AbortController().signal })
		await stream.next()
		const parked = stream.next()

		await transport.close()

		await expect(parked).rejects.toThrow('MCP transport closed')
	})
})

describe('the client transport event map', () => {
	it('surfaces a parsed JSON-RPC message on the client carrier', () => {
		expectTypeOf<MCPMessageTransportEventMap['message']>().toEqualTypeOf<
			readonly [message: JSONRPCMessage]
		>()
		expectTypeOf<MCPMessageTransportEventMap['close']>().toEqualTypeOf<readonly []>()
	})
})
