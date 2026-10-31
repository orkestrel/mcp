import type { JSONRPCId, JSONRPCInvocation, JSONRPCResponse } from '@orkestrel/jsonrpc'
import {
	JSONRPC_INVALID_PARAMS,
	JSONRPC_METHOD_NOT_FOUND,
	buildJSONRPCResult,
} from '@orkestrel/jsonrpc'
import type { MCPMethodOptions, MCPStreamControllerInterface } from '@src/core'
import { createTool, createToolManager } from '@orkestrel/tool'
import {
	createMCPLegacy,
	createMCPServer,
	JSONRPC_SERVER_ERROR,
	MCP_META_CAPABILITIES,
	MCP_META_VERSION,
	MCP_MODERN_VERSION,
	MCPLegacy,
	MCPError,
} from '@src/core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { waitForAbort } from '@orkestrel/test'
import {
	createCalculatorServer,
	createLegacyTools,
	createUnreachableStream,
	MCP_LEGACY_CASES,
	MCPFixtureCell,
	createJSONRPCNotification,
	createJSONRPCRequest,
	MemoryResourceManager,
	TestTaskManager,
	waitForSettlement,
} from '../../setup.js'

describe('handshake method options', () => {
	it('carries caller identity and closes the request lifetime after readiness', async () => {
		const observed: MCPMethodOptions[] = []
		const caller = { subject: 'reader' }
		const server = createMCPServer({
			identity: { name: 'ready', version: '1.0.0' },
			tools: createToolManager(),
			async handshake(options) {
				expect(options.signal.aborted).toBe(false)
				observed.push(options)
			},
		})
		const signal = new AbortController().signal
		const response = await createMCPLegacy(server).dispatch(createJSONRPCRequest(), {
			signal,
			caller,
		})
		expect(response).toHaveProperty('result')
		expect(observed).toHaveLength(1)
		expect(observed[0]?.caller).toBe(caller)
		expect(observed[0]?.signal.aborted).toBe(true)
		expect(signal.aborted).toBe(false)
	})

	it('rethrows an aborted handshake rejection at the direct decorator boundary', async () => {
		const controller = new AbortController()
		const failure = new MCPError('setup ended', -32000, { code: 'ENDED' })
		const errors: unknown[] = []
		const server = createMCPServer({
			identity: { name: 'ready', version: '1.0.0' },
			tools: createToolManager(),
			on: { error: (error) => errors.push(error) },
		})
		const legacy = new MCPLegacy({
			dispatcher: server,
			identity: server.identity,
			async handshake(options) {
				await waitForAbort(options.signal)
				throw failure
			},
		})
		const answer = legacy.dispatch(createJSONRPCRequest(), { signal: controller.signal })
		controller.abort()
		await expect(answer).rejects.toBe(failure)
		expect(errors).toEqual([])
	})
})

// Captured before the W07-A production edit; divergences remain explicit named rows.

const tools = createLegacyTools()

const dispatcher = createMCPLegacy(
	createMCPServer({
		identity: { name: 'freeze', version: '1.0.0' },
		tools,
		limit: { message: 1024, content: 128 },
	}),
)

describe('legacy dispatch behavior freeze', () => {
	it.each(MCP_LEGACY_CASES)('%s', async (_name, request, output) => {
		expect(await dispatcher.dispatch(request)).toEqual(output)
	})
})

describe('the dispatch overloads', () => {
	it('resolves an answer for a request and nothing for a notification', async () => {
		const mcp = createMCPLegacy(createCalculatorServer())
		const answer = mcp.dispatch(createJSONRPCRequest({ method: 'ping', id: 1 }))
		const silence = mcp.dispatch(createJSONRPCNotification('notifications/initialized'))
		expectTypeOf(answer).resolves.toEqualTypeOf<JSONRPCResponse | MCPStreamControllerInterface>()
		expectTypeOf(silence).resolves.toEqualTypeOf<undefined>()

		expect(await answer).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
		expect(await silence).toBeUndefined()
	})

	it('keeps the union arm for a caller that narrowed no further', async () => {
		const mcp = createMCPLegacy(createCalculatorServer())
		const invocation: JSONRPCInvocation = createJSONRPCRequest({ method: 'ping', id: 2 })
		const answer: JSONRPCResponse | MCPStreamControllerInterface | undefined =
			await mcp.dispatch(invocation)

		expect(answer).toEqual({ jsonrpc: '2.0', id: 2, result: {} })
	})
})

describe('MCP legacy resource exclusions', () => {
	it('keeps removed and legacy resource methods fail-closed', async () => {
		const server = createMCPLegacy(
			createMCPServer({
				identity: { name: 'resources', version: '1.0.0' },
				tools: createToolManager(),
				resources: new MemoryResourceManager(),
			}),
		)
		const methods = [
			'resources/subscribe',
			'resources/unsubscribe',
			'resources/list',
			'resources/read',
			'resources/templates/list',
		]
		const answers = await Promise.all(
			methods.map((method, id) => server.dispatch(createJSONRPCRequest({ id, method }))),
		)

		expect(
			answers.map((answer) => {
				if (Symbol.asyncIterator in answer) throw new Error('expected a unary resource response')
				return answer.error?.code
			}),
		).toEqual(methods.map(() => JSONRPC_METHOD_NOT_FOUND))
	})
})

describe('MCPLegacy collapse boundaries', () => {
	it('projects a tokened legacy tools/call stream with its progress and complete result', async () => {
		const executions = new MCPFixtureCell(0)
		const legacy = createMCPLegacy(
			createMCPServer({
				identity: { name: 'progress', version: '1.0.0' },
				tools,
				execution: async (context) => {
					executions.value += 1
					if (context.progress === undefined) throw new Error('expected a progress reporter')
					await context.progress.report({ progress: 1, total: 1, message: 'complete' })
					return context.tools.execute(context.call)
				},
			}),
		)
		const answer = await legacy.dispatch({
			jsonrpc: '2.0',
			id: 'legacy-progress',
			method: 'tools/call',
			params: { name: 'good', arguments: {}, _meta: { progressToken: 0 } },
		})
		if (!('next' in answer)) throw new Error('expected a controlled legacy progress stream')

		expect(await answer.next()).toEqual({
			done: false,
			value: {
				jsonrpc: '2.0',
				method: 'notifications/progress',
				params: { progressToken: 0, progress: 1, total: 1, message: 'complete' },
			},
		})
		expect(await answer.next()).toEqual({
			done: true,
			value: {
				jsonrpc: '2.0',
				id: 'legacy-progress',
				result: { content: [{ type: 'text', text: '5' }], structuredContent: 5 },
			},
		})
		expect(executions.value).toBe(1)
	})

	it('mirrors an empty-token call with no reports through the text face', async () => {
		const signal = new MCPFixtureCell<AbortSignal | undefined>(undefined)
		const legacy = createMCPLegacy(
			createMCPServer({
				identity: { name: 'progress', version: '1.0.0' },
				tools,
				execution: (context) => {
					signal.value = context.signal
					return context.tools.execute(context.call)
				},
			}),
		)
		const answer = await legacy.handle(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 'empty-token',
				method: 'tools/call',
				params: { name: 'good', arguments: {}, _meta: { progressToken: '' } },
			}),
		)
		if (answer === undefined || typeof answer === 'string') {
			throw new Error('expected a controlled legacy text stream')
		}

		expect(await answer.next()).toEqual({
			done: true,
			value:
				'{"jsonrpc":"2.0","id":"empty-token","result":{"content":[{"type":"text","text":"5"}],"structuredContent":5}}',
		})
		expect(signal.value?.aborted).toBe(true)
	})

	it('projects a native tool error result at the tokened terminal', async () => {
		const legacy = createMCPLegacy(
			createMCPServer({
				identity: { name: 'progress', version: '1.0.0' },
				tools,
				execution: (context) => context.tools.execute(context.call),
			}),
		)
		const answer = await legacy.dispatch({
			jsonrpc: '2.0',
			id: 'native-error',
			method: 'tools/call',
			params: { name: 'failure', _meta: { progressToken: 'native-error' } },
		})
		if (!('next' in answer)) throw new Error('expected a controlled legacy progress stream')

		expect(await answer.next()).toEqual({
			done: true,
			value: {
				jsonrpc: '2.0',
				id: 'native-error',
				result: { content: [{ type: 'text', text: 'frozen failure' }], isError: true },
			},
		})
	})

	it('keeps a stopped tokened call isolated from its live sibling', async () => {
		const executions: JSONRPCId[] = []
		const legacy = createMCPLegacy(
			createMCPServer({
				identity: { name: 'progress', version: '1.0.0' },
				tools,
				execution: async (context) => {
					executions.push(context.request.id)
					if (context.progress === undefined) throw new Error('expected a progress reporter')
					await context.progress.report({ progress: 1 })
					return context.tools.execute(context.call)
				},
			}),
		)
		const [stopped, live] = await Promise.all([
			legacy.dispatch({
				jsonrpc: '2.0',
				id: 'stopped',
				method: 'tools/call',
				params: { name: 'good', _meta: { progressToken: 'stopped' } },
			}),
			legacy.dispatch({
				jsonrpc: '2.0',
				id: 'live',
				method: 'tools/call',
				params: { name: 'good', _meta: { progressToken: 'live' } },
			}),
		])
		if (!('next' in stopped) || !('next' in live)) {
			throw new Error('expected independent controlled legacy progress streams')
		}

		stopped.stop()
		await expect(stopped.next()).rejects.toBeInstanceOf(DOMException)
		expect(await live.next()).toMatchObject({
			done: false,
			value: { method: 'notifications/progress', params: { progressToken: 'live' } },
		})
		expect(await live.next()).toMatchObject({
			done: true,
			value: { id: 'live', result: { structuredContent: 5 } },
		})
		expect(executions).toEqual(['live'])
	})

	it('does not execute when the caller aborts before the first read', async () => {
		const controller = new AbortController()
		const executions = new MCPFixtureCell(0)
		const legacy = createMCPLegacy(
			createMCPServer({
				identity: { name: 'progress', version: '1.0.0' },
				tools,
				execution: (context) => {
					executions.value += 1
					return context.tools.execute(context.call)
				},
			}),
		)
		const answer = await legacy.dispatch(
			{
				jsonrpc: '2.0',
				id: 'pre-abort',
				method: 'tools/call',
				params: { name: 'good', _meta: { progressToken: 'pre-abort' } },
			},
			{ signal: controller.signal },
		)
		if (!('next' in answer)) throw new Error('expected a controlled legacy progress stream')
		const failure = new Error('caller left before reading')

		controller.abort(failure)

		await expect(answer.next()).rejects.toBe(failure)
		expect(executions.value).toBe(0)
	})

	it('aborts an executor immediately during an outstanding read', async () => {
		const controller = new AbortController()
		const started = Promise.withResolvers<AbortSignal>()
		const legacy = createMCPLegacy(
			createMCPServer({
				identity: { name: 'progress', version: '1.0.0' },
				tools,
				execution: async (context) => {
					started.resolve(context.signal)
					if (!context.signal.aborted) {
						await new Promise<void>((resolve) =>
							context.signal.addEventListener('abort', () => resolve(), { once: true }),
						)
					}
					return context.tools.execute(context.call)
				},
			}),
		)
		const answer = await legacy.dispatch(
			{
				jsonrpc: '2.0',
				id: 'parked-abort',
				method: 'tools/call',
				params: { name: 'good', _meta: { progressToken: 'parked-abort' } },
			},
			{ signal: controller.signal },
		)
		if (!('next' in answer)) throw new Error('expected a controlled legacy progress stream')
		const reading = answer.next()
		const signal = await waitForSettlement(started.promise)
		const failure = new Error('caller left during execution')

		controller.abort(failure)

		await expect(waitForSettlement(reading)).rejects.toBe(failure)
		expect(signal.aborted).toBe(true)
	})

	it('propagates return through a parked tokened request', async () => {
		const started = Promise.withResolvers<AbortSignal>()
		const legacy = createMCPLegacy(
			createMCPServer({
				identity: { name: 'progress', version: '1.0.0' },
				tools,
				execution: async (context) => {
					started.resolve(context.signal)
					if (!context.signal.aborted) {
						await new Promise<void>((resolve) =>
							context.signal.addEventListener('abort', () => resolve(), { once: true }),
						)
					}
					return context.tools.execute(context.call)
				},
			}),
		)
		const answer = await legacy.dispatch({
			jsonrpc: '2.0',
			id: 'returned',
			method: 'tools/call',
			params: { name: 'good', _meta: { progressToken: 'returned' } },
		})
		if (!('next' in answer)) throw new Error('expected a controlled legacy progress stream')
		const reading = answer.next()
		const signal = await waitForSettlement(started.promise)
		const terminal = buildJSONRPCResult('returned', { consumer: true })

		expect(await answer.return(terminal)).toEqual({ done: true, value: terminal })
		expect(await waitForSettlement(reading)).toEqual({ done: true, value: terminal })
		expect(signal.aborted).toBe(true)
	})

	it.each(['stop', 'dispose'])(
		'aborts the source request when %s ends the adapter before its first read',
		async (closure) => {
			const signals: AbortSignal[] = []
			const server = createMCPServer({
				identity: { name: 'stream', version: '1.0.0' },
				tools,
			})
			server.methods.add('tools/call', async (request, options) => {
				signals.push(options.signal)
				return createUnreachableStream(request.id)
			})
			const answer = await createMCPLegacy(server).dispatch({
				jsonrpc: '2.0',
				id: closure,
				method: 'tools/call',
				params: { name: 'good', _meta: { progressToken: closure } },
			})
			if (!('next' in answer)) throw new Error('expected a controlled legacy progress stream')

			if (closure === 'stop') answer.stop()
			else await answer[Symbol.asyncDispose]()

			expect(signals[0]?.aborted).toBe(true)
			await expect(answer.next()).rejects.toBeInstanceOf(DOMException)
		},
	)

	it('rejects a mismatched progress frame without yielding it', async () => {
		const signal = new MCPFixtureCell<AbortSignal | undefined>(undefined)
		const server = createMCPServer({
			identity: { name: 'stream', version: '1.0.0' },
			tools,
		})
		server.methods.add('tools/call', async (request, options) => {
			signal.value = options.signal
			return createUnreachableStream(request.id)
		})
		const answer = await createMCPLegacy(server).dispatch({
			jsonrpc: '2.0',
			id: 'mismatch',
			method: 'tools/call',
			params: { name: 'good', _meta: { progressToken: 'expected-request' } },
		})
		if (!('next' in answer)) throw new Error('expected a controlled legacy progress stream')

		expect(await answer.next()).toEqual({
			done: true,
			value: {
				jsonrpc: '2.0',
				id: 'mismatch',
				error: {
					code: JSONRPC_SERVER_ERROR,
					message: 'Legacy protocol 2025-11-25 cannot represent a stream result',
				},
			},
		})
		expect(signal.value?.aborted).toBe(true)
	})

	it('rejects and disposes override streams without a legitimate tools/call token', async () => {
		const signals: AbortSignal[] = []
		const server = createMCPServer({
			identity: { name: 'stream', version: '1.0.0' },
			tools,
		})
		server.methods.add('tools/list', async (request, options) => {
			signals.push(options.signal)
			return createUnreachableStream(request.id)
		})
		server.methods.add('tools/call', async (request, options) => {
			signals.push(options.signal)
			return createUnreachableStream(request.id)
		})
		const legacy = createMCPLegacy(server)
		const list = await legacy.dispatch({
			jsonrpc: '2.0',
			id: 'list-stream',
			method: 'tools/list',
			params: { _meta: { progressToken: 'irrelevant' } },
		})
		const call = await legacy.dispatch({
			jsonrpc: '2.0',
			id: 'call-stream',
			method: 'tools/call',
			params: { name: 'good' },
		})
		if (Symbol.asyncIterator in list || Symbol.asyncIterator in call) {
			throw new Error('expected unsupported override streams to be closed')
		}

		expect([list.error?.code, call.error?.code]).toEqual([
			JSONRPC_SERVER_ERROR,
			JSONRPC_SERVER_ERROR,
		])
		expect(signals.map((entry) => entry.aborted)).toEqual([true, true])
	})

	it('forwards the inner dispatcher emitter as the one shared error feed', () => {
		const server = createMCPServer({
			identity: { name: 'emitter', version: '1.0.0' },
			tools: createToolManager(),
		})

		expect(createMCPLegacy(server).emitter).toBe(server.emitter)
	})

	it('refuses a deployment-selected task at the legacy revision boundary', async () => {
		const registry = createToolManager()
		registry.add(createTool({ name: 'good', execute: () => 5 }))
		const tasks = new TestTaskManager()
		const legacy = createMCPLegacy(
			createMCPServer({
				identity: { name: 'task', version: '1.0.0' },
				tools: registry,
				task: { tasks, deferral: () => 'legacy-task' },
			}),
		)

		const answer = await legacy.dispatch({
			jsonrpc: '2.0',
			id: 'task',
			method: 'tools/call',
			params: { name: 'good', arguments: {} },
		})

		expect(answer).toEqual({
			jsonrpc: '2.0',
			id: 'task',
			error: {
				code: JSONRPC_SERVER_ERROR,
				message: 'Legacy protocol 2025-11-25 cannot represent a task result',
			},
		})
		expect(tasks.starts).toEqual([])
	})

	it('refuses input-required at the legacy revision boundary', async () => {
		const registry = createToolManager()
		registry.add(createTool({ name: 'good', execute: () => 5 }))
		const legacy = createMCPLegacy(
			createMCPServer({
				identity: { name: 'input', version: '1.0.0' },
				tools: registry,
				input: {
					continuation: {
						seal: (value) => Promise.resolve(value),
						open: (value) => Promise.resolve(value),
					},
					ttl: 1000,
					principal: () => 'operator',
					// The round is never ISSUED on this path. `legacyInvocationToModern` stamps an
					// empty capability declaration, the modern gate refuses every kind against it,
					// and the legacy layer projects that refusal. So the round only has to be a
					// legal one — nothing here is sent, sealed, or answered.
					selector: () => ({ requests: { approval: { method: 'roots/list' } } }),
				},
			}),
		)

		expect(
			await legacy.dispatch({
				jsonrpc: '2.0',
				id: 'input',
				method: 'tools/call',
				params: { name: 'good', arguments: {} },
			}),
		).toEqual({
			jsonrpc: '2.0',
			id: 'input',
			error: {
				code: JSONRPC_SERVER_ERROR,
				message: 'Legacy protocol 2025-11-25 cannot represent an input-required result',
			},
		})
	})

	it('returns -32602 from the explicit legacy MRTR door guard', async () => {
		expect(
			await dispatcher.dispatch({
				jsonrpc: '2.0',
				id: 'continuation',
				method: 'tools/call',
				params: { name: 'good', requestState: 'foreign', inputResponses: {} },
			}),
		).toEqual({
			jsonrpc: '2.0',
			id: 'continuation',
			error: {
				code: JSONRPC_INVALID_PARAMS,
				message: 'Invalid params: legacy requests cannot continue an input-required result',
			},
		})
	})

	it.each([
		'tasks/get',
		'tasks/update',
		'tasks/cancel',
		'subscriptions/listen',
		'server/discover',
		'resources/list',
		'resources/read',
		'resources/templates/list',
		'prompts/list',
		'prompts/get',
		'completion/complete',
	])('refuses %s at the fixed legacy door', async (method) => {
		const registry = createToolManager()
		const server = createMCPServer({
			identity: { name: 'modern', version: '1.0.0' },
			tools: registry,
			resources: {
				resources: () => ({ resources: [] }),
				resource: () => [],
				templates: () => ({ resourceTemplates: [] }),
			},
			prompts: {
				prompts: () => ({ prompts: [] }),
				prompt: () => ({ resultType: 'complete', messages: [] }),
			},
			completion: { complete: () => ({ values: [] }) },
		})

		expect(await createMCPLegacy(server).dispatch({ jsonrpc: '2.0', id: method, method })).toEqual({
			jsonrpc: '2.0',
			id: method,
			error: { code: JSONRPC_METHOD_NOT_FOUND, message: `Method not found: ${method}` },
		})
	})

	it('keeps a consumer-registered stream unreachable from the legacy door', async () => {
		const registry = createToolManager()
		const server = createMCPServer({
			identity: { name: 'stream', version: '1.0.0' },
			tools: registry,
		})
		server.methods.add('consumer/stream', async (request) => createUnreachableStream(request.id))
		const legacy = createMCPLegacy(server)

		expect(
			await legacy.dispatch({ jsonrpc: '2.0', id: 'stream', method: 'consumer/stream' }),
		).toEqual({
			jsonrpc: '2.0',
			id: 'stream',
			error: {
				code: JSONRPC_METHOD_NOT_FOUND,
				message: 'Method not found: consumer/stream',
			},
		})
	})

	it('forwards a modern consumer method through the decorator', async () => {
		const registry = createToolManager()
		const server = createMCPServer({
			identity: { name: 'modern', version: '1.0.0' },
			tools: registry,
		})
		server.methods.add('consumer/result', async (request) =>
			buildJSONRPCResult(request.id, { resultType: 'complete', value: 1 }),
		)

		expect(
			await createMCPLegacy(server).dispatch({
				jsonrpc: '2.0',
				id: 'modern',
				method: 'consumer/result',
				params: {
					_meta: {
						[MCP_META_VERSION]: MCP_MODERN_VERSION,
						[MCP_META_CAPABILITIES]: {},
					},
				},
			}),
		).toEqual({ jsonrpc: '2.0', id: 'modern', result: { resultType: 'complete', value: 1 } })
	})
})
