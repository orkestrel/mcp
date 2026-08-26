import type {
	JSONRPCInvocation,
	JSONRPCMessage,
	JSONRPCResponse,
	MCPClientTransportEventMap,
	MCPClientTransportInterface,
} from '@src/core'
import { createEmitter } from '@orkestrel/emitter'
import { describe, expect, it } from 'vitest'
import {
	createMCPClient,
	createMCPLegacyClientTransport,
	isMCPError,
	MCP_META_CAPABILITIES,
	MCP_META_CLIENT,
	MCP_META_VERSION,
	MCP_PROTOCOL_VERSION,
	MCP_UNSUPPORTED_VERSION,
} from '@src/core'
import { isRecord } from '@orkestrel/contract'
import { waitForDelay } from '@orkestrel/test'

interface LegacyPeerInterface extends MCPClientTransportInterface {
	readonly sent: readonly JSONRPCMessage[]
	readonly violations: readonly string[]
	readonly closed: number
	readonly lifecycle: readonly string[]
	deliver(message: JSONRPCMessage): void
	release(): void
}

interface LegacyPeerOptions {
	readonly drop?: (method: string, count: number) => boolean
	readonly park?: (method: string, count: number) => boolean
	readonly reply?: (
		request: JSONRPCInvocation,
		count: number,
	) => JSONRPCResponse | Error | undefined
	readonly refuse?: boolean
	readonly version?: unknown
}

function createLegacyPeer(options?: LegacyPeerOptions): LegacyPeerInterface {
	const emitter = createEmitter<MCPClientTransportEventMap>()
	const sent: JSONRPCMessage[] = []
	const violations: string[] = []
	const lifecycle: string[] = []
	const held: Array<() => void> = []
	let closed = 0
	return {
		emitter,
		session: undefined,
		duplex: true,
		get sent() {
			return sent
		},
		get violations() {
			return violations
		},
		get closed() {
			return closed
		},
		get lifecycle() {
			return lifecycle
		},
		async start() {
			lifecycle.push('start')
		},
		async send(message) {
			sent.push(message)
			if (!('method' in message)) return
			const count = sent.length
			if (options?.park?.(message.method, count) === true) {
				await new Promise<void>((resolve) => {
					held.push(resolve)
				})
			}
			const metadata = message.params?.['_meta']
			if (
				isRecord(metadata) &&
				(Object.hasOwn(metadata, MCP_META_VERSION) ||
					Object.hasOwn(metadata, MCP_META_CAPABILITIES) ||
					Object.hasOwn(metadata, MCP_META_CLIENT))
			) {
				violations.push(`modern metadata reached ${message.method}`)
			}
			const scripted = options?.reply?.(message, count)
			if (scripted instanceof Error) throw scripted
			if (scripted !== undefined) {
				emitter.emit('message', scripted)
				return
			}
			if (options?.drop?.(message.method, count) === true) return
			if (message.id === undefined) return
			if (message.method === 'initialize') {
				emitter.emit(
					'message',
					options?.refuse === true
						? {
								jsonrpc: '2.0',
								id: message.id,
								error: { code: -32602, message: 'Legacy handshake refused' },
							}
						: {
								jsonrpc: '2.0',
								id: message.id,
								result: {
									protocolVersion: options?.version ?? '2025-11-25',
									capabilities: { tools: {} },
									serverInfo: { name: 'legacy-peer', version: '1.0.0' },
								},
							},
				)
				return
			}
			if (message.method === 'tools/list') {
				emitter.emit('message', {
					jsonrpc: '2.0',
					id: message.id,
					result: {
						tools: [{ name: 'echo', description: 'Echoes input', inputSchema: { type: 'object' } }],
					},
				})
				return
			}
			if (message.method === 'tools/call') {
				emitter.emit('message', {
					jsonrpc: '2.0',
					id: message.id,
					result: {
						content: [{ type: 'text', text: '{"echoed":"legacy"}' }],
						structuredContent: { echoed: 'legacy' },
					},
				})
			}
		},
		async close() {
			closed += 1
			lifecycle.push('close')
		},
		deliver(message) {
			emitter.emit('message', message)
		},
		release() {
			for (const resolve of held.splice(0)) resolve()
		},
	}
}

function initializeResponse(id: string | number, protocol: unknown): JSONRPCResponse {
	return {
		jsonrpc: '2.0',
		id,
		result: {
			protocolVersion: protocol,
			capabilities: { tools: {} },
			serverInfo: { name: 'legacy-peer', version: '1.0.0' },
		},
	}
}

describe('MCPLegacyClientTransport', () => {
	it('keeps the adapter pin on the legacy handshake and exposes the modern revision', async () => {
		const peer = createLegacyPeer({ version: '2025-06-18' })
		const client = createMCPClient({
			transport: createMCPLegacyClientTransport(peer, { version: '2025-06-18' }),
		})

		await client.connect()

		expect(client.version).toBe('2026-07-28')
		expect(peer.sent).toMatchObject([
			{ method: 'initialize', params: { protocolVersion: '2025-06-18' } },
			{ method: 'notifications/initialized' },
		])
	})

	it('rejects an unsupported negotiated legacy revision before initialization completes', async () => {
		const peer = createLegacyPeer({ version: '2099-01-01' })
		const client = createMCPClient({ transport: createMCPLegacyClientTransport(peer) })

		await expect(client.connect()).rejects.toMatchObject({
			message: "Legacy MCP peer negotiated unsupported protocol version '2099-01-01'",
			code: MCP_UNSUPPORTED_VERSION,
		})
		expect(client.connected).toBe(false)
		expect(peer.closed).toBe(1)
		expect(peer.sent).toMatchObject([{ method: 'initialize' }])
	})

	it('rejects a negotiated revision that differs from the adapter pin', async () => {
		const peer = createLegacyPeer()
		const client = createMCPClient({
			transport: createMCPLegacyClientTransport(peer, { version: '2025-06-18' }),
		})

		await expect(client.connect()).rejects.toMatchObject({
			code: MCP_UNSUPPORTED_VERSION,
			context: { requested: '2025-06-18', negotiated: MCP_PROTOCOL_VERSION },
		})
		expect(client.connected).toBe(false)
		expect(peer.closed).toBe(1)
	})

	it('rejects an absent legacy protocol before initialization completes', async () => {
		const peer = createLegacyPeer({
			reply: (request) =>
				request.method === 'initialize' && request.id !== undefined
					? {
							jsonrpc: '2.0',
							id: request.id,
							result: {
								capabilities: { tools: {} },
								serverInfo: { name: 'legacy-peer', version: '1.0.0' },
							},
						}
					: undefined,
		})
		const client = createMCPClient({ transport: createMCPLegacyClientTransport(peer) })

		await expect(client.connect()).rejects.toThrow(
			'Legacy MCP handshake returned no protocol version',
		)
		expect(client.connected).toBe(false)
		expect(peer.closed).toBe(1)
	})

	it('rejects a malformed legacy protocol before initialization completes', async () => {
		const peer = createLegacyPeer({
			reply: (request) =>
				request.method === 'initialize' && request.id !== undefined
					? initializeResponse(request.id, 42)
					: undefined,
		})
		const client = createMCPClient({ transport: createMCPLegacyClientTransport(peer) })

		await expect(client.connect()).rejects.toThrow(
			'Legacy MCP handshake returned a malformed protocol version',
		)
		expect(client.connected).toBe(false)
		expect(peer.closed).toBe(1)
	})

	it('performs the legacy handshake and synthesizes modern discovery', async () => {
		const peer = createLegacyPeer()
		const client = createMCPClient({ transport: createMCPLegacyClientTransport(peer) })

		await client.connect()
		const discovery = await client.discover()

		expect(client.version).toBe('2026-07-28')
		expect(discovery).toMatchObject({
			supportedVersions: ['2026-07-28'],
			capabilities: { tools: {} },
			resultType: 'complete',
			_meta: {
				'io.modelcontextprotocol/serverInfo': { name: 'legacy-peer', version: '1.0.0' },
			},
		})
		expect(peer.sent.map((message) => ('method' in message ? message.method : 'response'))).toEqual(
			['initialize', 'notifications/initialized'],
		)
	})

	it('preserves legacy instructions in discovery and clears them across reconnect', async () => {
		let handshakes = 0
		const peer = createLegacyPeer({
			reply: (request) => {
				if (request.method !== 'initialize' || request.id === undefined) return undefined
				handshakes += 1
				return {
					jsonrpc: '2.0',
					id: request.id,
					result: {
						protocolVersion: MCP_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: 'legacy-peer', version: '1.0.0' },
						...(handshakes === 1 ? { instructions: 'Use read-only tools' } : {}),
					},
				}
			},
		})
		const client = createMCPClient({ transport: createMCPLegacyClientTransport(peer) })

		await client.connect()
		await expect(client.discover()).resolves.toMatchObject({
			instructions: 'Use read-only tools',
		})
		await client.disconnect()
		await client.connect()
		const discovery = await client.discover()

		expect(Object.hasOwn(discovery, 'instructions')).toBe(false)
	})

	it('refuses a stamped legacy handshake result', async () => {
		const peer = createLegacyPeer({
			reply: (request) =>
				request.method === 'initialize' && request.id !== undefined
					? {
							jsonrpc: '2.0',
							id: request.id,
							result: {
								protocolVersion: MCP_PROTOCOL_VERSION,
								capabilities: { tools: {} },
								serverInfo: { name: 'legacy-peer', version: '1.0.0' },
								resultType: 'complete',
							},
						}
					: undefined,
		})
		const client = createMCPClient({ transport: createMCPLegacyClientTransport(peer) })

		await expect(client.connect()).rejects.toThrow(
			'Legacy MCP handshake returned a malformed result',
		)
		expect(client.connected).toBe(false)
	})

	it('claims a foreign id-0 response while the handshake reservation is open', async () => {
		const peer = createLegacyPeer({ park: (method) => method === 'initialize' })
		const transport = createMCPLegacyClientTransport(peer, { timeout: 30 })
		const starting = transport.start()
		await waitForDelay()

		peer.deliver({
			jsonrpc: '2.0',
			id: 0,
			error: { code: -32601, message: 'foreign id-0 response' },
		})
		peer.release()

		await expect(starting).rejects.toMatchObject({
			code: -32601,
			message: 'foreign id-0 response',
		})
	})

	it('answers discovery before the handshake with a correlated error', async () => {
		const peer = createLegacyPeer()
		const transport = createMCPLegacyClientTransport(peer)
		const messages: JSONRPCMessage[] = []
		const errors: unknown[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('error', (error) => errors.push(error))

		await transport.send({ jsonrpc: '2.0', id: 7, method: 'server/discover' })

		expect(errors).toHaveLength(1)
		expect(messages).toEqual([
			{
				jsonrpc: '2.0',
				id: 7,
				error: {
					code: -32603,
					message: 'Legacy MCP transport has not completed its handshake',
				},
			},
		])
	})

	it('answers a malformed correlated result and forgets its method', async () => {
		const peer = createLegacyPeer({ drop: (method) => method === 'tools/list' })
		const transport = createMCPLegacyClientTransport(peer)
		const messages: JSONRPCMessage[] = []
		const errors: unknown[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('error', (error) => errors.push(error))
		await transport.start()
		await transport.send({ jsonrpc: '2.0', id: 7, method: 'tools/list' })

		peer.deliver({ jsonrpc: '2.0', id: 7, result: { resultType: 'complete' } })
		peer.deliver({ jsonrpc: '2.0', id: 7, result: { tools: [] } })

		expect(errors).toHaveLength(1)
		expect(messages).toEqual([
			{
				jsonrpc: '2.0',
				id: 7,
				error: { code: -32603, message: 'Legacy MCP peer returned a malformed result' },
			},
			{ jsonrpc: '2.0', id: 7, result: { tools: [] } },
		])
	})

	it('bounds a forwarded request that receives no peer response', async () => {
		const peer = createLegacyPeer({ drop: (method) => method === 'tools/list' })
		const transport = createMCPLegacyClientTransport(peer, { timeout: 20 })
		const messages: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		await transport.start()

		await transport.send({ jsonrpc: '2.0', id: 7, method: 'tools/list' })
		await waitForDelay(30)
		peer.deliver({ jsonrpc: '2.0', id: 7, result: { tools: [] } })

		expect(messages).toEqual([
			{
				jsonrpc: '2.0',
				id: 7,
				error: { code: -32603, message: 'Legacy MCP request timed out after 20ms' },
			},
			{ jsonrpc: '2.0', id: 7, result: { tools: [] } },
		])
	})

	it('converts a legacy tools/list result to the modern consumer shape', async () => {
		const peer = createLegacyPeer()
		const client = createMCPClient({ transport: createMCPLegacyClientTransport(peer) })
		await client.connect()

		const tools = await client.tools()

		expect(tools.map((tool) => tool.name)).toEqual(['echo'])
		expect(peer.violations).toEqual([])
	})

	it('converts a legacy tools/call result to the modern consumer shape', async () => {
		const peer = createLegacyPeer()
		const client = createMCPClient({ transport: createMCPLegacyClientTransport(peer) })
		await client.connect()

		await expect(client.call('echo', {})).resolves.toEqual({
			resultType: 'complete',
			value: { echoed: 'legacy' },
		})
		expect(peer.violations).toEqual([])
	})

	it('surfaces a clear failure when the peer refuses the legacy handshake', async () => {
		const peer = createLegacyPeer({ refuse: true })
		const client = createMCPClient({ transport: createMCPLegacyClientTransport(peer) })
		let failure: unknown

		try {
			await client.connect()
		} catch (error) {
			failure = error
		}

		expect(isMCPError(failure)).toBe(true)
		expect(failure).toMatchObject({ message: 'Legacy handshake refused', code: -32602 })
		expect(peer.closed).toBe(1)
	})

	it('leaves the client disconnected when the adapter initialized notification fails', async () => {
		const peer = createLegacyPeer({
			reply: (request) =>
				request.method === 'notifications/initialized'
					? new Error('initialized notification failed')
					: undefined,
		})
		const client = createMCPClient({ transport: createMCPLegacyClientTransport(peer) })

		await expect(client.connect()).rejects.toThrow('initialized notification failed')
		expect(client.connected).toBe(false)
		expect(client.version).toBeUndefined()
		expect(peer.closed).toBe(1)
		expect(peer.sent).toMatchObject([
			{ method: 'initialize' },
			{ method: 'notifications/initialized' },
		])
	})

	it('rejects a superseded connect after the adapter initialized notification lands', async () => {
		const peer = createLegacyPeer({
			park: (method) => method === 'notifications/initialized',
		})
		const client = createMCPClient({ transport: createMCPLegacyClientTransport(peer) })
		const connecting = client.connect()

		await waitForDelay()
		await client.disconnect()
		peer.release()

		await expect(connecting).rejects.toThrow('MCP client disconnected')
		expect(client.connected).toBe(false)
		expect(client.version).toBeUndefined()
		expect(peer.lifecycle).toEqual(['start', 'close'])
	})

	it('completes the adapter-owned handshake before closing a superseded connect', async () => {
		let client = createMCPClient({ transport: createLegacyPeer() })
		const peer = createLegacyPeer({
			reply: (request) => {
				if (request.method !== 'initialize' || request.id === undefined) return undefined
				void client.disconnect()
				return initializeResponse(request.id, MCP_PROTOCOL_VERSION)
			},
		})
		client = createMCPClient({ transport: createMCPLegacyClientTransport(peer) })

		await expect(client.connect()).rejects.toThrow('MCP client disconnected')
		expect(client.connected).toBe(false)
		expect(peer.sent).toMatchObject([
			{ method: 'initialize' },
			{ method: 'notifications/initialized' },
		])
		expect(peer.lifecycle).toEqual(['start', 'close'])
	})

	it('waits for the superseded adapter handshake before opening the next connection', async () => {
		const peer = createLegacyPeer({
			park: (method, count) => method === 'notifications/initialized' && count === 2,
		})
		const client = createMCPClient({ transport: createMCPLegacyClientTransport(peer) })
		const first = client.connect()

		await waitForDelay()
		await client.disconnect()
		const second = client.connect()
		await waitForDelay()

		expect(peer.lifecycle).toEqual(['start'])
		expect(client.connected).toBe(false)

		peer.release()
		await expect(first).rejects.toThrow('MCP client disconnected')
		await second

		expect(client.connected).toBe(true)
		expect(peer.lifecycle).toEqual(['start', 'close', 'start'])
	})

	it('supersedes a permanently parked handshake write and admits the next connect', async () => {
		const peer = createLegacyPeer({
			park: (method, count) => method === 'notifications/initialized' && count === 2,
		})
		const client = createMCPClient({
			transport: createMCPLegacyClientTransport(peer, { timeout: 30 }),
		})

		const first = client.connect()
		await waitForDelay()
		await client.disconnect()
		const second = client.connect()

		await expect(first).rejects.toThrow('Legacy MCP handshake write timed out after 30ms')
		await second

		expect(client.connected).toBe(true)
		expect(peer.lifecycle).toEqual(['start', 'close', 'start'])
	})

	it('surfaces a failing adapter initialized notification on reconnect', async () => {
		let notifications = 0
		const peer = createLegacyPeer({
			reply: (request) => {
				if (request.method !== 'notifications/initialized') return undefined
				notifications += 1
				return notifications > 1 ? new Error('initialized notification failed') : undefined
			},
		})
		const client = createMCPClient({ transport: createMCPLegacyClientTransport(peer) })

		await client.connect()
		await client.disconnect()

		await expect(client.connect()).rejects.toThrow('initialized notification failed')
		expect(client.connected).toBe(false)
		expect(peer.lifecycle).toEqual(['start', 'close', 'start', 'close'])
	})

	it('waits for the adapter handshake write on reconnect', async () => {
		const peer = createLegacyPeer({
			park: (method, count) => method === 'notifications/initialized' && count === 4,
		})
		const client = createMCPClient({ transport: createMCPLegacyClientTransport(peer) })
		await client.connect()
		await client.disconnect()

		let reconnected = false
		const reconnecting = client.connect().then(() => {
			reconnected = true
		})
		await waitForDelay(20)

		expect(reconnected).toBe(false)
		expect(client.connected).toBe(false)

		peer.release()
		await reconnecting

		expect(reconnected).toBe(true)
		expect(client.connected).toBe(true)
	})

	it('repeats the adapter handshake across reconnect without peer discovery', async () => {
		const peer = createLegacyPeer()
		const client = createMCPClient({ transport: createMCPLegacyClientTransport(peer) })

		await client.connect()
		await client.disconnect()
		await client.connect()

		expect(peer.sent).toMatchObject([
			{ method: 'initialize' },
			{ method: 'notifications/initialized' },
			{ method: 'initialize' },
			{ method: 'notifications/initialized' },
		])
		expect(client.version).toBe('2026-07-28')
	})

	it('reports when modern metadata reaches the legacy fixture', async () => {
		const peer = createLegacyPeer()

		await peer.send({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: {
				_meta: {
					[MCP_META_VERSION]: '2026-07-28',
					[MCP_META_CAPABILITIES]: {},
				},
			},
		})

		expect(peer.violations).toEqual(['modern metadata reached tools/list'])
	})
})
