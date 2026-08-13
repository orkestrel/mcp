import type { ServeMCPScopeInterface } from '@src/browser'
import type { ToolManagerInterface } from '@orkestrel/tool'
import { describe, expect, it, vi } from 'vitest'
import { MCP_META_SERVER } from '@src/core'
import { DEFAULT_MCP_SERVER_NAME, DEFAULT_MCP_SERVER_VERSION, serveMCPScope } from '@src/browser'
import { createTool, createToolManager } from '@orkestrel/tool'
import { waitForDelay } from '@orkestrel/test'
import { createJSONRPCRequest, MODERN_METADATA, modernRequest } from '../../setup.js'

// serveMCPScope (`src/browser/helpers.ts`) — the exported, scope-parameterized core
// `serveMCP` wraps over `globalThis`. Driven here with SCOPE DOUBLES (AGENTS §16 — a
// real object satisfying `ServeMCPScopeInterface`'s structural shape, not a mock of
// this package's own code) covering BOTH shapes the unified design serves: a
// dedicated-worker-shaped double (implicit portless channel) and a
// Service-Worker-shaped double (message events carrying a real `MessagePort`, built
// from a real `new MessageChannel()`). Raw JSON-RPC request/response strings prove the
// wiring without needing a full `MCPClient` for every scenario.

interface ScopeDoubleInterface {
	readonly scope: ServeMCPScopeInterface
	readonly sent: readonly unknown[]
	readonly listenerCount: number
	dispatch(init: { data?: unknown; ports?: readonly MessagePort[] }): void
}

function createScopeDouble(): ScopeDoubleInterface {
	const sent: unknown[] = []
	const listeners = new Set<(event: MessageEvent) => void>()
	const scope: ServeMCPScopeInterface = {
		postMessage(message: unknown): void {
			sent.push(message)
		},
		addEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
			listeners.add(listener)
		},
		removeEventListener(_type: 'message', listener: (event: MessageEvent) => void): void {
			listeners.delete(listener)
		},
	}
	return {
		scope,
		get sent() {
			return sent
		},
		get listenerCount() {
			return listeners.size
		},
		dispatch(init) {
			const ports = init.ports === undefined ? [] : [...init.ports]
			const event = new MessageEvent('message', { data: init.data, ports })
			for (const listener of listeners) listener(event)
		},
	}
}

function createCalculatorTools(): ToolManagerInterface {
	const tools = createToolManager()
	tools.add(createTool({ name: 'add', execute: (a) => Number(a['x']) + Number(a['y']) }))
	return tools
}

// The scope double hosts a bare modern server. Use `modernRequest` because a version-less
// `createJSONRPCRequest` is correctly rejected by that server with JSON-RPC -32602.
function expectModernReply(message: unknown, id: number): void {
	expect(JSON.parse(String(message))).toEqual({
		jsonrpc: '2.0',
		id,
		result: {
			resultType: 'complete',
			_meta: {
				[MCP_META_SERVER]: {
					name: DEFAULT_MCP_SERVER_NAME,
					version: DEFAULT_MCP_SERVER_VERSION,
				},
			},
		},
	})
}

describe('serveMCPScope — dedicated-worker-shaped scope (implicit, portless channel)', () => {
	it('a portless string-data message round-trips through the implicit scope channel', async () => {
		const double = createScopeDouble()
		const dispose = serveMCPScope(double.scope, { tools: createCalculatorTools() })

		double.dispatch({ data: JSON.stringify(modernRequest('tools/list')) })

		await vi.waitFor(() => expect(double.sent).toHaveLength(1))
		const reply: { result: { tools: ReadonlyArray<{ name: string }> } } = JSON.parse(
			String(double.sent[0]),
		)
		expect(reply.result.tools.map((tool) => tool.name)).toEqual(['add'])

		dispose()
	})

	it('an event with a port on a dedicated-worker-shaped double STILL spawns a per-port binding (cross-case)', async () => {
		const double = createScopeDouble()
		const dispose = serveMCPScope(double.scope, { tools: createCalculatorTools() })
		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()

		double.dispatch({ ports: [port1] })
		port2.postMessage(JSON.stringify(modernRequest('ping')))

		await vi.waitFor(() => expect(replies).toHaveLength(1))
		expectModernReply(replies[0], 1)
		expect(double.sent).toEqual([])

		dispose()
	})
})

describe('serveMCPScope — Service-Worker-shaped scope (per-client MessagePort, no implicit postMessage)', () => {
	it('a message event carrying a port spawns a per-port binding; the client round-trips over it', async () => {
		const double = createScopeDouble()
		const dispose = serveMCPScope(double.scope, { tools: createCalculatorTools() })
		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()

		double.dispatch({ ports: [port1] })
		port2.postMessage(
			JSON.stringify(
				createJSONRPCRequest({
					method: 'tools/call',
					id: 1,
					params: { name: 'add', arguments: {}, _meta: MODERN_METADATA },
				}),
			),
		)

		await vi.waitFor(() => expect(replies).toHaveLength(1))
		const reply: { error: { code: number } } = JSON.parse(String(replies[0]))
		expect(reply.error.code).toBe(-32603)

		dispose()
	})

	it('two connecting clients (two channels) get ISOLATED sessions — a call on one never replies on the other', async () => {
		const double = createScopeDouble()
		const dispose = serveMCPScope(double.scope, { tools: createCalculatorTools() })
		const channelA = new MessageChannel()
		const channelB = new MessageChannel()
		const repliesA: unknown[] = []
		const repliesB: unknown[] = []
		channelA.port2.addEventListener('message', (event: MessageEvent) => repliesA.push(event.data))
		channelB.port2.addEventListener('message', (event: MessageEvent) => repliesB.push(event.data))
		channelA.port2.start()
		channelB.port2.start()

		double.dispatch({ ports: [channelA.port1] })
		double.dispatch({ ports: [channelB.port1] })
		channelA.port2.postMessage(JSON.stringify(modernRequest('ping')))

		await vi.waitFor(() => expect(repliesA).toHaveLength(1))
		await waitForDelay(30)
		expect(repliesB).toEqual([])

		dispose()
	})
})

describe('serveMCPScope — dispose', () => {
	it('after dispose, a new request on an already-accepted port gets NO reply', async () => {
		const double = createScopeDouble()
		const dispose = serveMCPScope(double.scope, { tools: createCalculatorTools() })
		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()

		double.dispatch({ ports: [port1] })
		port2.postMessage(JSON.stringify(modernRequest('ping')))
		await vi.waitFor(() => expect(replies).toHaveLength(1))

		dispose()
		port2.postMessage(JSON.stringify(modernRequest('ping', 2)))
		await waitForDelay(30)

		expect(replies).toHaveLength(1)
	})

	it('after dispose, the scope listener is removed — a new port-carrying event binds nothing', async () => {
		const double = createScopeDouble()
		const dispose = serveMCPScope(double.scope, { tools: createCalculatorTools() })
		expect(double.listenerCount).toBe(1)

		dispose()
		expect(double.listenerCount).toBe(0)

		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()

		double.dispatch({ ports: [port1] })
		port2.postMessage(JSON.stringify(modernRequest('ping')))
		await waitForDelay(30)

		expect(replies).toEqual([])
	})

	it('a second dispose() is a no-op', async () => {
		const double = createScopeDouble()
		const dispose = serveMCPScope(double.scope, { tools: createCalculatorTools() })

		dispose()
		expect(() => dispose()).not.toThrow()
		expect(double.listenerCount).toBe(0)
	})
})

describe('serveMCPScope — accept option (A2)', () => {
	it('accept returning false drops the event: no binding, no reply', async () => {
		const double = createScopeDouble()
		const dispose = serveMCPScope(double.scope, {
			tools: createCalculatorTools(),
			accept: () => false,
		})
		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()

		double.dispatch({ ports: [port1] })
		port2.postMessage(JSON.stringify(modernRequest('ping')))
		await waitForDelay(30)

		expect(replies).toEqual([])
		dispose()
	})

	it('accept filtering by event.data token: only a matching token gets bound', async () => {
		const double = createScopeDouble()
		const dispose = serveMCPScope(double.scope, {
			tools: createCalculatorTools(),
			accept: (event) => event.data === 'allow',
		})
		const allowed = new MessageChannel()
		const denied = new MessageChannel()
		const allowedReplies: unknown[] = []
		const deniedReplies: unknown[] = []
		allowed.port2.addEventListener('message', (event: MessageEvent) =>
			allowedReplies.push(event.data),
		)
		denied.port2.addEventListener('message', (event: MessageEvent) =>
			deniedReplies.push(event.data),
		)
		allowed.port2.start()
		denied.port2.start()

		double.dispatch({ data: 'deny', ports: [denied.port1] })
		double.dispatch({ data: 'allow', ports: [allowed.port1] })
		allowed.port2.postMessage(JSON.stringify(modernRequest('ping')))
		await vi.waitFor(() => expect(allowedReplies).toHaveLength(1))

		expectModernReply(allowedReplies[0], 1)
		denied.port2.postMessage(JSON.stringify(modernRequest('ping', 2)))
		await waitForDelay(30)
		expect(deniedReplies).toEqual([])

		dispose()
	})
})

describe('serveMCPScope — dispose mid-flight (A5.2)', () => {
	it('dispose while a request is in flight: no unhandled rejection; no reply after dispose', async () => {
		const double = createScopeDouble()
		const dispose = serveMCPScope(double.scope, { tools: createCalculatorTools() })
		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()

		double.dispatch({ ports: [port1] })
		port2.postMessage(JSON.stringify(modernRequest('tools/call')))
		dispose()
		await waitForDelay(50)

		const replyCount = replies.length
		port2.postMessage(JSON.stringify(modernRequest('ping', 2)))
		await waitForDelay(30)

		expect(replies.length).toBe(replyCount)
	})
})

describe('serveMCPScope — double-port-delivery dedup (A5.3)', () => {
	it('the same port delivered twice is deduped: only one binding, only one reply per request', async () => {
		const double = createScopeDouble()
		const dispose = serveMCPScope(double.scope, { tools: createCalculatorTools() })
		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()

		double.dispatch({ ports: [port1] })
		double.dispatch({ ports: [port1] })
		port2.postMessage(JSON.stringify(modernRequest('ping')))
		await vi.waitFor(() => expect(replies).toHaveLength(1))

		expect(replies).toHaveLength(1)
		expectModernReply(replies[0], 1)
		dispose()
	})
})

describe('serveMCPScope — hostile inbound', () => {
	it('malformed JSON string on a bound port produces no unhandled throw (a -32700 reply)', async () => {
		const double = createScopeDouble()
		const dispose = serveMCPScope(double.scope, { tools: createCalculatorTools() })
		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()

		double.dispatch({ ports: [port1] })
		port2.postMessage('not valid json{{{')

		await vi.waitFor(() => expect(replies).toHaveLength(1))
		const reply: { error: { code: number } } = JSON.parse(String(replies[0]))
		expect(reply.error.code).toBe(-32700)

		dispose()
	})

	it('an oversized string on a bound port is handled without crashing', async () => {
		const double = createScopeDouble()
		const dispose = serveMCPScope(double.scope, { tools: createCalculatorTools() })
		const { port1, port2 } = new MessageChannel()
		const replies: unknown[] = []
		port2.addEventListener('message', (event: MessageEvent) => replies.push(event.data))
		port2.start()

		double.dispatch({ ports: [port1] })
		const oversized = 'x'.repeat(1_000_000)
		port2.postMessage(
			JSON.stringify(
				createJSONRPCRequest({
					method: 'tools/call',
					id: 1,
					params: { name: 'add', arguments: { x: oversized }, _meta: MODERN_METADATA },
				}),
			),
		)

		await vi.waitFor(() => expect(replies).toHaveLength(1))
		const reply: { error: { code: number } } = JSON.parse(String(replies[0]))
		expect(reply.error.code).toBe(-32603)

		dispose()
	})

	it('an object payload on a portless event is ignored — no reply, no crash', async () => {
		const double = createScopeDouble()
		const dispose = serveMCPScope(double.scope, { tools: createCalculatorTools() })

		double.dispatch({ data: { not: 'a string' } })
		double.dispatch({ data: JSON.stringify(modernRequest('ping')) })

		await vi.waitFor(() => expect(double.sent).toHaveLength(1))
		expectModernReply(double.sent[0], 1)

		dispose()
	})
})
