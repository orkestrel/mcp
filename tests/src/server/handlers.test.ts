import type {
	JSONRPCId,
	JSONRPCNotification,
	MCPMethodOptions,
	MCPServerInterface,
	MCPStream,
} from '@src/core'
import type { HTTPTransportOptions } from '@src/server'
import type { StartedServerInterface } from '../../setupServer.js'
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
	createMCPServer,
	createMCPLegacy,
	buildJSONRPCResult,
	MCP_META_CAPABILITIES,
	MCP_META_SERVER,
	MCP_META_SUBSCRIPTION,
	MCP_META_VERSION,
	MCP_MODERN_VERSION,
	MCP_PROTOCOL_VERSION,
} from '@src/core'
import { createToolManager } from '@orkestrel/tool'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { createTeardown } from '@orkestrel/test'
import {
	createMCPPostHandler as createPostHandler,
	createMCPRoutes,
	MCP_METHOD_HEADER,
	MCP_NAME_HEADER,
	MCP_PROTOCOL_VERSION_HEADER,
} from '@src/server'
import {
	collectSSE,
	createCalculatorServer,
	createJSONRPCNotification,
	createJSONRPCRequest,
	readSSEStream,
} from '../../setup.js'
import { startServer } from '../../setupServer.js'

async function* subscriptionEvents(): AsyncGenerator<JSONRPCNotification> {
	yield { jsonrpc: '2.0', method: 'notifications/tools/list_changed' }
}

async function* disconnectEvents(
	signal: AbortSignal,
	observe: () => void,
): AsyncGenerator<JSONRPCNotification> {
	await new Promise<void>((resolve) => {
		if (signal.aborted) resolve()
		else signal.addEventListener('abort', () => resolve(), { once: true })
	})
	observe()
	// This yield is reachable only after the disconnect signal was observed; the live stream
	// remains idle and cannot use a producer write to trigger its own cancellation.
	yield { jsonrpc: '2.0', method: 'notifications/tools/list_changed' }
	throw new Error('subscription client disconnected')
}

async function* callerEvents(
	options: MCPMethodOptions,
	id: JSONRPCId,
	first: Promise<void>,
	second: Promise<void>,
): MCPStream {
	await first
	yield {
		jsonrpc: '2.0',
		method: 'notifications/caller',
		params: { caller: options.caller, step: 1 },
	}
	await second
	yield {
		jsonrpc: '2.0',
		method: 'notifications/caller',
		params: { caller: options.caller, step: 2 },
	}
	return buildJSONRPCResult(id, { caller: options.caller })
}

const teardown = createTeardown()
afterEach(() => teardown.destroy())

function createMCPPostHandler<TState = unknown>(
	mcp: MCPServerInterface,
	options?: HTTPTransportOptions<TState>,
): ReturnType<typeof createPostHandler<TState>> {
	return createPostHandler(createMCPLegacy(mcp), options)
}

async function startHTTP(
	mcp: MCPServerInterface,
	options?: HTTPTransportOptions,
): Promise<StartedServerInterface<undefined>> {
	const dispatcher = createDispatcher<undefined>()
	dispatcher.add(createMCPRoutes<undefined>(createMCPLegacy(mcp), options))
	const handle = await startServer(createServer({ dispatcher, state: () => undefined }))
	teardown.add(() => handle.stop())
	return handle
}

function disconnectHTTP(
	url: string,
	options: {
		readonly method: string
		readonly headers: Readonly<Record<string, string>>
		readonly body: string
	},
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const outgoing = httpRequest(url, {
			method: options.method,
			headers: options.headers,
		})
		outgoing.on('response', (response) => {
			response.once('data', () => response.destroy())
			response.once('close', () => setImmediate(resolve))
			response.on('error', (error) => {
				if (!response.destroyed) reject(error)
			})
		})
		outgoing.on('error', (error) => {
			if (!outgoing.destroyed) reject(error)
		})
		outgoing.end(options.body)
	})
}

describe('createMCPPostHandler', () => {
	it('extracts caller context for a registered method immediately before dispatch', async () => {
		const mcp = createCalculatorServer()
		const caller = Object.freeze({ subject: 'http-user' })
		const seen: unknown[] = []
		mcp.methods.add('demo/caller', async (request, options) => {
			seen.push(options.caller)
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
		})
		const handler = createMCPPostHandler(mcp, {
			streaming: false,
			caller: () => caller,
		})
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					[MCP_PROTOCOL_VERSION_HEADER]: '2026-07-28',
					[MCP_METHOD_HEADER]: 'demo/caller',
				},
				body: JSON.stringify(
					createJSONRPCRequest({
						method: 'demo/caller',
						params: {
							_meta: {
								[MCP_META_VERSION]: '2026-07-28',
								[MCP_META_CAPABILITIES]: {},
							},
						},
					}),
				),
			}),
		)

		expect(response.status).toBe(200)
		expect(seen).toEqual([caller])
	})

	it('omits caller exactly when the extractor is absent or returns undefined', async () => {
		const mcp = createCalculatorServer()
		const seen: MCPMethodOptions[] = []
		mcp.methods.add('demo/options', async (request, options) => {
			seen.push(options)
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
		})
		const body = JSON.stringify(
			createJSONRPCRequest({
				method: 'demo/options',
				params: {
					_meta: {
						[MCP_META_VERSION]: '2026-07-28',
						[MCP_META_CAPABILITIES]: {},
					},
				},
			}),
		)
		const headers = {
			[MCP_PROTOCOL_VERSION_HEADER]: '2026-07-28',
			[MCP_METHOD_HEADER]: 'demo/options',
		}
		await createMCPPostHandler(mcp, { streaming: false })(
			new Request('http://localhost/mcp', { method: 'POST', headers, body }),
		)
		await createMCPPostHandler(mcp, { streaming: false, caller: () => undefined })(
			new Request('http://localhost/mcp', { method: 'POST', headers, body }),
		)

		expect(seen).toHaveLength(2)
		for (const options of seen) {
			expect(options.caller).toBeUndefined()
			expect(Object.keys(options)).toEqual(['signal'])
			expect(options.signal).toBeInstanceOf(AbortSignal)
		}
	})

	it('never invokes the caller extractor for rejected origin or protocol headers', async () => {
		const mcp = createCalculatorServer()
		let calls = 0
		const handler = createMCPPostHandler(mcp, {
			streaming: false,
			caller: () => {
				calls += 1
				return 'unreachable'
			},
		})
		const denied = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { origin: 'https://denied.example' },
				body: JSON.stringify(createJSONRPCRequest()),
			}),
		)
		const mismatched = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					[MCP_PROTOCOL_VERSION_HEADER]: '2026-07-28',
					[MCP_METHOD_HEADER]: 'tools/list',
				},
				body: JSON.stringify(
					createJSONRPCRequest({
						method: 'server/discover',
						params: {
							_meta: {
								[MCP_META_VERSION]: '2026-07-28',
								[MCP_META_CAPABILITIES]: {},
							},
						},
					}),
				),
			}),
		)

		expect(denied.status).toBe(403)
		expect(mismatched.status).toBe(400)
		expect(calls).toBe(0)
	})

	it('propagates a synchronous caller extractor throw', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), {
			streaming: false,
			caller: () => {
				throw new Error('caller extraction failed')
			},
		})
		const request = new Request('http://localhost/mcp', {
			method: 'POST',
			body: JSON.stringify(createJSONRPCRequest()),
		})

		await expect(handler(request)).rejects.toThrow('caller extraction failed')
	})

	it('returns a JSON response for an id-bearing request', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), { streaming: false })
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { [MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18' },
				body: JSON.stringify(createJSONRPCRequest({ method: 'ping' })),
			}),
		)

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
	})

	it('accepts a supported protocol-version header', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), { streaming: false })
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { [MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18' },
				body: JSON.stringify(createJSONRPCRequest({ method: 'ping' })),
			}),
		)

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
	})

	it('rejects an unsupported protocol-version header before dispatch', async () => {
		const mcp = createCalculatorServer()
		let requests = 0
		mcp.emitter.on('request', () => {
			requests += 1
		})
		const handler = createMCPPostHandler(mcp, { streaming: false })
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { [MCP_PROTOCOL_VERSION_HEADER]: '2099-01-01' },
				body: JSON.stringify(createJSONRPCRequest({ method: 'ping' })),
			}),
		)

		expect(response.status).toBe(400)
		expect(requests).toBe(0)
		expect(await response.json()).toEqual({
			jsonrpc: '2.0',
			id: 1,
			error: {
				code: -32022,
				message: "Unsupported MCP protocol version '2099-01-01'",
				data: {
					supported: ['2026-07-28', '2025-11-25', '2025-06-18'],
					requested: '2099-01-01',
				},
			},
		})
	})

	it('returns a parse error for malformed JSON', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), { streaming: false })
		const response = await handler(
			new Request('http://localhost/mcp', { method: 'POST', body: '{ not json' }),
		)

		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({
			jsonrpc: '2.0',
			error: { code: -32700, message: 'Parse error' },
		})
	})

	it('returns an empty accepted response for a notification', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), { streaming: false })
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { [MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18' },
				body: JSON.stringify(createJSONRPCNotification('notifications/initialized')),
			}),
		)

		expect(response.status).toBe(202)
		expect(await response.text()).toBe('')
	})

	it('frames a response as an event stream when negotiated', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), {
			keepalive: { interval: 1 },
		})
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					accept: 'text/event-stream',
					[MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18',
				},
				body: JSON.stringify(createJSONRPCRequest({ method: 'ping' })),
			}),
		)
		const body = await response.text()

		expect(response.headers.get('x-accel-buffering')).toBe('no')
		expect(body).toBe('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n')
	})

	it('pumps a held-open subscription acknowledgement, notifications, and closure onto SSE', async () => {
		const identity = { name: 'stream-server', version: '1.0.0' }
		const mcp = createMCPServer({
			identity,
			tools: createToolManager(),
			subscription: {
				notifications: { toolsListChanged: true },
				listen: () => subscriptionEvents(),
			},
		})
		const handler = createMCPPostHandler(mcp, { streaming: false })
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					[MCP_PROTOCOL_VERSION_HEADER]: '2026-07-28',
					[MCP_METHOD_HEADER]: 'subscriptions/listen',
				},
				body: JSON.stringify(
					createJSONRPCRequest({
						method: 'subscriptions/listen',
						id: 'http-listen',
						params: {
							notifications: { toolsListChanged: true },
							_meta: {
								[MCP_META_VERSION]: '2026-07-28',
								[MCP_META_CAPABILITIES]: {},
							},
						},
					}),
				),
			}),
		)
		const events = await collectSSE(response)

		expect(response.headers.get('x-accel-buffering')).toBe('no')
		expect(events.map((event) => JSON.parse(event.data))).toEqual([
			{
				jsonrpc: '2.0',
				method: 'notifications/subscriptions/acknowledged',
				params: {
					notifications: { toolsListChanged: true },
					_meta: { [MCP_META_SUBSCRIPTION]: 'http-listen' },
				},
			},
			{
				jsonrpc: '2.0',
				method: 'notifications/tools/list_changed',
				params: { _meta: { [MCP_META_SUBSCRIPTION]: 'http-listen' } },
			},
			{
				jsonrpc: '2.0',
				id: 'http-listen',
				result: {
					resultType: 'complete',
					_meta: {
						[MCP_META_SUBSCRIPTION]: 'http-listen',
						[MCP_META_SERVER]: identity,
					},
				},
			},
		])
	})

	it('retains captured caller context across two stream resumptions after returning', async () => {
		let resumeFirst: (() => void) | undefined
		let resumeSecond: (() => void) | undefined
		const first = new Promise<void>((resolve) => {
			resumeFirst = resolve
		})
		const second = new Promise<void>((resolve) => {
			resumeSecond = resolve
		})
		const caller = Object.freeze({ subject: 'stream-user' })
		const mcp = createCalculatorServer()
		mcp.methods.add('demo/caller-stream', async (request, options) =>
			callerEvents(options, request.id, first, second),
		)
		const handler = createMCPPostHandler(mcp, { caller: () => caller })
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					[MCP_PROTOCOL_VERSION_HEADER]: '2026-07-28',
					[MCP_METHOD_HEADER]: 'demo/caller-stream',
				},
				body: JSON.stringify(
					createJSONRPCRequest({
						id: 'caller-stream',
						method: 'demo/caller-stream',
						params: {
							_meta: {
								[MCP_META_VERSION]: '2026-07-28',
								[MCP_META_CAPABILITIES]: {},
							},
						},
					}),
				),
			}),
		)
		const events = readSSEStream(response)
		const iterator = events[Symbol.asyncIterator]()
		if (resumeFirst === undefined || resumeSecond === undefined) {
			throw new Error('stream controls were not initialized')
		}

		resumeFirst()
		const firstEvent = await iterator.next()
		resumeSecond()
		const secondEvent = await iterator.next()
		const finalEvent = await iterator.next()
		const closed = await iterator.next()

		expect(firstEvent.value?.data).toBe(
			'{"jsonrpc":"2.0","method":"notifications/caller","params":{"caller":{"subject":"stream-user"},"step":1}}',
		)
		expect(secondEvent.value?.data).toBe(
			'{"jsonrpc":"2.0","method":"notifications/caller","params":{"caller":{"subject":"stream-user"},"step":2}}',
		)
		expect(finalEvent.value?.data).toBe(
			'{"jsonrpc":"2.0","id":"caller-stream","result":{"caller":{"subject":"stream-user"}}}',
		)
		expect(closed.done).toBe(true)
	})

	it('aborts an A4 subscription handler when a real HTTP client disconnects', async () => {
		const mcp = createMCPServer({
			identity: { name: 'signal-server', version: '1.0.0' },
			tools: createToolManager(),
			subscription: {
				notifications: { toolsListChanged: true },
				listen: (_notifications, options) => {
					if (options.signal === undefined) throw new Error('expected HTTP disconnect signal')
					observed = options.signal
					return disconnectEvents(options.signal, () => abortedResolve?.())
				},
			},
		})
		let observed: AbortSignal | undefined
		let abortedResolve: (() => void) | undefined
		const aborted = new Promise<void>((resolve) => {
			abortedResolve = resolve
		})
		const handle = await startHTTP(mcp, { keepalive: { interval: 25 } })
		const body = JSON.stringify(
			createJSONRPCRequest({
				method: 'subscriptions/listen',
				id: 'disconnect-listen',
				params: {
					notifications: { toolsListChanged: true },
					_meta: {
						[MCP_META_VERSION]: '2026-07-28',
						[MCP_META_CAPABILITIES]: {},
					},
				},
			}),
		)
		await disconnectHTTP(`${handle.base}/mcp`, {
			method: 'POST',
			headers: {
				accept: 'text/event-stream',
				'content-type': 'application/json',
				[MCP_PROTOCOL_VERSION_HEADER]: '2026-07-28',
				[MCP_METHOD_HEADER]: 'subscriptions/listen',
			},
			body,
		})
		await aborted

		expect(observed).toBeDefined()
		expect(observed?.aborted).toBe(true)
	})

	it('composes the incoming request signal into the handler signal', async () => {
		const mcp = createMCPServer({
			identity: { name: 'signal-server', version: '1.0.0' },
			tools: createToolManager(),
		})
		let observed: AbortSignal | undefined
		let startedResolve: (() => void) | undefined
		const started = new Promise<void>((resolve) => {
			startedResolve = resolve
		})
		mcp.methods.add('demo/slow', async (request, options) => {
			observed = options.signal
			startedResolve?.()
			await new Promise<void>((resolve) => {
				options.signal.addEventListener('abort', () => resolve(), { once: true })
			})
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
		})
		const controller = new AbortController()
		const request = new Request('http://localhost/mcp', {
			method: 'POST',
			headers: {
				[MCP_PROTOCOL_VERSION_HEADER]: '2026-07-28',
				[MCP_METHOD_HEADER]: 'demo/slow',
			},
			body: JSON.stringify(
				createJSONRPCRequest({
					method: 'demo/slow',
					params: {
						_meta: {
							[MCP_META_VERSION]: '2026-07-28',
							[MCP_META_CAPABILITIES]: {},
						},
					},
				}),
			),
			signal: controller.signal,
		})
		const pending = createMCPPostHandler(mcp, { streaming: false })(request)
		await started
		controller.abort()
		const response = await pending

		expect(observed).not.toBe(request.signal)
		expect(observed?.aborted).toBe(true)
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({
			jsonrpc: '2.0',
			id: 1,
			result: { resultType: 'complete' },
		})
	})

	it('accepts a headerless legacy initialize request', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), { streaming: false })
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				body: JSON.stringify(createJSONRPCRequest()),
			}),
		)

		expect(response.status).toBe(200)
		expect((await response.json()).result.protocolVersion).toBe('2025-11-25')
	})

	it('names the missing protocol header on a headerless legacy request with no data member', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), { streaming: false })
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				body: JSON.stringify(createJSONRPCRequest({ method: 'tools/list' })),
			}),
		)
		const body = await response.json()

		expect(response.status).toBe(400)
		expect(body.error).toEqual({
			code: -32020,
			message: "Required MCP-Protocol-Version header is missing; this server offers '2025-11-25'.",
		})
		expect(body.error).not.toHaveProperty('data')
	})

	it('requires protocol and method headers on modern discovery, but not Mcp-Name', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), { streaming: false })
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					[MCP_PROTOCOL_VERSION_HEADER]: MCP_PROTOCOL_VERSION,
					[MCP_METHOD_HEADER]: 'server/discover',
				},
				body: JSON.stringify(
					createJSONRPCRequest({
						method: 'server/discover',
						params: {
							_meta: {
								[MCP_META_VERSION]: MCP_PROTOCOL_VERSION,
								[MCP_META_CAPABILITIES]: {},
							},
						},
					}),
				),
			}),
		)

		expect(response.status).toBe(200)
	})

	it('requires Mcp-Name only on tools/call and matches it to params.name', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), { streaming: false })
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					[MCP_PROTOCOL_VERSION_HEADER]: MCP_PROTOCOL_VERSION,
					[MCP_METHOD_HEADER]: 'tools/call',
					[MCP_NAME_HEADER]: 'add',
				},
				body: JSON.stringify(
					createJSONRPCRequest({
						method: 'tools/call',
						params: {
							name: 'add',
							arguments: {},
							_meta: {
								[MCP_META_VERSION]: MCP_PROTOCOL_VERSION,
								[MCP_META_CAPABILITIES]: {},
							},
						},
					}),
				),
			}),
		)

		expect(response.status).toBe(200)
	})

	it.each([
		{
			branch: 'names a missing modern protocol header',
			method: 'tools/list',
			params: {},
			headers: { [MCP_METHOD_HEADER]: 'tools/list' },
			message:
				"Required MCP-Protocol-Version header is missing; the request body version is '2026-07-28'.",
		},
		{
			branch: 'names a mismatched modern protocol header',
			method: 'tools/list',
			params: {},
			headers: {
				[MCP_PROTOCOL_VERSION_HEADER]: 'client-supplied-version',
				[MCP_METHOD_HEADER]: 'tools/list',
			},
			message: "MCP-Protocol-Version header does not match the request body version '2026-07-28'.",
			supplied: 'client-supplied-version',
		},
		{
			branch: 'names a missing modern method header',
			method: 'tools/list',
			params: {},
			headers: { [MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_VERSION },
			message: "Required Mcp-Method header is missing; the request body method is 'tools/list'.",
		},
		{
			branch: 'names a mismatched modern method header',
			method: 'tools/list',
			params: {},
			headers: {
				[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_VERSION,
				[MCP_METHOD_HEADER]: 'client-supplied-method',
			},
			message: "Mcp-Method header does not match the request body method 'tools/list'.",
			supplied: 'client-supplied-method',
		},
		{
			branch: 'names a missing modern tools/call name header',
			method: 'tools/call',
			params: { name: 'add', arguments: {} },
			headers: {
				[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_VERSION,
				[MCP_METHOD_HEADER]: 'tools/call',
			},
			message: "Required Mcp-Name header is missing; the request body tool name is 'add'.",
		},
		{
			branch: 'names a mismatched modern tools/call name header',
			method: 'tools/call',
			params: { name: 'add', arguments: {} },
			headers: {
				[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_VERSION,
				[MCP_METHOD_HEADER]: 'tools/call',
				[MCP_NAME_HEADER]: 'client-supplied-name',
			},
			message: "Mcp-Name header does not match the request body tool name 'add'.",
			supplied: 'client-supplied-name',
		},
	])('$branch with HTTP 400, -32020, and no data member', async (test) => {
		const handler = createMCPPostHandler(createCalculatorServer(), { streaming: false })
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: test.headers,
				body: JSON.stringify(
					createJSONRPCRequest({
						method: test.method,
						params: {
							...test.params,
							_meta: {
								[MCP_META_VERSION]: MCP_MODERN_VERSION,
								[MCP_META_CAPABILITIES]: {},
							},
						},
					}),
				),
			}),
		)
		const body = await response.json()

		expect(response.status).toBe(400)
		expect(body.error).toEqual({ code: -32020, message: test.message })
		expect(body.error).not.toHaveProperty('data')
		expect(test.message).not.toContain(test.supplied ?? 'client-supplied-value')
	})

	it('returns -32602 when the modern metadata version is present but not a string', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), { streaming: false })
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					[MCP_PROTOCOL_VERSION_HEADER]: '7',
					[MCP_METHOD_HEADER]: 'server/discover',
				},
				body: JSON.stringify(
					createJSONRPCRequest({
						method: 'server/discover',
						params: {
							_meta: {
								[MCP_META_VERSION]: 7,
								[MCP_META_CAPABILITIES]: {},
							},
						},
					}),
				),
			}),
		)

		expect(response.status).toBe(400)
		expect((await response.json()).error).toEqual({
			code: -32602,
			message: 'Invalid params: malformed modern request metadata',
		})
	})

	it('maps a modern unknown method to HTTP 404 while legacy remains HTTP 200', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), { streaming: false })
		const params = {
			_meta: {
				[MCP_META_VERSION]: MCP_PROTOCOL_VERSION,
				[MCP_META_CAPABILITIES]: {},
			},
		}
		const modern = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					[MCP_PROTOCOL_VERSION_HEADER]: MCP_PROTOCOL_VERSION,
					[MCP_METHOD_HEADER]: 'unknown',
				},
				body: JSON.stringify(createJSONRPCRequest({ method: 'unknown', params })),
			}),
		)
		const legacy = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { [MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18' },
				body: JSON.stringify(createJSONRPCRequest({ method: 'unknown' })),
			}),
		)

		expect(modern.status).toBe(404)
		expect((await modern.json()).error.code).toBe(-32601)
		expect(legacy.status).toBe(200)
		expect((await legacy.json()).error.code).toBe(-32601)
	})

	it('allows no Origin and rejects every non-loopback origin outside the allowlist', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), { streaming: false })
		const allowed = createMCPPostHandler(createCalculatorServer(), {
			streaming: false,
			origin: { origins: ['https://client.example'] },
		})
		const delegated = createMCPPostHandler(createCalculatorServer(), {
			streaming: false,
			origin: { enabled: false },
		})
		const body = JSON.stringify(createJSONRPCRequest())
		const absent = await handler(new Request('http://localhost/mcp', { method: 'POST', body }))
		const unlisted = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { origin: 'https://client.example' },
				body,
			}),
		)
		const malformed = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { origin: 'not an origin' },
				body,
			}),
		)
		const admitted = await allowed(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { origin: 'https://client.example' },
				body,
			}),
		)
		const delegatedResponse = await delegated(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { origin: 'https://unlisted.example' },
				body,
			}),
		)

		expect(absent.status).toBe(200)
		expect(unlisted.status).toBe(403)
		expect(malformed.status).toBe(403)
		expect(admitted.status).toBe(200)
		expect(delegatedResponse.status).toBe(200)
	})
})
