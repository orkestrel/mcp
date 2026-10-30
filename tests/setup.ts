import type {
	MCPCallResult,
	MCPCompletion,
	MCPCompletionInterface,
	MCPCompletionParams,
	MCPContinuationInterface,
	MCPElicitForm,
	MCPInputContext,
	MCPInputRequestMap,
	MCPInputResponseMap,
	MCPInputRound,
	MCPInputState,
	MCPPromptGetParams,
	MCPPromptGetResult,
	MCPPromptManagerInterface,
	MCPPromptPage,
	MCPServerOptions,
	MCPTaskOptions,
	MCPTextStream,
} from '@src/core'
import type { JSONValue } from '@orkestrel/contract'
import type { EmitterErrorHandler } from '@orkestrel/emitter'
import type { SSEEvent } from '@orkestrel/sse'
import type { RecorderInterface } from '@orkestrel/test'
import type { ToolInterface, ToolManagerInterface } from '@orkestrel/tool'
import type {
	MCPMessageTransportEventMap,
	MCPDispatcherInterface,
	MCPMessageTransportInterface,
	JSONRPCId,
	JSONRPCInvocation,
	JSONRPCMessage,
	JSONRPCNotification,
	JSONRPCRequest,
	JSONRPCResponse,
	MCPClientCapabilities,
	MCPClientInterface,
	MCPConsumerFilter,
	MCPInputResult,
	MCPInputRequest,
	MCPElicitSchema,
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
	MCPSubscriptionOptions,
	MCPStreamControllerInterface,
	MCPStream,
	MCPTransportInterface,
	MCPTask,
	MCPTaskContext,
	MCPTaskDetail,
	MCPTaskManagerInterface,
} from '@src/core'
import { isJSONRPCErrorResponse, isMCPInputResult, parseMCPInputState } from '@src/core'
import * as core from '@src/core'
import {
	bindClient,
	bindServer,
	buildJSONRPCResult,
	createDuplexClientTransport,
	createMCPClient,
	createMCPLegacy,
	createMCPServer,
	MCP_EXTENSION_TASKS,
	MCP_META_CAPABILITIES,
	MCP_META_CLIENT,
	MCP_META_VERSION,
	MCP_MODERN_VERSION,
	MCP_UNSUPPORTED_VERSION,
	MCPStreamController,
	parseJSONRPCMessage,
} from '@src/core'
import { createTool, createToolManager } from '@orkestrel/tool'
import { createEmitter } from '@orkestrel/emitter'
import { createSSEParser } from '@orkestrel/sse'
import { createRecorder, waitForAbort, waitForDelay } from '@orkestrel/test'
import { attempt, isRecord } from '@orkestrel/contract'
import { MCPTextStreamController, supportsFormElicitation, supportsTask } from '@src/core'

export async function* createReplyStream(
	messages: readonly JSONRPCNotification[],
	response: JSONRPCResponse,
): MCPStream {
	for (const message of messages) yield message
	return response
}

export async function createHeldReply(): Promise<MCPStream> {
	return createReplyStream([MCP_HELPER_PROGRESS, MCP_HELPER_PROGRESS], MCP_HELPER_TERMINAL)
}

export async function* createParkedReply(options: MCPMethodOptions, ended: string[]): MCPStream {
	try {
		yield MCP_HELPER_PROGRESS
		await waitForAbort(options.signal)
		return MCP_HELPER_TERMINAL
	} finally {
		ended.push('demo/parked')
	}
}

export function createTextController(source: MCPStream): MCPTextStreamController {
	const closure = new AbortController()
	return new MCPTextStreamController(new MCPStreamController(source, closure.signal, closure))
}

export function buildDataEvent(payload: unknown): string {
	return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`
}

export function createSSEResponse(body: string): Response {
	return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

export function createRPCMessage(
	overrides?: Parameters<typeof createJSONRPCRequest>[0],
): JSONRPCMessage {
	const message = parseJSONRPCMessage(createJSONRPCRequest(overrides))
	if (message === undefined) throw new Error('unreachable: createJSONRPCRequest is a message')
	return message
}

export function createBinderServer() {
	const tools = createToolManager()
	tools.add(createTool({ name: 'add', execute: (a) => Number(a['x']) + Number(a['y']) }))
	return createMCPServer({ identity: { name: 'demo', version: '1.0.0' }, tools })
}

export function createBoundedServer() {
	const tools = createToolManager()
	return createMCPServer({
		identity: { name: 'bounded', version: '1.0.0' },
		tools,
		limit: { message: 240 },
	})
}

export function createBoundClient(transport: MCPTransportInterface) {
	return createMCPClient({ transport: createDuplexClientTransport(transport) })
}

export function createMemoryTransportPair(): readonly [
	MemoryTransportInterface,
	MemoryTransportInterface,
] {
	const server = createMemoryTransport()
	const client = createMemoryTransport()
	server.connect(client)
	client.connect(server)
	return [server, client]
}

export const MCP_HELPER_PROGRESS: JSONRPCNotification = Object.freeze({
	jsonrpc: '2.0',
	method: 'notifications/progress',
})
export const MCP_HELPER_TERMINAL: JSONRPCResponse = Object.freeze({
	jsonrpc: '2.0',
	id: 1,
	result: { done: true },
})

// Every published CAPABILITY predicate as a unary call. A `supports*` predicate reads a
// declaration and narrows nothing, so it is no `Guard<T>` — but it takes the same `unknown`
// from the same wire, so it owes the same totality.
export const MCP_PUBLISHED_PREDICATES: Readonly<Record<string, (value: unknown) => boolean>> =
	Object.freeze({
		supportsFormElicitation,
		supportsTask,
	})

export function createSignalRecorder(
	real: MCPServerInterface,
	signals: AbortSignal[],
	release: MCPFixtureCell<(() => void) | undefined>,
): MCPServerInterface {
	return {
		emitter: real.emitter,
		identity: real.identity,
		handshake: real.handshake,
		methods: real.methods,
		limit: real.limit,
		dispatch: real.dispatch.bind(real),
		async handle(message, options) {
			const signal = options?.signal
			if (signal === undefined) throw new Error('the binder must supply a request signal')
			signals.push(signal)
			if (signals.length > 10_000) {
				await new Promise<void>((resolve) => {
					release.value = resolve
				})
			}
			return await real.handle(message, options)
		},
	}
}

export const MCP_SERVER_ANNOTATED_TOOLS = {
	jsonrpc: '2.0',
	id: 1,
	result: {
		resultType: 'complete',
		ttlMs: 0,
		cacheScope: 'private',
		nextCursor: 'page-2',
		tools: [
			{
				name: 'valid_tool',
				inputSchema: {
					type: 'object',
					properties: {
						region: { type: 'string', 'x-mcp-header': 'Region' },
						priority: { type: 'integer', 'x-mcp-header': 'Priority' },
						verbose: { type: 'boolean', 'x-mcp-header': 'Verbose' },
						query: { type: 'string' },
					},
				},
			},
			{
				name: 'invalid_space_in_name',
				inputSchema: {
					type: 'object',
					properties: { value: { type: 'string', 'x-mcp-header': 'My Region' } },
				},
			},
			{
				name: 'plain_tool',
				inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
			},
		],
	},
}

// General, environment-agnostic test helpers — no `node:*`, no `document`/`window`. Loaded by
// every test project (core, server, guides). Environment-specific harnesses live in
// `tests/setupServer.ts`.

export const MCP_PROGRESS_LIMITS = Object.freeze({ bytes: 256, keys: 3, depth: 1 })

export async function* createSubscriptionEvents(): AsyncGenerator<JSONRPCNotification> {
	yield { jsonrpc: '2.0', method: 'notifications/prompts/list_changed' }
}

export async function* createDisconnectEvents(
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
	yield { jsonrpc: '2.0', method: 'notifications/prompts/list_changed' }
	throw new Error('subscription client disconnected')
}

export async function* createCallerEvents(
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

export const ROUTE_SCHEMA = {
	type: 'object',
	properties: {
		value: { type: 'string', 'x-mcp-header': 'value' },
		count: { type: 'integer', 'x-mcp-header': 'Count' },
		note: { type: 'string' },
	},
}

export function createAnnotatedServer(): MCPServerInterface {
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
export function createPagedServer(depth: number): MCPServerInterface {
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

export function createForgedResponsePeer(): MCPMessageTransportInterface {
	const emitter = createEmitter<MCPMessageTransportEventMap>()
	return {
		emitter,
		session: undefined,
		duplex: true,
		async start() {},
		async send(message) {
			if (!('method' in message) || message.id === undefined) return
			const target = buildPeerDiscovery(message.id)
			const response = new Proxy(target, {
				get(source, property) {
					if (property === 'error') {
						return { code: -32_000, message: 'forged after validation' }
					}
					return Reflect.get(source, property)
				},
			})
			emitter.emit('message', response)
		},
		async close() {},
	}
}

/** Aborts the captured signal when a later accessor read selects its replacement. */
export function createAccessorSignal(
	captured: AbortController,
	replacement: AbortController,
	reason: unknown,
	reads: MCPFixtureCell<number>,
): { readonly signal: AbortSignal } {
	return {
		get signal(): AbortSignal {
			reads.value += 1
			if (reads.value === 1) return captured.signal
			captured.abort(reason)
			return replacement.signal
		},
	}
}

export interface EndlessFetchInterface {
	/** The `fetch` to hand the transport through its public `fetch` option. */
	readonly answer: typeof fetch
	/** How many response bodies were cancelled through the signal the transport passed. */
	readonly cancelled: number
}

export function createEndlessFetch(): EndlessFetchInterface {
	const cancelled = new MCPFixtureCell(0)
	const encoder = new TextEncoder()

	return {
		async answer(_input, init) {
			const signal = init?.signal ?? undefined
			if (signal !== null && signal?.aborted === true) throw new Error('aborted before dispatch')
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					// One SSE comment: enough for the response headers to flush and the reader to park,
					// and not an event, so the transport never finishes decoding.
					controller.enqueue(encoder.encode(': open\n\n'))
					signal?.addEventListener(
						'abort',
						() => {
							cancelled.value += 1
							controller.error(new Error('response body cancelled'))
						},
						{ once: true },
					)
				},
			})
			return new Response(body, {
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
			})
		},
		get cancelled() {
			return cancelled.value
		},
	}
}

export const MCP_HTTP_REQUEST: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'tools/list' }

export const MCP_HTTP_ANNOTATED_TOOLS = {
	jsonrpc: '2.0',
	id: 1,
	result: {
		resultType: 'complete',
		ttlMs: 0,
		cacheScope: 'private',
		nextCursor: 'page-2',
		tools: [
			{
				name: 'valid_tool',
				inputSchema: {
					type: 'object',
					properties: {
						region: { type: 'string', 'x-mcp-header': 'Region' },
						priority: { type: 'integer', 'x-mcp-header': 'Priority' },
						verbose: { type: 'boolean', 'x-mcp-header': 'Verbose' },
						query: { type: 'string' },
					},
				},
			},
			{
				name: 'invalid_duplicate_diff_case',
				inputSchema: {
					type: 'object',
					properties: {
						field1: { type: 'string', 'x-mcp-header': 'MyField' },
						field2: { type: 'string', 'x-mcp-header': 'myfield' },
					},
				},
			},
		],
	},
}

export const MCP_HTTP_CALL_METADATA = {
	'io.modelcontextprotocol/protocolVersion': '2026-07-28',
	'io.modelcontextprotocol/clientCapabilities': {},
}

// A listing that advertises one annotated tool, and the fresh listing that no longer carries
// it. A `tools/list` sent with no `cursor` REPLACES what the caller was told, so the second
// of these leaves the transport with nothing to project for `gone`. The Node face pins the
// same interleaving, plus the continuation half.
export const MCP_HTTP_GONE_LISTING = {
	jsonrpc: '2.0',
	id: 1,
	result: {
		resultType: 'complete',
		ttlMs: 0,
		cacheScope: 'private',
		tools: [
			{
				name: 'gone',
				inputSchema: {
					type: 'object',
					properties: { region: { type: 'string', 'x-mcp-header': 'Region' } },
				},
			},
		],
	},
}

export const MCP_HTTP_EMPTY_LISTING = {
	jsonrpc: '2.0',
	id: 2,
	result: { resultType: 'complete', ttlMs: 0, cacheScope: 'private', tools: [] },
}

// Two pages of ONE listing, the second requested with the cursor the first handed back. A
// continuation ACCUMULATES, so both tools stay projectable.
export const MCP_HTTP_FIRST_PAGE = {
	jsonrpc: '2.0',
	id: 1,
	result: {
		resultType: 'complete',
		ttlMs: 0,
		cacheScope: 'private',
		nextCursor: 'page-2',
		tools: [
			{
				name: 'paged_one',
				inputSchema: {
					type: 'object',
					properties: { region: { type: 'string', 'x-mcp-header': 'Region' } },
				},
			},
		],
	},
}

export const MCP_HTTP_SECOND_PAGE = {
	jsonrpc: '2.0',
	id: 2,
	result: {
		resultType: 'complete',
		ttlMs: 0,
		cacheScope: 'private',
		tools: [
			{
				name: 'paged_two',
				inputSchema: {
					type: 'object',
					properties: { priority: { type: 'integer', 'x-mcp-header': 'Priority' } },
				},
			},
		],
	},
}

export async function* createFixtureResponseStream(
	notification: JSONRPCNotification,
	response: JSONRPCResponse,
): MCPStream {
	yield notification
	return response
}

/** Re-enters a scenario when a native resolver factory is observed. */
export function createResolverHook(
	intrinsic: typeof Promise.withResolvers,
	observe: () => void,
): typeof Promise.withResolvers {
	return function <T>(): PromiseWithResolvers<T> {
		Promise.withResolvers = intrinsic
		observe()
		return Promise.withResolvers<T>()
	}
}

/** Re-enters a scenario before a native resolver rejects its promise. */
export function createRejectResolverHook(
	intrinsic: typeof Promise.withResolvers,
	observe: () => void,
): typeof Promise.withResolvers {
	return function <T>(): PromiseWithResolvers<T> {
		Promise.withResolvers = intrinsic
		const record = Promise.withResolvers<T>()
		return {
			promise: record.promise,
			resolve: record.resolve,
			reject(reason?: unknown) {
				observe()
				record.reject(reason)
			},
		}
	}
}

/** Reports the record reached after walking a nested fixture. */
export interface NestedFixtureResult {
	readonly level: unknown
	readonly walked: number
}

/** Walks the nesting independently of the fixture builder, within a caller's depth bound. */
export function inspectNestedFixture(value: unknown, remaining: number): NestedFixtureResult {
	if (!isRecord(value) || !('nested' in value)) return { level: value, walked: 0 }
	if (remaining <= 0) throw new Error('The nested fixture exceeded its inspection bound')
	const result = inspectNestedFixture(value['nested'], remaining - 1)
	return { level: result.level, walked: result.walked + 1 }
}

/** Holds the state a fixture's callbacks share for one scenario. */
export class MCPFixtureCell<T> {
	#value: T

	constructor(value: T) {
		this.#value = value
	}

	get value(): T {
		return this.#value
	}

	set value(value: T) {
		this.#value = value
	}
}

/** Answers the method registry's primary fixture request. */
export async function respondFixtureMethod(request: JSONRPCRequest): Promise<JSONRPCResponse> {
	return buildJSONRPCResult(request.id, { from: 'ok' })
}

/** Answers the method registry's replacement fixture request. */
export async function respondAlternateMethod(request: JSONRPCRequest): Promise<JSONRPCResponse> {
	return buildJSONRPCResult(request.id, { from: 'other' })
}

/** Completes the server fixture's configured handshake. */
export async function completeFixtureHandshake(): Promise<void> {}

/**
 * Narrows an untyped value to an {@link MCPMethodHandler} the way a DYNAMIC registration must.
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
 * Awaits one promise within a bounded interval and clear the watchdog on every settlement path.
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
	const watchdog = Promise.withResolvers<never>()
	const handle = setTimeout(() => watchdog.reject(new Error(message)), timeout)
	try {
		return await Promise.race([promise, watchdog.promise])
	} finally {
		clearTimeout(handle)
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
 * Builds a well-formed {@link JSONRPCRequest} — the default `{ jsonrpc: '2.0', method:
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
 * Builds a JSON-RPC notification whose absent `id` means no response is produced.
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
 * Builds one adversarial corpus every total guard must survive without throwing.
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

/** Lists every key name the published guards read off an untrusted value by name. */
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

/** Throws as the accessor body every throwing-key row installs. */
export function throwOnRead(): never {
	throw new Error('must not escape')
}

/**
 * Builds one record per key, each defining that key as an enumerable accessor that throws.
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
	return Array.from({ length: Math.max(0, Math.ceil(depth)) }).reduce<Record<string, unknown>>(
		(nested) => ({ nested }),
		{ leaf: true },
	)
}

// ── Canonical MCP server fixture (the calculator over a ToolManager) ─────────

/**
 * Builds the canonical calculator {@link MCPServerInterface} the MCP transport tests
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
 * Builds an {@link MCPServerInterface} whose every first-round `tools/call` asks for a form
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

/** Supplies the reserved `_meta` a modern request carries — the protocol version plus empty capabilities. */
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

/** Describes one row of the protocol-version projection both HTTP client transports must answer alike. */
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

/** Supplies the shared modern-context table both HTTP client transports are driven over. */
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
 * Builds one `tools/list` request for the header-projection table.
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
 * Builds a modern request carrying the shared protocol metadata.
 *
 * @param method - The method to invoke
 * @param id - The request identifier
 * @returns A modern JSON-RPC request
 */
export function modernRequest(method: string, id: string | number = 1): JSONRPCRequest {
	return createJSONRPCRequest({ method, id, params: { _meta: MODERN_METADATA } })
}

/** Serves resources from memory for the server and legacy dispatch tests. */
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

/** Describes a peerable in-memory transport with outbound recording. */
export interface MemoryTransportInterface extends MCPTransportInterface {
	readonly sent: readonly string[]
	readonly closedCalls: number
	readonly failSend: Error | undefined
	connect(peer: MemoryTransportInterface): void
	deliver(message: string): void
	fail(error?: Error): void
}

/**
 * Creates a peerable in-memory MCP transport.
 *
 * @returns A transport that can record, connect to a peer, and receive messages
 */
export function createMemoryTransport(): MemoryTransportInterface {
	const onMessage = new MCPFixtureCell<((message: string) => void) | undefined>(undefined)
	const onClosed = new MCPFixtureCell<(() => void) | undefined>(undefined)
	const peer = new MCPFixtureCell<MemoryTransportInterface | undefined>(undefined)
	const failure = new MCPFixtureCell<Error | undefined>(undefined)
	const sent: string[] = []
	const closedCalls = new MCPFixtureCell(0)
	return {
		async send(message) {
			if (failure.value !== undefined) throw failure.value
			sent.push(message)
			peer.value?.deliver(message)
		},
		listen(handler) {
			onMessage.value = handler
		},
		closed(handler) {
			onClosed.value = handler
		},
		async close() {
			closedCalls.value += 1
			const callback = onClosed.value
			callback?.()
		},
		get sent() {
			return sent
		},
		get closedCalls() {
			return closedCalls.value
		},
		get failSend() {
			return failure.value
		},
		connect(value) {
			peer.value = value
		},
		deliver(message) {
			const callback = onMessage.value
			callback?.(message)
		},
		fail(error) {
			failure.value = error
		},
	}
}

/** Describes a minimal protocol peer that exchanges serialized JSON-RPC over the real duplex port. */
export interface HostilePeerInterface {
	readonly messages: readonly string[]
	send(message: string): Promise<void>
	responses(): readonly JSONRPCMessage[]
	response(): JSONRPCResponse | undefined
	clear(): void
	close(): void
}

/**
 * Binds an MCP server to a minimal serialized-message peer.
 *
 * @param server - The real MCP server under test
 * @returns A protocol peer for sending hostile wire messages and reading protocol answers
 */
export function createHostilePeer(server: MCPServerInterface): HostilePeerInterface {
	const listener = new MCPFixtureCell<((message: string) => void) | undefined>(undefined)
	const closed = new MCPFixtureCell<(() => void) | undefined>(undefined)
	const waiting = new MCPFixtureCell<(() => void) | undefined>(undefined)
	const messages: string[] = []
	const unbind = bindServer(server, {
		send(message) {
			messages.push(message)
			const callback = waiting.value
			callback?.()
			waiting.value = undefined
		},
		listen(handler) {
			listener.value = handler
		},
		closed(handler) {
			closed.value = handler
		},
		close() {
			const callback = closed.value
			callback?.()
		},
	})
	return {
		get messages() {
			return messages
		},
		async send(message) {
			if (listener.value === undefined) throw new Error('hostile peer is not bound')
			await new Promise<void>((resolve) => {
				waiting.value = resolve
				const callback = listener.value
				callback?.(message)
			})
		},
		responses() {
			return messages.map((message) => {
				const value: unknown = JSON.parse(message)
				const response = parseJSONRPCMessage(value)
				if (response === undefined) throw new Error('server sent a non-JSON-RPC fixture message')
				return response
			})
		},
		response() {
			for (const message of messages.toReversed()) {
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
 * Builds one modern `subscriptions/listen` request — the held-open method every ownership
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

/** Reports what one consumer did with the controlled exchange it was handed. */
export interface TestOwnershipInterface {
	/** Whether the exchange had ENDED by the time the consumer returned. */
	readonly released: boolean
	/** Whatever the consumer threw, or `undefined` when it returned normally. */
	readonly failure: unknown
}

/**
 * Hands one controlled exchange to a consumer and reports whether that consumer ENDED it.
 *
 * @remarks
 * The observable is the live-subscription SLOT, because that is the resource an abandoned
 * exchange actually holds: the server is built with `limit.subscriptions: 1`, so a second
 * `subscriptions/listen` after the consumer returns either opens (the first exchange was
 * released) or is refused with the capacity error (it was not). No private state is read and
 * no timing is assumed — the slot is returned synchronously on the exchange's own closure.
 *
 * The built-in tools family keeps the exchange open until its signal aborts, so the
 * exchange ends only when the consumer releases it.
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
	const mcp = createMCPServer({
		identity: { name: 'ownership', version: '1.0.0' },
		tools: createToolManager(),
		limit: { subscriptions: 1 },
	})
	const opened = await mcp.dispatch(createSubscriptionRequest('probe-open'))
	if (!(Symbol.asyncIterator in opened)) throw new Error('expected a controlled exchange')
	const consumed = attempt(() => consume(opened))
	const failure: unknown = consumed.success
		? await consumed.value.then(
				() => undefined,
				(error: unknown) => error,
			)
		: consumed.error
	const rival = await mcp.dispatch(createSubscriptionRequest('probe-rival'))
	if (!(Symbol.asyncIterator in rival)) throw new Error('expected a controlled exchange')
	// A live subscription answers its acknowledgement first; a refused one answers the
	// capacity error as its terminal, which is `done`.
	const first = await rival.next()
	rival.stop()
	return { released: first.done !== true, failure }
}

/** Lists the owner-of-last-resort spellings a controlled exchange must never grow. */
export const OWNER_OF_LAST_RESORT_SPELLINGS: readonly string[] = Object.freeze([
	'FinalizationRegistry',
	'WeakRef',
	'setTimeout',
	'setInterval',
	'setImmediate',
	'AbortSignal.timeout',
])

/**
 * Reports every owner-of-last-resort construct a source declares.
 *
 * @remarks
 * A finalizer or a timer that ends an exchange nobody released converts a missing obligation
 * into a nondeterministic one, so the controllers carry none. Supply COMMENT-STRIPPED source:
 * the prose above these classes names the constructs to forbid them.
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
 * Drives one client-initiated notification through a live carrier and reports what the peer got.
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
 * Reads the `method` of every invocation among a peer's received frames, in order.
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
 * Dispatches directly against a given {@link MCPServerInterface} from an in-process
 * {@link MCPMessageTransportInterface} — no wire, no network. Each `send` dispatches its
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
	notifications: MCPConsumerFilter = {
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
		...(tasks === undefined ? {} : { task: { tasks, deferral: declineFixtureTask } }),
	})
}

/** Declines deferred execution in a subscription-only fixture. */
export function declineFixtureTask(): undefined {
	return undefined
}

/** Describes real tools whose handler entry and cancellation can be observed. */
export interface AbortToolsInterface {
	readonly tools: ToolManagerInterface
	readonly entered: Promise<AbortSignal>
	readonly aborted: Promise<void>
	release(): void
}

/** Describes the duplex connection and registries used by the refresh guide. */
export interface ToolRefreshInterface {
	readonly client: MCPClientInterface
	readonly server: MCPServerInterface
	readonly remote: ToolManagerInterface
	readonly tools: ToolManagerInterface
	readonly local: ToolInterface
	close(): Promise<void>
}

/** Reports the installed names, refused collisions, and fetch failures from a refresh. */
export interface ToolRefreshResult {
	readonly installed: readonly string[]
	readonly collisions: readonly string[]
	readonly failures: readonly unknown[]
}

/** Creates real tools with an observable cancellation boundary and an explicit cleanup release. */
export function createAbortTools(): AbortToolsInterface {
	const entered = Promise.withResolvers<AbortSignal>()
	const release = Promise.withResolvers<void>()
	const tools = createToolManager()
	tools.add(
		createTool({
			name: 'wait',
			execute: async (_args, context) => {
				entered.resolve(context.signal)
				await Promise.race([waitForAbort(context.signal), release.promise])
				return 'finished'
			},
		}),
	)
	tools.add(createTool({ name: 'echo', execute: (args) => args['value'] }))
	// `aborted` observes the same signal the handler received, so a caller reads the report
	// without a second deferred beside the handler's own wait.
	return {
		tools,
		entered: entered.promise,
		aborted: entered.promise.then(waitForAbort),
		release: release.resolve,
	}
}

/** Transcribes the guide's explicit snapshot replacement for its executed proof. */
export async function refreshTools(
	client: MCPClientInterface,
	tools: ToolManagerInterface,
	installed: readonly string[],
): Promise<ToolRefreshResult> {
	const collisions: string[] = []
	const requested = attempt(() => client.tools())
	if (!requested.success) return { installed, collisions, failures: [requested.error] }
	const outcome = await requested.value.then(
		(snapshot) => ({ success: true as const, snapshot }),
		(error: unknown) => ({ success: false as const, error }),
	)
	if (!outcome.success) return { installed, collisions, failures: [outcome.error] }
	const snapshot = outcome.snapshot
	const accepted = snapshot.filter((tool) => {
		if (tools.tool(tool.name) !== undefined && !installed.includes(tool.name)) {
			collisions.push(tool.name)
			return false
		}
		return true
	})
	tools.remove(installed)
	tools.add(accepted)
	return { installed: accepted.map((tool) => tool.name), collisions, failures: [] }
}

/** Creates the guide's real duplex server pair and mixed local/remote tool registries. */
export function createToolRefresh(): ToolRefreshInterface {
	const remote = createToolManager()
	remote.add(createTool({ name: 'remote', title: 'Original', execute: () => 'original' }))
	const tools = createToolManager()
	const local = createTool({ name: 'local', execute: () => 'local value' })
	tools.add(local)
	const server = createMCPServer({
		identity: { name: 'refresh', version: '1' },
		tools: remote,
	})
	const serverSide = createMemoryTransport()
	const clientSide = createMemoryTransport()
	serverSide.connect(clientSide)
	clientSide.connect(serverSide)
	const unbindServer = bindServer(server, serverSide)
	const client = createMCPClient({ transport: createDuplexClientTransport(clientSide) })
	const unbindClient = bindClient(client, clientSide)
	return {
		client,
		server,
		remote,
		tools,
		local,
		async close() {
			await client.disconnect()
			unbindClient()
			unbindServer()
			remote.destroy()
			tools.destroy()
		},
	}
}

/** Configures a scripted consumer producer and its observations. */
export interface ProducerScriptOptions {
	readonly frames: readonly JSONRPCNotification[]
	readonly filters?: RecorderInterface<readonly [MCPSubscriptionFilter]>
	readonly signals?: RecorderInterface<readonly [AbortSignal]>
	readonly park?: boolean
	readonly failure?: { readonly error: unknown }
}

/**
 * Creates a consumer producer that yields scripted frames and records its request context.
 *
 * @param script - The frames, observations, optional failure, and cancellation wait
 * @returns A producer that completes after its frames unless configured to park or fail
 * @remarks If `park` is true, waits on the signal after yielding; if false, completes. A
 * configured `failure` throws before `park` is reached, so the two never combine.
 */
export function createProducerScript(script: ProducerScriptOptions): MCPSubscriptionHandler {
	return async function* (filter, options) {
		script.filters?.handler(filter)
		script.signals?.handler(options.signal)
		for (const frame of script.frames) yield frame
		if (script.failure !== undefined) throw script.failure.error
		if (script.park === true) await waitForAbort(options.signal)
	}
}

/** Holds a real registry subscription and its request lifetime. */
export interface RegistrySubscriptionInterface {
	readonly tools: ToolManagerInterface
	readonly stream: MCPStreamControllerInterface
	readonly controller: AbortController
	close(): void
}

/** Creates a server stream over a seeded registry without consuming its acknowledgement. */
export async function createRegistrySubscription(
	subscription?: MCPSubscriptionOptions,
): Promise<RegistrySubscriptionInterface> {
	const tools = createToolManager()
	tools.add(createTool({ name: 'original', execute: () => 'original' }))
	const server = createMCPServer({
		identity: { name: 'registry', version: '1' },
		tools,
		...(subscription === undefined ? {} : { subscription }),
	})
	const controller = new AbortController()
	const stream = await server.dispatch(
		createJSONRPCRequest({
			method: 'subscriptions/listen',
			id: 'registry',
			params: {
				notifications: { toolsListChanged: true, promptsListChanged: true },
				_meta: MODERN_METADATA,
			},
		}),
		{ signal: controller.signal },
	)
	if (!(Symbol.asyncIterator in stream)) throw new Error('Expected a registry stream')
	return {
		tools,
		stream,
		controller,
		close() {
			controller.abort()
			tools.destroy()
		},
	}
}

/** Names the registry operations whose events reach an open tools subscription. */
export const REGISTRY_CHANGES = Object.freeze([
	{
		title: 'adds a tool',
		change: (tools: ToolManagerInterface) =>
			tools.add(createTool({ name: 'added', execute: () => 'added' })),
	},
	{ title: 'removes a tool', change: (tools: ToolManagerInterface) => tools.remove('original') },
	{ title: 'clears', change: (tools: ToolManagerInterface) => tools.clear() },
])

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
				while (true) {
					const frame = await answer.next()
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
 * Posts a JSON value to a real HTTP fixture endpoint.
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
 * Drains a `fetch` Response's SSE body to completion, returning every dispatched
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
 * Streams a `fetch` Response's SSE body as decoded {@link SSEEvent}s, yielding each as its
 * blank line arrives — so a consumer can react (for example abort the `fetch`) mid-stream.
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

/** Describes a manually-driven epoch-ms clock plus the control to advance it explicitly. */
export interface ManualClockInterface {
	/** The injectable `() => number` clock — returns the current manual instant; never moves on its own. */
	readonly now: () => number
	/** Advance the manual instant by `ms` (the explicit stand-in for a real-time wait). */
	advance(ms: number): void
}

/**
 * Creates a {@link ManualClockInterface} — a manual-time clock-reading seam.
 * Injected wherever a `clock: () => number` option is exposed (`createMCPSession` for the
 * store sweep, `MCPSessionOptions.clock` for the replay log's own sweep): the test advances
 * the instant explicitly instead of sleeping through a real TTL window, so idle-TTL eviction
 * is deterministic under any suite load.
 *
 * @param start - The initial manual instant (epoch ms); defaults to `0`
 * @returns A manual clock whose `now` is the injectable `() => number`
 */
export function createManualClock(start = 0): ManualClockInterface {
	const instant = new MCPFixtureCell(start)
	return {
		now: () => instant.value,
		advance(ms: number): void {
			instant.value += ms
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

/** Describes one outbound frame, with the real instant it left the client. */
export interface TestFrame {
	/** The JSON-RPC method the frame carried. */
	readonly method: string
	/** The `performance.now()` reading when the transport accepted it. */
	readonly at: number
}

/** Records every outbound frame and when it left, as an {@link MCPMessageTransportInterface}. */
export interface TestTransportInterface extends MCPMessageTransportInterface {
	/** Every frame written through `send`, in order, each stamped with its real instant. */
	readonly frames: readonly TestFrame[]
}

/**
 * Creates an in-process {@link TestTransportInterface} over a real {@link MCPServerInterface} —
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
 * Creates a real {@link MCPServerInterface} with the stable Tasks extension configured — one
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

/** Declares the stable Tasks extension in the client capabilities — the whole declaration. */
export const TASK_CAPABILITIES: MCPClientCapabilities = Object.freeze({
	extensions: Object.freeze({ [MCP_EXTENSION_TASKS]: Object.freeze({}) }),
})

/** Decides how one {@link TestTaskManager} runs a task's work. */
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
 * Runs durable tasks in memory as a real {@link MCPTaskManagerInterface} — a durable store, a worker per task,
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
		await waitForAbort(signal)
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

/** Holds the notification emitted by the controller fixtures. */
export const MCP_STREAM_PROGRESS: JSONRPCNotification = Object.freeze({
	jsonrpc: '2.0',
	method: 'notifications/progress',
})

/** Holds the terminal emitted by the controller fixtures. */
export const MCP_STREAM_TERMINAL: JSONRPCResponse = Object.freeze({
	jsonrpc: '2.0',
	id: 1,
	result: { done: true },
})

/** Holds the failure emitted by the controlled producer fixture. */
export const MCP_STREAM_FAILURE = new Error('source blew up')

/** Creates a producer that never resumes on its own. */
export async function* createParkedStream(): MCPStream {
	await new Promise<void>(() => undefined)
	yield MCP_STREAM_PROGRESS
	return MCP_STREAM_TERMINAL
}

/** Creates a producer that parks after a notification. */
export async function* createSuspendedStream(closed: string[]): MCPStream {
	try {
		yield MCP_STREAM_PROGRESS
		await new Promise<void>(() => undefined)
		return MCP_STREAM_TERMINAL
	} finally {
		closed.push('yielding')
	}
}

/** Creates a producer that records its signal and closure. */
export async function* createCooperativeStream(signal: AbortSignal, woken: string[]): MCPStream {
	try {
		await new Promise<void>((resolve) =>
			signal.addEventListener('abort', () => resolve(), { once: true }),
		)
		woken.push(signal.aborted ? 'aborted' : 'resumed')
		if (!signal.aborted) yield MCP_STREAM_PROGRESS
		return MCP_STREAM_TERMINAL
	} finally {
		woken.push('closed')
	}
}

/** Replays notifications before the fixture terminal. */
export async function* createReplayStream(messages: readonly JSONRPCNotification[]): MCPStream {
	for (const message of messages) yield message
	return MCP_STREAM_TERMINAL
}

/** Creates a producer that fails after a notification. */
export async function* createFaultedStream(): MCPStream {
	yield MCP_STREAM_PROGRESS
	throw MCP_STREAM_FAILURE
}

/** Owns a fixture producer through the real controller. */
export function createControlledStream(
	source: MCPStream,
	closure = new AbortController(),
): MCPStreamController {
	return new MCPStreamController(source, closure.signal, closure)
}

/** Creates a producer that records text-face cancellation. */
export async function* createTextCooperativeStream(
	signal: AbortSignal,
	closed: string[],
): MCPStream {
	try {
		await new Promise<void>((resolve) =>
			signal.addEventListener('abort', () => resolve(), { once: true }),
		)
		if (!signal.aborted) yield MCP_STREAM_PROGRESS
		return MCP_STREAM_TERMINAL
	} finally {
		closed.push('cooperating')
	}
}

/** Creates a producer that records its terminal path. */
export async function* createRecordedStream(endings: string[]): MCPStream {
	try {
		yield MCP_STREAM_PROGRESS
		yield MCP_STREAM_PROGRESS
		return MCP_STREAM_TERMINAL
	} catch {
		endings.push('catch')
		return MCP_STREAM_TERMINAL
	} finally {
		endings.push('finally')
	}
}

export interface LegacyPeerInterface extends MCPMessageTransportInterface {
	readonly sent: readonly JSONRPCMessage[]
	readonly violations: readonly string[]
	readonly closed: number
	readonly lifecycle: readonly string[]
	deliver(message: JSONRPCMessage): void
	release(): void
}

export interface LegacyPeerOptions {
	readonly drop?: (method: string, count: number) => boolean
	readonly park?: (method: string, count: number) => boolean
	readonly reply?: (
		request: JSONRPCInvocation,
		count: number,
	) => JSONRPCResponse | Error | undefined
	readonly refuse?: boolean
	readonly version?: unknown
}

export function createLegacyPeer(options?: LegacyPeerOptions): LegacyPeerInterface {
	const emitter = createEmitter<MCPMessageTransportEventMap>()
	const sent: JSONRPCMessage[] = []
	const violations: string[] = []
	const lifecycle: string[] = []
	const held: Array<() => void> = []
	const closed = new MCPFixtureCell(0)
	return {
		emitter,
		session: undefined,
		duplex: true,
		get sent() {
			return sent
		},
		get violations() {
			return violations
		},
		get closed() {
			return closed.value
		},
		get lifecycle() {
			return lifecycle
		},
		async start() {
			lifecycle.push('start')
		},
		async send(message) {
			sent.push(message)
			if (!('method' in message)) return
			const count = sent.length
			if (options?.park?.(message.method, count) === true) {
				await new Promise<void>((resolve) => {
					held.push(resolve)
				})
			}
			const metadata = message.params?.['_meta']
			if (
				isRecord(metadata) &&
				(Object.hasOwn(metadata, MCP_META_VERSION) ||
					Object.hasOwn(metadata, MCP_META_CAPABILITIES) ||
					Object.hasOwn(metadata, MCP_META_CLIENT))
			) {
				violations.push(`modern metadata reached ${message.method}`)
			}
			const scripted = options?.reply?.(message, count)
			if (scripted instanceof Error) throw scripted
			if (scripted !== undefined) {
				emitter.emit('message', scripted)
				return
			}
			if (options?.drop?.(message.method, count) === true) return
			if (message.id === undefined) return
			if (message.method === 'initialize') {
				emitter.emit(
					'message',
					options?.refuse === true
						? {
								jsonrpc: '2.0',
								id: message.id,
								error: { code: -32602, message: 'Legacy handshake refused' },
							}
						: {
								jsonrpc: '2.0',
								id: message.id,
								result: {
									protocolVersion: options?.version ?? '2025-11-25',
									capabilities: { tools: {} },
									serverInfo: { name: 'legacy-peer', version: '1.0.0' },
								},
							},
				)
				return
			}
			if (message.method === 'tools/list') {
				emitter.emit('message', {
					jsonrpc: '2.0',
					id: message.id,
					result: {
						tools: [{ name: 'echo', description: 'Echoes input', inputSchema: { type: 'object' } }],
					},
				})
				return
			}
			if (message.method === 'tools/call') {
				emitter.emit('message', {
					jsonrpc: '2.0',
					id: message.id,
					result: {
						content: [{ type: 'text', text: '{"echoed":"legacy"}' }],
						structuredContent: { echoed: 'legacy' },
					},
				})
			}
		},
		async close() {
			closed.value += 1
			lifecycle.push('close')
		},
		deliver(message) {
			emitter.emit('message', message)
		},
		release() {
			for (const resolve of held.splice(0)) resolve()
		},
	}
}

export function buildLegacyHandshakeResponse(
	id: string | number,
	protocol: unknown,
): JSONRPCResponse {
	return {
		jsonrpc: '2.0',
		id,
		result: {
			protocolVersion: protocol,
			capabilities: { tools: {} },
			serverInfo: { name: 'legacy-peer', version: '1.0.0' },
		},
	}
}

export function createLegacyTools(): ToolManagerInterface {
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
	return tools
}

export const MCP_LEGACY_DESCRIPTORS = [
	{ name: 'good', inputSchema: { type: 'object' } },
	{ name: 'missing', inputSchema: { type: 'object' } },
	{ name: 'nan', inputSchema: { type: 'object' } },
	{ name: 'failure', inputSchema: { type: 'object' } },
	{ name: 'oversized', inputSchema: { type: 'object' } },
]

export const MCP_LEGACY_CASES: ReadonlyArray<
	readonly [string, JSONRPCInvocation, JSONRPCResponse | undefined]
> = [
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
		{ jsonrpc: '2.0', id: 9, result: { tools: MCP_LEGACY_DESCRIPTORS } },
	],
	[
		'tools-list-params',
		{ jsonrpc: '2.0', id: 10, method: 'tools/list', params: { cursor: 'ignored' } },
		{ jsonrpc: '2.0', id: 10, result: { tools: MCP_LEGACY_DESCRIPTORS } },
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
	// A method the MODERN era defines is refused by the legacy door for the same reason an
	// invented one is: the decorator forwards only what legacy names, so `server/discover`
	// reaches the same arm rather than a modern handler behind it.
	[
		'modern-method-not-found',
		{ jsonrpc: '2.0', id: 22, method: 'server/discover' },
		{
			jsonrpc: '2.0',
			id: 22,
			error: { code: -32601, message: 'Method not found: server/discover' },
		},
	],
	[
		'malformed-null-id',
		{ jsonrpc: '2.0', id: JSON.parse('null'), method: 'ping' },
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

export async function* createUnreachableStream(id: JSONRPCId): MCPStream {
	yield {
		jsonrpc: '2.0',
		method: 'notifications/progress',
		params: { progressToken: 'another-request', progress: 1 },
	}
	return buildJSONRPCResult(id, { resultType: 'complete' })
}

export const TOTALITY_SCHEMA: MCPElicitSchema = Object.freeze({
	type: 'object',
	properties: Object.freeze({}),
})

// The issued request `isMCPInputResponse` is measured against, for the same reason.
export const TOTALITY_REQUEST: MCPInputRequest = Object.freeze({
	method: 'elicitation/create',
	params: Object.freeze({ message: 'Approve?', requestedSchema: TOTALITY_SCHEMA }),
})

// Every published guard as a unary call. The guards taking a second argument are given a
// real one, because a guard starved of its bound would be answering a different question.
export type FixtureGuard = (value: unknown) => boolean

export const PUBLISHED_GUARDS: Readonly<Record<string, FixtureGuard>> = Object.freeze({
	isMCPToolError: core.isMCPToolError,
	isAbsoluteURI: core.isAbsoluteURI,
	isBoundedJSON: (value) => core.isBoundedJSON(value, { bytes: 4_096, keys: 64, depth: 16 }),
	isBoundedString: (value) => core.isBoundedString(value, 4_096),
	isElicitContent: (value) => core.isElicitContent(value, TOTALITY_SCHEMA),
	isFieldToken: core.isFieldToken,
	isInitializeRequest: core.isInitializeRequest,
	isPingRequest: core.isPingRequest,
	isJSONObject: core.isJSONObject,
	isJSONRPCError: core.isJSONRPCError,
	isJSONRPCErrorResponse: core.isJSONRPCErrorResponse,
	isJSONRPCId: core.isJSONRPCId,
	isJSONRPCInvocation: core.isJSONRPCInvocation,
	isJSONRPCMessage: core.isJSONRPCMessage,
	isJSONRPCNotification: core.isJSONRPCNotification,
	isJSONRPCRequest: core.isJSONRPCRequest,
	isJSONRPCResponse: core.isJSONRPCResponse,
	isJSONRPCResultResponse: core.isJSONRPCResultResponse,
	isMCPAnnotations: core.isMCPAnnotations,
	isMCPBlobResource: core.isMCPBlobResource,
	isMCPCallResult: core.isMCPCallResult,
	isMCPClientCapabilities: core.isMCPClientCapabilities,
	isMCPCompletion: core.isMCPCompletion,
	isMCPCompletionParams: core.isMCPCompletionParams,
	isMCPCompletionReference: core.isMCPCompletionReference,
	isMCPCompletionResult: core.isMCPCompletionResult,
	isMCPContent: core.isMCPContent,
	isMCPElicitFieldSchema: core.isMCPElicitFieldSchema,
	isMCPElicitForm: core.isMCPElicitForm,
	isMCPElicitRequest: core.isMCPElicitRequest,
	isMCPElicitResult: core.isMCPElicitResult,
	isMCPElicitSchema: core.isMCPElicitSchema,
	isMCPElicitURL: core.isMCPElicitURL,
	isMCPError: core.isMCPError,
	isMCPHeaderPrimitive: core.isMCPHeaderPrimitive,
	isMCPIcon: core.isMCPIcon,
	isMCPIdentity: core.isMCPIdentity,
	isMCPInputRequest: core.isMCPInputRequest,
	isMCPInputRequestMap: core.isMCPInputRequestMap,
	isMCPInputResponse: (value) => core.isMCPInputResponse(value, TOTALITY_REQUEST),
	isMCPInputResult: core.isMCPInputResult,
	isMCPLegacyVersion: core.isMCPLegacyVersion,
	isMCPLegacyResult: core.isMCPLegacyResult,
	isMCPLoggingLevel: core.isMCPLoggingLevel,
	isMCPMetaKey: core.isMCPMetaKey,
	isMCPMetaObject: core.isMCPMetaObject,
	isMCPModernVersion: core.isMCPModernVersion,
	isMCPProgress: core.isMCPProgress,
	isMCPPaginationParams: core.isMCPPaginationParams,
	isMCPPrompt: core.isMCPPrompt,
	isMCPPromptArgument: core.isMCPPromptArgument,
	isMCPPromptGetResult: core.isMCPPromptGetResult,
	isMCPPromptMessage: core.isMCPPromptMessage,
	isMCPPromptPage: core.isMCPPromptPage,
	isMCPResource: core.isMCPResource,
	isMCPResourceContents: core.isMCPResourceContents,
	isMCPResourcePage: core.isMCPResourcePage,
	isMCPResourceTemplate: core.isMCPResourceTemplate,
	isMCPResourceTemplatePage: core.isMCPResourceTemplatePage,
	isMCPResult: core.isMCPResult,
	isMCPResultMetaObject: core.isMCPResultMetaObject,
	isMCPRoot: core.isMCPRoot,
	isMCPRootResult: core.isMCPRootResult,
	isMCPSampleContent: core.isMCPSampleContent,
	isMCPSampleResult: core.isMCPSampleResult,
	isMCPServerCapabilities: core.isMCPServerCapabilities,
	isMCPStringArguments: core.isMCPStringArguments,
	isMCPSubscriptionFilter: core.isMCPSubscriptionFilter,
	isMCPConsumerFilter: core.isMCPConsumerFilter,
	isMCPSubscriptionResult: core.isMCPSubscriptionResult,
	isMCPNotificationMetaObject: core.isMCPNotificationMetaObject,
	isMCPTaskDetail: core.isMCPTaskDetail,
	isMCPTaskDetailResult: core.isMCPTaskDetailResult,
	isMCPTaskNotification: core.isMCPTaskNotification,
	isMCPTaskResult: core.isMCPTaskResult,
	isMCPTaskStatus: core.isMCPTaskStatus,
	isMCPTextResource: core.isMCPTextResource,
	isMCPToolAnnotations: core.isMCPToolAnnotations,
	isMCPVersion: core.isMCPVersion,
	isModernRequest: core.isModernRequest,
	isRFC3339Date: core.isRFC3339Date,
	isRFC3339DateTime: core.isRFC3339DateTime,
	isStandardBase64: core.isStandardBase64,
})

// The sweep itself, so the guards and their control run the identical loop.
export function sweepGuard(
	guard: (value: unknown) => boolean,
	battery: readonly unknown[],
): readonly number[] {
	const escaped: number[] = []
	for (const [index, value] of battery.entries()) {
		try {
			guard(value)
		} catch {
			escaped.push(index)
		}
	}
	return escaped
}

// The instrument's negative control, drawn from OUTSIDE the population it certifies: the exact
// shape `isJSONRPCError` shipped with — two named key reads and no boundary at all. The sweep
// must REPORT this, or a clean run over the published guards has measured nothing.
export function readFixtureKeys(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) return false
	return (
		typeof Reflect.get(value, 'code') === 'number' &&
		typeof Reflect.get(value, 'message') === 'string'
	)
}

/** Supplies an ordinary class instance for exact-JSON rejection. */
export class MCPValueFixture {
	readonly value = true
}

export const NATIVE_ABORT_TIMEOUT = AbortSignal.timeout
export const RECORDED_ABORT_DEADLINES: number[] = []

export function recordAbortTimeout(deadline: number): AbortSignal {
	RECORDED_ABORT_DEADLINES.push(deadline)
	return NATIVE_ABORT_TIMEOUT(deadline)
}

// MCPClient ↔ a REAL MCPServer over an in-process LOOPBACK transport (a
// real server + real ToolManager, no mocks of the unit under test). The loopback's
// `send` dispatches each message through the server's `dispatch` and emits the response
// back on its `message` event, so the full `initialize` / `tools/list` / `tools/call`
// path runs in-process and deterministically. The OVER-FETCH JSON/SSE wire path is
// pinned in tests/src/server/integration.test.ts. Here: the handshake, tool discovery + local-tool
// wrapping (the wrapped `execute` calls back over the loopback), the content round-trip
// + a remote-error → local throw, id correlation, the per-request timeout, and
// disconnect rejecting pending requests.

// An in-process loopback ClientTransport over a real MCPServer: each sent message is
// dispatched through the server and its response (if any) emitted on `message` — a real
// transport, not a mock. `gate` optionally WITHHOLDS the response for a chosen method
// (so a request stays pending), to drive the timeout / disconnect paths. `sent` records
// every method sent, for the correlation / handshake assertions.
export interface DispatchPeerInterface extends MCPMessageTransportInterface {
	readonly sent: readonly string[]
	readonly requests: readonly JSONRPCInvocation[]
	readonly started: number
	readonly closed: number
	// The ORDERED transport lifecycle, recording each `start` / `close` at the moment the step
	// hands control back — including a `close` that then FAULTS, because the client did perform
	// it. Counts alone cannot see an interleaving: `{started: 2, closed: 1}` is the same tally
	// whether the second start ran before or after the close finished.
	readonly lifecycle: readonly string[]
}

// A fixture peer additionally exposes `release()`, which drains every suspended lifecycle step
// the peer is parking — a `close.hold`-suspended `close()`, a `send.park`-suspended
// `send()`, a `start.hold`-suspended `start()`, or any of them — and `live`: how many connections
// it has OPEN. `live` is the instrument the attempt counters cannot be. `closed` counts
// close ATTEMPTS, so `{ started: 2, closed: 2 }` reads identically whether both connections closed
// or one close FAILED and left its connection open with no path back to it; `lifecycle` records the
// same attempts in order and cannot separate them either. `live` rises when a `start()` completes
// and falls only when a `close()` SUCCEEDS, so it is the one reading that answers "is anything
// still open".
//
// Recorded gap: `release()` drains ONE shared list, so "release the held close while the held start
// stays held" is inexpressible. No scenario here needs it — every test holding two steps at once
// releases them in the order the client reaches them — but a test that must free one kind of
// suspension while another stays parked needs the list split by step first.
export interface FixturePeerInterface extends DispatchPeerInterface {
	readonly live: number
	release(): void
}

export function createDispatchPeer(
	server: MCPDispatcherInterface,
	gate?: (method: string) => boolean,
): DispatchPeerInterface {
	const emitter = createEmitter<MCPMessageTransportEventMap>()
	const requests: JSONRPCInvocation[] = []
	const lifecycle: string[] = []
	const started = new MCPFixtureCell(0)
	const closed = new MCPFixtureCell(0)
	return {
		emitter,
		session: undefined,
		duplex: true,
		get sent() {
			return requests.map((request) => request.method)
		},
		get requests() {
			return requests
		},
		get started() {
			return started.value
		},
		get closed() {
			return closed.value
		},
		get lifecycle() {
			return lifecycle
		},
		async start() {
			started.value += 1
			lifecycle.push('start')
		},
		async send(message: JSONRPCMessage) {
			if (!('method' in message)) return
			requests.push(message)
			const answer = await server.dispatch(message)
			// This scripted peer drives only unary methods, so a held-open stream never
			// arrives here; narrow it off rather than pretending it is a message.
			if (answer === undefined || Symbol.asyncIterator in answer) return
			// `gate(method)` true → withhold the response (the request stays pending), to
			// drive the timeout / disconnect tests; otherwise emit it for id correlation.
			if (gate === undefined || !gate(message.method)) emitter.emit('message', answer)
		},
		async close() {
			closed.value += 1
			lifecycle.push('close')
		},
	}
}

// The peer's seams, grouped under the transport method each one shapes. Every leaf answers for ONE
// call, keyed by that call's 1-based count, because a boolean seam cannot express "the first close
// fails, the second succeeds" — which is exactly what the client documents about a faulted close,
// and what no instrument in this file could previously produce.
export interface FixturePeerOptions {
	// The scripted answer to one request: a correlated response, a transport failure, or nothing.
	readonly reply: (request: JSONRPCInvocation, count: number) => JSONRPCResponse | Error | undefined
	// The OPENING step's seams. `hold` suspends the chosen `start()` through the shared
	// held-resolver list — a transport whose socket or session is still coming up — until
	// `release()` drains it; `enter` runs at `start()`'s first statement, before any await, so an
	// injected transport can re-enter the client at the one position that observes what the client
	// published before it handed control away. `fault` makes the chosen `start()` FAIL after it has
	// already opened its connection — the acquire-then-reject class, which the client cannot see and
	// therefore cannot clean up.
	readonly start?: {
		readonly hold?: (count: number) => boolean
		readonly enter?: () => void
		readonly fault?: (count: number) => boolean
	}
	// `park` suspends the write of the chosen method through that same list, for a slow write of a
	// handshake step, so a test can observe what the client does WHILE the write is still in flight.
	// Keyed by the same 1-based request count `reply` receives, so "the FIRST notification, not the
	// one a reconnect sends" is a predicate rather than a counter smuggled into the test.
	readonly send?: { readonly park?: (method: string, count: number) => boolean }
	// `hold` suspends the chosen `close()` — a real transport whose shutdown takes time, a socket
	// draining, an HTTP session ending — so a test can observe what the client does WHILE a close is
	// still in flight; a held close the test never releases is a shutdown that never returns at all.
	// `fault` makes the chosen `close()` FAIL: a socket that refuses to drain, a peer that rejects
	// the shutdown.
	readonly close?: {
		readonly hold?: (count: number) => boolean
		readonly fault?: (count: number) => boolean
	}
	// What the carrier declares about client-initiated notifications. Defaults to a duplex
	// channel; `false` is the CONTROL for every claim about a cancellation frame, because it
	// is the carrier class the frame structurally cannot reach — a request/response transport
	// with no client→server notification channel at all, not a duplex one behaving badly.
	readonly duplex?: boolean
}

// A minimal protocol-faithful peer for negotiation paths a conforming local MCPServer cannot
// produce. The script returns a correlated response, no response, or a transport failure; the peer
// records every real JSON-RPC request, preserves the lifecycle counts, and counts its own live
// connections. No fake clock, no mock: each suspension is a real unresolved promise the test itself
// settles, and each fault is a real rejection out of the real interface.
export function createFixturePeer(options: FixturePeerOptions): FixturePeerInterface {
	const emitter = createEmitter<MCPMessageTransportEventMap>()
	const requests: JSONRPCInvocation[] = []
	const lifecycle: string[] = []
	const held: Array<() => void> = []
	const started = new MCPFixtureCell(0)
	const closed = new MCPFixtureCell(0)
	const live = new MCPFixtureCell(0)
	return {
		emitter,
		session: undefined,
		duplex: options.duplex ?? true,
		get sent() {
			return requests.map((request) => request.method)
		},
		get requests() {
			return requests
		},
		get started() {
			return started.value
		},
		get closed() {
			return closed.value
		},
		get lifecycle() {
			return lifecycle
		},
		get live() {
			return live.value
		},
		async start() {
			options.start?.enter?.()
			// Indexed off the count this call WILL take: `started` moves once the open completes, so
			// a test can still read `started === 0` while the opening step is suspended.
			if (options.start?.hold?.(started.value + 1) === true) {
				await new Promise<void>((resolve) => {
					held.push(resolve)
				})
			}
			started.value += 1
			live.value += 1
			lifecycle.push('start')
			// Opened, then refused: the connection exists and the caller is told the open failed, so
			// nothing on the client side ever has a claim on it. Recorded AFTER `live` rises, because
			// that strand is the whole point of the seam.
			if (options.start?.fault?.(started.value) === true) throw new Error('transport start failed')
		},
		async send(message) {
			if (!('method' in message)) return
			requests.push(message)
			const count = requests.length
			// A parked write has left the client but not yet reached the peer, so the peer
			// answers only once `release()` lets the write land.
			if (options.send?.park?.(message.method, count) === true) {
				await new Promise<void>((resolve) => {
					held.push(resolve)
				})
			}
			const response = options.reply(message, count)
			if (response instanceof Error) throw response
			if (response !== undefined) emitter.emit('message', response)
		},
		async close() {
			// Counted on ENTRY, so a suspended close still has a stable index and the seams can name
			// it; `lifecycle` still records the attempt only once the step hands control back.
			closed.value += 1
			const count = closed.value
			if (options.close?.hold?.(count) === true) {
				await new Promise<void>((resolve) => {
					held.push(resolve)
				})
			}
			// Recorded BEFORE the fault: a close that failed is still a close this client
			// performed, and the count of attempts is what a retry has to move. What it did NOT do
			// is close anything — so only a close that reaches the end lowers `live`.
			lifecycle.push('close')
			if (options.close?.fault?.(count) === true) throw new Error('transport close failed')
			// `live` refuses to go negative and says so instead. A close reaching here ends a
			// connection, so finding none open means this peer was asked to shut down something that
			// was not there — a second close over one connection, or a close landing after a later
			// attempt already closed it. A counter that silently reaches -1 cannot report the defect
			// it exists to detect, and a raced-away rejection nobody is waiting for is invisible, so
			// the lifecycle carries the marker too.
			if (live.value === 0) {
				lifecycle.push('overclose')
				throw new Error('transport closed a connection that was not open')
			}
			live.value -= 1
		},
		release() {
			for (const resolve of held.splice(0)) resolve()
		},
	}
}

export function buildClientHandshakeResponse(
	id: string | number,
	protocol: unknown,
): JSONRPCResponse {
	return {
		jsonrpc: '2.0',
		id,
		result: {
			protocolVersion: protocol,
			capabilities: {},
			serverInfo: { name: 'fixture', version: '1.0.0' },
		},
	}
}

export function buildPeerDiscovery(
	id: string | number,
	versions: readonly unknown[] = ['2026-07-28', '2025-11-25'],
	fields: Readonly<Record<string, unknown>> = {},
): JSONRPCResponse {
	return {
		jsonrpc: '2.0',
		id,
		result: {
			supportedVersions: versions,
			capabilities: { tools: {} },
			resultType: 'complete',
			ttlMs: 60_000,
			cacheScope: 'private',
			...fields,
		},
	}
}

// One scripted `tools/call` answer, carrying whatever result the test needs — the arms a
// conforming local MCPServer never produces (a deferred task, an input request, a
// `resultType` no revision defines) all arrive this way.
export function buildPeerCallResponse(
	id: string | number,
	result: Readonly<Record<string, unknown>>,
): JSONRPCResponse {
	return { jsonrpc: '2.0', id, result }
}

// A modern peer that always completes discovery and hands every other request to `answer`.
// `duplex` is the carrier's own declaration, so a test can put the SAME scenario on a
// carrier that cannot take a client notification at all.
export function createCallPeer(
	answer: (request: JSONRPCInvocation, count: number) => JSONRPCResponse | Error | undefined,
	duplex = true,
): FixturePeerInterface {
	return createFixturePeer({
		duplex,
		reply: (request, count) => {
			if (request.id === undefined) return undefined
			if (request.method === 'server/discover') return buildPeerDiscovery(request.id)
			return answer(request, count)
		},
	})
}

// The id the peer saw on its `count`-th request (1-based) — the correlation a test needs to
// address a specific in-flight request, rather than assuming the client's counter.
export function readPeerRequestId(peer: DispatchPeerInterface, count: number): string | number {
	const id = peer.requests[count - 1]?.id
	if (id === undefined) throw new Error(`Expected request ${count} to carry an id`)
	return id
}

// A carrier whose `tools/call` write FAILS, in one of the shapes a failing write can
// take — and they are one keyword apart. `throws` picks it: `true` is a non-`async` `send`
// that throws SYNCHRONOUSLY, which `MCPMessageTransportInterface` forbids; `false` is the same
// non-`async` `send` returning a REJECTED promise, which is what the contract requires. The
// carrier is `duplex` either way, so a cancellation frame CAN reach it and its absence means
// the client did not write one rather than that nothing could have carried it.
//
// Deliberately NOT built on `createFixturePeer`: every peer in this file declares `async send`,
// and an `async` function converts a synchronous throw into a rejection — which is the whole
// difference under test. This is the one carrier that has to be written the other way.
export function createWritePeer(throws: boolean): DispatchPeerInterface {
	const emitter = createEmitter<MCPMessageTransportEventMap>()
	const requests: JSONRPCInvocation[] = []
	const lifecycle: string[] = []
	const started = new MCPFixtureCell(0)
	const closed = new MCPFixtureCell(0)
	return {
		emitter,
		session: undefined,
		duplex: true,
		get sent() {
			return requests.map((request) => request.method)
		},
		get requests() {
			return requests
		},
		get started() {
			return started.value
		},
		get closed() {
			return closed.value
		},
		get lifecycle() {
			return lifecycle
		},
		async start() {
			started.value += 1
			lifecycle.push('start')
		},
		send(message: JSONRPCMessage): Promise<void> {
			if (!('method' in message)) return Promise.resolve()
			requests.push(message)
			if (message.method === 'server/discover' && message.id !== undefined) {
				emitter.emit('message', buildPeerDiscovery(message.id))
				return Promise.resolve()
			}
			if (message.method !== 'tools/call') return Promise.resolve()
			const failure = new Error('write failed')
			if (throws) throw failure
			return Promise.reject(failure)
		},
		async close() {
			closed.value += 1
			lifecycle.push('close')
		},
	}
}

// One inbound progress frame naming a request by its progress token.
export function buildPeerProgress(token: string | number, progress: number): JSONRPCMessage {
	return {
		jsonrpc: '2.0',
		method: 'notifications/progress',
		params: { progressToken: token, progress },
	}
}

export function buildPeerError(id: string | number, code: number, data?: unknown): JSONRPCResponse {
	return {
		jsonrpc: '2.0',
		id,
		error: {
			code,
			message: code === MCP_UNSUPPORTED_VERSION ? 'Unsupported protocol version' : 'Legacy peer',
			...(data === undefined ? {} : { data }),
		},
	}
}

// A real ToolManager carrying a deterministic `echo` (returns a structured value),
// a `greet` (a plain string), and a `boom` (throws — the manager isolates it into a
// result error, which the server maps to an `isError` tool result).
export function createPeerTools(): ToolManagerInterface {
	const tools = createToolManager()
	tools.add(
		createTool({
			name: 'echo',
			description: 'Echo the arguments back',
			parameters: { type: 'object', properties: { value: { type: 'string' } } },
			execute: (args) => ({ echoed: args['value'] }),
		}),
	)
	tools.add(createTool({ name: 'greet', execute: () => 'hello' }))
	tools.add(
		createTool({
			name: 'boom',
			execute: () => {
				throw new Error('tool exploded')
			},
		}),
	)
	return tools
}

export function createPeerServer(): MCPDispatcherInterface {
	return createMCPLegacy(
		createMCPServer({
			identity: { name: 'loopback', version: '1.2.3' },
			tools: createPeerTools(),
		}),
	)
}

export class MemoryContinuation implements MCPContinuationInterface {
	readonly #values = new Map<string, string>()
	readonly #sealed: string[] = []
	readonly #opened: string[] = []
	readonly #seal: ((count: number) => void) | undefined
	#payload: string | undefined

	constructor(seal?: (count: number) => void) {
		this.#seal = seal
	}

	/** Every canonical payload the server asked this port to protect, in order. */
	get sealed(): readonly string[] {
		return this.#sealed
	}

	/** Every carrier the server asked this port to recover, in order. */
	get opened(): readonly string[] {
		return this.#opened
	}

	/** Make `open` succeed while handing back a payload the server never authored. */
	corrupt(payload: string): void {
		this.#payload = payload
	}

	async seal(value: string): Promise<string> {
		this.#sealed.push(value)
		await this.#seal?.(this.#sealed.length)
		const key = crypto.randomUUID()
		this.#values.set(key, value)
		return key
	}

	async open(value: string): Promise<string | undefined> {
		this.#opened.push(value)
		return this.#payload ?? this.#values.get(value)
	}
}

export class MemoryPromptManager implements MCPPromptManagerInterface {
	readonly #cursors: Array<string | undefined> = []
	readonly #requests: MCPPromptGetParams[] = []
	readonly #options: MCPMethodOptions[] = []

	get cursors(): ReadonlyArray<string | undefined> {
		return this.#cursors
	}

	get requests(): readonly MCPPromptGetParams[] {
		return this.#requests
	}

	get options(): readonly MCPMethodOptions[] {
		return this.#options
	}

	prompts(pagination: MCPPaginationParams, options: MCPMethodOptions): MCPPromptPage {
		this.#cursors.push(pagination.cursor)
		this.#options.push(options)
		return pagination.cursor === undefined
			? {
					prompts: [
						{
							name: 'greet',
							title: 'Greeting',
							arguments: [{ name: 'person', required: true }],
						},
					],
					nextCursor: 'second',
				}
			: { prompts: [{ name: 'summarize', description: 'Summarize one resource' }] }
	}

	prompt(
		params: MCPPromptGetParams,
		options: MCPMethodOptions,
	): MCPPromptGetResult | MCPInputResult | undefined {
		this.#requests.push(params)
		this.#options.push(options)
		if (params.name === 'input') {
			return { resultType: 'input_required', requestState: 'prompt-state' }
		}
		// The arm that ASKS the client something. The carrier-only arm above asks nothing, so
		// only this one reaches the server's capability gate.
		if (params.name === 'round') {
			return {
				resultType: 'input_required',
				inputRequests: { context: { method: 'sampling/createMessage', params: {} } },
				requestState: 'prompt-state',
			}
		}
		if (params.name !== 'greet') return undefined
		return {
			resultType: 'complete',
			description: 'A rendered greeting',
			messages: [
				{ role: 'user', content: { type: 'text', text: `Hello ${params.arguments?.['person']}` } },
				{
					role: 'assistant',
					content: {
						type: 'resource',
						resource: { uri: 'memory://resource/greeting', text: 'Welcome' },
					},
				},
			],
		}
	}
}

export class MemoryCompletion implements MCPCompletionInterface {
	readonly #requests: MCPCompletionParams[] = []

	get requests(): readonly MCPCompletionParams[] {
		return this.#requests
	}

	complete(params: MCPCompletionParams, _options: MCPMethodOptions): MCPCompletion | undefined {
		this.#requests.push(params)
		if (params.ref.type === 'ref/prompt') {
			if (params.ref.name === 'many') {
				return { values: Array.from({ length: 105 }, (_, index) => `candidate-${index}`) }
			}
			return params.ref.name === 'greet' ? { values: ['Ada', 'Grace'], total: 2 } : undefined
		}
		return params.ref.uri === 'memory://resource/{name}'
			? { values: ['one', 'two'], hasMore: false }
			: undefined
	}
}

export function createRound(
	request: MCPElicitForm = APPROVAL_FORM,
	state?: JSONValue,
): MCPInputRound {
	const requests: MCPInputRequestMap = {
		approval: { method: 'elicitation/create', params: request },
	}
	return state === undefined ? { requests } : { requests, state }
}

export function buildMixedCall(): Readonly<Record<string, unknown>> {
	return {
		name: 'echo',
		_meta: {
			[MCP_META_VERSION]: '2026-07-28',
			[MCP_META_CAPABILITIES]: { elicitation: {}, sampling: {}, roots: {} },
		},
	}
}

export async function* createServerProgress(id: JSONRPCId): MCPStream {
	yield { jsonrpc: '2.0', method: 'notifications/progress', params: { step: 1 } }
	yield { jsonrpc: '2.0', method: 'notifications/progress', params: { step: 2 } }
	return buildJSONRPCResult(id, { done: true })
}

export async function createHeldMethod(request: JSONRPCRequest): Promise<MCPStream> {
	return createServerProgress(request.id)
}

export async function drainStream(
	stream: MCPStream,
): Promise<readonly [readonly JSONRPCNotification[], JSONRPCResponse]> {
	const messages: JSONRPCNotification[] = []
	while (true) {
		const next = await stream.next()
		if (next.done) return [messages, next.value]
		messages.push(next.value)
	}
}

export async function drainText(
	stream: MCPTextStream,
): Promise<readonly [readonly string[], string]> {
	const messages: string[] = []
	while (true) {
		const next = await stream.next()
		if (next.done) return [messages, next.value]
		messages.push(next.value)
	}
}

export function readStreamAnswer(
	answer: JSONRPCResponse | MCPStreamControllerInterface | undefined,
): MCPStreamControllerInterface {
	if (answer === undefined || !(Symbol.asyncIterator in answer)) {
		throw new Error('expected a held-open stream, got a unary answer')
	}
	return answer
}

export function readTextAnswer(answer: string | MCPTextStream | undefined): MCPTextStream {
	if (answer === undefined || typeof answer === 'string') {
		throw new Error('expected a serialized held-open stream, got a unary answer')
	}
	return answer
}

export function createServerTools(): ToolManagerInterface {
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

export function createTestServer(
	error?: EmitterErrorHandler,
	subscription?: MCPSubscriptionOptions,
) {
	const mcp = createMCPServer({
		identity: { name: 'test-server', version: '1.2.3' },
		tools: createServerTools(),
		...(error === undefined ? {} : { error }),
		...(subscription === undefined ? {} : { subscription }),
	})
	return Object.assign(createMCPLegacy(mcp), {
		identity: mcp.identity,
		handshake: mcp.handshake,
		methods: mcp.methods,
	})
}

export function readUnaryAnswer(
	answer: JSONRPCResponse | MCPStream | undefined,
): JSONRPCResponse | undefined {
	if (answer !== undefined && Symbol.asyncIterator in answer) {
		throw new Error('expected a unary response, got a held-open stream')
	}
	return answer
}

export function readResultRecord(response: JSONRPCResponse | undefined): Record<string, unknown> {
	if (response === undefined) throw new Error('expected a response, got undefined')
	const result = response.result
	if (typeof result !== 'object' || result === null) {
		throw new Error('expected an object result')
	}
	const record: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(result)) record[key] = value
	return record
}

export interface FaultScenario {
	readonly name: string
	readonly server: MCPDispatcherInterface
	readonly request: JSONRPCRequest
}

export async function readStreamFault(
	answer: JSONRPCResponse | MCPStream | undefined,
): Promise<number | undefined> {
	if (answer === undefined) return undefined
	if (Symbol.asyncIterator in answer) return (await drainStream(answer))[1].error?.code
	return answer.error?.code
}

export async function readTextFault(
	answer: string | MCPTextStream | undefined,
): Promise<number | undefined> {
	if (answer === undefined) return undefined
	const text = typeof answer === 'string' ? answer : (await drainText(answer))[1]
	const parsed: unknown = JSON.parse(text)
	return isJSONRPCErrorResponse(parsed) ? parsed.error.code : undefined
}

export function buildModernCall(
	params: Readonly<Record<string, unknown>>,
	id: JSONRPCId = 1,
): JSONRPCRequest {
	return createJSONRPCRequest({
		method: 'tools/call',
		id,
		params: { ...params, _meta: MODERN_METADATA },
	})
}

export function createFaultServer(execution: () => never): MCPServerInterface {
	return createMCPServer({
		identity: { name: 'test-server', version: '1.2.3' },
		tools: createServerTools(),
		execution,
	})
}

export function createHandlerFaultServer(): MCPServerInterface {
	const mcp = createTestServer()
	mcp.methods.add('demo/boom', () => {
		throw new Error('handler detail must not escape')
	})
	return mcp
}

export function createSourceFaultServer(): MCPServerInterface {
	return createTestServer(undefined, {
		notifications: { promptsListChanged: true },
		producer: () => {
			throw new Error('subscription source detail')
		},
	})
}

export function createBoundedTools(name: string, value: unknown): ToolManagerInterface {
	const manager = createToolManager()
	manager.add(createTool({ name, execute: () => value }))
	return manager
}

export function completeExecution(): MCPCallResult {
	return { resultType: 'complete', content: [{ type: 'text', text: 'complete' }] }
}

export async function* createIdleStream(): MCPStream {
	await new Promise<void>(() => undefined)
	yield { jsonrpc: '2.0', method: 'notifications/progress' }
	return buildJSONRPCResult('parked-1', { resultType: 'complete' })
}

export async function* createIdleSource(): AsyncGenerator<JSONRPCNotification> {
	await new Promise<void>(() => undefined)
	yield { jsonrpc: '2.0', method: 'notifications/prompts/list_changed' }
}

export function createModernFaults(): readonly FaultScenario[] {
	const listen: JSONRPCRequest = createJSONRPCRequest({
		method: 'subscriptions/listen',
		id: 'listen-fault',
		params: { notifications: { promptsListChanged: true }, _meta: MODERN_METADATA },
	})
	const elicitMetadata = {
		[MCP_META_VERSION]: '2026-07-28',
		[MCP_META_CAPABILITIES]: { elicitation: {} },
	}
	return [
		{
			name: 'registered handler throw',
			server: createHandlerFaultServer(),
			request: modernRequest('demo/boom'),
		},
		{
			name: 'execution provider throw',
			server: createFaultServer(() => {
				throw new Error('provider detail must not escape')
			}),
			request: buildModernCall({ name: 'echo' }),
		},
		{
			name: 'malformed executor result',
			server: createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: createServerTools(),
				execution: new Proxy(completeExecution, { apply: () => 7 }),
			}),
			request: buildModernCall({ name: 'echo' }),
		},
		{
			name: 'unserializable tool value',
			server: createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: createBoundedTools('unserializable', { size: 1n }),
			}),
			request: buildModernCall({ name: 'unserializable' }),
		},
		{
			name: 'produced content beyond the bound',
			server: createMCPServer({
				identity: { name: 'bounded', version: '1.0.0' },
				tools: createBoundedTools('large', 'x'.repeat(64)),
				limit: { content: 24 },
			}),
			request: buildModernCall({ name: 'large' }),
		},
		// The value FITS and the wrapped payload does not: `snapshotToolResult` bounds the tool's
		// own value, and the modern content envelope built around it is bounded a second time. A
		// server whose bound sits between the two reaches a site no "oversized value" scenario
		// can, which is why this row exists beside the one above rather than instead of it.
		{
			name: 'wrapped content beyond the bound',
			server: createMCPServer({
				identity: { name: 'bounded', version: '1.0.0' },
				tools: createBoundedTools('fits', 'x'.repeat(16)),
				limit: { content: 20 },
			}),
			request: buildModernCall({ name: 'fits' }),
		},
		{
			name: 'subscription capacity exhausted',
			server: createMCPServer({
				identity: { name: 'bounded', version: '1.0.0' },
				tools: createServerTools(),
				limit: { subscriptions: 0 },
				subscription: {
					notifications: { promptsListChanged: true },
					producer: () => new TransformStream<JSONRPCNotification, JSONRPCNotification>().readable,
				},
			}),
			request: listen,
		},
		{ name: 'subscription source throw', server: createSourceFaultServer(), request: listen },
		{
			name: 'continuation provider throw',
			server: createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: createServerTools(),
				input: {
					continuation: {
						async seal() {
							return 'carrier'
						},
						async open() {
							throw new Error('continuation detail must not escape')
						},
					},
					ttl: 1_000,
					principal: () => 'operator-1',
					selector: () => createRound(),
				},
			}),
			request: createJSONRPCRequest({
				method: 'tools/call',
				id: 'continuation-fault',
				params: {
					name: 'echo',
					requestState: 'carrier',
					inputResponses: { key: { action: 'accept' } },
					_meta: elicitMetadata,
				},
			}),
		},
		// A port that OPENS SUCCESSFULLY is a different failure from one that throws, and it is
		// the provider's contract failure rather than the client's invalid state: the client
		// never wrote these bytes. Both arms below need a port that answers, so a throwing-open
		// scenario cannot stand in for either.
		{
			name: 'continuation port opens beyond the state bound',
			server: createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: createServerTools(),
				limit: { state: 16 },
				input: {
					continuation: {
						async seal() {
							return 'carrier'
						},
						async open() {
							return 'x'.repeat(64)
						},
					},
					ttl: 1_000,
					principal: () => 'operator-1',
					selector: () => createRound(),
				},
			}),
			request: createJSONRPCRequest({
				method: 'tools/call',
				id: 'opened-oversized',
				params: {
					name: 'echo',
					requestState: 'carrier',
					inputResponses: { key: { action: 'accept' } },
					_meta: elicitMetadata,
				},
			}),
		},
		{
			name: 'continuation port opens a malformed payload',
			server: createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: createServerTools(),
				input: {
					continuation: {
						async seal() {
							return 'carrier'
						},
						async open() {
							return 'this server never authored these bytes'
						},
					},
					ttl: 1_000,
					principal: () => 'operator-1',
					selector: () => createRound(),
				},
			}),
			request: createJSONRPCRequest({
				method: 'tools/call',
				id: 'opened-malformed',
				params: {
					name: 'echo',
					requestState: 'carrier',
					inputResponses: { key: { action: 'accept' } },
					_meta: elicitMetadata,
				},
			}),
		},
		{
			name: 'principal provider throw',
			server: createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: createServerTools(),
				input: {
					continuation: new MemoryContinuation(),
					ttl: 1_000,
					principal: () => {
						throw new Error('principal detail must not escape')
					},
					selector: () => createRound(),
				},
			}),
			request: createJSONRPCRequest({
				method: 'tools/call',
				id: 'principal-fault',
				params: { name: 'echo', _meta: elicitMetadata },
			}),
		},
	]
}

export function createLegacyFaults(): readonly FaultScenario[] {
	const cycle: Record<string, unknown> = {}
	cycle['self'] = cycle
	const failing = createToolManager()
	failing.add(
		createTool({
			name: 'boom',
			execute: () => {
				throw new Error('y'.repeat(64))
			},
		}),
	)
	return [
		{
			name: 'legacy hostile tool value',
			server: createMCPLegacy(
				createMCPServer({
					identity: { name: 'legacy', version: '1.0.0' },
					tools: createBoundedTools('cycle', cycle),
				}),
			),
			request: createJSONRPCRequest({
				method: 'tools/call',
				id: 'legacy-1',
				params: { name: 'cycle' },
			}),
		},
		{
			name: 'legacy content beyond the bound',
			server: createMCPLegacy(
				createMCPServer({
					identity: { name: 'legacy', version: '1.0.0' },
					tools: createBoundedTools('large', 'x'.repeat(64)),
					limit: { content: 24 },
				}),
			),
			request: createJSONRPCRequest({
				method: 'tools/call',
				id: 'legacy-2',
				params: { name: 'large' },
			}),
		},
		{
			name: 'legacy failure text beyond the bound',
			server: createMCPLegacy(
				createMCPServer({
					identity: { name: 'legacy', version: '1.0.0' },
					tools: failing,
					limit: { content: 24 },
				}),
			),
			request: createJSONRPCRequest({
				method: 'tools/call',
				id: 'legacy-3',
				params: { name: 'boom' },
			}),
		},
	]
}

export interface InputProbeInterface {
	readonly server: MCPServerInterface
	readonly continuation: MemoryContinuation
	/** The resolved options every `principal` call observed — its length is the call count. */
	readonly principals: readonly MCPMethodOptions[]
	/** Every selector context, in order — its length is the selector's call count. */
	readonly selections: readonly MCPInputContext[]
	/** Every argument record the tool actually executed with — its length is the run count. */
	readonly executions: ReadonlyArray<Readonly<Record<string, unknown>>>
}

export function createInputProbe(
	options: {
		/** How many form rounds the selector asks for before it lets the call through. */
		readonly rounds?: number
		readonly schema?: MCPElicitSchema
		readonly ttl?: number
		readonly clock?: () => number
		readonly selector?: (context: MCPInputContext) => void
		readonly seal?: (count: number) => void
	} = {},
): InputProbeInterface {
	const principals: MCPMethodOptions[] = []
	const selections: MCPInputContext[] = []
	const executions: Array<Readonly<Record<string, unknown>>> = []
	const continuation = new MemoryContinuation(options.seal)
	const rounds = options.rounds ?? 1
	const schema: MCPElicitSchema = options.schema ?? { type: 'object', properties: {} }
	const manager = createToolManager()
	manager.add(
		createTool({
			name: 'echo',
			execute: (args) => {
				executions.push(args)
				return args
			},
		}),
	)
	const probed = createMCPServer({
		identity: { name: 'test-server', version: '1.2.3' },
		tools: manager,
		input: {
			continuation,
			...(options.clock === undefined ? {} : { clock: options.clock }),
			ttl: options.ttl ?? 1_000,
			principal: (_request, resolved) => {
				principals.push(resolved)
				return 'operator-1'
			},
			selector: async (context) => {
				selections.push(context)
				await options.selector?.(context)
				return selections.length > rounds
					? undefined
					: createRound(
							{ message: `Approve round ${selections.length}?`, requestedSchema: schema },
							{ round: selections.length },
						)
			},
		},
	})
	return { server: probed, continuation, principals, selections, executions }
}

export function buildFormCall(
	id: JSONRPCId,
	params: Readonly<Record<string, unknown>> = {},
): JSONRPCRequest {
	return createJSONRPCRequest({
		id,
		method: 'tools/call',
		params: { name: 'echo', _meta: FORM_METADATA, ...params },
	})
}

export function readInputRound(response: JSONRPCResponse | undefined): {
	readonly key: string
	readonly requestState: string
	readonly issued: unknown
} {
	if (!isMCPInputResult(response?.result)) throw new Error('expected an input_required result')
	const key = Object.keys(response.result.inputRequests ?? {})[0]
	const requestState = response.result.requestState
	if (key === undefined || requestState === undefined) {
		throw new Error('expected the consumer’s key and protected request state')
	}
	return { key, requestState, issued: response.result.inputRequests?.[key] }
}

export async function* createSilentSource(): AsyncGenerator<JSONRPCNotification> {}

export function readSealedState(probe: InputProbeInterface, index: number): MCPInputState {
	const state = parseMCPInputState(probe.continuation.sealed[index])
	if (state === undefined) throw new Error(`expected sealed state at index ${index}`)
	return state
}

export function buildTaskCall(
	params: Readonly<Record<string, unknown>>,
	id: JSONRPCId = 1,
): JSONRPCRequest {
	return createJSONRPCRequest({
		method: 'tools/call',
		id,
		params: { ...params, _meta: TASK_METADATA },
	})
}

export function buildTaskRequest(
	method: string,
	params: Readonly<Record<string, unknown>>,
	id: JSONRPCId = 1,
): JSONRPCRequest {
	return createJSONRPCRequest({ method, id, params: { ...params, _meta: TASK_METADATA } })
}

export async function readCreatedTask(
	mcp: MCPServerInterface,
	id: JSONRPCId = 'create',
): Promise<string> {
	const answer = readResultRecord(
		readUnaryAnswer(await mcp.dispatch(buildTaskCall({ name: 'echo' }, id))),
	)
	const taskId = answer['taskId']
	if (typeof taskId !== 'string') throw new Error('expected a created task to carry a taskId')
	return taskId
}

export function createTaskFixtureServer(
	task: MCPTaskOptions,
	extra: Partial<MCPServerOptions> = {},
): MCPServerInterface {
	return createMCPServer({
		identity: { name: 'test-server', version: '1.2.3' },
		tools: createServerTools(),
		task,
		...extra,
	})
}

export function createFixedTasks(created: MCPTask): MCPTaskManagerInterface {
	return {
		start: () => Promise.resolve(created),
		task: () => Promise.resolve(undefined),
		update: () => Promise.resolve(),
		abort: () => Promise.resolve(),
	}
}

export function createMutableTasks(details: Map<string, MCPTaskDetail>): MCPTaskManagerInterface {
	return {
		start: (key) => {
			const found = details.get(key)
			if (found === undefined) throw new Error('unseeded operation key')
			return Promise.resolve(found)
		},
		task: (id) => Promise.resolve(details.get(id)),
		update: () => Promise.resolve(),
		abort: () => Promise.resolve(),
	}
}

export function createDeferredTasks(): MCPTaskManagerInterface {
	const details = new Map<string, MCPTaskDetail>()
	const created: MCPTaskDetail = {
		taskId: 'task-late',
		status: 'working',
		createdAt: '1970-01-01T00:00:01.000Z',
		lastUpdatedAt: '1970-01-01T00:00:01.000Z',
		ttlMs: null,
	}
	return {
		start: () => {
			void waitForDelay(20).then(() => void details.set(created.taskId, created))
			return Promise.resolve(created)
		},
		task: (id) => Promise.resolve(details.get(id)),
		update: () => Promise.resolve(),
		abort: () => Promise.resolve(),
	}
}

export function createGuessableTasks(): MCPTaskManagerInterface {
	const details = new Map<string, MCPTaskDetail>()
	return {
		start: (key) => {
			const existing = details.get(key)
			if (existing !== undefined) return Promise.resolve(existing)
			const created: MCPTaskDetail = {
				taskId: key,
				status: 'working',
				createdAt: '1970-01-01T00:00:01.000Z',
				lastUpdatedAt: '1970-01-01T00:00:01.000Z',
				ttlMs: null,
			}
			details.set(key, created)
			return Promise.resolve(created)
		},
		task: (id) => Promise.resolve(details.get(id)),
		update: () => Promise.resolve(),
		abort: () => Promise.resolve(),
	}
}

export function readAbsentTask(): Promise<null> {
	return Promise.resolve(null)
}

export function createWatchedTasks(
	read: MCPTaskManagerInterface['task'],
	invoked: string[],
): MCPTaskManagerInterface {
	return {
		start: () => Promise.reject(new Error('nothing is created here')),
		task: read,
		update: (id) => {
			invoked.push(`update:${id}`)
			return Promise.resolve()
		},
		abort: (id) => {
			invoked.push(`abort:${id}`)
			return Promise.resolve()
		},
	}
}

export const MCP_EVENTS = ['request'] as const

export const APPROVAL_FORM: MCPElicitForm = {
	message: 'Approve?',
	requestedSchema: { type: 'object', properties: {} },
}

export const MIXED_ROUND: MCPInputRequestMap = Object.freeze({
	user_name: {
		method: 'elicitation/create',
		params: {
			message: 'What is your name?',
			requestedSchema: {
				type: 'object',
				properties: { name: { type: 'string' } },
				required: ['name'],
			},
		},
	},
	greeting: {
		method: 'sampling/createMessage',
		params: {
			messages: [{ role: 'user', content: { type: 'text', text: 'Generate a greeting' } }],
			maxTokens: 50,
		},
	},
	client_roots: { method: 'roots/list', params: {} },
})

export const MIXED_ANSWERS: MCPInputResponseMap = Object.freeze({
	user_name: { action: 'accept', content: { name: 'Ada' } },
	greeting: {
		role: 'assistant',
		content: { type: 'text', text: 'Hello, Ada.' },
		model: 'test-model',
		stopReason: 'endTurn',
	},
	client_roots: { roots: [{ uri: 'file:///workspace', name: 'workspace' }] },
})

export const FORM_METADATA: Readonly<Record<string, unknown>> = Object.freeze({
	[MCP_META_VERSION]: '2026-07-28',
	[MCP_META_CAPABILITIES]: Object.freeze({ elicitation: {} }),
})

export const APPROVAL_SCHEMA: MCPElicitSchema = {
	type: 'object',
	properties: {
		approved: { type: 'boolean' },
		count: { type: 'integer', minimum: 1, maximum: 5 },
	},
	required: ['approved'],
}

export const TASK_METADATA: Readonly<Record<string, unknown>> = Object.freeze({
	[MCP_META_VERSION]: '2026-07-28',
	[MCP_META_CAPABILITIES]: TASK_CAPABILITIES,
})

export const TASK_METHODS = Object.freeze(['tasks/get', 'tasks/update', 'tasks/cancel'] as const)

export function createFaultContinuation(
	sealed: MCPFixtureCell<string>,
	mode: MCPFixtureCell<'reject' | 'oversize'>,
): MCPContinuationInterface {
	return {
		async seal(value) {
			sealed.value = value
			return 'carrier'
		},
		async open() {
			if (mode.value === 'reject') throw new Error('continuation provider detail')
			return `${sealed.value.slice(0, -1)},"padding":"${'x'.repeat(1024)}"}`
		},
	}
}

export function createStartFaultTasks(): MCPTaskManagerInterface {
	return {
		start: () => {
			throw new Error('manager start detail')
		},
		task: () => Promise.resolve(undefined),
		update: () => Promise.resolve(),
		abort: () => Promise.resolve(),
	}
}

export function createStubbornTasks(
	details: Map<string, MCPTaskDetail>,
	asks: string[],
): MCPTaskManagerInterface {
	return {
		start: () => Promise.reject(new Error('nothing is created here')),
		task: (id) => Promise.resolve(details.get(id)),
		update: () => Promise.resolve(),
		abort: (id) => {
			asks.push(id)
			details.set(id, {
				taskId: id,
				status: 'completed',
				createdAt: 'a',
				lastUpdatedAt: 'c',
				ttlMs: null,
				result: { resultType: 'complete', content: [{ type: 'text', text: 'finished anyway' }] },
			})
			return Promise.resolve()
		},
	}
}

export function createReadFaultTasks(): MCPTaskManagerInterface {
	return {
		start: () =>
			Promise.resolve({
				taskId: 'task-1',
				status: 'working',
				createdAt: 'a',
				lastUpdatedAt: 'b',
				ttlMs: null,
			}),
		task: () => {
			throw new Error('manager read detail')
		},
		update: () => Promise.resolve(),
		abort: () => Promise.resolve(),
	}
}

export function createRecordedTasks(
	tasks: MCPTaskManagerInterface,
	seen: MCPMethodOptions[],
): MCPTaskManagerInterface {
	return {
		start: (key, context, options) => tasks.start(key, context, options),
		task: (id, options) => {
			seen.push(options)
			return tasks.task(id, options)
		},
		update: (id, responses, options) => {
			seen.push(options)
			return tasks.update(id, responses, options)
		},
		abort: (id, options) => {
			seen.push(options)
			return tasks.abort(id, options)
		},
	}
}

export async function declineAsyncTask(): Promise<undefined> {
	return undefined
}

export function buildProtectedPayload(overrides: Readonly<Record<string, unknown>> = {}): string {
	return JSON.stringify({
		principal: 'operator-1',
		expiry: 1_000,
		id: 7,
		version: '2026-07-28',
		method: 'tools/call',
		name: 'reply',
		digest: 'abc',
		requests: {
			confirm: {
				method: 'elicitation/create',
				params: {
					message: 'Approve?',
					requestedSchema: { type: 'object', properties: { approved: { type: 'boolean' } } },
				},
			},
		},
		...overrides,
	})
}

export interface TaskScenario {
	readonly client: MCPClientInterface
	readonly transport: TestTransportInterface
	readonly tasks: TestTaskManager
}

export async function connectTaskClient(
	options: { readonly poll?: number } = {},
): Promise<TaskScenario> {
	const tasks = new TestTaskManager({
		work: TASK_WORK,
		...(options.poll === undefined ? {} : { poll: options.poll }),
	})
	const transport = createRecordingTransport(createTaskServer(tasks))
	const client = createMCPClient({ transport, capabilities: TASK_CAPABILITIES })
	await client.connect()
	return { client, transport, tasks }
}

export async function startTask(client: MCPClientInterface): Promise<string> {
	const outcome = await client.call('render', { page: 3 })
	if (outcome.resultType !== 'task') {
		throw new Error(`expected a deferred call, got '${outcome.resultType}'`)
	}
	return outcome.taskId
}

export async function scheduleTaskReads(
	client: MCPClientInterface,
	id: string,
	interval: number,
	window: number,
): Promise<readonly MCPTaskDetail[]> {
	const seen: MCPTaskDetail[] = []
	const until = performance.now() + window
	while (performance.now() < until) {
		seen.push(await client.tasks.task(id))
		await waitForDelay(interval)
	}
	return seen
}

export function countFrames(frames: readonly TestFrame[], method: string): number {
	return frames.filter((frame) => frame.method === method).length
}

export const POLL_INTERVAL = 10

export const WATCH_WINDOW = 140

export const TASK_WORK = 200

export const METHOD_OPTIONS: MCPMethodOptions = { signal: new AbortController().signal }

export const TASK_CONTEXT: MCPTaskContext = {
	request: modernRequest('tools/call', 1),
	call: { id: 'call-1', name: 'render', arguments: {} },
	tools: createToolManager(),
}

export const MCP_CLONE_LIMITS = Object.freeze({ bytes: 256, keys: 8, depth: 4 })
