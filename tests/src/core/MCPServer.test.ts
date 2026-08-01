import type {
	JSONRPCRequest,
	JSONRPCResponse,
	MCPDispatchOptions,
	MCPStream,
	MCPSubscriptionOptions,
	MCPTextStream,
} from '@src/core'
import type { EmitterErrorHandler } from '@orkestrel/emitter'
import type { ToolManagerInterface } from '@orkestrel/tool'
import {
	buildJSONRPCResult,
	createMCPServer,
	DEFAULT_MCP_CACHE_TTL,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_METHOD_NOT_FOUND,
	JSONRPC_PARSE_ERROR,
	MCP_META_CAPABILITIES,
	MCP_META_SERVER,
	MCP_META_SUBSCRIPTION,
	MCP_META_VERSION,
	MCP_PROTOCOL_VERSION,
	MCP_UNSUPPORTED_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import { createTool, createToolManager } from '@orkestrel/tool'
import {
	createErrorRecorder,
	createJSONRPCNotification,
	createJSONRPCRequest,
	recordEmitterEvents,
} from '../../setup.js'

// MCPServer is the transport-agnostic JSON-RPC 2.0 dispatch core that exposes a live
// ToolManager over MCP (AGENTS §16 — a REAL ToolManager with real Tools, no mocks; no
// HTTP, no live model). Covers dispatch + handle for initialize (version negotiation,
// capabilities, serverInfo), ping, tools/list (parameters → inputSchema), tools/call
// (value round-trip, the isError tool mapping, missing-name → -32602), notifications
// (no id → no response; notifications/initialized), unknown method → -32601, handle's
// malformed-JSON → -32700 and non-request → -32600, plus the §13 request event +
// observer-throw safety — and the modern METHOD SEAM: the four built-ins registered on
// the same registry every dispatch resolves from, per-request options reaching a handler,
// and the held-open stream arm crossing both the typed and the string boundary.

const MCP_EVENTS = ['request'] as const
const MODERN_METADATA: Readonly<Record<string, unknown>> = Object.freeze({
	[MCP_META_VERSION]: '2026-07-28',
	[MCP_META_CAPABILITIES]: Object.freeze({}),
})

// A modern request: the reserved metadata key is what selects the modern era, so every
// seam scenario carries it.
function modernRequest(method: string, id: string | number = 1): JSONRPCRequest {
	return createJSONRPCRequest({ method, id, params: { _meta: MODERN_METADATA } })
}

// A REAL held-open modern method (AGENTS §16 — a genuine async generator, not a fake):
// two progress notifications, then the terminating response as the generator's `return`.
async function* progress(request: JSONRPCRequest): MCPStream {
	yield { jsonrpc: '2.0', method: 'notifications/progress', params: { step: 1 } }
	yield { jsonrpc: '2.0', method: 'notifications/progress', params: { step: 2 } }
	return buildJSONRPCResult(request.id ?? null, { done: true })
}

// The registered handler for it — an `MCPMethodHandler` whose answer is the stream arm.
async function holdOpen(request: JSONRPCRequest): Promise<MCPStream> {
	return progress(request)
}

// Drain a typed held-open answer into its yielded notifications and its terminating
// response — kept APART, because the terminating value is a `return`, not a `yield`, and
// that distinction is the contract under test.
async function drainStream(
	stream: MCPStream,
): Promise<readonly [readonly JSONRPCRequest[], JSONRPCResponse]> {
	const messages: JSONRPCRequest[] = []
	let next = await stream.next()
	while (!next.done) {
		messages.push(next.value)
		next = await stream.next()
	}
	return [messages, next.value]
}

// The string-boundary mirror of `drainStream`.
async function drainText(stream: MCPTextStream): Promise<readonly [readonly string[], string]> {
	const messages: string[] = []
	let next = await stream.next()
	while (!next.done) {
		messages.push(next.value)
		next = await stream.next()
	}
	return [messages, next.value]
}

// Narrow a dispatch answer to its HELD-OPEN arm — the mirror of `responseOf`.
function streamOf(answer: JSONRPCResponse | MCPStream | undefined): MCPStream {
	if (answer === undefined || !(Symbol.asyncIterator in answer)) {
		throw new Error('expected a held-open stream, got a unary answer')
	}
	return answer
}

// Narrow a `handle` answer to its held-open arm (a string is the unary arm).
function textOf(answer: string | MCPTextStream | undefined): MCPTextStream {
	if (answer === undefined || typeof answer === 'string') {
		throw new Error('expected a serialized held-open stream, got a unary answer')
	}
	return answer
}

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

function server(error?: EmitterErrorHandler, subscription?: MCPSubscriptionOptions) {
	return createMCPServer({
		identity: { name: 'test-server', version: '1.2.3' },
		tools: tools(),
		...(error === undefined ? {} : { error }),
		...(subscription === undefined ? {} : { subscription }),
	})
}

// Narrow a dispatch answer to its UNARY arm. `dispatch` now answers either a response or
// a held-open MCPStream; every method exercised below is unary, so a stream here is a
// defect and fails loudly rather than passing silently.
function responseOf(answer: JSONRPCResponse | MCPStream | undefined): JSONRPCResponse | undefined {
	if (answer !== undefined && Symbol.asyncIterator in answer) {
		throw new Error('expected a unary response, got a held-open stream')
	}
	return answer
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

		expect(mcp.identity.name).toBe('test-server')
		expect(mcp.identity.version).toBe('1.2.3')
	})
})

describe('MCPServer — dual-era dispatch', () => {
	it('keeps the four legacy method responses byte-identical and unstamped', async () => {
		const mcp = server()

		expect(await mcp.handle('{"jsonrpc":"2.0","method":"initialize","id":1}')).toBe(
			'{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"test-server","version":"1.2.3"}}}',
		)
		expect(await mcp.handle('{"jsonrpc":"2.0","method":"ping","id":2}')).toBe(
			'{"jsonrpc":"2.0","id":2,"result":{}}',
		)
		expect(await mcp.handle('{"jsonrpc":"2.0","method":"tools/list","id":3}')).toBe(
			'{"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"echo","inputSchema":{"type":"object"}},{"name":"sum","inputSchema":{"type":"object","properties":{"a":{"type":"number"},"b":{"type":"number"}}},"description":"Add two numbers"},{"name":"boom","inputSchema":{"type":"object"}}]}}',
		)
		expect(
			await mcp.handle(
				'{"jsonrpc":"2.0","method":"tools/call","id":4,"params":{"name":"sum","arguments":{"a":2,"b":5}}}',
			),
		).toBe('{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"7"}]}}')
	})

	it('rejects malformed modern metadata with -32602', async () => {
		const response = responseOf(
			await server().dispatch(
				createJSONRPCRequest({
					method: 'tools/list',
					params: { _meta: { [MCP_META_VERSION]: '2026-07-28' } },
				}),
			),
		)

		expect(response?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
	})

	it('treats a present non-string version as modern and rejects it with -32602', async () => {
		const mcp = server()
		const events = recordEmitterEvents(mcp.emitter, MCP_EVENTS)
		const response = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'tools/list',
					params: {
						_meta: {
							[MCP_META_VERSION]: 7,
							[MCP_META_CAPABILITIES]: {},
						},
					},
				}),
			),
		)

		expect(response?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(events.request.calls).toEqual([['tools/list', 1, 'modern']])
	})

	it('rejects an unsupported modern version with -32022 and exact retry data', async () => {
		const response = responseOf(
			await server().dispatch(
				createJSONRPCRequest({
					method: 'tools/list',
					params: {
						_meta: {
							[MCP_META_VERSION]: '2099-01-01',
							[MCP_META_CAPABILITIES]: {},
						},
					},
				}),
			),
		)

		expect(response?.error?.code).toBe(MCP_UNSUPPORTED_VERSION)
		expect(response?.error?.data).toEqual({
			supported: SUPPORTED_PROTOCOL_VERSIONS,
			requested: '2099-01-01',
		})
	})

	it('returns a stamped cacheable server/discover result', async () => {
		const identity = { name: 'modern-server', version: '2.0.0' }
		const mcp = createMCPServer({
			identity,
			tools: tools(),
			instructions: 'Use the available tools.',
			cache: { ttl: 123, scope: 'public' },
		})
		const response = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'server/discover',
					params: { _meta: MODERN_METADATA },
				}),
			),
		)

		expect(response?.result).toEqual({
			supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
			capabilities: { tools: {} },
			instructions: 'Use the available tools.',
			resultType: 'complete',
			ttlMs: 123,
			cacheScope: 'public',
			_meta: { [MCP_META_SERVER]: identity },
		})
	})

	it('returns a stamped cacheable modern tools/list result', async () => {
		const response = responseOf(
			await server().dispatch(
				createJSONRPCRequest({
					method: 'tools/list',
					params: { _meta: MODERN_METADATA },
				}),
			),
		)
		const result = resultOf(response)

		expect(result['resultType']).toBe('complete')
		expect(result['ttlMs']).toBe(DEFAULT_MCP_CACHE_TTL)
		expect(result['cacheScope']).toBe('private')
		expect(result['_meta']).toEqual({
			[MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' },
		})
		expect(result['tools']).toHaveLength(3)
	})

	it('returns a stamped non-cacheable modern tools/call result', async () => {
		const response = responseOf(
			await server().dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: {
						name: 'sum',
						arguments: { a: 2, b: 5 },
						_meta: MODERN_METADATA,
					},
				}),
			),
		)
		const result = resultOf(response)

		expect(result['content']).toEqual([{ type: 'text', text: '7' }])
		expect(result['resultType']).toBe('complete')
		expect(result['_meta']).toEqual({
			[MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' },
		})
		expect(result['ttlMs']).toBeUndefined()
		expect(result['cacheScope']).toBeUndefined()
	})

	it.each(['initialize', 'ping', 'does/not/exist'])(
		'returns -32601 for modern method %s',
		async (method) => {
			const response = responseOf(
				await server().dispatch(
					createJSONRPCRequest({ method, params: { _meta: MODERN_METADATA } }),
				),
			)

			expect(response?.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
		},
	)

	it('returns no response for a modern notification after emitting its era', async () => {
		const mcp = server()
		const events = recordEmitterEvents(mcp.emitter, MCP_EVENTS)
		const response = responseOf(
			await mcp.dispatch({
				jsonrpc: '2.0',
				method: 'tools/list',
				params: { _meta: MODERN_METADATA },
			}),
		)

		expect(response).toBeUndefined()
		expect(events.request.calls).toEqual([['tools/list', null, 'modern']])
	})
})

describe('MCPServer — the modern method seam', () => {
	it('registers the four built-in modern methods on the registry it dispatches from', () => {
		const mcp = server()

		expect(mcp.methods.method('server/discover')).toBeTypeOf('function')
		expect(mcp.methods.method('tools/list')).toBeTypeOf('function')
		expect(mcp.methods.method('tools/call')).toBeTypeOf('function')
		expect(mcp.methods.method('subscriptions/listen')).toBeTypeOf('function')
	})

	// THE LOAD-BEARING PROOF that -32601 is decided by the registry and not by a
	// hard-coded arm list: the SAME method flips from unknown to answered purely by
	// registering it, with no other change.
	it('turns a -32601 method into an answered one by registering it', async () => {
		const mcp = server()
		const before = responseOf(await mcp.dispatch(modernRequest('demo/probe')))
		mcp.methods.add('demo/probe', async (request) =>
			buildJSONRPCResult(request.id ?? null, { probed: true }),
		)
		const after = responseOf(await mcp.dispatch(modernRequest('demo/probe')))

		expect(before?.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
		expect(before?.error?.message).toContain('demo/probe')
		expect(after?.result).toEqual({ probed: true })
	})

	// THE LOAD-BEARING PROOF that the built-ins are dispatched THROUGH the seam rather
	// than ahead of it: replacing one changes what dispatch answers. A surviving
	// hard-coded arm would win and this would still return the real tool list.
	it('replaces a built-in modern method when one is registered over it', async () => {
		const mcp = server()
		mcp.methods.add('tools/list', async (request) =>
			buildJSONRPCResult(request.id ?? null, { tools: [] }),
		)
		const response = responseOf(await mcp.dispatch(modernRequest('tools/list')))

		expect(response?.result).toEqual({ tools: [] })
	})

	it('leaves the legacy branch byte-identical when a modern method is replaced', async () => {
		const mcp = server()
		mcp.methods.add('tools/list', async (request) =>
			buildJSONRPCResult(request.id ?? null, { tools: [] }),
		)

		// The legacy switch is untouched by the seam — the same registry, the same string.
		expect(await mcp.handle('{"jsonrpc":"2.0","method":"tools/list","id":3}')).toBe(
			'{"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"echo","inputSchema":{"type":"object"}},{"name":"sum","inputSchema":{"type":"object","properties":{"a":{"type":"number"},"b":{"type":"number"}}},"description":"Add two numbers"},{"name":"boom","inputSchema":{"type":"object"}}]}}',
		)
	})

	it('never reaches a registered method when the modern metadata is unsupported', async () => {
		const mcp = server()
		const seen: JSONRPCRequest[] = []
		mcp.methods.add('demo/probe', async (request) => {
			seen.push(request)
			return buildJSONRPCResult(request.id ?? null, {})
		})
		const response = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'demo/probe',
					params: {
						_meta: { [MCP_META_VERSION]: '2099-01-01', [MCP_META_CAPABILITIES]: {} },
					},
				}),
			),
		)

		expect(response?.error?.code).toBe(MCP_UNSUPPORTED_VERSION)
		expect(seen).toEqual([])
	})

	it('never reaches a registered method for a legacy request of the same name', async () => {
		const mcp = server()
		const seen: JSONRPCRequest[] = []
		mcp.methods.add('demo/probe', async (request) => {
			seen.push(request)
			return buildJSONRPCResult(request.id ?? null, {})
		})
		const response = responseOf(
			await mcp.dispatch(createJSONRPCRequest({ method: 'demo/probe', id: 4 })),
		)

		expect(response?.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
		expect(seen).toEqual([])
	})

	it('hands every handler a dispatch options bag, empty when the caller supplied none', async () => {
		const mcp = server()
		const seen: MCPDispatchOptions[] = []
		mcp.methods.add('demo/probe', async (request, options) => {
			seen.push(options)
			return buildJSONRPCResult(request.id ?? null, {})
		})
		await mcp.dispatch(modernRequest('demo/probe'))

		expect(seen).toEqual([{}])
		expect(seen[0]?.signal).toBeUndefined()
	})

	it('passes the caller’s abort signal through dispatch to the handler', async () => {
		const mcp = server()
		const controller = new AbortController()
		const seen: MCPDispatchOptions[] = []
		mcp.methods.add('demo/probe', async (request, options) => {
			seen.push(options)
			return buildJSONRPCResult(request.id ?? null, {})
		})
		await mcp.dispatch(modernRequest('demo/probe'), { signal: controller.signal })
		controller.abort()

		expect(seen[0]?.signal).toBe(controller.signal)
		expect(seen[0]?.signal?.aborted).toBe(true)
	})

	it('passes the caller’s abort signal through handle to the handler', async () => {
		const mcp = server()
		const controller = new AbortController()
		const seen: MCPDispatchOptions[] = []
		mcp.methods.add('demo/probe', async (request, options) => {
			seen.push(options)
			return buildJSONRPCResult(request.id ?? null, {})
		})
		await mcp.handle(JSON.stringify(modernRequest('demo/probe')), { signal: controller.signal })

		expect(seen[0]?.signal).toBe(controller.signal)
	})

	it('returns a handler’s held-open stream from dispatch, terminating with its response', async () => {
		const mcp = server()
		mcp.methods.add('demo/stream', holdOpen)
		const [messages, response] = await drainStream(
			streamOf(await mcp.dispatch(modernRequest('demo/stream', 11))),
		)

		expect(messages).toEqual([
			{ jsonrpc: '2.0', method: 'notifications/progress', params: { step: 1 } },
			{ jsonrpc: '2.0', method: 'notifications/progress', params: { step: 2 } },
		])
		// Each yielded message is a NOTIFICATION — a request with no id.
		expect(messages.every((message) => message.id === undefined)).toBe(true)
		expect(response).toEqual({ jsonrpc: '2.0', id: 11, result: { done: true } })
	})

	it('mirrors a held-open answer as a serialized stream through handle', async () => {
		const mcp = server()
		mcp.methods.add('demo/stream', holdOpen)
		const [messages, response] = await drainText(
			textOf(await mcp.handle(JSON.stringify(modernRequest('demo/stream', 12)))),
		)

		expect(messages).toEqual([
			'{"jsonrpc":"2.0","method":"notifications/progress","params":{"step":1}}',
			'{"jsonrpc":"2.0","method":"notifications/progress","params":{"step":2}}',
		])
		expect(response).toBe('{"jsonrpc":"2.0","id":12,"result":{"done":true}}')
	})

	it('answers nothing for a held-open method dispatched as a notification', async () => {
		const mcp = server()
		mcp.methods.add('demo/stream', holdOpen)

		expect(
			await mcp.dispatch(createJSONRPCNotification('demo/stream', { _meta: MODERN_METADATA })),
		).toBeUndefined()
	})

	it('answers undefined when a registered handler answers undefined', async () => {
		const mcp = server()
		mcp.methods.add('demo/silent', async () => undefined)

		expect(await mcp.dispatch(modernRequest('demo/silent'))).toBeUndefined()
		expect(await mcp.handle(JSON.stringify(modernRequest('demo/silent')))).toBeUndefined()
	})
})

describe('MCPServer — modern subscriptions/listen', () => {
	it('acknowledges the honoured subset, stamps every delivery, and closes with the same id', async () => {
		const controller = new AbortController()
		const notifications: unknown[] = []
		const options: MCPDispatchOptions[] = []
		const source = new TransformStream<JSONRPCRequest, JSONRPCRequest>()
		const writer = source.writable.getWriter()
		const mcp = server(undefined, {
			notifications: {
				toolsListChanged: true,
				resourcesListChanged: true,
				resourceSubscriptions: ['resource://kept'],
			},
			listen(filter, dispatch) {
				notifications.push(filter)
				options.push(dispatch)
				return source.readable
			},
		})
		const stream = streamOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'subscriptions/listen',
					id: 'listen-7',
					params: {
						notifications: {
							toolsListChanged: true,
							promptsListChanged: true,
							resourceSubscriptions: ['resource://ignored', 'resource://kept'],
						},
						_meta: MODERN_METADATA,
					},
				}),
				{ signal: controller.signal },
			),
		)
		const acknowledgement = await stream.next()
		if (acknowledgement.done) throw new Error('expected a subscription acknowledgement')
		expect(notifications).toEqual([])
		const drained = drainStream(stream)
		await writer.write({ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' })
		await writer.write({
			jsonrpc: '2.0',
			method: 'notifications/tools/list_changed',
			params: { _meta: { producer: true } },
		})
		await writer.write({
			jsonrpc: '2.0',
			method: 'notifications/resources/updated',
			params: { uri: 'resource://ignored' },
		})
		await writer.write({
			jsonrpc: '2.0',
			method: 'notifications/resources/updated',
			params: { uri: 'resource://kept', _meta: { [MCP_META_SUBSCRIPTION]: 'wrong' } },
		})
		await writer.close()
		const [messages, response] = await drained

		expect(acknowledgement.value).toEqual({
			jsonrpc: '2.0',
			method: 'notifications/subscriptions/acknowledged',
			params: {
				notifications: {
					toolsListChanged: true,
					resourceSubscriptions: ['resource://kept'],
				},
				_meta: { [MCP_META_SUBSCRIPTION]: 'listen-7' },
			},
		})
		expect(messages).toEqual([
			{
				jsonrpc: '2.0',
				method: 'notifications/tools/list_changed',
				params: {
					_meta: { producer: true, [MCP_META_SUBSCRIPTION]: 'listen-7' },
				},
			},
			{
				jsonrpc: '2.0',
				method: 'notifications/resources/updated',
				params: {
					uri: 'resource://kept',
					_meta: { [MCP_META_SUBSCRIPTION]: 'listen-7' },
				},
			},
		])
		expect(notifications).toEqual([
			{ toolsListChanged: true, resourceSubscriptions: ['resource://kept'] },
		])
		expect(options[0]?.signal).toBe(controller.signal)
		expect(response).toEqual({
			jsonrpc: '2.0',
			id: 'listen-7',
			result: {
				resultType: 'complete',
				_meta: {
					[MCP_META_SUBSCRIPTION]: 'listen-7',
					[MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' },
				},
			},
		})
	})

	it('rejects a missing notification filter and keeps the legacy method frozen', async () => {
		const mcp = server()
		const invalid = responseOf(await mcp.dispatch(modernRequest('subscriptions/listen')))
		const legacy = responseOf(
			await mcp.dispatch(createJSONRPCRequest({ method: 'subscriptions/listen', id: 7 })),
		)

		expect(invalid?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(legacy?.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
	})
})

describe('MCPServer — initialize', () => {
	it('returns the default protocol version, the tools capability, and serverInfo', async () => {
		const response = responseOf(await server().dispatch(createJSONRPCRequest()))
		const result = resultOf(response)

		expect(response?.id).toBe(1)
		expect(result['protocolVersion']).toBe(MCP_PROTOCOL_VERSION)
		expect(result['capabilities']).toEqual({ tools: {} })
		expect(result['serverInfo']).toEqual({ name: 'test-server', version: '1.2.3' })
	})

	it('falls back when the requested protocol version requires unsupported batching', async () => {
		const response = responseOf(
			await server().dispatch(createJSONRPCRequest({ params: { protocolVersion: '2025-03-26' } })),
		)

		expect(resultOf(response)['protocolVersion']).toBe(MCP_PROTOCOL_VERSION)
	})

	it('falls back to the default for an unsupported requested version', async () => {
		const response = responseOf(
			await server().dispatch(createJSONRPCRequest({ params: { protocolVersion: '1999-01-01' } })),
		)

		expect(resultOf(response)['protocolVersion']).toBe(MCP_PROTOCOL_VERSION)
	})

	it('ignores a non-string requested version (falls back to the default)', async () => {
		const response = responseOf(
			await server().dispatch(createJSONRPCRequest({ params: { protocolVersion: 42 } })),
		)

		expect(resultOf(response)['protocolVersion']).toBe(MCP_PROTOCOL_VERSION)
	})
})

describe('MCPServer — ping', () => {
	it('returns an empty result', async () => {
		const response = responseOf(
			await server().dispatch(createJSONRPCRequest({ method: 'ping', id: 7 })),
		)

		expect(response?.id).toBe(7)
		expect(response?.result).toEqual({})
	})
})

describe('MCPServer — tools/list', () => {
	it('lists the registered tools with inputSchema mapped from parameters', async () => {
		const response = responseOf(
			await server().dispatch(createJSONRPCRequest({ method: 'tools/list', id: 2 })),
		)
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
		const mcp = createMCPServer({
			identity: { name: 'empty', version: '0.0.0' },
			tools: createToolManager(),
		})
		const response = responseOf(await mcp.dispatch(createJSONRPCRequest({ method: 'tools/list' })))

		expect(resultOf(response)['tools']).toEqual([])
	})
})

describe('MCPServer — tools/call', () => {
	it('executes a tool and round-trips its value through a text content block', async () => {
		const response = responseOf(
			await server().dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					id: 3,
					params: { name: 'sum', arguments: { a: 2, b: 5 } },
				}),
			),
		)
		const result = resultOf(response)

		expect(result['content']).toEqual([{ type: 'text', text: '7' }])
		expect(result['isError']).toBeUndefined()
	})

	it('round-trips a structured value (the echo tool) as serialized JSON', async () => {
		const response = responseOf(
			await server().dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					id: 3,
					params: { name: 'echo', arguments: { hello: 'world', n: 1 } },
				}),
			),
		)

		expect(resultOf(response)['content']).toEqual([
			{ type: 'text', text: JSON.stringify({ hello: 'world', n: 1 }) },
		])
	})

	it('defaults arguments to an empty record when omitted', async () => {
		const response = responseOf(
			await server().dispatch(
				createJSONRPCRequest({ method: 'tools/call', id: 3, params: { name: 'echo' } }),
			),
		)

		expect(resultOf(response)['content']).toEqual([{ type: 'text', text: '{}' }])
	})

	it('maps an erroring tool to an isError result carrying the error text', async () => {
		const response = responseOf(
			await server().dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					id: 4,
					params: { name: 'boom', arguments: {} },
				}),
			),
		)
		const result = resultOf(response)

		expect(result['isError']).toBe(true)
		expect(result['content']).toEqual([{ type: 'text', text: 'tool exploded' }])
	})

	it('maps an unknown tool name to an isError result (the manager not-found error)', async () => {
		const response = responseOf(
			await server().dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					id: 4,
					params: { name: 'missing', arguments: {} },
				}),
			),
		)
		const result = resultOf(response)

		expect(result['isError']).toBe(true)
		expect(result['content']).toEqual([{ type: 'text', text: 'tool not found: missing' }])
	})

	it('rejects a missing tool name with -32602 invalid params', async () => {
		const response = responseOf(
			await server().dispatch(createJSONRPCRequest({ method: 'tools/call', id: 5, params: {} })),
		)

		expect(response?.result).toBeUndefined()
		expect(response?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
	})

	it('rejects a non-string tool name with -32602 invalid params', async () => {
		const response = responseOf(
			await server().dispatch(
				createJSONRPCRequest({ method: 'tools/call', id: 5, params: { name: 42 } }),
			),
		)

		expect(response?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
	})
})

describe('MCPServer — notifications & unknown methods', () => {
	it('returns no response for a request without an id (a notification)', async () => {
		const response = responseOf(await server().dispatch(createJSONRPCNotification('ping')))

		expect(response).toBeUndefined()
	})

	it('returns no response for notifications/initialized', async () => {
		const response = responseOf(
			await server().dispatch(createJSONRPCNotification('notifications/initialized')),
		)

		expect(response).toBeUndefined()
	})

	it('returns -32601 for an unknown method', async () => {
		const response = responseOf(
			await server().dispatch(createJSONRPCRequest({ method: 'does/not/exist', id: 9 })),
		)

		expect(response?.id).toBe(9)
		expect(response?.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
		expect(response?.error?.message).toContain('does/not/exist')
	})

	it('returns no response for an unknown-method notification (no id)', async () => {
		const response = responseOf(
			await server().dispatch(createJSONRPCNotification('does/not/exist')),
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
			['ping', 1, 'legacy'],
			['tools/list', 2, 'legacy'],
		])
	})

	it('fires request with a null id for a notification', async () => {
		const mcp = server()
		const events = recordEmitterEvents(mcp.emitter, MCP_EVENTS)
		await mcp.dispatch(createJSONRPCNotification('notifications/initialized'))

		expect(events.request.calls).toEqual([['notifications/initialized', null, 'legacy']])
	})

	it('fires request through handle as well (parse → dispatch path)', async () => {
		const mcp = server()
		const events = recordEmitterEvents(mcp.emitter, MCP_EVENTS)
		await mcp.handle('{"jsonrpc":"2.0","method":"ping","id":3}')

		expect(events.request.calls).toEqual([['ping', 3, 'legacy']])
	})

	it('EMIT SAFETY: a throwing request listener cannot corrupt the dispatch, and routes to the error handler', async () => {
		const errors = createErrorRecorder()
		const mcp = server(errors.handler)
		mcp.emitter.on('request', () => {
			throw new Error('request observer blew up')
		})

		// THE LOAD-BEARING ASSERTION: the dispatch still produces its response.
		const response = responseOf(await mcp.dispatch(createJSONRPCRequest({ method: 'ping' })))

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
		const response = responseOf(await mcp.dispatch(createJSONRPCRequest({ method: 'ping' })))

		expect(response?.result).toEqual({})
		// Fired exactly once (its own throw was swallowed, not re-entered — no recursion).
		expect(errors.count).toBe(1)
		expect(errors.calls[0]?.[1]).toBe('request')
	})
})
