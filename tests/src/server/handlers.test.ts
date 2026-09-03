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
	buildJSONRPCResult,
	createMCPLegacy,
	createMCPServer,
	MCP_FALLBACK_VERSION,
	MCP_HANDSHAKE_VERSION,
	MCP_LOOKUP_PAGES,
	MCP_META_CAPABILITIES,
	MCP_META_SERVER,
	MCP_META_SUBSCRIPTION,
	MCP_META_VERSION,
	MCP_METHOD_HEADER,
	MCP_MODERN_VERSION,
	MCP_NAME_HEADER,
	MCP_PROTOCOL_VERSION_HEADER,
} from '@src/core'
import { createTool, createToolManager } from '@orkestrel/tool'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { createTeardown } from '@orkestrel/test'
import { createMCPPostHandler as createPostHandler, createMCPRoutes } from '@src/server'
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
					supported: [MCP_HANDSHAKE_VERSION, MCP_FALLBACK_VERSION],
					requested: '2099-01-01',
				},
			},
		})
	})

	// A header naming the MODERN revision is a client declaring the revision this server
	// implements, so the request is held to that revision's own rule: SEP-2575 requires every
	// modern request to carry a parsable `_meta`, and a body without one is `-32602`. The
	// legacy `-32022` fallthrough would answer "this server does not implement 2026-07-28",
	// which is false. An unsupported revision, modern or not, still answers `-32022`.
	it.each([
		{
			branch: 'a legacy-shaped body with no _meta at all',
			params: undefined,
		},
		{
			branch: 'a body whose _meta omits the protocol version',
			params: { _meta: { [MCP_META_CAPABILITIES]: {} } },
		},
	])('answers -32602 for a modern protocol header over $branch', async (test) => {
		const mcp = createCalculatorServer()
		let requests = 0
		mcp.emitter.on('request', () => {
			requests += 1
		})
		const handler = createPostHandler(createMCPLegacy(mcp), { streaming: false })
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_VERSION,
					[MCP_METHOD_HEADER]: 'server/discover',
				},
				body: JSON.stringify(
					createJSONRPCRequest({
						method: 'server/discover',
						id: 9,
						...(test.params === undefined ? {} : { params: test.params }),
					}),
				),
			}),
		)

		expect(response.status).toBe(400)
		expect(requests).toBe(0)
		expect(await response.json()).toEqual({
			jsonrpc: '2.0',
			id: 9,
			error: {
				code: -32602,
				message: 'Invalid params: malformed modern request metadata',
			},
		})
	})

	it('keeps -32022 for a protocol header naming a revision this server does not implement', async () => {
		const handler = createPostHandler(createMCPLegacy(createCalculatorServer()), {
			streaming: false,
		})
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { [MCP_PROTOCOL_VERSION_HEADER]: 'v999.0.0' },
				body: JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 9 })),
			}),
		)

		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({
			jsonrpc: '2.0',
			id: 9,
			error: {
				code: -32022,
				message: "Unsupported MCP protocol version 'v999.0.0'",
				data: {
					supported: [MCP_HANDSHAKE_VERSION, MCP_FALLBACK_VERSION],
					requested: 'v999.0.0',
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
				producer: () => subscriptionEvents(),
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
				producer: (_notifications, options) => {
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
					[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_VERSION,
					[MCP_METHOD_HEADER]: 'server/discover',
				},
				body: JSON.stringify(
					createJSONRPCRequest({
						method: 'server/discover',
						params: {
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

		expect(response.status).toBe(200)
		expect(body.result.supportedVersions).toEqual([MCP_MODERN_VERSION])
		expect(body.result['_meta'][MCP_META_SERVER]).toEqual({ name: 'calculator', version: '1.0.0' })
	})

	it('requires Mcp-Name only on tools/call and matches it to params.name', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), { streaming: false })
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_VERSION,
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
								[MCP_META_VERSION]: MCP_MODERN_VERSION,
								[MCP_META_CAPABILITIES]: {},
							},
						},
					}),
				),
			}),
		)
		const body = await response.json()

		expect(response.status).toBe(200)
		expect(body.result.resultType).toBe('complete')
		expect(body.result.content).toEqual([{ type: 'text', text: '5' }])
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
			message: "Required Mcp-Name header is missing; the request body target is 'add'.",
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
			message: "Mcp-Name header does not match the request body target 'add'.",
			supplied: 'client-supplied-name',
		},
		{
			branch: 'names a missing modern resources/read name header',
			method: 'resources/read',
			params: { uri: 'memory://resource/one' },
			headers: {
				[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_VERSION,
				[MCP_METHOD_HEADER]: 'resources/read',
			},
			message:
				"Required Mcp-Name header is missing; the request body target is 'memory://resource/one'.",
		},
		{
			branch: 'names a mismatched modern prompts/get name header',
			method: 'prompts/get',
			params: { name: 'greet' },
			headers: {
				[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_VERSION,
				[MCP_METHOD_HEADER]: 'prompts/get',
				[MCP_NAME_HEADER]: 'client-supplied-name',
			},
			message: "Mcp-Name header does not match the request body target 'greet'.",
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
				[MCP_META_VERSION]: MCP_MODERN_VERSION,
				[MCP_META_CAPABILITIES]: {},
			},
		}
		const modern = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_VERSION,
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

// SEP-2243's `Mcp-Param-*` server half, proven AT THE WIRE through the shipped POST handler
// over a real MCPServer and a real ToolManager. The annotated tool lives here rather than in
// `tests/setup.ts` because no other suite drives an annotated definition.

const ROUTE_SCHEMA = {
	type: 'object',
	properties: {
		value: { type: 'string', 'x-mcp-header': 'value' },
		count: { type: 'integer', 'x-mcp-header': 'Count' },
		note: { type: 'string' },
	},
}

function createAnnotatedServer(): MCPServerInterface {
	const tools = createToolManager()
	tools.add(
		createTool({
			name: 'route',
			description: 'Echo the routed arguments back to the caller.',
			parameters: ROUTE_SCHEMA,
			execute: (values) => values,
		}),
	)
	return createMCPServer({ identity: { name: 'router', version: '1.0.0' }, tools })
}

// A consumer that replaced `tools/list` with a handler paging ONE definition per page — the
// documented `methods.add` seam. `route` sits on the page at `depth`, so the header lookup
// reaches its annotations only by following `nextCursor` that far.
function createPagedServer(depth: number): MCPServerInterface {
	const server = createAnnotatedServer()
	server.methods.add('tools/list', async (request) => {
		const cursor = request.params?.['cursor']
		const page = typeof cursor === 'string' ? Number(cursor) : 0
		const listed =
			page === depth
				? { name: 'route', inputSchema: ROUTE_SCHEMA }
				: { name: `filler_${page}`, inputSchema: { type: 'object', properties: {} } }
		return buildJSONRPCResult(request.id, {
			tools: [listed],
			...(page === depth ? {} : { nextCursor: String(page + 1) }),
		})
	})
	return server
}

async function callAnnotated(
	name: string,
	headers: Readonly<Record<string, string>>,
	args: Readonly<Record<string, unknown>>,
): Promise<Response> {
	return await callTool(createAnnotatedServer(), name, headers, args)
}

async function callTool(
	server: MCPServerInterface,
	name: string,
	headers: Readonly<Record<string, string>>,
	args: Readonly<Record<string, unknown>>,
): Promise<Response> {
	const handler = createMCPPostHandler(server, { streaming: false })
	return await handler(
		new Request('http://localhost/mcp', {
			method: 'POST',
			headers: {
				[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_VERSION,
				[MCP_METHOD_HEADER]: 'tools/call',
				[MCP_NAME_HEADER]: name,
				...headers,
			},
			body: JSON.stringify(
				createJSONRPCRequest({
					method: 'tools/call',
					params: {
						name,
						arguments: args,
						_meta: {
							[MCP_META_VERSION]: MCP_MODERN_VERSION,
							[MCP_META_CAPABILITIES]: {},
						},
					},
				}),
			),
		}),
	)
}

describe('createMCPPostHandler — Mcp-Param headers validated against the request body', () => {
	it.each([
		{
			branch: 'decodes a well-formed sentinel and matches the body',
			headers: { 'Mcp-Param-value': '=?base64?SGVsbG8=?=' },
			args: { value: 'Hello' },
		},
		{
			branch: 'treats a value missing the opening marker as literal',
			headers: { 'Mcp-Param-value': 'SGVsbG8=' },
			args: { value: 'SGVsbG8=' },
		},
		{
			branch: 'treats a value missing the closing marker as literal',
			headers: { 'Mcp-Param-value': '=?base64?SGVsbG8=' },
			args: { value: '=?base64?SGVsbG8=' },
		},
		{
			branch: 'excludes optional whitespace around a literal field value',
			headers: { 'Mcp-Param-value': '  Hello  ' },
			args: { value: 'Hello' },
		},
		{
			branch: 'compares an integer numerically rather than textually',
			headers: { 'Mcp-Param-Count': '007' },
			args: { count: 7 },
		},
		{
			branch: 'ignores a Mcp-Param header no served definition annotates',
			headers: { 'Mcp-Param-Unknown': 'anything' },
			args: { note: 'free text' },
		},
		{
			branch: 'requires no header for an argument the schema leaves unannotated',
			headers: {},
			args: { note: 'free text' },
		},
		{
			branch: 'requires no header for an annotated argument the call omits',
			headers: {},
			args: {},
		},
	])('$branch', async (test) => {
		const response = await callAnnotated('route', test.headers, test.args)
		const body = await response.json()

		expect(response.status).toBe(200)
		expect(body.error).toBeUndefined()
	})

	it.each([
		{
			branch: 'refuses a sentinel whose payload has invalid padding',
			headers: { 'Mcp-Param-value': '=?base64?SGVsbG8?=' },
			args: { value: 'Hello' },
			message: 'Mcp-Param-value header value is not a valid Base64 sentinel.',
		},
		{
			branch: 'refuses a sentinel whose payload has non-alphabet characters',
			headers: { 'Mcp-Param-value': '=?base64?SGVs!!!bG8=?=' },
			args: { value: 'Hello' },
			message: 'Mcp-Param-value header value is not a valid Base64 sentinel.',
		},
		{
			branch: 'refuses a header the request omits while the body carries its value',
			headers: {},
			args: { value: 'test-value' },
			message: "Required Mcp-Param-value header is missing; the request body carries 'value'.",
		},
		{
			branch: 'refuses a decoded value that disagrees with the body',
			headers: { 'Mcp-Param-value': 'client-supplied-value' },
			args: { value: 'Hello' },
			message: "Mcp-Param-value header does not match the request body value at 'value'.",
		},
		{
			branch: 'refuses an integer header naming a different number',
			headers: { 'Mcp-Param-Count': '8' },
			args: { count: 7 },
			message: "Mcp-Param-Count header does not match the request body value at 'count'.",
		},
		{
			branch: 'refuses an integer header carrying no number at all',
			headers: { 'Mcp-Param-Count': '  ' },
			args: { count: 7 },
			message: "Mcp-Param-Count header does not match the request body value at 'count'.",
		},
		{
			branch: 'refuses a header carrying a value the body never supplied',
			headers: { 'Mcp-Param-value': 'client-supplied-value' },
			args: { note: 'free text' },
			message: "Mcp-Param-value header carries a value the request body omits at 'value'.",
		},
	])('$branch with HTTP 400, -32020, and no echoed header value', async (test) => {
		const response = await callAnnotated('route', test.headers, test.args)
		const body = await response.json()

		expect(response.status).toBe(400)
		expect(body.error).toEqual({ code: -32020, message: test.message })
		expect(body.error).not.toHaveProperty('data')
		expect(test.message).not.toContain('client-supplied-value')
	})

	it('refuses a forged header for a tool a replacement listing pages onto page two', async () => {
		const response = await callTool(
			createPagedServer(1),
			'route',
			{ 'Mcp-Param-value': 'client-supplied-value' },
			{ value: 'Hello' },
		)
		const body = await response.json()

		// The definition is reachable only through `nextCursor`, so a lookup reading page one
		// alone would recognize no `value` parameter and forward the forgery untouched.
		expect(response.status).toBe(400)
		expect(body.error).toEqual({
			code: -32020,
			message: "Mcp-Param-value header does not match the request body value at 'value'.",
		})
	})

	it('admits a matching header for a tool a replacement listing pages onto page two', async () => {
		const response = await callTool(
			createPagedServer(1),
			'route',
			{ 'Mcp-Param-value': 'Hello' },
			{ value: 'Hello' },
		)
		const body = await response.json()

		expect(response.status).toBe(200)
		expect(body.error).toBeUndefined()
	})

	it('forwards a header unrecognized for a tool paged past the walk bound', async () => {
		const response = await callTool(
			createPagedServer(MCP_LOOKUP_PAGES),
			'route',
			{ 'Mcp-Param-value': 'client-supplied-value' },
			{ value: 'Hello' },
		)
		const body = await response.json()

		// The bound is the residual limit: a definition further in than the walk reaches reads
		// as no definition, exactly as a name no served definition annotates does.
		expect(response.status).toBe(200)
		expect(body.error).toBeUndefined()
	})

	it('recognizes no parameter for a tool this server serves no definition for', async () => {
		const response = await callAnnotated(
			'absent',
			{ 'Mcp-Param-value': 'anything' },
			{
				value: 'Hello',
			},
		)
		const body = await response.json()

		// Nothing is recognized, so nothing is validated: the refusal comes from the registry
		// rather than from the header seam.
		expect(body.error?.code).not.toBe(-32020)
	})
})
