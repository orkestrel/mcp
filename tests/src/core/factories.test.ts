import type { MCPTransportInterface } from '@src/core'
import { createDuplexClientTransport, createMCPServer } from '@src/core'
import { describe, expect, it } from 'vitest'
import { createTool, createToolManager } from '@orkestrel/agent'

// A minimal in-memory MCPTransportInterface double (AGENTS §16 — real, not a mock):
// `send` records every outbound string, `close` counts calls; `listen`/`closed` are
// unused by these adapter-only tests (they exercise createDuplexClientTransport's
// OWN send/start/close forwarding, not inbound delivery — that is bindClient's job,
// covered in helpers.test.ts).
function createMemoryTransport(): MCPTransportInterface & {
	readonly sent: readonly string[]
	readonly closedCalls: number
} {
	const sent: string[] = []
	let closedCalls = 0
	return {
		async send(message) {
			sent.push(message)
		},
		listen() {},
		closed() {},
		async close() {
			closedCalls += 1
		},
		get sent() {
			return sent
		},
		get closedCalls() {
			return closedCalls
		},
	}
}

// createMCPServer returns a working MCPServerInterface over a live ToolManager
// (AGENTS §16 — a real registry, no mocks). The behavioral coverage of dispatch /
// handle lives in MCPServer.test.ts; this asserts the factory wires identity, the
// tools, and the emitter through to a working instance.

describe('createMCPServer', () => {
	it('returns a server exposing the configured identity', () => {
		const server = createMCPServer({
			name: 'demo',
			version: '2.0.0',
			tools: createToolManager(),
		})

		expect(server.name).toBe('demo')
		expect(server.version).toBe('2.0.0')
	})

	it('dispatches over the supplied tool registry', async () => {
		const tools = createToolManager()
		tools.add(createTool({ name: 'add', execute: (a) => Number(a['x']) + Number(a['y']) }))
		const server = createMCPServer({ name: 'demo', version: '1.0.0', tools })

		const response = await server.dispatch({
			jsonrpc: '2.0',
			method: 'tools/call',
			id: 1,
			params: { name: 'add', arguments: { x: 4, y: 6 } },
		})

		expect(response?.result).toEqual({ content: [{ type: 'text', text: '10' }] })
	})

	it('wires the on hooks (the §8 reserved key) to the emitter', async () => {
		const seen: (readonly [string, string | number | null])[] = []
		const server = createMCPServer({
			name: 'demo',
			version: '1.0.0',
			tools: createToolManager(),
			on: { request: (method, id) => seen.push([method, id]) },
		})

		await server.dispatch({ jsonrpc: '2.0', method: 'ping', id: 1 })

		expect(seen).toEqual([['ping', 1]])
	})
})

describe('createDuplexClientTransport', () => {
	it('reports no session (the duplex port carries none)', () => {
		const adapted = createDuplexClientTransport(createMemoryTransport())

		expect(adapted.session).toBeUndefined()
	})

	it('start is a no-op (the duplex channel is already open)', async () => {
		const adapted = createDuplexClientTransport(createMemoryTransport())

		await expect(adapted.start()).resolves.toBeUndefined()
	})

	it('send serializes ONE message and writes it via the duplex transport', async () => {
		const transport = createMemoryTransport()
		const adapted = createDuplexClientTransport(transport)

		await adapted.send({ jsonrpc: '2.0', method: 'ping', id: 1 })

		expect(transport.sent).toEqual([JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 })])
	})

	it('send unrolls a batch into ONE duplex write per message', async () => {
		const transport = createMemoryTransport()
		const adapted = createDuplexClientTransport(transport)

		await adapted.send([
			{ jsonrpc: '2.0', method: 'a', id: 1 },
			{ jsonrpc: '2.0', method: 'b', id: 2 },
		])

		expect(transport.sent).toEqual([
			JSON.stringify({ jsonrpc: '2.0', method: 'a', id: 1 }),
			JSON.stringify({ jsonrpc: '2.0', method: 'b', id: 2 }),
		])
	})

	it('close closes the underlying duplex transport', async () => {
		const transport = createMemoryTransport()
		const adapted = createDuplexClientTransport(transport)

		await adapted.close()

		expect(transport.closedCalls).toBe(1)
	})
})
