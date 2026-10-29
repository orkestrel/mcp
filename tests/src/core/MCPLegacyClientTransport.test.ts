import type { JSONRPCMessage } from '@src/core'
import { createLegacyPeer, buildLegacyHandshakeResponse, MCPFixtureCell } from '../../setup'
import { describe, expect, it } from 'vitest'
import {
	createMCPClient,
	createMCPLegacyClientTransport,
	isMCPError,
	MCP_META_CAPABILITIES,
	MCP_META_VERSION,
	MCP_HANDSHAKE_VERSION,
	MCP_UNSUPPORTED_VERSION,
} from '@src/core'
import { waitForDelay } from '@orkestrel/test'

describe('MCPLegacyClientTransport', () => {
	it('delivers an id-0 response after the accepted handshake as a message', async () => {
		const peer = createLegacyPeer()
		const transport = createMCPLegacyClientTransport(peer)
		const messages: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		await transport.start()

		const response: JSONRPCMessage = { jsonrpc: '2.0', id: 0, result: { tools: [] } }
		peer.deliver(response)

		expect(messages).toEqual([response])
		await transport.close()
	})

	it('ignores a forwarded request deadline after close', async () => {
		const peer = createLegacyPeer({ drop: (method) => method === 'tools/list' })
		const transport = createMCPLegacyClientTransport(peer, { timeout: 20 })
		const messages: JSONRPCMessage[] = []
		const errors: unknown[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('error', (error) => errors.push(error))
		await transport.start()
		await transport.send({ jsonrpc: '2.0', id: 7, method: 'tools/list' })

		await transport.close()
		await waitForDelay(30)

		expect(messages).toEqual([])
		expect(errors).toEqual([])
	})

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
			context: { requested: '2025-06-18', negotiated: MCP_HANDSHAKE_VERSION },
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
					? buildLegacyHandshakeResponse(request.id, 42)
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
		const handshakes = new MCPFixtureCell(0)
		const peer = createLegacyPeer({
			reply: (request) => {
				if (request.method !== 'initialize' || request.id === undefined) return undefined
				handshakes.value += 1
				return {
					jsonrpc: '2.0',
					id: request.id,
					result: {
						protocolVersion: MCP_HANDSHAKE_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: 'legacy-peer', version: '1.0.0' },
						...(handshakes.value === 1 ? { instructions: 'Use read-only tools' } : {}),
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
								protocolVersion: MCP_HANDSHAKE_VERSION,
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
		const failure = new MCPFixtureCell<unknown>(undefined)

		try {
			await client.connect()
		} catch (error) {
			failure.value = error
		}

		expect(isMCPError(failure.value)).toBe(true)
		expect(failure.value).toMatchObject({ message: 'Legacy handshake refused', code: -32602 })
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
		const client = new MCPFixtureCell(createMCPClient({ transport: createLegacyPeer() }))
		const peer = createLegacyPeer({
			reply: (request) => {
				if (request.method !== 'initialize' || request.id === undefined) return undefined
				void client.value.disconnect()
				return buildLegacyHandshakeResponse(request.id, MCP_HANDSHAKE_VERSION)
			},
		})
		client.value = createMCPClient({ transport: createMCPLegacyClientTransport(peer) })

		await expect(client.value.connect()).rejects.toThrow('MCP client disconnected')
		expect(client.value.connected).toBe(false)
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
		const notifications = new MCPFixtureCell(0)
		const peer = createLegacyPeer({
			reply: (request) => {
				if (request.method !== 'notifications/initialized') return undefined
				notifications.value += 1
				return notifications.value > 1 ? new Error('initialized notification failed') : undefined
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

		const reconnected = new MCPFixtureCell(false)
		const reconnecting = client.connect().then(() => {
			reconnected.value = true
		})
		await waitForDelay(20)

		expect(reconnected.value).toBe(false)
		expect(client.connected).toBe(false)

		peer.release()
		await reconnecting

		expect(reconnected.value).toBe(true)
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
