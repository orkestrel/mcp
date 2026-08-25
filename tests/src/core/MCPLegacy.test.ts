import type {
	JSONRPCId,
	JSONRPCInvocation,
	JSONRPCResponse,
	MCPStream,
	MCPStreamControllerInterface,
} from '@src/core'
import { createTool, createToolManager } from '@orkestrel/tool'
import {
	buildJSONRPCResult,
	createMCPLegacy,
	createMCPServer,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_METHOD_NOT_FOUND,
	JSONRPC_SERVER_ERROR,
	MCP_META_CAPABILITIES,
	MCP_META_VERSION,
	MCP_MODERN_VERSION,
} from '@src/core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
	createCalculatorServer,
	createJSONRPCNotification,
	createJSONRPCRequest,
	MemoryResourceManager,
	TestTaskManager,
} from '../../setup.js'

// Captured before the W07-A production edit; divergences remain explicit named rows.

const tools = createToolManager()
tools.add(createTool({ name: 'good', execute: () => 5 }))
tools.add(createTool({ name: 'missing', execute: () => undefined }))
tools.add(createTool({ name: 'nan', execute: () => Number.NaN }))
tools.add(
	createTool({
		name: 'failure',
		execute: () => {
			throw new Error('frozen failure')
		},
	}),
)
tools.add(createTool({ name: 'oversized', execute: () => 'x'.repeat(256) }))

const descriptors = [
	{ name: 'good', inputSchema: { type: 'object' } },
	{ name: 'missing', inputSchema: { type: 'object' } },
	{ name: 'nan', inputSchema: { type: 'object' } },
	{ name: 'failure', inputSchema: { type: 'object' } },
	{ name: 'oversized', inputSchema: { type: 'object' } },
]

const dispatcher = createMCPLegacy(
	createMCPServer({
		identity: { name: 'freeze', version: '1.0.0' },
		tools,
		limit: { message: 1024, content: 128 },
	}),
)

const malformedId: JSONRPCId = JSON.parse('null')

const cases: ReadonlyArray<readonly [string, JSONRPCInvocation, JSONRPCResponse | undefined]> = [
	[
		'initialize-default',
		{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
		{
			jsonrpc: '2.0',
			id: 1,
			result: {
				protocolVersion: '2025-11-25',
				capabilities: { tools: {} },
				serverInfo: { name: 'freeze', version: '1.0.0' },
			},
		},
	],
	[
		'initialize-legacy-anchor',
		{ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
		{
			jsonrpc: '2.0',
			id: 2,
			result: {
				protocolVersion: '2025-06-18',
				capabilities: { tools: {} },
				serverInfo: { name: 'freeze', version: '1.0.0' },
			},
		},
	],
	[
		'initialize-newest-legacy',
		{ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
		{
			jsonrpc: '2.0',
			id: 3,
			result: {
				protocolVersion: '2025-11-25',
				capabilities: { tools: {} },
				serverInfo: { name: 'freeze', version: '1.0.0' },
			},
		},
	],
	[
		'initialize-modern-requested',
		{ jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '2026-07-28' } },
		{
			jsonrpc: '2.0',
			id: 4,
			result: {
				protocolVersion: '2025-11-25',
				capabilities: { tools: {} },
				serverInfo: { name: 'freeze', version: '1.0.0' },
			},
		},
	],
	[
		'initialize-missing-params',
		{ jsonrpc: '2.0', id: 5, method: 'initialize' },
		{
			jsonrpc: '2.0',
			id: 5,
			result: {
				protocolVersion: '2025-11-25',
				capabilities: { tools: {} },
				serverInfo: { name: 'freeze', version: '1.0.0' },
			},
		},
	],
	['ping-empty', { jsonrpc: '2.0', id: 6, method: 'ping' }, { jsonrpc: '2.0', id: 6, result: {} }],
	[
		'ping-params',
		{ jsonrpc: '2.0', id: 7, method: 'ping', params: { extra: true } },
		{ jsonrpc: '2.0', id: 7, result: {} },
	],
	[
		'ping-string-id',
		{ jsonrpc: '2.0', id: 'ping', method: 'ping' },
		{ jsonrpc: '2.0', id: 'ping', result: {} },
	],
	[
		'tools-list-empty',
		{ jsonrpc: '2.0', id: 9, method: 'tools/list' },
		{ jsonrpc: '2.0', id: 9, result: { tools: descriptors } },
	],
	[
		'tools-list-params',
		{ jsonrpc: '2.0', id: 10, method: 'tools/list', params: { cursor: 'ignored' } },
		{ jsonrpc: '2.0', id: 10, result: { tools: descriptors } },
	],
	[
		'tools-call-good',
		{ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'good', arguments: {} } },
		{
			jsonrpc: '2.0',
			id: 11,
			result: { content: [{ type: 'text', text: '5' }], structuredContent: 5 },
		},
	],
	[
		'tools-call-no-arguments',
		{ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'good' } },
		{
			jsonrpc: '2.0',
			id: 12,
			result: { content: [{ type: 'text', text: '5' }], structuredContent: 5 },
		},
	],
	[
		'tools-call-missing-value',
		{ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'missing', arguments: {} } },
		{ jsonrpc: '2.0', id: 13, result: { content: [{ type: 'text', text: '' }] } },
	],
	[
		'tools-call-nan',
		{ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'nan', arguments: {} } },
		{
			jsonrpc: '2.0',
			id: 14,
			error: { code: -32603, message: 'Server execution returned an invalid tool result' },
		},
	],
	[
		'tools-call-failure',
		{ jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'failure', arguments: {} } },
		{
			jsonrpc: '2.0',
			id: 15,
			result: { content: [{ type: 'text', text: 'frozen failure' }], isError: true },
		},
	],
	[
		'tools-call-unknown-tool',
		{ jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'absent', arguments: {} } },
		{
			jsonrpc: '2.0',
			id: 16,
			result: { content: [{ type: 'text', text: 'tool not found: absent' }], isError: true },
		},
	],
	[
		'tools-call-missing-name',
		{ jsonrpc: '2.0', id: 17, method: 'tools/call', params: { arguments: {} } },
		{
			jsonrpc: '2.0',
			id: 17,
			error: { code: -32602, message: 'Invalid params: a string `name` is required' },
		},
	],
	[
		'tools-call-nonstring-name',
		{ jsonrpc: '2.0', id: 18, method: 'tools/call', params: { name: 4, arguments: {} } },
		{
			jsonrpc: '2.0',
			id: 18,
			error: { code: -32602, message: 'Invalid params: a string `name` is required' },
		},
	],
	[
		'tools-call-null-arguments',
		{ jsonrpc: '2.0', id: 19, method: 'tools/call', params: { name: 'good', arguments: null } },
		{
			jsonrpc: '2.0',
			id: 19,
			error: {
				code: -32602,
				message: 'Invalid params: `arguments` must be an object when present',
			},
		},
	],
	[
		'tools-call-oversized-value',
		{ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'oversized', arguments: {} } },
		{
			jsonrpc: '2.0',
			id: 20,
			error: { code: -32603, message: 'Server execution returned an invalid tool result' },
		},
	],
	[
		'unknown-method',
		{ jsonrpc: '2.0', id: 21, method: 'unknown/method' },
		{
			jsonrpc: '2.0',
			id: 21,
			error: { code: -32601, message: 'Method not found: unknown/method' },
		},
	],
	[
		'malformed-null-id',
		{ jsonrpc: '2.0', id: malformedId, method: 'ping' },
		{ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } },
	],
	[
		'malformed-fractional-id',
		{ jsonrpc: '2.0', id: 2.5, method: 'ping' },
		{ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } },
	],
	[
		'oversized-message',
		{ jsonrpc: '2.0', id: 24, method: 'ping', params: { text: 'x'.repeat(2048) } },
		{ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } },
	],
	['initialized-notification', { jsonrpc: '2.0', method: 'notifications/initialized' }, undefined],
]

async function* createUnreachableStream(id: JSONRPCId): MCPStream {
	yield { jsonrpc: '2.0', method: 'notifications/tools/list_changed' }
	return buildJSONRPCResult(id, { resultType: 'complete' })
}

describe('legacy dispatch behavior freeze', () => {
	it.each(cases)('%s', async (_name, request, output) => {
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
				task: { tasks, defer: () => 'legacy-task' },
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
					elicit: () => ({
						request: {
							message: 'Approve?',
							requestedSchema: { type: 'object', properties: {} },
						},
					}),
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
