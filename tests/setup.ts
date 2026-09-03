// General, environment-agnostic test helpers — no `node:*`, no `document`/`window`. Loaded by
// every test project (core, server, guides). Environment-specific harnesses live in
// `tests/setupServer.ts`.

import type { SSEEvent } from '@orkestrel/sse'
import type { RecorderInterface } from '@orkestrel/test'
import type { ToolManagerInterface } from '@orkestrel/tool'
import type {
	MCPMessageTransportEventMap,
	MCPMessageTransportInterface,
	JSONRPCId,
	JSONRPCInvocation,
	JSONRPCMessage,
	JSONRPCNotification,
	JSONRPCRequest,
	JSONRPCResponse,
	MCPClientCapabilities,
	MCPClientInterface,
	MCPInputResult,
	MCPMethodHandler,
	MCPMethodOptions,
	MCPPaginationParams,
	MCPResourceContents,
	MCPResourceManagerInterface,
	MCPResourcePage,
	MCPResourceReadParams,
	MCPResourceTemplatePage,
	MCPServerInterface,
	MCPSubscriptionFilter,
	MCPSubscriptionHandler,
	MCPStreamControllerInterface,
	MCPTransportInterface,
	MCPTask,
	MCPTaskContext,
	MCPTaskDetail,
	MCPTaskManagerInterface,
} from '@src/core'
import {
	bindServer,
	createMCPServer,
	MCP_EXTENSION_TASKS,
	MCP_META_CAPABILITIES,
	MCP_META_VERSION,
	MCP_MODERN_VERSION,
	parseJSONRPCMessage,
} from '@src/core'
import { createTool, createToolManager } from '@orkestrel/tool'
import { createEmitter } from '@orkestrel/emitter'
import { createSSEParser } from '@orkestrel/sse'
import { createRecorder, waitForDelay } from '@orkestrel/test'

/**
 * Narrow an untyped value to an {@link MCPMethodHandler} the way a DYNAMIC registration must.
 *
 * @remarks
 * The seam's contract — answer a request with a response or a stream, never with nothing — is
 * a compile-time promise, and a consumer registering from JavaScript (or from a module whose
 * own return type was widened somewhere upstream) never made it. What a registry can check at
 * runtime is exactly one fact: that the value is callable. This guard checks that fact and
 * nothing else ON PURPOSE, so a test can put a genuinely unchecked handler on the seam without
 * an assertion and without inventing a shape TypeScript would have caught.
 *
 * Use it wherever the claim under test is about what DISPATCH does with a handler that broke
 * the contract, rather than about what the type system refuses to compile.
 *
 * @param value - The unknown value a dynamic registration is about to register
 * @returns Whether the value is callable, narrowing it to the seam's type
 */
export function isMCPMethodHandler(value: unknown): value is MCPMethodHandler {
	return typeof value === 'function'
}

// ── Async wait ───────────────────────────────────────────────────────────────

/**
 * Await one promise within a bounded interval and clear the watchdog on every settlement path.
 *
 * @typeParam T - The resolved value type
 * @param promise - The promise whose settlement to await
 * @param timeout - Maximum milliseconds to wait; defaults to `250`
 * @param message - Error message used when the deadline elapses
 * @returns The caller promise's resolved value
 * @throws When the caller promise rejects or the deadline elapses first
 */
export async function waitForSettlement<T>(
	promise: Promise<T>,
	timeout = 250,
	message = 'Timed out waiting for promise settlement',
): Promise<T> {
	let handle: ReturnType<typeof setTimeout> | undefined
	const watchdog = new Promise<never>((_resolve, reject) => {
		handle = setTimeout(() => reject(new Error(message)), timeout)
	})
	try {
		return await Promise.race([promise, watchdog])
	} finally {
		if (handle !== undefined) clearTimeout(handle)
	}
}

// ── JSON-RPC message factory (MCP request shape) ─────────────────────────────
//
// the well-formed JSON-RPC 2.0 request literal the MCP tests repeat
// (`{ jsonrpc: '2.0', method, id }`) folded into one builder with a sensible default plus
// per-call overrides, so a test names only the `method` / `id` / `params` its scenario
// varies. A real `JSONRPCRequest` (env-agnostic — only the `@src/core` type), NOT a mock
// of the transport.

/**
 * Build a well-formed {@link JSONRPCRequest} — the default `{ jsonrpc: '2.0', method:
 * 'initialize', id: 1 }` merged with per-call overrides (a different `method` / `id`, or a
 * `params` payload), so the MCP dispatch / transport tests name only the field that
 * matters instead of re-typing the envelope.
 *
 * @param overrides - Fields to override on the default request (`method` / `id` / `params`)
 * @returns The assembled JSON-RPC request
 */
export function createJSONRPCRequest(overrides?: Partial<JSONRPCRequest>): JSONRPCRequest {
	return { jsonrpc: '2.0', method: 'initialize', id: 1, ...overrides }
}

/**
 * Build a JSON-RPC notification whose absent `id` means no response is produced.
 *
 * @param method - The notification method
 * @param params - Optional notification parameters
 * @returns A notification envelope, which carries no `id` at all
 */
export function createJSONRPCNotification(
	method: string,
	params?: JSONRPCNotification['params'],
): JSONRPCNotification {
	return {
		jsonrpc: '2.0',
		method,
		...(params !== undefined ? { params } : {}),
	}
}

/**
 * Build a record nested `depth` levels deep around a `{ leaf: true }` terminal — the shared
 * builder for the JSON depth-bound batteries, so a test names only the nesting its scenario
 * needs instead of hand-writing a literal nobody can count.
 *
 * @param depth - How many record levels to wrap around the terminal leaf
 * @returns A freshly built nested record
 */
/**
 * Build one adversarial corpus every total guard must survive without throwing.
 *
 * @remarks
 * A guard over JSON-RPC envelopes has one membership rule — an exact-JSON RECORD of the
 * required shape — so a control drawn from another envelope shape only proves the guard
 * discriminates among records. These entries are drawn from OUTSIDE that population
 * entirely: absent and primitive values, a revoked proxy, a throwing accessor, a
 * self-referential cycle, a hostile-key record, a hidden non-enumerable member, and a
 * class instance. A guard that returns `false` for every one of them is total; a guard
 * that throws on any of them is not.
 *
 * A throwing accessor has to be keyed to EVERY name a guard under test reads directly.
 * A guard that clones the whole value meets every key, so one accessor reaches it whatever
 * the key is called; a guard that reads two named keys and clones nothing meets only the
 * names it asks for, and an accessor keyed elsewhere never arrives. The `method` row
 * certifies the cloning family and structurally cannot reach the direct-reading one, so
 * the `error`-member keys carry their own row — this corpus separates the two families
 * rather than certifying one of them from inside the other.
 *
 * Each call builds a FRESH corpus, because a revoked proxy and a cycle are single-use.
 *
 * @returns One adversarial value per row, in a stable order
 */
export function createHostileCorpus(): readonly unknown[] {
	const { proxy, revoke } = Proxy.revocable({ jsonrpc: '2.0', method: 'ping', id: 1 }, {})
	revoke()
	const cycle: Record<string, unknown> = { jsonrpc: '2.0', method: 'ping', id: 1 }
	cycle['self'] = cycle
	const accessor = Object.defineProperty({ jsonrpc: '2.0', id: 1 }, 'method', {
		enumerable: true,
		get(): string {
			throw new Error('must not escape')
		},
	})
	const hidden = Object.defineProperty({ jsonrpc: '2.0', id: 1 }, 'method', {
		enumerable: false,
		value: 'ping',
	})
	const failing = Object.defineProperty({ message: 'must not escape' }, 'code', {
		enumerable: true,
		get(): number {
			throw new Error('must not escape')
		},
	})
	return Object.freeze([
		undefined,
		null,
		0,
		-0,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		'',
		'{}',
		true,
		false,
		[],
		[{ jsonrpc: '2.0', method: 'ping', id: 1 }],
		() => undefined,
		Symbol('id'),
		new Date(0),
		new Map([['jsonrpc', '2.0']]),
		new Set(['2.0']),
		proxy,
		cycle,
		accessor,
		hidden,
		failing,
		Object.create(null),
		{ __proto__: { jsonrpc: '2.0', method: 'ping', id: 1 } },
		{ jsonrpc: '2.0', method: 'ping', id: 1, params: undefined },
		buildNestedRecord(64),
	])
}

/** Every key name the published guards read off an untrusted value by name. */
export const GUARD_KEY_NAMES: readonly string[] = Object.freeze([
	'_meta',
	'action',
	'annotations',
	'anyOf',
	'approved',
	'audience',
	'blob',
	'code',
	'const',
	'content',
	'context',
	'createdAt',
	'data',
	'default',
	'description',
	'elicitation',
	'enum',
	'enumNames',
	'error',
	'experimental',
	'extensions',
	'form',
	'format',
	'icons',
	'id',
	'inputRequests',
	'isError',
	'items',
	'jsonrpc',
	'lastModified',
	'lastUpdatedAt',
	'listChanged',
	'maxItems',
	'maxLength',
	'maximum',
	'message',
	'method',
	'mimeType',
	'minItems',
	'minLength',
	'minimum',
	'mode',
	'name',
	'oneOf',
	'params',
	'pollIntervalMs',
	'priority',
	'progress',
	'promptsListChanged',
	'properties',
	'requestState',
	'requestedSchema',
	'required',
	'resource',
	'resourceSubscriptions',
	'resources',
	'resourcesListChanged',
	'result',
	'resultType',
	'sampling',
	'size',
	'sizes',
	'src',
	'status',
	'statusMessage',
	'subscribe',
	'taskId',
	'text',
	'theme',
	'title',
	'tools',
	'toolsListChanged',
	'total',
	'ttlMs',
	'type',
	'uri',
	'url',
	'version',
	'websiteUrl',
])

/** The accessor body every throwing-key row installs. */
export function throwOnRead(): never {
	throw new Error('must not escape')
}

/**
 * Build one record per key, each defining that key as an enumerable accessor that throws.
 *
 * @remarks
 * The companion to {@link createHostileCorpus}, and the control it structurally could not
 * be. One throwing accessor certifies every guard that CLONES, because a clone reads whatever
 * keys the value has; it certifies nothing about a guard that reads two names directly, which
 * meets only the names it asks for. This battery keys the throw to each name in turn, so the
 * question is asked at the key rather than at the value.
 *
 * @param keys - The key names to key a throwing accessor to, one row each
 * @returns One record per key, in the order given
 *
 * @example
 * ```ts
 * createThrowingKeys(['code']).length // 1 — reading `.code` on that row throws
 * ```
 */
export function createThrowingKeys(keys: readonly string[]): readonly unknown[] {
	const battery: unknown[] = []
	for (const key of keys) {
		battery.push(
			Object.defineProperty({ jsonrpc: '2.0', id: 1, message: 'x' }, key, {
				enumerable: true,
				get: throwOnRead,
			}),
		)
	}
	return battery
}

export function buildNestedRecord(depth: number): Record<string, unknown> {
	let nested: Record<string, unknown> = { leaf: true }
	for (let level = 0; level < depth; level += 1) nested = { nested }
	return nested
}

// ── Canonical MCP server fixture (the calculator over a ToolManager) ─────────

/**
 * Build the canonical calculator {@link MCPServerInterface} the MCP transport tests
 * share — a real server over a real `ToolManager` carrying an `add` tool plus a `boom`
 * tool that throws, so every transport proves both the value and error paths.
 *
 * @returns The MCP server over the `add` and `boom` registry
 */
export function createCalculatorServer(): MCPServerInterface {
	const tools = createToolManager()
	tools.add(createTool({ name: 'add', execute: () => 5 }))
	tools.add(
		createTool({
			name: 'boom',
			execute: () => {
				throw new Error('kaboom')
			},
		}),
	)
	return createMCPServer({ identity: { name: 'calculator', version: '1.0.0' }, tools })
}

/**
 * Build an {@link MCPServerInterface} whose every first-round `tools/call` asks for a form
 * elicitation, so a client-side scenario can drive the input continuation end to end.
 *
 * @remarks
 * The continuation port is the identity adapter — `seal` and `open` hand the value straight
 * back — which keeps the protected state readable to the scenario while leaving every binding
 * the server writes into it intact. The registry is a parameter because the tools a
 * continuation scenario needs belong to that scenario, not to the input configuration.
 *
 * The `selector` answers on the round it can tell apart: a first round arrives with no
 * response and receives the approval question, and a retry arrives carrying one and receives
 * `undefined`, which is what lets the tool run.
 *
 * @param tools - The registry whose tools the returned server dispatches `tools/call` against
 * @returns An MCP server configured with a 60-second input continuation window
 *
 * @example
 * ```ts
 * const server = createInputServer(createToolManager())
 * server.identity.name // 'input-loopback'
 * ```
 */
export function createInputServer(tools: ToolManagerInterface): MCPServerInterface {
	return createMCPServer({
		identity: { name: 'input-loopback', version: '1.2.3' },
		tools,
		input: {
			continuation: {
				seal: (value) => Promise.resolve(value),
				open: (value) => Promise.resolve(value),
			},
			ttl: 60_000,
			principal: () => 'operator-1',
			selector: ({ responses }) =>
				responses === undefined
					? {
							requests: {
								approval: {
									method: 'elicitation/create',
									params: {
										message: 'Approve this call?',
										requestedSchema: {
											type: 'object',
											properties: { approved: { type: 'boolean' } },
											required: ['approved'],
										},
									},
								},
							},
						}
					: undefined,
		},
	})
}

// ── Exchange-ownership instrument (shared by every pump, and by the control) ─
//
// The standing ruling says ending a controlled exchange is the obligation of whoever is
// handed it, on EVERY exit. That claim is about a POPULATION of pumps, not about one, so the
// instrument that measures it is shared and the negative control is drawn from OUTSIDE the
// population the ruling covers: a hand-written consumer that reads one message and returns.
// It must be reported as leaking, or the instrument cannot tell a released exchange from an
// unreleased one.

/** The reserved `_meta` a modern request carries — the protocol version plus empty capabilities. */
export const MODERN_METADATA: Readonly<Record<string, unknown>> = Object.freeze({
	[MCP_META_VERSION]: MCP_MODERN_VERSION,
	[MCP_META_CAPABILITIES]: Object.freeze({}),
})

// ── Header-projection table (ONE mechanism, proven on BOTH faces) ────────────
//
// The HTTP client transport stamps `mcp-protocol-version` on a modern POST by reading `_meta`
// raw through `inferRequestVersion`, which is the same read the server's own expectation
// (`inferHeaderIssue`) performs. Routing it through `parseRequestContext` instead withholds the
// header on every context that is modern by key presence but carries no valid
// client-capability declaration, and the server answers that request `-32602`.
//
// This table is shared BY EVERY project that drives the transport, so one row cannot pass in
// one runtime and fail in another, and some of its rows are contexts that parse on ONLY ONE
// path — a table where every row agrees would prove nothing about the divergence it exists to
// catch.

/** One row of the protocol-version projection both HTTP client transports must answer alike. */
export interface TestHeaderContext {
	/** What the row is about, used as the failure label. */
	readonly label: string
	/** The `_meta` object the modern request carries. */
	readonly metadata: Readonly<Record<string, unknown>>
	/** Whether `parseRequestContext` admits this metadata — `false` rows are the divergent ones. */
	readonly parsed: boolean
	/** The `mcp-protocol-version` value both faces must send, or `undefined` for no header. */
	readonly version: string | undefined
}

/** The shared modern-context table both HTTP client transports are driven over. */
export const HEADER_PROJECTION_CONTEXTS: readonly TestHeaderContext[] = Object.freeze([
	{
		label: 'a complete modern context',
		metadata: MODERN_METADATA,
		parsed: true,
		version: MCP_MODERN_VERSION,
	},
	{
		label: 'a version with NO capability declaration',
		metadata: Object.freeze({ [MCP_META_VERSION]: MCP_MODERN_VERSION }),
		parsed: false,
		version: MCP_MODERN_VERSION,
	},
	{
		label: 'a version with a non-object capability declaration',
		metadata: Object.freeze({
			[MCP_META_VERSION]: MCP_MODERN_VERSION,
			[MCP_META_CAPABILITIES]: 'not a record',
		}),
		parsed: false,
		version: MCP_MODERN_VERSION,
	},
	{
		label: 'a complete context carrying an invalid logging level',
		metadata: Object.freeze({
			[MCP_META_VERSION]: MCP_MODERN_VERSION,
			[MCP_META_CAPABILITIES]: Object.freeze({}),
			'io.modelcontextprotocol/logLevel': 'loud',
		}),
		parsed: false,
		version: MCP_MODERN_VERSION,
	},
	{
		label: 'a non-string version — modern by key presence, projecting nothing',
		metadata: Object.freeze({ [MCP_META_VERSION]: 12 }),
		parsed: false,
		version: undefined,
	},
])

/**
 * Build one `tools/list` request for the header-projection table.
 *
 * @remarks
 * The table deliberately includes metadata that is modern by key presence but not well formed.
 *
 * @param metadata - The reserved metadata whose header projection is under test
 * @returns The request the header-projection table is driven with
 */
export function createHeaderProjectionRequest(
	metadata: Readonly<Record<string, unknown>>,
): JSONRPCRequest {
	return createJSONRPCRequest({ method: 'tools/list', id: 1, params: { _meta: metadata } })
}

/**
 * Build a modern request carrying the shared protocol metadata.
 *
 * @param method - The method to invoke
 * @param id - The request identifier
 * @returns A modern JSON-RPC request
 */
export function modernRequest(method: string, id: string | number = 1): JSONRPCRequest {
	return createJSONRPCRequest({ method, id, params: { _meta: MODERN_METADATA } })
}

/** In-memory resource manager shared by server and legacy dispatch tests. */
export class MemoryResourceManager implements MCPResourceManagerInterface {
	readonly #cursors: Array<string | undefined> = []
	readonly #reads: MCPResourceReadParams[] = []
	readonly #options: MCPMethodOptions[] = []
	readonly #records = new Map<string, readonly MCPResourceContents[]>([
		['memory://resource/one', [{ uri: 'memory://resource/one', text: 'one' }]],
		['memory://resource/two', [{ uri: 'memory://resource/two', blob: 'dHdv' }]],
	])

	get cursors(): ReadonlyArray<string | undefined> {
		return this.#cursors
	}

	get reads(): readonly MCPResourceReadParams[] {
		return this.#reads
	}

	get options(): readonly MCPMethodOptions[] {
		return this.#options
	}

	resources(pagination: MCPPaginationParams, options: MCPMethodOptions): MCPResourcePage {
		this.#cursors.push(pagination.cursor)
		this.#options.push(options)
		return pagination.cursor === undefined
			? {
					resources: [{ uri: 'memory://resource/one', name: 'one', mimeType: 'text/plain' }],
					nextCursor: 'second',
				}
			: { resources: [{ uri: 'memory://resource/two', name: 'two' }] }
	}

	resource(
		params: MCPResourceReadParams,
		options: MCPMethodOptions,
	): readonly MCPResourceContents[] | MCPInputResult | undefined {
		this.#reads.push(params)
		this.#options.push(options)
		if (params.uri === 'memory://resource/input') {
			return { resultType: 'input_required', requestState: 'resource-state' }
		}
		// The arm that ASKS the client something. The carrier-only arm above asks nothing, so
		// only this one reaches the server's capability gate.
		if (params.uri === 'memory://resource/round') {
			return {
				resultType: 'input_required',
				inputRequests: { workspace: { method: 'roots/list' } },
				requestState: 'resource-state',
			}
		}
		return this.#records.get(params.uri)
	}

	templates(pagination: MCPPaginationParams, options: MCPMethodOptions): MCPResourceTemplatePage {
		this.#cursors.push(pagination.cursor)
		this.#options.push(options)
		return {
			resourceTemplates: [
				{
					uriTemplate: 'memory://resource/{name}',
					name: 'named',
					description: 'A manager-owned RFC 6570 template',
				},
			],
		}
	}
}

/** A peerable in-memory transport with outbound recording. */
export interface MemoryTransportInterface extends MCPTransportInterface {
	readonly sent: readonly string[]
	readonly closedCalls: number
	readonly failSend: Error | undefined
	connect(peer: MemoryTransportInterface): void
	deliver(message: string): void
	fail(error?: Error): void
}

/**
 * Create a peerable in-memory MCP transport.
 *
 * @returns A transport that can record, connect to a peer, and receive messages
 */
export function createMemoryTransport(): MemoryTransportInterface {
	let onMessage: ((message: string) => void) | undefined
	let onClosed: (() => void) | undefined
	let peer: MemoryTransportInterface | undefined
	let failure: Error | undefined
	const sent: string[] = []
	let closedCalls = 0
	const transport: MemoryTransportInterface = {
		async send(message) {
			if (failure !== undefined) throw failure
			sent.push(message)
			peer?.deliver(message)
		},
		listen(handler) {
			onMessage = handler
		},
		closed(handler) {
			onClosed = handler
		},
		async close() {
			closedCalls += 1
			onClosed?.()
		},
		get sent() {
			return sent
		},
		get closedCalls() {
			return closedCalls
		},
		get failSend() {
			return failure
		},
		connect(value) {
			peer = value
		},
		deliver(message) {
			onMessage?.(message)
		},
		fail(error) {
			failure = error
		},
	}
	return transport
}

/** A minimal protocol peer that exchanges serialized JSON-RPC over the real duplex port. */
export interface HostilePeerInterface {
	readonly messages: readonly string[]
	send(message: string): Promise<void>
	responses(): readonly JSONRPCMessage[]
	response(): JSONRPCResponse | undefined
	clear(): void
	close(): void
}

/**
 * Bind an MCP server to a minimal serialized-message peer.
 *
 * @param server - The real MCP server under test
 * @returns A protocol peer for sending hostile wire messages and reading protocol answers
 */
export function createHostilePeer(server: MCPServerInterface): HostilePeerInterface {
	let listener: ((message: string) => void) | undefined
	let closed: (() => void) | undefined
	let waiting: (() => void) | undefined
	const messages: string[] = []
	const transport: MCPTransportInterface = {
		send(message) {
			messages.push(message)
			waiting?.()
			waiting = undefined
		},
		listen(handler) {
			listener = handler
		},
		closed(handler) {
			closed = handler
		},
		close() {
			closed?.()
		},
	}
	const unbind = bindServer(server, transport)
	return {
		get messages() {
			return messages
		},
		async send(message) {
			if (listener === undefined) throw new Error('hostile peer is not bound')
			await new Promise<void>((resolve) => {
				waiting = resolve
				listener?.(message)
			})
		},
		responses() {
			const decoded: JSONRPCMessage[] = []
			for (const message of messages) {
				const value: unknown = JSON.parse(message)
				const response = parseJSONRPCMessage(value)
				if (response === undefined) throw new Error('server sent a non-JSON-RPC fixture message')
				decoded.push(response)
			}
			return decoded
		},
		response() {
			for (let index = messages.length - 1; index >= 0; index -= 1) {
				const message = messages[index]
				if (message === undefined) continue
				const value: unknown = JSON.parse(message)
				const response = parseJSONRPCMessage(value)
				if (response !== undefined && !('method' in response)) return response
			}
			return undefined
		},
		clear() {
			messages.length = 0
		},
		close() {
			unbind()
		},
	}
}

/**
 * Build one modern `subscriptions/listen` request — the held-open method every ownership
 * scenario opens its exchange with.
 *
 * @param id - The request id the exchange is correlated by
 * @param notifications - The filter the request asks for. Default: `{ toolsListChanged: true }`
 * @returns The modern subscription request
 */
export function createSubscriptionRequest(
	id: JSONRPCId,
	notifications: MCPSubscriptionFilter = { toolsListChanged: true },
): JSONRPCRequest {
	return createJSONRPCRequest({
		method: 'subscriptions/listen',
		id,
		params: { notifications, _meta: MODERN_METADATA },
	})
}

/** What one consumer did with the controlled exchange it was handed. */
export interface TestOwnershipInterface {
	/** Whether the exchange had ENDED by the time the consumer returned. */
	readonly released: boolean
	/** Whatever the consumer threw, or `undefined` when it returned normally. */
	readonly failure: unknown
}

/**
 * Hand one controlled exchange to a consumer and report whether that consumer ENDED it.
 *
 * @remarks
 * The observable is the live-subscription SLOT, because that is the resource an abandoned
 * exchange actually holds: the server is built with `limit.subscriptions: 1`, so a second
 * `subscriptions/listen` after the consumer returns either opens (the first exchange was
 * released) or is refused with the capacity error (it was not). No private state is read and
 * no timing is assumed — the slot is returned synchronously on the exchange's own closure.
 *
 * The producer never yields, so nothing here completes on its own: whatever ends the
 * exchange is something the consumer did.
 *
 * @param consume - The pump under test, handed the controlled exchange to own
 * @returns Whether the exchange was released, and whatever the consumer threw
 *
 * @example
 * ```ts
 * const outcome = await probeOwnership(async (stream) => void (await stream.next()))
 * outcome.released // false — a consumer that reads and walks away releases nothing
 * ```
 */
export async function probeOwnership(
	consume: (stream: MCPStreamControllerInterface) => Promise<void>,
): Promise<TestOwnershipInterface> {
	const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
	const mcp = createMCPServer({
		identity: { name: 'ownership', version: '1.0.0' },
		tools: createToolManager(),
		limit: { subscriptions: 1 },
		subscription: { notifications: { toolsListChanged: true }, producer: () => source.readable },
	})
	const opened = await mcp.dispatch(createSubscriptionRequest('probe-open'))
	if (!(Symbol.asyncIterator in opened)) throw new Error('expected a controlled exchange')
	let failure: unknown
	try {
		await consume(opened)
	} catch (error) {
		failure = error
	}
	const rival = await mcp.dispatch(createSubscriptionRequest('probe-rival'))
	if (!(Symbol.asyncIterator in rival)) throw new Error('expected a controlled exchange')
	// A live subscription answers its acknowledgement first; a refused one answers the
	// capacity error as its terminal, which is `done`.
	const first = await rival.next()
	rival.stop()
	return { released: first.done !== true, failure }
}

/** The owner-of-last-resort spellings a controlled exchange must never grow. */
export const OWNER_OF_LAST_RESORT_SPELLINGS: readonly string[] = Object.freeze([
	'FinalizationRegistry',
	'WeakRef',
	'setTimeout',
	'setInterval',
	'setImmediate',
	'AbortSignal.timeout',
])

/**
 * Report every owner-of-last-resort construct a source declares.
 *
 * @remarks
 * A finalizer or a timer that ends an exchange nobody released converts a missing obligation
 * into a nondeterministic one, so the controllers carry none. Supply COMMENT-STRIPPED source:
 * the prose above these classes names the constructs in order to forbid them.
 *
 * @param source - The comment-stripped source text to sweep
 * @returns Each forbidden spelling the source contains, in declaration order
 *
 * @example
 * ```ts
 * inspectOwnerOfLastResort('new FinalizationRegistry(() => stream.stop())') // → ['FinalizationRegistry']
 * ```
 */
export function inspectOwnerOfLastResort(source: string): readonly string[] {
	return OWNER_OF_LAST_RESORT_SPELLINGS.filter((spelling) => source.includes(spelling))
}

// ── In-process loopback MCP client transport (env-agnostic scenario builder) ─
//
// the `MCPMessageTransportInterface` doc for `@src/core` names "the in-process
// loopback transport in the tests" as one of its concrete forms — this is that shared,
// general one. It dispatches straight to a REAL `MCPServerInterface` with no wire, no
// network — a real transport, not a mock. A test needing gated / instrumented
// responses (withholding a reply to drive a timeout) still keeps its own bespoke variant
// local (only a genuinely reusable form is centralized).

// ── Duplex instrument (DRIVE the declaration, never read it) ─────────────────
//
// `duplex` is a claim a carrier makes about ITSELF, and getting it wrong is invisible:
// `send` accepts any message, so a carrier with no client→server notification channel
// writes one and drops it silently. Reading the literal back therefore proves nothing
// about the carrier — only that the getter returns what it was written to return.
//
// So the claim is DRIVEN: a real client-initiated `notifications/cancelled`, produced by
// aborting a live request through the real `MCPClient`, and then observed AT THE PEER.
// The control is drawn from outside the population of honestly-declaring transports — a
// carrier that LIES (see the browser suite): a real `MessagePort` whose peer half is
// closed, still declaring `duplex: true`. The instrument must come back empty for it.

/**
 * Drive one client-initiated notification through a live carrier and report what the peer got.
 *
 * @remarks
 * The request is aborted in the SAME synchronous turn it was issued in — the pending entry
 * exists before `call` first suspends, and no real carrier can have delivered a reply yet —
 * so the cancellation frame is written while the request is genuinely in flight. The caller
 * supplies `drain`, which returns and clears whatever the peer has actually received.
 *
 * EVERY frame is returned, not only the cancellation: a probe that filtered first could not
 * tell "the carrier dropped the frame" from "the drain sees nothing at all", and those are
 * the two answers the negative cases have to distinguish.
 *
 * @param client - The connected client whose carrier is under test
 * @param drain - Returns (and clears) every message the PEER received
 * @returns Every message that reached the peer while the request was driven
 *
 * @example
 * ```ts
 * const frames = await probeDuplex(client, drainRecorded)
 * expect(readMethods(frames)).toContain('notifications/cancelled')
 * ```
 */
export async function probeDuplex(
	client: MCPClientInterface,
	drain: () => Promise<readonly JSONRPCMessage[]>,
): Promise<readonly JSONRPCMessage[]> {
	const controller = new AbortController()
	const pending = client.call('add', {}, { signal: controller.signal })
	controller.abort()
	await pending.catch(() => undefined)
	await waitForDelay(50)
	return drain()
}

/**
 * Read the `method` of every invocation among a peer's received frames, in order.
 *
 * @param frames - The messages a peer received
 * @returns One method name per invocation; responses contribute nothing
 *
 * @example
 * ```ts
 * expect(readMethods(frames)).toEqual(['tools/call', 'notifications/cancelled'])
 * ```
 */
export function readMethods(frames: readonly JSONRPCMessage[]): readonly string[] {
	const methods: string[] = []
	for (const frame of frames) {
		if ('method' in frame) methods.push(frame.method)
	}
	return methods
}

/**
 * Create an in-process {@link MCPMessageTransportInterface} that dispatches directly against a
 * given {@link MCPServerInterface} — no wire, no network. Each `send` dispatches its
 * request through `mcp.dispatch` and emits a DEFINED response (a
 * notification produces none) on the `message` event, mirroring how a real transport
 * surfaces replies.
 *
 * @param mcp - The MCP server to dispatch requests against in-process
 * @returns A working duplex {@link MCPMessageTransportInterface} with no `session` (stateless)
 */
export interface MCPTestLoopbackInterface extends MCPMessageTransportInterface {
	/** The client invocations delivered to the real server, in wire order. */
	readonly messages: readonly JSONRPCInvocation[]
	/** Delivers one peer-originated frame through the transport's real message event. */
	receive(message: JSONRPCMessage): void
}

/**
 * Creates a real MCP server whose subscription source is supplied by the test scenario.
 *
 * @remarks
 * `tasks` is what turns the task family of the filter on, and supplying it is the ONLY door:
 * the server derives task-stream support from a configured manager beside a configured
 * producer, so a scenario that omits the manager is the negative half of that derivation
 * rather than a differently configured server. The manager also authorizes each requested
 * identifier before the acknowledgement agrees to it, so the store a scenario seeds is what
 * decides the acknowledged set.
 *
 * @param producer - The real server subscription producer
 * @param notifications - The notification families the server advertises
 * @param tasks - The durable store the server resolves requested task identifiers through
 * @returns A real in-process MCP server with the built-in subscription method registered
 */
export function createSubscriptionServer(
	producer: MCPSubscriptionHandler,
	notifications: MCPSubscriptionFilter = {
		toolsListChanged: true,
		promptsListChanged: true,
		resourcesListChanged: true,
		resourceSubscriptions: ['resource://one', 'resource://two'],
	},
	tasks?: MCPTaskManagerInterface,
): MCPServerInterface {
	return createMCPServer({
		identity: { name: 'subscription-server', version: '1.0.0' },
		tools: createToolManager(),
		subscription: { notifications, producer },
		...(tasks === undefined ? {} : { task: { tasks, deferral: () => undefined } }),
	})
}

export function createLoopbackTransport(mcp: MCPServerInterface): MCPTestLoopbackInterface {
	const emitter = createEmitter<MCPMessageTransportEventMap>()
	const messages: JSONRPCInvocation[] = []
	return {
		emitter,
		session: undefined,
		get messages() {
			return messages
		},
		// An in-process channel carries a frame in either direction at any moment, so the
		// loopback is duplex — a client notification reaches `dispatch` like any other message.
		duplex: true,
		async start() {},
		async send(message) {
			if (!('method' in message)) return
			messages.push(message)
			const answer = await mcp.dispatch(message)
			if (answer === undefined) return
			// Before the subscription client rows, no existing scenario produced this held-open
			// arm. Iterating it is a strict extension of the unary loopback below: each yielded
			// notification is delivered immediately, followed by the iterator's terminal response.
			if (Symbol.asyncIterator in answer) {
				for (let frame = await answer.next(); ; frame = await answer.next()) {
					emitter.emit('message', frame.value)
					if (frame.done === true) return
				}
			}
			emitter.emit('message', answer)
		},
		receive(message) {
			emitter.emit('message', message)
		},
		async close() {
			emitter.emit('close')
		},
	}
}

/**
 * POST a JSON value to a real HTTP fixture endpoint.
 *
 * @param base - The fixture server's base URL
 * @param body - The JSON value to serialize
 * @param options - Optional request headers and endpoint path
 * @returns The real fetch response
 */
export function postJSON(
	base: string,
	body: unknown,
	options?: { readonly headers?: Readonly<Record<string, string>>; readonly path?: string },
): Promise<Response> {
	return fetch(`${base}${options?.path ?? '/mcp'}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...options?.headers },
		body: JSON.stringify(body),
	})
}

// ── SSE response decoding (environment-agnostic) ─────────────────────────────
//
// The client side of the HTTP SSE seam: read a `fetch` Response's body stream, decode
// the bytes (`TextDecoder` for split multi-byte chars), and feed them to the
// `@orkestrel/sse` parser — so a test asserts the EXACT events the seam serialized,
// proving the encode ↔ decode round-trip. No `node:*` / DOM — web `Response` /
// `ReadableStream` / `TextDecoder` are global in both the node and the browser test
// runners.

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

// ── Deterministic clock (session TTL batteries) ──────────────────────────────

/** A manually-driven epoch-ms clock plus the control to advance it explicitly. */
export interface ManualClockInterface {
	/** The injectable `() => number` clock — returns the current manual instant; never moves on its own. */
	readonly now: () => number
	/** Advance the manual instant by `ms` (the explicit stand-in for a real-time wait). */
	advance(ms: number): void
}

/**
 * Create a {@link ManualClockInterface} — a manual-time clock-reading seam.
 * Injected wherever a `clock: () => number` option is exposed (`createMCPSession` for the
 * store sweep, `MCPSessionOptions.clock` for the replay log's own sweep): the test advances
 * the instant explicitly instead of sleeping through a real TTL window, so idle-TTL eviction
 * is deterministic under any suite load.
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

// ── Durable task manager fixture (the Tasks extension's consumer half) ───────
//
// A REAL implementation of the published `MCPTaskManagerInterface`, not a fake of
// anything this package owns: the extension deliberately puts the whole task lifecycle
// on the consumer's side of the port, so a store, a worker, and a terminal status are
// exactly what a manager IS. `bind` is the one variable the port's own TSDoc warns
// about — a manager that hands the request's cancellation signal to the task's work —
// so the same fixture drives both halves of that proof.

/** One outbound frame, with the real instant it left the client. */
export interface TestFrame {
	/** The JSON-RPC method the frame carried. */
	readonly method: string
	/** The `performance.now()` reading when the transport accepted it. */
	readonly at: number
}

/** An {@link MCPMessageTransportInterface} that records every outbound frame and when it left. */
export interface TestTransportInterface extends MCPMessageTransportInterface {
	/** Every frame written through `send`, in order, each stamped with its real instant. */
	readonly frames: readonly TestFrame[]
}

/**
 * Create an in-process {@link TestTransportInterface} over a real {@link MCPServerInterface} —
 * {@link createLoopbackTransport} plus a timestamped record of everything the client wrote.
 *
 * @remarks
 * The instrument for any claim of the form "this client writes nothing unless asked". A
 * spelling scan cannot make that claim: a scheduler can be spelled a hundred ways and one of
 * them will not be in the list. What cannot be spelled around is TIME — a loop that runs leaves
 * frames on the wire, and this records each one with a real `performance.now()` reading, so a
 * test asserts against elapsed milliseconds instead of against source text. Pair it with a
 * consumer-written scheduler that DOES poll, so the recorder is shown capable of seeing polling
 * before any silence is read as meaningful.
 *
 * @param mcp - The MCP server every recorded frame is dispatched against
 * @returns A working duplex client transport that also records what crossed it
 */
export function createRecordingTransport(mcp: MCPServerInterface): TestTransportInterface {
	const loopback = createLoopbackTransport(mcp)
	const frames: TestFrame[] = []
	return {
		...loopback,
		get frames() {
			return frames
		},
		async send(message) {
			if ('method' in message) frames.push({ method: message.method, at: performance.now() })
			await loopback.send(message)
		},
	}
}

/**
 * Create a real {@link MCPServerInterface} with the stable Tasks extension configured — one
 * `render` tool, and a `deferral` that turns every call into a durable task.
 *
 * @remarks
 * The peer half of every client-side task scenario. Its negative control is
 * {@link createCalculatorServer}, which configures no `task` at all and therefore answers
 * every `tasks/*` method `-32601` — a server drawn from OUTSIDE the extension's population,
 * which is what makes "the client mirrors the server port" falsifiable rather than circular.
 *
 * @param tasks - The durable store the server creates tasks in and reads them back from
 * @returns A working MCP server whose every `tools/call` becomes a task
 */
export function createTaskServer(tasks: MCPTaskManagerInterface): MCPServerInterface {
	const registry = createToolManager()
	registry.add(createTool({ name: 'render', execute: () => 'rendered' }))
	return createMCPServer({
		identity: { name: 'task-server', version: '1.0.0' },
		tools: registry,
		task: { tasks, deferral: () => 'operation-1' },
	})
}

/** The client capabilities that declare the stable Tasks extension — the whole declaration. */
export const TASK_CAPABILITIES: MCPClientCapabilities = Object.freeze({
	extensions: Object.freeze({ [MCP_EXTENSION_TASKS]: Object.freeze({}) }),
})

/** How one {@link TestTaskManager} runs a task's work. */
export interface TestTaskOptions {
	/** Bind the REQUEST's `options.signal` to the task's work — the hazard the port's TSDoc names. */
	readonly bind?: boolean
	/** Milliseconds the work takes before it completes. */
	readonly work?: number
	/** Start each task `input_required` (awaiting `update`) instead of `working`. */
	readonly asking?: boolean
	/** The only `options.caller` entitled to read a task; every other caller sees `undefined`. */
	readonly owner?: unknown
	/** The `ttlMs` each created task carries; `null` (the default) means it never expires. */
	readonly ttl?: number | null
	/**
	 * The `pollIntervalMs` hint each created task publishes; omitted publishes none.
	 *
	 * @remarks
	 * A manager's SUGGESTION about how often a client must ask again, and nothing more —
	 * opt-in here precisely because a manager that pushes notifications instead omits it,
	 * and every existing snapshot assertion was written against a task that does.
	 */
	readonly poll?: number
}

/**
 * A real in-memory {@link MCPTaskManagerInterface} — a durable store, a worker per task,
 * and the deduplication the port asks managers for.
 *
 * @remarks
 * `settle()` awaits every started worker, so a test observes a terminal status without
 * polling or sleeping past a guessed deadline. Timestamps come from a monotonic counter
 * rather than the host clock, so two runs produce identical snapshots.
 */
export class TestTaskManager implements MCPTaskManagerInterface {
	readonly #details = new Map<string, MCPTaskDetail>()
	readonly #identifiers = new Map<string, string>()
	readonly #starts: Array<readonly [string, MCPTaskContext, MCPMethodOptions]> = []
	readonly #running: Array<Promise<void>> = []
	readonly #bind: boolean
	readonly #work: number
	readonly #asking: boolean
	readonly #owner: unknown
	readonly #guarded: boolean
	readonly #ttl: number | null
	readonly #poll: number | undefined
	readonly #reads = createRecorder<readonly [string]>()
	#instant = 0

	constructor(options: TestTaskOptions = {}) {
		this.#bind = options.bind ?? false
		this.#work = options.work ?? 10
		this.#asking = options.asking ?? false
		this.#owner = options.owner
		this.#guarded = options.owner !== undefined
		this.#ttl = options.ttl ?? null
		this.#poll = options.poll
	}

	/** Each `(key, context, options)` triple `start` received, in call order. */
	get starts(): ReadonlyArray<readonly [string, MCPTaskContext, MCPMethodOptions]> {
		return this.#starts
	}

	/** Every stored task's current snapshot, in creation order. */
	get details(): readonly MCPTaskDetail[] {
		return [...this.#details.values()]
	}

	/**
	 * Every identifier {@link task} was asked to resolve, in call order.
	 *
	 * @remarks
	 * The store is the ONLY place a task resolution can be observed from, so this recorder is
	 * what a claim about WHEN the package reads the store is measured against. Read the count
	 * at two moments and compare them: a count that rose proves the recorder sees a read at
	 * all, and a count that then held proves the reads a scenario is asserting the absence of
	 * did not happen.
	 */
	get reads(): RecorderInterface<readonly [string]> {
		return this.#reads
	}

	/** Await every started worker — the deterministic stand-in for polling `tasks/get`. */
	async settle(): Promise<void> {
		await Promise.all([...this.#running])
	}

	/**
	 * Drop every task that CAN expire, which is the whole of a TTL sweep here.
	 *
	 * @remarks
	 * A task whose `ttlMs` is `null` survives, because `null` is the extension's spelling for
	 * "no expiry" rather than a zero-length one — the member of this store the purge rule was
	 * never written against.
	 */
	purge(): void {
		for (const [id, detail] of this.#details) {
			if (detail.ttlMs !== null) this.#details.delete(id)
		}
	}

	/**
	 * Write one `working` task into the store under an identifier the scenario chooses.
	 *
	 * @remarks
	 * The identifiers {@link start} mints are cryptographic and unpredictable, which is what the
	 * port asks a manager for and what makes them useless to a scenario that must NAME a task
	 * before any call exists — a subscription filter carries identifiers a client already holds.
	 * A store writing a task out of band is what a durable store does, so this is the ordinary
	 * case rather than a shortcut: the task carries this manager's own `ttlMs` and poll hint,
	 * so a seeded task purges and reads exactly as a started one does. It runs no worker, so it
	 * stays `working` until {@link abort} moves it and {@link settle} is unaffected.
	 *
	 * @param id - The `taskId` the store files the task under
	 * @returns The stored snapshot
	 */
	seed(id: string): MCPTaskDetail {
		const stamp = this.#stamp()
		const detail: MCPTaskDetail = {
			taskId: id,
			status: 'working',
			createdAt: stamp,
			lastUpdatedAt: stamp,
			ttlMs: this.#ttl,
			...(this.#poll === undefined ? {} : { pollIntervalMs: this.#poll }),
		}
		this.#details.set(id, detail)
		return detail
	}

	async start(key: string, context: MCPTaskContext, options: MCPMethodOptions): Promise<MCPTask> {
		this.#starts.push([key, context, options])
		const existing = this.#identifiers.get(key)
		const found = existing === undefined ? undefined : this.#details.get(existing)
		// Deduplication by stable key: a repeated key answers the task it already made.
		if (found !== undefined) return found
		const id = crypto.randomUUID()
		const stamp = this.#stamp()
		// The manager's poll HINT, published only when this manager was built to publish one.
		// It is a datum on the snapshot and nothing else: nothing in the package reads it, and
		// that is the claim the client-side scenarios exist to prove.
		const hint = this.#poll === undefined ? {} : { pollIntervalMs: this.#poll }
		const created: MCPTaskDetail = this.#asking
			? {
					taskId: id,
					status: 'input_required',
					createdAt: stamp,
					lastUpdatedAt: stamp,
					ttlMs: this.#ttl,
					...hint,
					inputRequests: {
						approval: {
							method: 'elicitation/create',
							params: {
								message: 'Approve?',
								requestedSchema: { type: 'object', properties: {} },
								mode: 'form',
							},
						},
					},
				}
			: {
					taskId: id,
					status: 'working',
					createdAt: stamp,
					lastUpdatedAt: stamp,
					ttlMs: this.#ttl,
					...hint,
				}
		this.#details.set(id, created)
		this.#identifiers.set(key, id)
		if (!this.#asking) this.#running.push(this.#run(id, this.#bind ? options.signal : undefined))
		return created
	}

	// The port's `undefined` carries several facts at once, and this manager produces each:
	// a task that never existed, one `purge()` removed, and one belonging to another caller.
	// Distinguishing them HERE — by throwing for the unauthorized case, say — is what would
	// turn the store into an enumeration oracle, so it does not.
	async task(id: string, options?: MCPMethodOptions): Promise<MCPTaskDetail | undefined> {
		this.#reads.handler(id)
		if (this.#guarded && options?.caller !== this.#owner) return undefined
		return this.#details.get(id)
	}

	async update(
		id: string,
		responses: Readonly<Record<string, unknown>>,
		_options?: MCPMethodOptions,
	): Promise<void> {
		const current = this.#details.get(id)
		if (current === undefined || current.status !== 'input_required') return
		if (!Object.hasOwn(responses, 'approval')) return
		this.#details.set(id, {
			taskId: current.taskId,
			status: 'working',
			createdAt: current.createdAt,
			lastUpdatedAt: this.#stamp(),
			ttlMs: current.ttlMs,
		})
		this.#running.push(this.#run(id, undefined))
	}

	async abort(id: string, _options?: MCPMethodOptions): Promise<void> {
		this.#finish(id, false)
	}

	// One task's work. The signal is present only when this manager was built to bind it,
	// which is the whole difference between the halves of the port's TSDoc proof.
	async #run(id: string, signal: AbortSignal | undefined): Promise<void> {
		const completed =
			signal === undefined
				? await this.#worked()
				: await Promise.race([this.#worked(), this.#aborted(signal)])
		this.#finish(id, completed)
	}

	async #worked(): Promise<boolean> {
		await waitForDelay(this.#work)
		return true
	}

	async #aborted(signal: AbortSignal): Promise<boolean> {
		if (!signal.aborted) {
			await new Promise<void>((resolve) =>
				signal.addEventListener('abort', () => resolve(), { once: true }),
			)
		}
		return false
	}

	#finish(id: string, completed: boolean): void {
		const current = this.#details.get(id)
		if (current === undefined || current.status !== 'working') return
		const stamp = this.#stamp()
		this.#details.set(
			id,
			completed
				? {
						taskId: current.taskId,
						status: 'completed',
						createdAt: current.createdAt,
						lastUpdatedAt: stamp,
						ttlMs: current.ttlMs,
						result: { resultType: 'complete', content: [{ type: 'text', text: current.taskId }] },
					}
				: {
						taskId: current.taskId,
						status: 'cancelled',
						createdAt: current.createdAt,
						lastUpdatedAt: stamp,
						ttlMs: current.ttlMs,
					},
		)
	}

	#stamp(): string {
		this.#instant += 1_000
		return new Date(this.#instant).toISOString()
	}
}
