import type {
	JSONRPCMessage,
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
} from '@src/core'
import { isRecord } from '@orkestrel/contract'

interface LegacyPeerInterface extends MCPClientTransportInterface {
	readonly sent: readonly JSONRPCMessage[]
	readonly violations: readonly string[]
	readonly closed: number
}

interface LegacyPeerOptions {
	readonly refuse?: boolean
	readonly version?: string
}

function createLegacyPeer(options?: LegacyPeerOptions): LegacyPeerInterface {
	const emitter = createEmitter<MCPClientTransportEventMap>()
	const sent: JSONRPCMessage[] = []
	const violations: string[] = []
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
		async start() {},
		async send(message) {
			sent.push(message)
			if (!('method' in message)) return
			const metadata = message.params?.['_meta']
			if (
				isRecord(metadata) &&
				(Object.hasOwn(metadata, MCP_META_VERSION) ||
					Object.hasOwn(metadata, MCP_META_CAPABILITIES) ||
					Object.hasOwn(metadata, MCP_META_CLIENT))
			) {
				violations.push(`modern metadata reached ${message.method}`)
			}
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
		},
	}
}

describe('MCPLegacyClientTransport', () => {
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
		expect(peer.sent.map((message) => ('method' in message ? message.method : 'response'))).toEqual([
			'initialize',
			'notifications/initialized',
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
