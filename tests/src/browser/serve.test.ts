import type { ServeMCPScopeInterface } from '@src/browser'
import type { ToolManagerInterface } from '@orkestrel/agent'
import { describe, expect, it, vi } from 'vitest'
import { createTool, createToolManager } from '@orkestrel/agent'
import { serveMCPScope } from '@src/browser'
import { createJSONRPCRequest } from '../../setup.js'

// serveMCPScope (`src/browser/serve.ts`) — the exported, scope-parameterized core
// `serveMCP` wraps over `globalThis`. Driven here with SCOPE DOUBLES (AGENTS §16 — a
// real object satisfying `ServeMCPScopeInterface`'s structural shape, not a mock of
// this package's own code) covering BOTH shapes the unified design serves: a
// dedicated-worker-shaped double (implicit portless channel) and a
// Service-Worker-shaped double (message events carrying a real `MessagePort`, built
// from a real `new MessageChannel()`). Raw JSON-RPC request/response strings (as
// `tests/src/core/helpers.test.ts` uses for `bindServer`) prove the wiring without
// needing a full `MCPClient` for every scenario.

/** A double satisfying `ServeMCPScopeInterface` — records every `postMessage`, lets a
 * test dispatch a real `MessageEvent` (portless or port-bearing) into the ONE
 * currently-registered `message` listener, and exposes whether that listener is
 * still attached (for the dispose / listener-removal assertions). */
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

describe('serveMCPScope — dedicated-worker-shaped scope (implicit, portless channel)', () => {
	it('a portless string-data message round-trips through the implicit scope channel', async () => {
		const double = createScopeDouble()
		const dispose = serveMCPScope(double.scope, { tools: createCalculatorTools() })

		double.dispatch({ data: JSON.stringify(createJSONRPCRequest({ method: 'tools/list', id: 1 })) })

		await vi.waitFor(() => expect(double.sent).toHaveLength(1))
		const reply: { result: { tools: readonly { name: string }[] } } = JSON.parse(
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
		port2.postMessage(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 1 })))

		await vi.waitFor(() => expect(replies).toHaveLength(1))
		expect(JSON.parse(String(replies[0]))).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
		// The portless implicit channel received nothing from this port-bearing exchange.
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
				createJSONRPCRequest({ method: 'tools/call', id: 1, params: { name: 'add' } }),
			),
		)

		await vi.waitFor(() => expect(replies).toHaveLength(1))
		const reply: { result: { content: readonly { text: string }[] } } = JSON.parse(
			String(replies[0]),
		)
		expect(reply.result.content[0]?.text).toBe('null')

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

		channelA.port2.postMessage(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 1 })))

		await vi.waitFor(() => expect(repliesA).toHaveLength(1))
		// Give B's port a real chance to (wrongly) receive A's reply before asserting isolation.
		await new Promise((resolve) => setTimeout(resolve, 30))
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
		port2.postMessage(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 1 })))
		await vi.waitFor(() => expect(replies).toHaveLength(1))

		dispose()
		port2.postMessage(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 2 })))
		await new Promise((resolve) => setTimeout(resolve, 30))

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

		double.dispatch({ ports: [port1] }) // no listener left to receive this — a no-op
		port2.postMessage(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 1 })))
		await new Promise((resolve) => setTimeout(resolve, 30))

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
		port2.postMessage(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 1 })))
		await new Promise((resolve) => setTimeout(resolve, 30))

		// No binding was created — nothing replies.
		expect(replies).toEqual([])

		dispose()
	})

	it('accept filtering by event.data token: only a matching token gets bound', async () => {
		// Simulates a handshake-token gate: only events where event.data is 'allow' get bound.
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

		// The denied port carries no matching token — should be rejected.
		double.dispatch({ data: 'deny', ports: [denied.port1] })
		// The allowed port carries the expected token — should be bound.
		double.dispatch({ data: 'allow', ports: [allowed.port1] })

		allowed.port2.postMessage(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 1 })))
		await vi.waitFor(() => expect(allowedReplies).toHaveLength(1))

		// The allowed port got its reply.
		expect(JSON.parse(String(allowedReplies[0]))).toEqual({ jsonrpc: '2.0', id: 1, result: {} })

		// The denied port got nothing — binding was rejected.
		denied.port2.postMessage(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 2 })))
		await new Promise((resolve) => setTimeout(resolve, 30))
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

		// Issue a request, then immediately dispose before any reply can arrive.
		port2.postMessage(
			JSON.stringify(
				createJSONRPCRequest({ method: 'tools/call', id: 1, params: { name: 'add' } }),
			),
		)
		dispose()

		// Wait a generous tick — any in-flight processing either completed a clean in-flight
		// reply before dispose, or was torn down and produced nothing. Either is acceptable;
		// what is NOT acceptable is an unhandled rejection (would fail the test runner) or a
		// reply AFTER dispose triggered by a second message.
		await new Promise((resolve) => setTimeout(resolve, 50))

		const replyCount = replies.length
		// Attempt a second message after dispose — must produce no additional reply.
		port2.postMessage(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 2 })))
		await new Promise((resolve) => setTimeout(resolve, 30))

		expect(replies.length).toBe(replyCount) // pinned: no reply after dispose
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

		// Deliver the same MessagePort in two separate message events.
		double.dispatch({ ports: [port1] })
		double.dispatch({ ports: [port1] }) // duplicate — must be ignored

		port2.postMessage(JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 1 })))
		await vi.waitFor(() => expect(replies).toHaveLength(1))

		// Exactly ONE reply — a duplicate binding would produce two replies.
		expect(replies).toHaveLength(1)
		expect(JSON.parse(String(replies[0]))).toEqual({ jsonrpc: '2.0', id: 1, result: {} })

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
		// Reaching the assertion below (no unhandled throw failing the run) is part of the proof.
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
					params: { name: 'add', arguments: { x: oversized } },
				}),
			),
		)

		await vi.waitFor(() => expect(replies).toHaveLength(1))
		const reply: { result: { content: readonly { text: string }[] } } = JSON.parse(
			String(replies[0]),
		)
		expect(reply.result.content[0]?.text).toBe('null')

		dispose()
	})

	it('an object payload on a portless event is ignored — no reply, no crash', async () => {
		const double = createScopeDouble()
		const dispose = serveMCPScope(double.scope, { tools: createCalculatorTools() })

		double.dispatch({ data: { not: 'a string' } })
		double.dispatch({ data: JSON.stringify(createJSONRPCRequest({ method: 'ping', id: 1 })) })

		await vi.waitFor(() => expect(double.sent).toHaveLength(1))
		expect(JSON.parse(String(double.sent[0]))).toEqual({ jsonrpc: '2.0', id: 1, result: {} })

		dispose()
	})
})
