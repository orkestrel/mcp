import type { EmitterErrorHandler, JSONRPCResponse, ToolManagerInterface } from '@src/core'
import {
	createMCPServer,
	createTool,
	createToolManager,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_METHOD_NOT_FOUND,
	JSONRPC_PARSE_ERROR,
	MCP_PROTOCOL_VERSION,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import { createErrorRecorder, createJSONRPCRequest, recordEmitterEvents } from '../../../setup.js'

// MCPServer is the transport-agnostic JSON-RPC 2.0 dispatch core that exposes a live
// ToolManager over MCP (AGENTS §16 — a REAL ToolManager with real Tools, no mocks; no
// HTTP, no live model). Covers dispatch + handle for initialize (version negotiation,
// capabilities, serverInfo), ping, tools/list (parameters → inputSchema), tools/call
// (value round-trip, the isError tool mapping, missing-name → -32602), notifications
// (no id → no response; notifications/initialized), unknown method → -32601, handle's
// malformed-JSON → -32700 and non-request → -32600, plus the §13 request event +
// observer-throw safety.

const MCP_EVENTS = ['request'] as const

// A real ToolManager seeded with deterministic stub tools: `echo` returns its args
// verbatim, `sum` adds two numbers (with a declared inputSchema), and `boom` throws
// (so the manager isolates the throw into a result error → an MCP isError result).
function tools(): ToolManagerInterface {
	const manager = createToolManager()
	manager.add(createTool({ name: 'echo', execute: (args) => args }))
	manager.add(
		createTool({
			name: 'sum',
			description: 'Add two numbers',
			parameters: {
				type: 'object',
				properties: { a: { type: 'number' }, b: { type: 'number' } },
			},
			execute: (args) => Number(args['a']) + Number(args['b']),
		}),
	)
	manager.add(
		createTool({
			name: 'boom',
			execute: () => {
				throw new Error('tool exploded')
			},
		}),
	)
	return manager
}

function server(error?: EmitterErrorHandler) {
	return createMCPServer({
		name: 'test-server',
		version: '1.2.3',
		tools: tools(),
		...(error === undefined ? {} : { error }),
	})
}

// Narrow a dispatch response to its `result` as a record (the MCP result payloads are
// always records) — a §14 guard standing in for an assertion, no `as`.
function resultOf(response: JSONRPCResponse | undefined): Record<string, unknown> {
	if (response === undefined) throw new Error('expected a response, got undefined')
	const result = response.result
	if (typeof result !== 'object' || result === null) {
		throw new Error('expected an object result')
	}
	const record: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(result)) record[key] = value
	return record
}

describe('MCPServer — identity', () => {
	it('exposes the name and version from options', () => {
		const mcp = server()

		expect(mcp.name).toBe('test-server')
		expect(mcp.version).toBe('1.2.3')
	})
})

describe('MCPServer — initialize', () => {
	it('returns the default protocol version, the tools capability, and serverInfo', async () => {
		const response = await server().dispatch(createJSONRPCRequest())
		const result = resultOf(response)

		expect(response?.id).toBe(1)
		expect(result['protocolVersion']).toBe(MCP_PROTOCOL_VERSION)
		expect(result['capabilities']).toEqual({ tools: {} })
		expect(result['serverInfo']).toEqual({ name: 'test-server', version: '1.2.3' })
	})

	it('echoes a supported requested protocol version', async () => {
		const response = await server().dispatch(
			createJSONRPCRequest({ params: { protocolVersion: '2025-03-26' } }),
		)

		expect(resultOf(response)['protocolVersion']).toBe('2025-03-26')
	})

	it('falls back to the default for an unsupported requested version', async () => {
		const response = await server().dispatch(
			createJSONRPCRequest({ params: { protocolVersion: '1999-01-01' } }),
		)

		expect(resultOf(response)['protocolVersion']).toBe(MCP_PROTOCOL_VERSION)
	})

	it('ignores a non-string requested version (falls back to the default)', async () => {
		const response = await server().dispatch(
			createJSONRPCRequest({ params: { protocolVersion: 42 } }),
		)

		expect(resultOf(response)['protocolVersion']).toBe(MCP_PROTOCOL_VERSION)
	})
})

describe('MCPServer — ping', () => {
	it('returns an empty result', async () => {
		const response = await server().dispatch(createJSONRPCRequest({ method: 'ping', id: 7 }))

		expect(response?.id).toBe(7)
		expect(response?.result).toEqual({})
	})
})

describe('MCPServer — tools/list', () => {
	it('lists the registered tools with inputSchema mapped from parameters', async () => {
		const response = await server().dispatch(createJSONRPCRequest({ method: 'tools/list', id: 2 }))
		const list = resultOf(response)['tools']

		expect(list).toEqual([
			{ name: 'echo', inputSchema: { type: 'object' } },
			{
				name: 'sum',
				description: 'Add two numbers',
				inputSchema: {
					type: 'object',
					properties: { a: { type: 'number' }, b: { type: 'number' } },
				},
			},
			{ name: 'boom', inputSchema: { type: 'object' } },
		])
	})

	it('lists an empty tool set for an empty registry', async () => {
		const mcp = createMCPServer({ name: 'empty', version: '0.0.0', tools: createToolManager() })
		const response = await mcp.dispatch(createJSONRPCRequest({ method: 'tools/list' }))

		expect(resultOf(response)['tools']).toEqual([])
	})
})

describe('MCPServer — tools/call', () => {
	it('executes a tool and round-trips its value through a text content block', async () => {
		const response = await server().dispatch(
			createJSONRPCRequest({
				method: 'tools/call',
				id: 3,
				params: { name: 'sum', arguments: { a: 2, b: 5 } },
			}),
		)
		const result = resultOf(response)

		expect(result['content']).toEqual([{ type: 'text', text: '7' }])
		expect(result['isError']).toBeUndefined()
	})

	it('round-trips a structured value (the echo tool) as serialized JSON', async () => {
		const response = await server().dispatch(
			createJSONRPCRequest({
				method: 'tools/call',
				id: 3,
				params: { name: 'echo', arguments: { hello: 'world', n: 1 } },
			}),
		)

		expect(resultOf(response)['content']).toEqual([
			{ type: 'text', text: JSON.stringify({ hello: 'world', n: 1 }) },
		])
	})

	it('defaults arguments to an empty record when omitted', async () => {
		const response = await server().dispatch(
			createJSONRPCRequest({ method: 'tools/call', id: 3, params: { name: 'echo' } }),
		)

		expect(resultOf(response)['content']).toEqual([{ type: 'text', text: '{}' }])
	})

	it('maps an erroring tool to an isError result carrying the error text', async () => {
		const response = await server().dispatch(
			createJSONRPCRequest({
				method: 'tools/call',
				id: 4,
				params: { name: 'boom', arguments: {} },
			}),
		)
		const result = resultOf(response)

		expect(result['isError']).toBe(true)
		expect(result['content']).toEqual([{ type: 'text', text: 'tool exploded' }])
	})

	it('maps an unknown tool name to an isError result (the manager not-found error)', async () => {
		const response = await server().dispatch(
			createJSONRPCRequest({
				method: 'tools/call',
				id: 4,
				params: { name: 'missing', arguments: {} },
			}),
		)
		const result = resultOf(response)

		expect(result['isError']).toBe(true)
		expect(result['content']).toEqual([{ type: 'text', text: 'tool not found: missing' }])
	})

	it('rejects a missing tool name with -32602 invalid params', async () => {
		const response = await server().dispatch(
			createJSONRPCRequest({ method: 'tools/call', id: 5, params: {} }),
		)

		expect(response?.result).toBeUndefined()
		expect(response?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
	})

	it('rejects a non-string tool name with -32602 invalid params', async () => {
		const response = await server().dispatch(
			createJSONRPCRequest({ method: 'tools/call', id: 5, params: { name: 42 } }),
		)

		expect(response?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
	})
})

describe('MCPServer — notifications & unknown methods', () => {
	it('returns no response for a request without an id (a notification)', async () => {
		const response = await server().dispatch(
			createJSONRPCRequest({ method: 'ping', id: undefined }),
		)

		expect(response).toBeUndefined()
	})

	it('returns no response for notifications/initialized', async () => {
		const response = await server().dispatch(
			createJSONRPCRequest({ method: 'notifications/initialized', id: undefined }),
		)

		expect(response).toBeUndefined()
	})

	it('returns -32601 for an unknown method', async () => {
		const response = await server().dispatch(
			createJSONRPCRequest({ method: 'does/not/exist', id: 9 }),
		)

		expect(response?.id).toBe(9)
		expect(response?.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
		expect(response?.error?.message).toContain('does/not/exist')
	})

	it('returns no response for an unknown-method notification (no id)', async () => {
		const response = await server().dispatch(
			createJSONRPCRequest({ method: 'does/not/exist', id: undefined }),
		)

		expect(response).toBeUndefined()
	})
})

describe('MCPServer — handle (string boundary)', () => {
	it('parses, dispatches, and serializes a request to a response string', async () => {
		const reply = await server().handle('{"jsonrpc":"2.0","method":"ping","id":1}')

		expect(reply).toBe(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
	})

	it('round-trips a tools/call over the string boundary', async () => {
		const reply = await server().handle(
			'{"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"sum","arguments":{"a":3,"b":4}}}',
		)

		expect(reply).toBe(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 2,
				result: { content: [{ type: 'text', text: '7' }] },
			}),
		)
	})

	it('returns a -32700 parse-error response for malformed JSON', async () => {
		const reply = await server().handle('{ not json )')

		expect(reply).toBe(
			JSON.stringify({
				jsonrpc: '2.0',
				id: null,
				error: { code: JSONRPC_PARSE_ERROR, message: 'Parse error' },
			}),
		)
	})

	it('returns a -32600 invalid-request response for a non-request payload', async () => {
		const reply = await server().handle('{"jsonrpc":"2.0","id":1,"result":{}}')

		expect(reply).toBe(
			JSON.stringify({
				jsonrpc: '2.0',
				id: null,
				error: { code: JSONRPC_INVALID_REQUEST, message: 'Invalid Request' },
			}),
		)
	})

	it('returns a -32600 invalid-request response for a parsed value that is not a message', async () => {
		const reply = await server().handle('[1, 2, 3]')

		expect(reply).toContain(String(JSONRPC_INVALID_REQUEST))
	})

	it('returns undefined (no reply) for a notification string', async () => {
		const reply = await server().handle('{"jsonrpc":"2.0","method":"notifications/initialized"}')

		expect(reply).toBeUndefined()
	})
})

describe('MCPServer — request event (§13)', () => {
	it('fires request with the method and id at the top of dispatch', async () => {
		const mcp = server()
		const events = recordEmitterEvents(mcp.emitter, MCP_EVENTS)
		await mcp.dispatch(createJSONRPCRequest({ method: 'ping' }))
		await mcp.dispatch(createJSONRPCRequest({ method: 'tools/list', id: 2 }))

		expect(events.request.calls).toEqual([
			['ping', 1],
			['tools/list', 2],
		])
	})

	it('fires request with a null id for a notification', async () => {
		const mcp = server()
		const events = recordEmitterEvents(mcp.emitter, MCP_EVENTS)
		await mcp.dispatch(createJSONRPCRequest({ method: 'notifications/initialized', id: undefined }))

		expect(events.request.calls).toEqual([['notifications/initialized', null]])
	})

	it('fires request through handle as well (parse → dispatch path)', async () => {
		const mcp = server()
		const events = recordEmitterEvents(mcp.emitter, MCP_EVENTS)
		await mcp.handle('{"jsonrpc":"2.0","method":"ping","id":3}')

		expect(events.request.calls).toEqual([['ping', 3]])
	})

	it('EMIT SAFETY: a throwing request listener cannot corrupt the dispatch, and routes to the error handler', async () => {
		const errors = createErrorRecorder()
		const mcp = server(errors.handler)
		mcp.emitter.on('request', () => {
			throw new Error('request observer blew up')
		})

		// THE LOAD-BEARING ASSERTION: the dispatch still produces its response.
		const response = await mcp.dispatch(createJSONRPCRequest({ method: 'ping' }))

		expect(response?.result).toEqual({})
		// The error handler received (error, event) — note the arg order.
		expect(errors.calls).toEqual([[expect.any(Error), 'request']])
	})

	it('EMIT SAFETY: a throwing error handler neither escapes nor recurses', async () => {
		const errors = createErrorRecorder()
		const mcp = server((error, event) => {
			errors.handler(error, event)
			throw new Error('error handler blew up too')
		})
		mcp.emitter.on('request', () => {
			throw new Error('request listener blew up')
		})

		// The dispatch STILL produces a response — neither throw escaped.
		const response = await mcp.dispatch(createJSONRPCRequest({ method: 'ping' }))

		expect(response?.result).toEqual({})
		// Fired exactly once (its own throw was swallowed, not re-entered — no recursion).
		expect(errors.count).toBe(1)
		expect(errors.calls[0]?.[1]).toBe('request')
	})
})
