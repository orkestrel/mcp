import type { HTTPClientTransportOptions, MCPMessageTransportInterface } from '@src/core'
import {
	createDuplexClientTransport,
	createHTTPClientTransport,
	createMCPServer,
	HTTPClientTransport,
	MCP_META_CAPABILITIES,
	MCP_META_SERVER,
	MCP_META_VERSION,
	MCP_MODERN_VERSION,
} from '@src/core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createTool, createToolManager } from '@orkestrel/tool'
import { completeFixtureHandshake, createMemoryTransport } from '../../setup.js'

// A minimal in-memory MCPTransportInterface double (real, not a mock):
// `send` records every outbound string, `close` counts calls; `listen`/`closed` are
// unused by these adapter-only tests (they exercise createDuplexClientTransport's
// OWN send/start/close forwarding, not inbound delivery — that is bindClient's job,
// covered in helpers.test.ts).
// createMCPServer returns a working MCPServerInterface over a live ToolManager
// (a real registry, no mocks). The behavioral coverage of dispatch /
// handle lives in MCPServer.test.ts; this asserts the factory wires identity, the
// tools, and the emitter through to a working instance.

describe('createMCPServer', () => {
	it('exposes the configured handshake by identity and leaves omission undefined', () => {
		const options = {
			identity: { name: 'ready', version: '1.0.0' },
			tools: createToolManager(),
			handshake: completeFixtureHandshake,
		}
		expect(createMCPServer(options).handshake).toBe(options.handshake)
		expect(
			createMCPServer({ identity: options.identity, tools: options.tools }).handshake,
		).toBeUndefined()
	})

	it('returns a server exposing the configured identity', () => {
		const server = createMCPServer({
			identity: { name: 'demo', version: '2.0.0' },
			tools: createToolManager(),
		})

		expect(server.identity.name).toBe('demo')
		expect(server.identity.version).toBe('2.0.0')
	})

	it('dispatches over the supplied tool registry', async () => {
		const tools = createToolManager()
		tools.add(createTool({ name: 'add', execute: (a) => Number(a['x']) + Number(a['y']) }))
		const server = createMCPServer({ identity: { name: 'demo', version: '1.0.0' }, tools })

		const answer = await server.dispatch({
			jsonrpc: '2.0',
			method: 'tools/call',
			id: 1,
			params: {
				name: 'add',
				arguments: { x: 4, y: 6 },
				_meta: {
					[MCP_META_VERSION]: MCP_MODERN_VERSION,
					[MCP_META_CAPABILITIES]: {},
				},
			},
		})
		// A legacy `tools/call` is unary — narrow off the held-open arm before asserting.
		if (answer === undefined || Symbol.asyncIterator in answer) {
			throw new Error('expected a unary response, got a held-open stream')
		}

		expect(answer.result).toEqual({
			resultType: 'complete',
			content: [{ type: 'text', text: '10' }],
			structuredContent: 10,
			_meta: { [MCP_META_SERVER]: { name: 'demo', version: '1.0.0' } },
		})
	})

	it('wires the on hooks (the reserved `on` key) to the emitter', async () => {
		const seen: Array<readonly [string, string | number | undefined]> = []
		const server = createMCPServer({
			identity: { name: 'demo', version: '1.0.0' },
			tools: createToolManager(),
			on: { request: (method, id) => seen.push([method, id]) },
		})

		await server.dispatch({ jsonrpc: '2.0', method: 'ping', id: 1 })

		expect(seen).toEqual([['ping', 1]])
	})
})

// createHTTPClientTransport is the one HTTP client factory both environments import from core.
// The peer is a boundary stub for the platform `fetch` that records each request and answers
// 202; the round trips against a real server live in tests/src/server/integration.test.ts and
// tests/src/browser/factories.test.ts.

describe('createHTTPClientTransport', () => {
	it('returns the core HTTPClientTransport', () => {
		const transport = createHTTPClientTransport({ url: 'http://127.0.0.1:1/mcp' })

		expect(transport).toBeInstanceOf(HTTPClientTransport)
		expect(transport.duplex).toBe(false)
		expect(transport.session).toBeUndefined()
	})

	it('posts each message to the configured url with the supplied headers merged on', async () => {
		const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = []
		const transport = createHTTPClientTransport({
			url: 'http://127.0.0.1:1/mcp',
			headers: { authorization: 'Bearer harbor-token' },
			fetch: (input, init) => {
				requests.push({ url: String(input), init })
				return Promise.resolve(new Response(null, { status: 202 }))
			},
		})

		await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })

		expect(requests).toHaveLength(1)
		expect(requests[0]?.url).toBe('http://127.0.0.1:1/mcp')
		expect(requests[0]?.init?.method).toBe('POST')
		const headers = new Headers(requests[0]?.init?.headers)
		expect(headers.get('authorization')).toBe('Bearer harbor-token')
		expect(headers.get('content-type')).toBe('application/json')
	})

	it('takes the HTTP client options and returns the message transport contract', () => {
		expectTypeOf<
			Parameters<typeof createHTTPClientTransport>[0]
		>().toEqualTypeOf<HTTPClientTransportOptions>()
		expectTypeOf(createHTTPClientTransport).returns.toEqualTypeOf<MCPMessageTransportInterface>()
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

	it('close closes the underlying duplex transport', async () => {
		const transport = createMemoryTransport()
		const adapted = createDuplexClientTransport(transport)

		await adapted.close()

		expect(transport.closedCalls).toBe(1)
	})
})
