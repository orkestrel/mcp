import type { ToolResult } from '@orkestrel/agent'
import type { MCPTransportInterface } from '@src/core'
import {
	bindClient,
	bindServer,
	buildToolDescriptors,
	buildToolResult,
	createDuplexClientTransport,
	createMCPClient,
	createMCPServer,
	initializeResult,
	jsonRPCError,
	jsonRPCResult,
	MCP_PROTOCOL_VERSION,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import { createTool, createToolManager } from '@orkestrel/agent'
import { createJSONRPCRequest } from '../../setup.js'

// An in-memory MCPTransportInterface double (AGENTS §16 — a real duplex channel, no
// mocks): `listen`/`closed` each hold THE SINGLE handler (replace semantics, per the
// port's own contract), `send` records every outbound string (optionally rejecting
// when `failSend` is set), and `deliver`/`signalClosed` drive the double from the
// test as the "environment" side would.
interface MemoryTransportInterface extends MCPTransportInterface {
	readonly sent: readonly string[]
	readonly closedCalls: number
	deliver(message: string): void
	signalClosed(): void
	failSend?: Error
}

function createMemoryTransport(): MemoryTransportInterface {
	let onMessage: ((message: string) => void) | undefined
	let onClosed: (() => void) | undefined
	const sent: string[] = []
	let closedCalls = 0
	const transport: MemoryTransportInterface = {
		async send(message) {
			if (transport.failSend !== undefined) throw transport.failSend
			sent.push(message)
		},
		listen(handler) {
			onMessage = handler
		},
		closed(handler) {
			onClosed = handler
		},
		async close() {
			closedCalls += 1
		},
		get sent() {
			return sent
		},
		get closedCalls() {
			return closedCalls
		},
		deliver(message) {
			onMessage?.(message)
		},
		signalClosed() {
			onClosed?.()
		},
	}
	return transport
}

// The pure dispatch builders (AGENTS §5 — exported, independently testable). Each
// turns a piece of MCP state into the JSON-RPC result payload (or envelope) the
// server returns.

describe('jsonRPCResult', () => {
	it('builds a success envelope echoing the id', () => {
		expect(jsonRPCResult(1, { ok: true })).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } })
	})

	it('carries a null id (a parse / invalid-request error)', () => {
		expect(jsonRPCResult(null, {})).toEqual({ jsonrpc: '2.0', id: null, result: {} })
	})
})

describe('jsonRPCError', () => {
	it('builds an error envelope without data when none is given', () => {
		expect(jsonRPCError(1, -32601, 'Method not found')).toEqual({
			jsonrpc: '2.0',
			id: 1,
			error: { code: -32601, message: 'Method not found' },
		})
	})

	it('includes data when supplied', () => {
		expect(jsonRPCError(1, -32000, 'Server error', { detail: 'x' })).toEqual({
			jsonrpc: '2.0',
			id: 1,
			error: { code: -32000, message: 'Server error', data: { detail: 'x' } },
		})
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

describe('buildToolResult', () => {
	it('serializes a value into one text content block', () => {
		const result: ToolResult = { id: '1', name: 'sum', value: 7 }

		expect(buildToolResult(result)).toEqual({ content: [{ type: 'text', text: '7' }] })
	})

	it('serializes a structured value as JSON', () => {
		const result: ToolResult = { id: '1', name: 'echo', value: { a: 1 } }

		expect(buildToolResult(result)).toEqual({
			content: [{ type: 'text', text: JSON.stringify({ a: 1 }) }],
		})
	})

	it('maps a value-less result to an EMPTY text block (a content block must carry a string text)', () => {
		const result: ToolResult = { id: '1', name: 'noop' }

		expect(buildToolResult(result)).toEqual({ content: [{ type: 'text', text: '' }] })
	})

	it('maps an error result to an isError content block', () => {
		const result: ToolResult = { id: '1', name: 'boom', error: 'kaboom' }

		expect(buildToolResult(result)).toEqual({
			content: [{ type: 'text', text: 'kaboom' }],
			isError: true,
		})
	})
})

describe('initializeResult', () => {
	it('uses the default protocol version when none requested', () => {
		expect(initializeResult('s', '1.0.0')).toEqual({
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: { tools: {} },
			serverInfo: { name: 's', version: '1.0.0' },
		})
	})

	it('echoes a supported requested version', () => {
		expect(initializeResult('s', '1.0.0', '2025-03-26')['protocolVersion']).toBe('2025-03-26')
	})

	it('falls back to the default for an unsupported requested version', () => {
		expect(initializeResult('s', '1.0.0', '1999-01-01')['protocolVersion']).toBe(
			MCP_PROTOCOL_VERSION,
		)
	})
})

// bindServer — pipes an MCPTransportInterface into a REAL MCPServer over a REAL
// ToolManager (AGENTS §16, no mocks). Covers the round trip, the notification
// no-reply path, unbind detaching without closing, a `send` throw surfacing on
// `server.emitter`'s `error` event (never unhandled), and the transport's own
// `closed` signal deactivating the binder.
describe('bindServer', () => {
	function server() {
		const tools = createToolManager()
		tools.add(createTool({ name: 'add', execute: (a) => Number(a['x']) + Number(a['y']) }))
		return createMCPServer({ name: 'demo', version: '1.0.0', tools })
	}

	it('dispatches an inbound request string and sends the reply string out', async () => {
		const mcp = server()
		const transport = createMemoryTransport()
		bindServer(mcp, transport)

		transport.deliver(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 1 })))
		await Promise.resolve()
		await Promise.resolve()

		expect(transport.sent).toEqual([JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })])
	})

	it('sends nothing for a notification (no id → no reply)', async () => {
		const mcp = server()
		const transport = createMemoryTransport()
		bindServer(mcp, transport)

		transport.deliver(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
		await Promise.resolve()
		await Promise.resolve()

		expect(transport.sent).toEqual([])
	})

	it('unbind detaches inbound delivery WITHOUT closing the transport', async () => {
		const mcp = server()
		const transport = createMemoryTransport()
		const unbind = bindServer(mcp, transport)
		unbind()

		transport.deliver(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 1 })))
		await Promise.resolve()
		await Promise.resolve()

		expect(transport.sent).toEqual([])
		expect(transport.closedCalls).toBe(0)
	})

	it('a send throw surfaces on server.emitter error, never as an unhandled rejection', async () => {
		const mcp = server()
		const transport = createMemoryTransport()
		transport.failSend = new Error('boom')
		const seen: unknown[] = []
		mcp.emitter.on('error', (error) => seen.push(error))
		bindServer(mcp, transport)

		transport.deliver(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 1 })))
		await Promise.resolve()
		await Promise.resolve()
		await Promise.resolve()

		expect(seen).toEqual([transport.failSend])
	})

	it('a throwing error listener is swallowed, not rethrown into the binder', async () => {
		const mcp = server()
		const transport = createMemoryTransport()
		transport.failSend = new Error('boom')
		mcp.emitter.on('error', () => {
			throw new Error('listener bug')
		})
		bindServer(mcp, transport)

		transport.deliver(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 1 })))
		await Promise.resolve()
		await Promise.resolve()
		await Promise.resolve()

		// Reaching here (no unhandled rejection failing the run) is the assertion.
		expect(transport.sent).toEqual([])
	})

	it('the transport signaling closed deactivates the binder (further inbound is ignored)', async () => {
		const mcp = server()
		const transport = createMemoryTransport()
		bindServer(mcp, transport)
		transport.signalClosed()

		transport.deliver(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 1 })))
		await Promise.resolve()
		await Promise.resolve()

		expect(transport.sent).toEqual([])
	})
})

// bindClient — completes the inbound wiring for a REAL MCPClient constructed over
// createDuplexClientTransport (AGENTS §16, no mocks). Covers the connect handshake
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
		await Promise.resolve()
		await Promise.resolve()
		expect(transport.sent).toHaveLength(1)
		const sentRequest: { id: number } = JSON.parse(transport.sent[0] ?? '{}')
		transport.deliver(
			JSON.stringify({
				jsonrpc: '2.0',
				id: sentRequest.id,
				result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: {} },
			}),
		)
		await connecting

		expect(mcp.connected).toBe(true)
		// notifications/initialized fires as the second, un-replied write.
		expect(transport.sent).toHaveLength(2)
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

	it('the transport signaling closed reaches client.transport.emitter close', () => {
		const transport = createMemoryTransport()
		const mcp = client(transport)
		bindClient(mcp, transport)
		let closed = 0
		mcp.transport.emitter.on('close', () => {
			closed += 1
		})

		transport.signalClosed()

		expect(closed).toBe(1)
	})
})
