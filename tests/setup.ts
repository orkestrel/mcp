// General, environment-agnostic test helpers — no `node:*`, no `document`/`window`. Loaded by
// every test project (core, server, guides). Environment-specific harnesses live in
// `tests/setupServer.ts` (AGENTS §16.1).

import type { EmitterInterface, EventMap } from '@orkestrel/emitter'
import type { SSEEvent } from '@orkestrel/sse'
import type {
	ClientTransportEventMap,
	ClientTransportInterface,
	JSONRPCRequest,
	MCPServerInterface,
} from '@src/core'
import { createEmitter } from '@orkestrel/emitter'
import { createSSEParser } from '@orkestrel/sse'

// ── Call recorder (a real callback, not a mock) ──────────────────────────────
//
// AGENTS §16.1: when a test only needs to count calls or inspect arguments, use a
// recorder — a real listener that records every invocation — rather than a test-
// framework spy. `handler` is a genuine callback; `calls` is each invocation's
// argument tuple, in order.

/** A real call-recording callback over an argument tuple (AGENTS §16.1). */
export interface TestRecorderInterface<TArgs extends readonly unknown[]> {
	readonly calls: readonly TArgs[]
	readonly count: number
	readonly handler: (...args: TArgs) => void
	clear(): void
}

/**
 * Create a {@link TestRecorderInterface} — a real callback that records each
 * invocation's arguments, for asserting what fired and with what (AGENTS §16.1).
 *
 * @typeParam TArgs - The argument tuple the recorded handler receives
 * @returns A recorder whose `handler` records into `calls`
 */
export function createRecorder<TArgs extends readonly unknown[]>(): TestRecorderInterface<TArgs> {
	const calls: TArgs[] = []
	return {
		get calls() {
			return calls
		},
		get count() {
			return calls.length
		},
		handler(...args: TArgs) {
			calls.push(args)
		},
		clear() {
			calls.length = 0
		},
	}
}

/**
 * Create a recorder for an {@link import('@orkestrel/emitter').EmitterErrorHandler} — the
 * emitter's own listener-error channel (AGENTS §13): a `TestRecorderInterface<[error, event]>`
 * whose `handler` is wired as the `error` option, so an emit-safety test asserts a buggy
 * listener's throw was routed here (with the offending event name) instead of corrupting the
 * entity. Argument order is `(error, event)`, matching `EmitterErrorHandler`. A thin alias over
 * {@link createRecorder} (AGENTS §16.1).
 *
 * @returns A recorder of `[error: unknown, event: string]` calls
 */
export function createErrorRecorder(): TestRecorderInterface<
	readonly [error: unknown, event: string]
> {
	return createRecorder<readonly [error: unknown, event: string]>()
}

/** A {@link createRecorder} per listed event of an `EmitterInterface`, keyed by event name. */
export type EmitterRecorders<TMap extends EventMap, TName extends keyof TMap> = {
	readonly [K in TName]: TestRecorderInterface<TMap[K]>
}

/**
 * Narrow an accumulated `Partial<EmitterRecorders>` to its total mapped form once every
 * listed event has a recorder present — the §14 guard standing in for an assertion in
 * {@link recordEmitterEvents} (whose loop assigns one recorder per name, so this holds; the
 * explicit per-name presence check keeps the narrowing a sound guard, not a cast).
 *
 * @typeParam TMap - The emitter's {@link EventMap}
 * @typeParam TName - The subset of event names that must each have a recorder
 * @param recorders - The partially-accumulated recorder map to narrow
 * @param events - The event names that must all be present for the map to be total
 * @returns Whether every listed event has a recorder (narrowing `recorders` to total)
 */
export function isTotal<TMap extends EventMap, TName extends keyof TMap>(
	recorders: Partial<EmitterRecorders<TMap, TName>>,
	events: readonly TName[],
): recorders is EmitterRecorders<TMap, TName> {
	return events.every((name) => recorders[name] !== undefined)
}

/**
 * Wire one {@link createRecorder} onto `emitter` for each of the named events — the one
 * generic form of a per-entity `recordXEvents` bundle (AGENTS §16.1). Each recorder
 * subscribes via `emitter.on(name, recorder.handler)` and is returned keyed by its event
 * name, typed with that event's argument tuple — so a test asserts what fired
 * (`events.request.calls`) and with which payload.
 *
 * @typeParam TMap - The emitter's {@link EventMap}
 * @typeParam TName - The subset of event names to record (inferred from `events`)
 * @param emitter - The emitter to subscribe the recorders to
 * @param events - The event names to record (each becomes a key of the result)
 * @returns A recorder per name, each subscribed and keyed by event name
 */
export function recordEmitterEvents<TMap extends EventMap, TName extends keyof TMap>(
	emitter: EmitterInterface<TMap>,
	events: readonly TName[],
): EmitterRecorders<TMap, TName> {
	// Accumulate into a `Partial` of the exact mapped shape — every value keeps its precise
	// per-event tuple type, all keys optional until assigned. The dynamic key list is the
	// untyped edge: once every listed name is present we narrow `Partial` → total through a
	// guard, never an assertion (§14).
	const recorders: Partial<EmitterRecorders<TMap, TName>> = {}
	for (const name of events) {
		const recorder = createRecorder<TMap[typeof name]>()
		emitter.on(name, recorder.handler)
		recorders[name] = recorder
	}
	if (!isTotal(recorders, events)) {
		throw new Error('recordEmitterEvents: a recorder was not wired for every event')
	}
	return recorders
}

// ── Async wait (AGENTS §16.1) ─────────────────────────────────────────────────

/**
 * Resolve after `ms` milliseconds — the single shared delay helper (AGENTS §16.1), for
 * letting a real short timer elapse instead of inlining a `setTimeout` promise per test.
 *
 * @param ms - Milliseconds to wait; defaults to `0` (a macrotask turn)
 * @returns A promise that resolves once the delay elapses
 */
export function waitForDelay(ms = 0): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── JSON-RPC message factory (MCP request shape) ─────────────────────────────
//
// AGENTS §16.1: the well-formed JSON-RPC 2.0 request literal the MCP tests repeat
// (`{ jsonrpc: '2.0', method, id }`) folded into one builder with a sensible default plus
// per-call overrides, so a test names only the `method` / `id` / `params` its scenario
// varies. A real `JSONRPCRequest` (env-agnostic — only the `@src/core` type), NOT a mock
// of the transport.

/**
 * Build a well-formed {@link JSONRPCRequest} — the default `{ jsonrpc: '2.0', method:
 * 'initialize', id: 1 }` merged with per-call overrides (a different `method` / `id`, or a
 * `params` payload), so the MCP dispatch / transport tests name only the field that
 * matters instead of re-typing the envelope (AGENTS §16.1). Omitting `id` via overrides
 * (`{ id: undefined }`) yields a notification.
 *
 * @param overrides - Fields to override on the default request (`method` / `id` / `params`)
 * @returns The assembled JSON-RPC request
 */
export function createJSONRPCRequest(overrides?: Partial<JSONRPCRequest>): JSONRPCRequest {
	return { jsonrpc: '2.0', method: 'initialize', id: 1, ...overrides }
}

// ── In-process loopback MCP client transport (env-agnostic scenario builder) ─
//
// AGENTS §16.1: the `ClientTransportInterface` doc for `@src/core` names "the in-process
// loopback transport in the tests" as one of its concrete forms — this is that shared,
// general one. It dispatches straight to a REAL `MCPServerInterface` with no wire, no
// network — a real transport, not a mock (§16). A test needing gated / instrumented
// responses (withholding a reply to drive a timeout) still keeps its own bespoke variant
// local (AGENTS §16.1 — only a genuinely reusable form is centralized).

/**
 * Create an in-process {@link ClientTransportInterface} that dispatches directly against a
 * given {@link MCPServerInterface} — no wire, no network. Each `send` dispatches every
 * request in the batch through `mcp.dispatch` and emits each DEFINED response (a
 * notification produces none) on the `message` event, mirroring how a real transport
 * surfaces replies.
 *
 * @param mcp - The MCP server to dispatch requests against in-process
 * @returns A working {@link ClientTransportInterface} with no `session` (stateless)
 */
export function createLoopbackTransport(mcp: MCPServerInterface): ClientTransportInterface {
	const emitter = createEmitter<ClientTransportEventMap>()
	return {
		emitter,
		session: undefined,
		async start() {},
		async send(message) {
			const messages = Array.isArray(message) ? message : [message]
			for (const one of messages) {
				if (!('method' in one)) continue
				const response = await mcp.dispatch(one)
				if (response !== undefined) emitter.emit('message', response)
			}
		},
		async close() {
			emitter.emit('close')
		},
	}
}

// ── SSE response decoding (environment-agnostic) ─────────────────────────────
//
// The client side of the HTTP SSE seam: read a `fetch` Response's body stream, decode
// the bytes (`TextDecoder` for split multi-byte chars), and feed them to the
// `@orkestrel/sse` parser — so a test asserts the EXACT events the seam serialized,
// proving the encode ↔ decode round-trip. No `node:*` / DOM — web `Response` /
// `ReadableStream` / `TextDecoder` are global in both the node and the browser test
// runners (AGENTS §16.1).

/**
 * Drain a `fetch` Response's SSE body to completion, returning every dispatched
 * {@link SSEEvent} (decoded by `@orkestrel/sse`'s parser).
 *
 * @remarks
 * Reads the whole `response.body` stream, so call it on a stream the server ENDS (a
 * bounded SSE response). For an unbounded / cancelled stream use {@link readSSEStream}
 * instead. A `null` body (no stream) yields no events.
 *
 * @param response - The SSE `fetch` Response to read
 * @returns Every {@link SSEEvent} the stream dispatched, in order
 */
export async function collectSSE(response: Response): Promise<readonly SSEEvent[]> {
	const events: SSEEvent[] = []
	for await (const event of readSSEStream(response)) events.push(event)
	return events
}

/**
 * Stream a `fetch` Response's SSE body as decoded {@link SSEEvent}s, yielding each as its
 * blank line arrives — so a consumer can react (e.g. abort the `fetch`) mid-stream.
 *
 * @remarks
 * Pulls the `response.body` reader chunk-by-chunk through a `TextDecoder({ stream: true
 * })` (handling a multi-byte char split across reads) and the SSE parser (handling a
 * partial line / in-progress event split across reads), yielding each dispatched event.
 * Ends when the body closes. A `null` body yields nothing.
 *
 * @param response - The SSE `fetch` Response to stream
 * @returns An async generator of decoded {@link SSEEvent}s
 */
export async function* readSSEStream(response: Response): AsyncGenerator<SSEEvent> {
	const body = response.body
	if (body === null) return
	const reader = body.getReader()
	const decoder = new TextDecoder()
	const parser = createSSEParser()
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			for (const event of parser.parse(decoder.decode(value, { stream: true }))) yield event
		}
	} finally {
		reader.releaseLock()
	}
}

// ── Deterministic clock (session TTL batteries) ───────────────────────────────

/** A manually-driven epoch-ms clock plus the control to advance it explicitly. */
export interface ManualClockInterface {
	/** The injectable `() => number` clock — returns the current manual instant; never moves on its own. */
	readonly now: () => number
	/** Advance the manual instant by `ms` (the explicit stand-in for a real-time wait). */
	advance(ms: number): void
}

/**
 * Create a {@link ManualClockInterface} — a manual-time clock-reading seam (AGENTS §16).
 * Injected wherever a `clock: () => number` option is exposed (`createMCPSession`
 * threads a trailing `now`): the test advances the instant explicitly instead of
 * sleeping through a real TTL window, so idle-TTL eviction is deterministic under any
 * suite load.
 *
 * @param start - The initial manual instant (epoch ms); defaults to `0`
 * @returns A manual clock whose `now` is the injectable `() => number`
 */
export function createManualClock(start = 0): ManualClockInterface {
	let instant = start
	return {
		now: () => instant,
		advance(ms: number): void {
			instant += ms
		},
	}
}
