import type {
	JSONRPCId,
	JSONRPCInvocation,
	JSONRPCNotification,
	JSONRPCRequest,
	JSONRPCResponse,
	MCPCallResult,
	MCPCompletion,
	MCPCompletionInterface,
	MCPCompletionParams,
	MCPContinuationInterface,
	MCPDispatcherInterface,
	MCPMethodOptions,
	MCPElicitForm,
	MCPElicitSchema,
	MCPInputContext,
	MCPInputRequestMap,
	MCPInputResponseMap,
	MCPInputResult,
	MCPInputRound,
	MCPInputState,
	MCPPaginationParams,
	MCPPromptGetParams,
	MCPPromptGetResult,
	MCPPromptManagerInterface,
	MCPPromptPage,
	MCPProgress,
	MCPProgressInterface,
	MCPServerEventMap,
	MCPServerInterface,
	MCPServerOptions,
	MCPStream,
	MCPStreamControllerInterface,
	MCPSubscriptionHandler,
	MCPSubscriptionOptions,
	MCPTask,
	MCPTaskContext,
	MCPTaskDetail,
	MCPTaskManagerInterface,
	MCPTaskOptions,
	MCPTextStream,
} from '@src/core'
import type { JSONValue } from '@orkestrel/contract'
import type { EmitterErrorHandler } from '@orkestrel/emitter'
import type { ToolManagerInterface, ToolSuccess } from '@orkestrel/tool'
import {
	buildJSONRPCResult,
	createMCPLegacy,
	createMCPServer,
	DEFAULT_MCP_CACHE_TTL,
	DEFAULT_MCP_LIMITS,
	EMPTY_MCP_ARGUMENTS,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_METHOD_NOT_FOUND,
	JSONRPC_PARSE_ERROR,
	JSONRPC_INTERNAL_ERROR,
	JSONRPC_SERVER_ERROR,
	isJSONRPCErrorResponse,
	isMCPCompletionResult,
	isMCPInputResult,
	parseMCPInputState,
	MCP_EXTENSION_TASKS,
	MCP_META_CAPABILITIES,
	MCP_META_SERVER,
	MCP_META_SUBSCRIPTION,
	MCP_META_VERSION,
	MCP_HANDSHAKE_VERSION,
	MCP_MISSING_CAPABILITY,
	MCP_UNSUPPORTED_VERSION,
	MCPTextStreamController,
	SUPPORTED_MODERN_PROTOCOL_VERSIONS,
} from '@src/core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createTool, createToolManager } from '@orkestrel/tool'
import { createRecorder, createRecorders, waitForDelay } from '@orkestrel/test'
import {
	buildNestedRecord,
	createJSONRPCNotification,
	createJSONRPCRequest,
	createHostilePeer,
	createSubscriptionRequest,
	isMCPMethodHandler,
	MODERN_METADATA,
	MemoryResourceManager,
	modernRequest,
	TestTaskManager,
} from '../../setup.js'

// MCPServer is the transport-agnostic JSON-RPC 2.0 dispatch core that exposes a live
// ToolManager over MCP (a REAL ToolManager with real Tools, no mocks; no
// HTTP, no live model). Covers dispatch + handle for initialize (version negotiation,
// capabilities, serverInfo), ping, tools/list (parameters → inputSchema), tools/call
// (value round-trip, the isError tool mapping, missing-name → -32602), notifications
// (no id → no response; notifications/initialized), unknown method → -32601, handle's
// malformed-JSON → -32700 and non-request → -32600, plus the request event +
// observer-throw safety — and the modern METHOD SEAM: the built-ins registered on
// the same registry every dispatch resolves from, per-request options reaching a handler,
// and the held-open stream arm crossing both the typed and the string boundary.

const MCP_EVENTS = ['request'] as const

// The one continuation fixture: a real integrity port over an in-process map, plus the
// observations an MRTR proof needs from it — the exact canonical payloads it was asked to
// seal, and a settable stall so a test can make a provider await outlive a short TTL without
// replacing the host clock.
class MemoryContinuation implements MCPContinuationInterface {
	readonly #values = new Map<string, string>()
	readonly #sealed: string[] = []
	readonly #opened: string[] = []
	#delay = 0
	#payload: string | undefined

	/** Every canonical payload the server asked this port to protect, in order. */
	get sealed(): readonly string[] {
		return this.#sealed
	}

	/** Every carrier the server asked this port to recover, in order. */
	get opened(): readonly string[] {
		return this.#opened
	}

	/** Make `seal` await `ms` before answering — a real await that can outlive a short TTL. */
	stall(ms: number): void {
		this.#delay = ms
	}

	/** Make `open` succeed while handing back a payload the server never authored. */
	corrupt(payload: string): void {
		this.#payload = payload
	}

	async seal(value: string): Promise<string> {
		this.#sealed.push(value)
		if (this.#delay > 0) await waitForDelay(this.#delay)
		const key = crypto.randomUUID()
		this.#values.set(key, value)
		return key
	}

	async open(value: string): Promise<string | undefined> {
		this.#opened.push(value)
		return this.#payload ?? this.#values.get(value)
	}
}

class MemoryPromptManager implements MCPPromptManagerInterface {
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

class MemoryCompletion implements MCPCompletionInterface {
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

// The question every proof that does not care WHAT was asked asks.
const APPROVAL_FORM: MCPElicitForm = {
	message: 'Approve?',
	requestedSchema: { type: 'object', properties: {} },
}

// One round carrying a single form elicitation under `approval`. The key belongs to the
// CONSUMER now, so it is fixed here and read back by name rather than discovered from a round.
function createRound(request: MCPElicitForm = APPROVAL_FORM, state?: JSONValue): MCPInputRound {
	const requests: MCPInputRequestMap = {
		approval: { method: 'elicitation/create', params: request },
	}
	return state === undefined ? { requests } : { requests, state }
}

// One round of all three kinds at once — the shape the protocol permits and the mechanism
// could not express while it minted one key and issued one form.
const MIXED_ROUND: MCPInputRequestMap = Object.freeze({
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

// The client's answers to that round, one legal shape per kind.
const MIXED_ANSWERS: MCPInputResponseMap = Object.freeze({
	user_name: { action: 'accept', content: { name: 'Ada' } },
	greeting: {
		role: 'assistant',
		content: { type: 'text', text: 'Hello, Ada.' },
		model: 'test-model',
		stopReason: 'endTurn',
	},
	client_roots: { roots: [{ uri: 'file:///workspace', name: 'workspace' }] },
})

// A `tools/call` from a client that declared every kind `MIXED_ROUND` asks for.
function mixedCall(): Readonly<Record<string, unknown>> {
	return {
		name: 'echo',
		_meta: {
			[MCP_META_VERSION]: '2026-07-28',
			[MCP_META_CAPABILITIES]: { elicitation: {}, sampling: {}, roots: {} },
		},
	}
}

// A REAL held-open modern method (a genuine async generator, not a fake):
// two progress notifications, then the terminating response as the generator's `return`.
async function* progress(id: JSONRPCId): MCPStream {
	yield { jsonrpc: '2.0', method: 'notifications/progress', params: { step: 1 } }
	yield { jsonrpc: '2.0', method: 'notifications/progress', params: { step: 2 } }
	return buildJSONRPCResult(id, { done: true })
}

// The registered handler for it — an `MCPMethodHandler` whose answer is the stream arm. It
// narrows nothing: the seam carries the request arm, so `request.id` is always there.
async function holdOpen(request: JSONRPCRequest): Promise<MCPStream> {
	return progress(request.id)
}

// Drain a typed held-open answer into its yielded notifications and its terminating
// response — kept APART, because the terminating value is a `return`, not a `yield`, and
// that distinction is the contract under test.
async function drainStream(
	stream: MCPStream,
): Promise<readonly [readonly JSONRPCNotification[], JSONRPCResponse]> {
	const messages: JSONRPCNotification[] = []
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

// Narrow a dispatch answer to its HELD-OPEN arm — the mirror of `responseOf`. The arm is
// the CONTROLLED contract, because dispatch wraps whatever a method produced.
function streamOf(
	answer: JSONRPCResponse | MCPStreamControllerInterface | undefined,
): MCPStreamControllerInterface {
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
	const mcp = createMCPServer({
		identity: { name: 'test-server', version: '1.2.3' },
		tools: tools(),
		...(error === undefined ? {} : { error }),
		...(subscription === undefined ? {} : { subscription }),
	})
	return Object.assign(createMCPLegacy(mcp), {
		identity: mcp.identity,
		methods: mcp.methods,
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
// always records) — a guard standing in for an assertion, no `as`.
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

describe('MCPServer — hostile-input and live-resource limits over the wire', () => {
	it('publishes frozen secure defaults sized for ordinary MCP traffic', () => {
		expect(DEFAULT_MCP_LIMITS).toEqual({
			message: 1_048_576,
			metadata: 16_384,
			keys: 64,
			state: 16_384,
			content: 4_194_304,
			subscriptions: 128,
			depth: 32,
		})
		expect(Object.isFrozen(DEFAULT_MCP_LIMITS)).toBe(true)
	})

	it('rejects an oversized valid wire message as -32700 before parsing it', async () => {
		const mcp = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: tools(),
			limit: { message: 32 },
		})
		const peer = createHostilePeer(mcp)

		await peer.send('{"jsonrpc":"2.0","method":"ping","id":1}')

		expect(peer.response()?.error?.code).toBe(JSONRPC_PARSE_ERROR)
		peer.close()
	})

	it('applies metadata bounds to translated requests and rejects byte and key overflow', async () => {
		const absentServer = createMCPLegacy(
			createMCPServer({
				identity: { name: 'bounded', version: '1.0.0' },
				tools: tools(),
				limit: { metadata: 0 },
			}),
		)
		const absent = responseOf(
			await absentServer.dispatch(createJSONRPCRequest({ method: 'tools/list' })),
		)
		expect(absent?.error?.code).toBe(JSONRPC_INVALID_PARAMS)

		const sizeServer = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: tools(),
			limit: { metadata: 180 },
		})
		const sizePeer = createHostilePeer(sizeServer)
		await sizePeer.send(
			JSON.stringify(
				createJSONRPCRequest({
					method: 'tools/list',
					params: {
						_meta: {
							...MODERN_METADATA,
							padding: 'x'.repeat(200),
						},
					},
				}),
			),
		)
		expect(sizePeer.response()?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		sizePeer.close()

		const keyServer = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: tools(),
			limit: { metadata: 1_024, keys: 2 },
		})
		const keyPeer = createHostilePeer(keyServer)
		await keyPeer.send(
			JSON.stringify(
				createJSONRPCRequest({
					method: 'tools/list',
					params: { _meta: { ...MODERN_METADATA, extension: true } },
				}),
			),
		)
		expect(keyPeer.response()?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		keyPeer.close()
	})

	it('rejects prototype-pollution metadata sent by a real peer', async () => {
		const mcp = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: tools(),
		})
		const peer = createHostilePeer(mcp)
		await peer.send(
			'{"jsonrpc":"2.0","method":"tools/list","id":1,"params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"__proto__":true}}}',
		)

		expect(peer.response()?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		peer.close()
	})

	it('accepts absent requestState and bounds it before verification and after signing', async () => {
		const absent = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: tools(),
			limit: { state: 0 },
			input: {
				continuation: new MemoryContinuation(),
				ttl: 60_000,
				principal: () => 'user-1',
				selector: () => undefined,
			},
		})
		const absentResponse = responseOf(
			await absent.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: { name: 'echo', _meta: MODERN_METADATA },
				}),
			),
		)
		expect(resultOf(absentResponse)['resultType']).toBe('complete')

		const incoming = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: tools(),
			limit: { state: 64 },
			input: {
				continuation: new MemoryContinuation(),
				ttl: 60_000,
				principal: () => 'user-1',
				selector: () => undefined,
			},
		})
		const incomingPeer = createHostilePeer(incoming)
		await incomingPeer.send(
			JSON.stringify(
				createJSONRPCRequest({
					method: 'tools/call',
					params: {
						name: 'echo',
						inputResponses: {},
						requestState: 'x'.repeat(65),
						_meta: MODERN_METADATA,
					},
				}),
			),
		)
		expect(incomingPeer.response()?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		incomingPeer.close()

		const outgoing = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: tools(),
			limit: { state: 256 },
			input: {
				continuation: new MemoryContinuation(),
				ttl: 60_000,
				principal: () => 'user-1',
				selector: () => createRound(APPROVAL_FORM, 'x'.repeat(512)),
			},
		})
		const outgoingPeer = createHostilePeer(outgoing)
		await outgoingPeer.send(
			JSON.stringify(
				createJSONRPCRequest({
					method: 'tools/call',
					params: {
						name: 'echo',
						arguments: {},
						_meta: {
							[MCP_META_VERSION]: '2026-07-28',
							[MCP_META_CAPABILITIES]: { elicitation: {} },
						},
					},
				}),
			),
		)
		expect(outgoingPeer.response()?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		outgoingPeer.close()

		const signed = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: tools(),
			limit: { state: 150 },
			input: {
				continuation: new MemoryContinuation(),
				ttl: 60_000,
				principal: () => 'user-1',
				selector: () => createRound(),
			},
		})
		const signedPeer = createHostilePeer(signed)
		await signedPeer.send(
			JSON.stringify(
				createJSONRPCRequest({
					method: 'tools/call',
					params: {
						name: 'echo',
						_meta: {
							[MCP_META_VERSION]: '2026-07-28',
							[MCP_META_CAPABILITIES]: { elicitation: {} },
						},
					},
				}),
			),
		)
		expect(signedPeer.response()?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		signedPeer.close()
	})

	it('routes oversized legacy tool content through the modern -32603 pipeline', async () => {
		const manager = createToolManager()
		manager.add(createTool({ name: 'large', execute: () => 'x'.repeat(32) }))
		const mcp = createMCPLegacy(
			createMCPServer({
				identity: { name: 'bounded', version: '1.0.0' },
				tools: manager,
				limit: { content: 16 },
			}),
		)
		const answer = await mcp.dispatch(
			createJSONRPCRequest({ method: 'tools/call', params: { name: 'large' } }),
		)
		if (Symbol.asyncIterator in answer) throw new Error('Legacy tools/call held open')

		expect(answer.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
	})

	it('admits only the configured number of live subscription streams and releases on close', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const writer = source.writable.getWriter()
		const mcp = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: tools(),
			limit: { subscriptions: 1 },
			subscription: {
				notifications: { toolsListChanged: true },
				producer: () => source.readable,
			},
		})
		const peer = createHostilePeer(mcp)
		const params = {
			notifications: { toolsListChanged: true },
			_meta: MODERN_METADATA,
		}

		await peer.send(
			JSON.stringify(createJSONRPCRequest({ method: 'subscriptions/listen', id: 'first', params })),
		)
		await peer.send(
			JSON.stringify(
				createJSONRPCRequest({ method: 'subscriptions/listen', id: 'second', params }),
			),
		)

		expect(peer.response()?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(peer.responses().some((message) => 'method' in message)).toBe(true)
		await writer.close()
		await waitForDelay()
		peer.clear()
		await peer.send(
			JSON.stringify(createJSONRPCRequest({ method: 'subscriptions/listen', id: 'third', params })),
		)
		expect(peer.responses().some((message) => 'method' in message)).toBe(true)
		peer.close()
	})
})

describe('MCPServer — published limits', () => {
	it('publishes every resolved bound, with the defaults for each omitted leaf', () => {
		const mcp = server()

		expect(mcp.limit).toEqual(DEFAULT_MCP_LIMITS)
	})

	it('publishes the configured value and sanitizes a hostile one back to its default', () => {
		const mcp = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: tools(),
			limit: { message: 4096, subscriptions: Number.NaN },
		})

		expect(mcp.limit.message).toBe(4096)
		expect(mcp.limit.subscriptions).toBe(DEFAULT_MCP_LIMITS.subscriptions)
	})

	// Published state that a consumer could move under a check that already ran would be a
	// bound in name only, so the object is frozen rather than merely typed readonly.
	it('is frozen, so a bound cannot be moved out from under the checks that read it', () => {
		const mcp = server()

		expect(Object.isFrozen(mcp.limit)).toBe(true)
		expect(mcp.limit).toBe(mcp.limit)
	})
})

// The subscription CLOSURE claim, pinned as a conformance claim rather than left implied.
// The cancellation page and the subscriptions page of the dated revision disagree about how a
// server ends a `subscriptions/listen` exchange: the cancellation page says it MUST send `notifications/cancelled` naming the
// listen request, while the subscriptions page it cites as its authority says the server
// SHOULD send the empty `subscriptions/listen` RESULT and attributes the notification to the
// client alone. The schema carries no subscription-specific variant, so it corroborates
// neither. This server implements the page that owns the mechanism, and this test is what
// keeps a later reader from "fixing" it toward the other one.
describe('MCPServer — graceful subscription closure', () => {
	it('ends a gracefully closed subscription with the empty result, correlated by the listen id', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const writer = source.writable.getWriter()
		const mcp = server(undefined, {
			notifications: { toolsListChanged: true },
			producer: () => source.readable,
		})
		const stream = streamOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'subscriptions/listen',
					id: 'listen-close',
					params: { notifications: { toolsListChanged: true }, _meta: MODERN_METADATA },
				}),
			),
		)
		const acknowledgement = await stream.next()
		if (acknowledgement.done) throw new Error('expected a subscription acknowledgement')

		await writer.close()
		const [messages, terminal] = await drainStream(stream)

		expect(terminal).toEqual({
			jsonrpc: '2.0',
			id: 'listen-close',
			result: {
				resultType: 'complete',
				_meta: {
					[MCP_META_SUBSCRIPTION]: 'listen-close',
					[MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' },
				},
			},
		})
		// And NOT the notification the cancellation page asks for: the mechanism is the result.
		expect(
			[acknowledgement.value, ...messages].filter(
				(message) => message.method === 'notifications/cancelled',
			),
		).toEqual([])
	})
})

describe('MCPServer — identity', () => {
	it('exposes the name and version from options', () => {
		const mcp = server()

		expect(mcp.identity.name).toBe('test-server')
		expect(mcp.identity.version).toBe('1.2.3')
	})
})

describe('MCPServer — modern-and-legacy dispatch', () => {
	it('answers a legacy initialize on the bare modern server as an unregistered method', async () => {
		const mcp = createMCPServer({
			identity: { name: 'modern-server', version: '2.0.0' },
			tools: tools(),
		})
		const response = responseOf(await mcp.dispatch(createJSONRPCRequest({ method: 'initialize' })))

		expect(response?.error).toEqual({
			code: JSONRPC_METHOD_NOT_FOUND,
			message: 'Method not found: initialize',
		})
		expect(await mcp.handle('{"jsonrpc":"2.0","method":"initialize","id":2}')).toBe(
			'{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"Method not found: initialize"}}',
		)
	})

	it('names the absent protocol version on a registered modern method', async () => {
		const mcp = createMCPServer({
			identity: { name: 'modern-server', version: '2.0.0' },
			tools: tools(),
		})
		const response = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'tools/list',
					params: { _meta: { [MCP_META_CAPABILITIES]: {} } },
				}),
			),
		)

		expect(response?.error).toEqual({
			code: JSONRPC_INVALID_PARAMS,
			message: 'Invalid params: request declares no protocol version',
		})
	})

	it('keeps the legacy method responses byte-identical and unstamped', async () => {
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
		).toBe(
			'{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"7"}],"structuredContent":7}}',
		)
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
		expect(response?.error?.message).toBe('Invalid params: malformed modern request metadata')
	})

	it('treats a present non-string version as modern and rejects it with -32602', async () => {
		const mcp = server()
		const events = createRecorders<MCPServerEventMap, (typeof MCP_EVENTS)[number]>(
			mcp.emitter,
			MCP_EVENTS,
		)
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
			supported: SUPPORTED_MODERN_PROTOCOL_VERSIONS,
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
			supportedVersions: SUPPORTED_MODERN_PROTOCOL_VERSIONS,
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
		expect(result['structuredContent']).toBe(7)
		expect(result['resultType']).toBe('complete')
		expect(result['_meta']).toEqual({
			[MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' },
		})
		expect(result['ttlMs']).toBeUndefined()
		expect(result['cacheScope']).toBeUndefined()
	})

	it('keeps a value-less modern tools/call result valid and omits structured content', async () => {
		const manager = createToolManager()
		manager.add(createTool({ name: 'noop', execute: () => undefined }))
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: manager,
			limit: { content: 512 },
		})
		const response = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: { name: 'noop', _meta: MODERN_METADATA },
				}),
			),
		)
		const result = resultOf(response)

		expect(result['content']).toEqual([{ type: 'text', text: '' }])
		expect(result['resultType']).toBe('complete')
		expect(Object.hasOwn(result, 'structuredContent')).toBe(false)
		expect(Object.hasOwn(result, 'ttlMs')).toBe(false)
	})

	it.each(['initialize', 'does/not/exist'])(
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

	it('refuses modern ping because the modern revision removed it', async () => {
		const response = responseOf(await server().dispatch(modernRequest('ping')))

		expect(response?.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
	})

	it('returns no response for a modern notification after emitting its era', async () => {
		const mcp = server()
		const events = createRecorders<MCPServerEventMap, (typeof MCP_EVENTS)[number]>(
			mcp.emitter,
			MCP_EVENTS,
		)
		const response = responseOf(
			await mcp.dispatch({
				jsonrpc: '2.0',
				method: 'tools/list',
				params: { _meta: MODERN_METADATA },
			}),
		)

		expect(response).toBeUndefined()
		expect(events.request.calls).toEqual([['tools/list', undefined, 'modern']])
	})
})

describe('MCPServer — W01 modern execution and progress', () => {
	it('rejects every present non-record modern arguments value before policy or execution', async () => {
		let selections = 0
		let executions = 0
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			execution: () => {
				executions += 1
				return { resultType: 'complete', content: [{ type: 'text', text: 'unexpected' }] }
			},
			input: {
				continuation: new MemoryContinuation(),
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: () => {
					selections += 1
					return undefined
				},
			},
		})

		for (const argumentsValue of [null, [], 'invalid', 1]) {
			const answer = responseOf(
				await mcp.dispatch(
					createJSONRPCRequest({
						method: 'tools/call',
						params: {
							name: 'echo',
							arguments: argumentsValue,
							_meta: MODERN_METADATA,
						},
					}),
				),
			)
			expect(answer?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		}
		expect(selections).toBe(0)
		expect(executions).toBe(0)
	})

	it('returns an explicitly produced complete rich result without guessing through ToolManager', async () => {
		const manager = createToolManager()
		manager.add(createTool({ name: 'rich', execute: () => ({ type: 'text', text: 'domain' }) }))
		const rich: MCPCallResult = {
			resultType: 'complete',
			content: [
				{ type: 'text', text: 'hello', annotations: { audience: ['assistant'], priority: 1 } },
				{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
				{ type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/mpeg' },
				{
					type: 'resource_link',
					name: 'guide',
					title: 'Guide',
					icons: [{ src: 'data:image/png;base64,aWNvbg==', sizes: ['16x16'], theme: 'dark' }],
					uri: 'resource://guide',
					description: 'The guide',
					mimeType: 'text/markdown',
					size: 12,
				},
				{
					type: 'resource',
					resource: { uri: 'resource://embedded', mimeType: 'text/plain', text: 'embedded' },
				},
			],
			structuredContent: ['array', 1, true, null],
		}
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: manager,
			execution: ({ request, call, tools: received, signal, progress: reporter }) => {
				expect(request.method).toBe('tools/call')
				expect(call.name).toBe('rich')
				expect(received).toBe(manager)
				expect(signal.aborted).toBe(false)
				expect(reporter).toBeUndefined()
				return rich
			},
		})

		const response = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: { name: 'rich', _meta: MODERN_METADATA },
				}),
			),
		)

		expect(response?.result).toEqual(rich)
	})

	it('contains rejected execution and malformed runtime executor results as detail-free errors', async () => {
		const valid: MCPCallResult = {
			resultType: 'complete',
			content: [{ type: 'text', text: 'valid target' }],
		}
		const rejected = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			execution: async () => {
				throw new Error('provider detail must not escape')
			},
		})
		const rejectedAnswer = responseOf(
			await rejected.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: { name: 'echo', _meta: MODERN_METADATA },
				}),
			),
		)
		expect(rejectedAnswer?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(rejectedAnswer?.error?.message).not.toContain('provider detail')

		for (const runtime of [null, 7, { success: true }]) {
			const execution = new Proxy(() => valid, { apply: () => runtime })
			const mcp = createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: tools(),
				execution,
			})
			const answer = responseOf(
				await mcp.dispatch(
					createJSONRPCRequest({
						method: 'tools/call',
						params: { name: 'echo', _meta: MODERN_METADATA },
					}),
				),
			)
			expect(answer?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		}
	})

	it('keeps modern Tool text and structured content on one owned observation', async () => {
		let valueReads = 0
		const target: ToolSuccess = { id: 'call', name: 'probe', success: true, value: { count: 1 } }
		const result = new Proxy(target, {
			getOwnPropertyDescriptor(source, property) {
				const descriptor = Reflect.getOwnPropertyDescriptor(source, property)
				if (property !== 'value' || descriptor === undefined) return descriptor
				valueReads += 1
				return {
					...descriptor,
					value: { count: valueReads },
				}
			},
		})
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			execution: () => result,
		})

		const answer = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: { name: 'probe', _meta: MODERN_METADATA },
				}),
			),
		)
		const payload = resultOf(answer)

		expect(payload['content']).toEqual([{ type: 'text', text: '{"count":1}' }])
		expect(payload['structuredContent']).toEqual({ count: 1 })
		expect(valueReads).toBe(1)
	})

	it('returns an owned explicit MCP result and bounds produced content before stamping', async () => {
		const structured = { status: 'first' }
		const explicit: MCPCallResult = {
			resultType: 'complete',
			content: [{ type: 'text', text: 'owned' }],
			structuredContent: structured,
		}
		const owned = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			execution: () => explicit,
		})
		const answer = responseOf(
			await owned.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: { name: 'probe', _meta: MODERN_METADATA },
				}),
			),
		)
		structured.status = 'changed'

		expect(answer?.result).toEqual({
			resultType: 'complete',
			content: [{ type: 'text', text: 'owned' }],
			structuredContent: { status: 'first' },
		})
		expect(Object.isFrozen(answer?.result)).toBe(true)

		const bounded = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			limit: { content: 100 },
			execution: () => ({ id: 'call', name: 'probe', success: true, value: 1 }),
		})
		const boundedAnswer = responseOf(
			await bounded.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: { name: 'probe', _meta: MODERN_METADATA },
				}),
			),
		)
		expect(boundedAnswer?.result).toEqual({
			resultType: 'complete',
			content: [{ type: 'text', text: '1' }],
			structuredContent: 1,
			_meta: { [MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' } },
		})
	})

	it('refuses non-finite results uniformly through the modern pipeline', async () => {
		const manager = createToolManager()
		manager.add(
			createTool({
				name: 'nonfinite',
				execute: () => ({
					top: Number.NaN,
					nested: [Number.POSITIVE_INFINITY, { value: Number.NEGATIVE_INFINITY }],
				}),
			}),
		)
		const modernServer = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: manager,
		})
		const mcp = createMCPLegacy(modernServer)

		expect(
			await mcp.handle(
				'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nonfinite"}}',
			),
		).toBe(
			'{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"Server execution returned an invalid tool result"}}',
		)
		const modern = responseOf(
			await modernServer.dispatch(
				createJSONRPCRequest({
					id: 2,
					method: 'tools/call',
					params: { name: 'nonfinite', _meta: MODERN_METADATA },
				}),
			),
		)
		expect(modern?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
	})

	it('keeps the collapsed pipeline bounded and inert over hostile tool values', async () => {
		let getterCalls = 0
		const cycle: Record<string, unknown> = {}
		cycle['self'] = cycle
		const accessor = Object.defineProperty({}, 'value', {
			enumerable: true,
			get() {
				getterCalls += 1
				return Number.NaN
			},
		})
		const manager = createToolManager()
		manager.add(createTool({ name: 'cycle', execute: () => cycle }))
		manager.add(createTool({ name: 'accessor', execute: () => accessor }))
		const mcp = createMCPLegacy(
			createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: manager,
			}),
		)

		for (const name of ['cycle', 'accessor']) {
			const answer = responseOf(
				await mcp.dispatch(createJSONRPCRequest({ method: 'tools/call', params: { name } })),
			)
			expect(answer?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		}
		expect(getterCalls).toBe(0)
	})

	it('yields backpressured progress on the original call stream before its terminal result', async () => {
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			execution: async ({ progress: reporter }) => {
				if (reporter === undefined) throw new Error('expected progress reporter')
				await reporter.report({ progress: 1, total: 2, message: 'halfway' })
				return { resultType: 'complete', content: [{ type: 'text', text: 'done' }] }
			},
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				id: 'progress-call',
				method: 'tools/call',
				params: {
					name: 'echo',
					_meta: { ...MODERN_METADATA, progressToken: 'opaque-progress' },
				},
			}),
		)
		if (answer === undefined || !('next' in answer)) throw new Error('expected progress stream')

		const [notifications, terminal] = await drainStream(answer)

		expect(notifications).toEqual([
			{
				jsonrpc: '2.0',
				method: 'notifications/progress',
				params: {
					progressToken: 'opaque-progress',
					progress: 1,
					total: 2,
					message: 'halfway',
				},
			},
		])
		expect(terminal.result).toEqual({
			resultType: 'complete',
			content: [{ type: 'text', text: 'done' }],
		})
	})

	it('keeps the normal ToolManager path unary and executes it exactly once despite a token', async () => {
		let executions = 0
		const manager = createToolManager()
		manager.add(
			createTool({
				name: 'once',
				execute: () => {
					executions += 1
					return executions
				},
			}),
		)
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: manager,
		})

		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'tools/call',
				params: {
					name: 'once',
					_meta: { ...MODERN_METADATA, progressToken: 7 },
				},
			}),
		)

		expect(responseOf(answer)?.result).toMatchObject({ structuredContent: 1 })
		expect(executions).toBe(1)
	})

	it('rejects a repeated progress value explicitly', async () => {
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			execution: async ({ progress: reporter }) => {
				if (reporter === undefined) throw new Error('expected progress reporter')
				await reporter.report({ progress: 1 })
				await reporter.report({ progress: 1 })
				return { resultType: 'complete', content: [{ type: 'text', text: 'unreachable' }] }
			},
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				id: 'strict-progress',
				method: 'tools/call',
				params: {
					name: 'echo',
					_meta: { ...MODERN_METADATA, progressToken: 'strict' },
				},
			}),
		)
		if (answer === undefined || !('next' in answer)) throw new Error('expected progress stream')

		const [notifications, terminal] = await drainStream(answer)
		expect(notifications).toMatchObject([{ method: 'notifications/progress' }])
		expect(terminal.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
	})

	it('rejects invalid and oversized progress before yielding it', async () => {
		const invalid = new Proxy<MCPProgress>(
			{ progress: 1, message: 'valid' },
			{
				getOwnPropertyDescriptor(target, property) {
					if (property !== 'message') return Reflect.getOwnPropertyDescriptor(target, property)
					return { configurable: true, enumerable: true, value: 7, writable: true }
				},
			},
		)
		const scenarios: ReadonlyArray<readonly [MCPProgress, number]> = [
			[invalid, 128],
			[{ progress: 1, message: 'x'.repeat(64) }, 32],
		]
		for (const [payload, content] of scenarios) {
			const mcp = createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: tools(),
				limit: { content },
				execution: async ({ progress: reporter }) => {
					if (reporter === undefined) throw new Error('expected progress reporter')
					await reporter.report(payload)
					return { resultType: 'complete', content: [{ type: 'text', text: 'unexpected' }] }
				},
			})
			const answer = streamOf(
				await mcp.dispatch(
					createJSONRPCRequest({
						method: 'tools/call',
						params: {
							name: 'echo',
							_meta: { ...MODERN_METADATA, progressToken: 'bounded' },
						},
					}),
				),
			)
			const [notifications, terminal] = await drainStream(answer)
			expect(notifications).toEqual([])
			expect(terminal.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		}
	})

	it('rejects a fractional progress token before tool execution', async () => {
		let executions = 0
		let reporter: MCPProgressInterface | undefined
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			execution: ({ progress: progressReporter }) => {
				executions += 1
				reporter = progressReporter
				return { resultType: 'complete', content: [{ type: 'text', text: 'done' }] }
			},
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'tools/call',
				params: {
					name: 'echo',
					_meta: { ...MODERN_METADATA, progressToken: 1.5 },
				},
			}),
		)

		expect(responseOf(answer)?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(reporter).toBeUndefined()
		expect(executions).toBe(0)
	})

	it('completes one explicit valid-token execution that reports no progress', async () => {
		let executions = 0
		let reporter: MCPProgressInterface | undefined
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			execution: ({ progress: progressReporter }) => {
				executions += 1
				reporter = progressReporter
				return { resultType: 'complete', content: [{ type: 'text', text: 'done' }] }
			},
		})
		const answer = streamOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: {
						name: 'echo',
						_meta: { ...MODERN_METADATA, progressToken: 2 },
					},
				}),
			),
		)
		const [notifications, terminal] = await drainStream(answer)

		expect(notifications).toEqual([])
		expect(terminal.result).toMatchObject({ resultType: 'complete' })
		expect(reporter).toBeDefined()
		expect(executions).toBe(1)
	})

	it('settles an active progress stream and stops reports on external abort', async () => {
		const controller = new AbortController()
		let reporter: MCPProgressInterface | undefined
		let signal: AbortSignal | undefined
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			execution: ({ progress: progressReporter, signal: received }) => {
				reporter = progressReporter
				signal = received
				return new Promise(() => undefined)
			},
		})
		const answer = streamOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: {
						name: 'echo',
						_meta: { ...MODERN_METADATA, progressToken: 'abort' },
					},
				}),
				{ signal: controller.signal },
			),
		)
		const pending = answer.next()
		await waitForDelay()
		controller.abort(new Error('request aborted'))
		if (reporter === undefined) throw new Error('expected captured reporter')
		const late = reporter.report({ progress: 1 })

		await expect(pending).rejects.toThrow('request aborted')
		await expect(late).rejects.toThrow('Progress reporter is stopped')
		expect(signal?.aborted).toBe(true)
	})

	// A request whose caller has already gone runs NOTHING: the controlled stream refuses its
	// first read, so the produced generator never starts and the executor is never invoked.
	// That is stronger than the old behaviour, which executed and then discarded the result.
	it('settles a pre-aborted progress stream without executing or answering', async () => {
		const controller = new AbortController()
		controller.abort(new Error('request aborted'))
		let executions = 0
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			execution: () => {
				executions += 1
				return { resultType: 'complete', content: [{ type: 'text', text: 'unexpected' }] }
			},
		})
		const answer = streamOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: {
						name: 'echo',
						_meta: { ...MODERN_METADATA, progressToken: 'pre-abort' },
					},
				}),
				{ signal: controller.signal },
			),
		)

		await expect(answer.next()).rejects.toThrow('request aborted')
		expect(executions).toBe(0)
	})

	it('aborts execution and rejects late reports when the response generator returns', async () => {
		const seen: { signal?: AbortSignal; reporter?: MCPProgressInterface } = {}
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			execution: async ({ signal, progress: reporter }) => {
				if (reporter === undefined) throw new Error('expected progress reporter')
				seen.signal = signal
				seen.reporter = reporter
				await reporter.report({ progress: 1 })
				await new Promise<void>((resolve) =>
					signal.addEventListener('abort', () => resolve(), { once: true }),
				)
				return { resultType: 'complete', content: [{ type: 'text', text: 'aborted' }] }
			},
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				id: 'returned-progress',
				method: 'tools/call',
				params: {
					name: 'echo',
					_meta: { ...MODERN_METADATA, progressToken: 'returned' },
				},
			}),
		)
		if (answer === undefined || !('next' in answer)) throw new Error('expected progress stream')
		await answer.next()
		await answer.return(buildJSONRPCResult('returned-progress', {}))
		if (seen.reporter === undefined) throw new Error('expected captured reporter')

		expect(seen.signal?.aborted).toBe(true)
		await expect(seen.reporter.report({ progress: 2 })).rejects.toThrow(
			'Progress reporter is stopped',
		)
	})
})

describe('MCPServer — multi-round-trip input', () => {
	it('passes the in-scope dispatch options to the principal handler', async () => {
		const seen: MCPMethodOptions[] = []
		const caller = Object.freeze({ subject: 'principal-user' })
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			input: {
				continuation: new MemoryContinuation(),
				ttl: 1_000,
				principal: (_request, options) => {
					seen.push(options)
					return 'operator-1'
				},
				selector: () => createRound(),
			},
		})

		await mcp.dispatch(
			createJSONRPCRequest({
				id: 'principal-options',
				method: 'tools/call',
				params: {
					name: 'echo',
					_meta: {
						[MCP_META_VERSION]: '2026-07-28',
						[MCP_META_CAPABILITIES]: { elicitation: {} },
					},
				},
			}),
			{ caller },
		)

		expect(seen).toHaveLength(1)
		expect(seen[0]?.caller).toBe(caller)
		expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
	})

	// Both halves of the continuation port's failure taxonomy are the PROVIDER's contract, not
	// the client's: a port that throws and a port that opens onto a value outside the state
	// bound each answer detail-free `-32603`, because the client never authored either
	// outcome and cannot act on being told it was at fault. The client-side arm — a carrier
	// the port simply cannot recover — is `-32602`, and lives in the W02-B taxonomy row.
	it('contains continuation open rejection and an out-of-bound opened value', async () => {
		let sealed = ''
		let mode: 'reject' | 'oversize' = 'reject'
		const continuation: MCPContinuationInterface = {
			async seal(value) {
				sealed = value
				return 'carrier'
			},
			async open() {
				if (mode === 'reject') throw new Error('continuation provider detail')
				return `${sealed.slice(0, -1)},"padding":"${'x'.repeat(1024)}"}`
			},
		}
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			limit: { state: 512 },
			input: {
				continuation,
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: (context) => (context.responses === undefined ? createRound() : undefined),
			},
		})
		const params = {
			name: 'echo',
			_meta: {
				[MCP_META_VERSION]: '2026-07-28',
				[MCP_META_CAPABILITIES]: { elicitation: {} },
			},
		}
		const first = responseOf(
			await mcp.dispatch(createJSONRPCRequest({ id: 40, method: 'tools/call', params })),
		)
		if (!isMCPInputResult(first?.result)) throw new Error('expected input_required')
		expect(parseMCPInputState(sealed)).toMatchObject({ id: 40, expiry: expect.any(Number) })
		expect(sealed).not.toContain('"expires"')
		expect(sealed).not.toContain('"origin"')
		const key = Object.keys(first.result.inputRequests ?? {})[0]
		if (key === undefined) throw new Error('expected an input request key')
		const retry = {
			...params,
			requestState: 'carrier',
			inputResponses: { [key]: { action: 'accept' } },
		}

		const rejected = responseOf(
			await mcp.dispatch(createJSONRPCRequest({ id: 41, method: 'tools/call', params: retry })),
		)
		expect(rejected?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(rejected?.error?.message).not.toContain('continuation provider detail')

		mode = 'oversize'
		const oversized = responseOf(
			await mcp.dispatch(createJSONRPCRequest({ id: 42, method: 'tools/call', params: retry })),
		)
		expect(oversized?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(oversized?.error?.message).toBe('Server error')
	})

	it('contains rejected input hooks and rejects invalid resolved policy values', async () => {
		const base = {
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
		}
		const cases = [
			{
				server: createMCPServer({
					...base,
					input: {
						continuation: new MemoryContinuation(),
						ttl: 1_000,
						principal: () => 'operator-1',
						selector: async () => {
							throw new Error('selector provider detail')
						},
					},
				}),
				code: JSONRPC_INTERNAL_ERROR,
			},
			{
				server: createMCPServer({
					...base,
					input: {
						continuation: new MemoryContinuation(),
						ttl: 1_000,
						principal: async () => {
							throw new Error('principal provider detail')
						},
						selector: () => createRound(),
					},
				}),
				code: JSONRPC_INTERNAL_ERROR,
			},
			{
				server: createMCPServer({
					...base,
					input: {
						continuation: {
							async seal() {
								throw new Error('seal provider detail')
							},
							async open() {
								return undefined
							},
						},
						ttl: 1_000,
						principal: () => 'operator-1',
						selector: () => createRound(),
					},
				}),
				code: JSONRPC_INTERNAL_ERROR,
			},
			{
				server: createMCPServer({
					...base,
					input: {
						continuation: new MemoryContinuation(),
						ttl: 1_000,
						principal: () => 'operator-1',
						selector: new Proxy(() => createRound(), { apply: () => 7 }),
					},
				}),
				code: JSONRPC_INVALID_PARAMS,
			},
			{
				server: createMCPServer({
					...base,
					input: {
						continuation: new MemoryContinuation(),
						ttl: 1_000,
						principal: new Proxy(() => 'operator-1', { apply: () => 7 }),
						selector: () => createRound(),
					},
				}),
				code: JSONRPC_INVALID_PARAMS,
			},
			{
				server: createMCPServer({
					...base,
					input: {
						continuation: {
							async seal() {
								return ''
							},
							async open() {
								return undefined
							},
						},
						ttl: 1_000,
						principal: () => 'operator-1',
						selector: () => createRound(),
					},
				}),
				code: JSONRPC_INVALID_PARAMS,
			},
		]
		const request = createJSONRPCRequest({
			id: 43,
			method: 'tools/call',
			params: {
				name: 'echo',
				_meta: {
					[MCP_META_VERSION]: '2026-07-28',
					[MCP_META_CAPABILITIES]: { elicitation: {} },
				},
			},
		})

		for (const scenario of cases) {
			const answer = responseOf(await scenario.server.dispatch(request))
			expect(answer?.error?.code).toBe(scenario.code)
			expect(answer?.error?.message).not.toContain('provider detail')
		}
	})

	it('returns the consumer’s keyed round and resumes under a new id from top-level echo fields', async () => {
		const seen: MCPInputContext[] = []
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			input: {
				continuation: new MemoryContinuation(),
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: (context) => {
					seen.push(context)
					return context.responses === undefined
						? createRound(
								{
									message: 'Approve the reply?',
									requestedSchema: {
										type: 'object',
										properties: { approved: { type: 'boolean' } },
										required: ['approved'],
									},
								},
								'run-42',
							)
						: undefined
				},
			},
		})
		const first = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 'origin-1',
					method: 'tools/call',
					params: {
						name: 'echo',
						arguments: { value: 7 },
						_meta: {
							[MCP_META_VERSION]: '2026-07-28',
							[MCP_META_CAPABILITIES]: { elicitation: {} },
						},
					},
				}),
			),
		)
		if (!isMCPInputResult(first?.result)) {
			throw new Error('expected an input-required result')
		}
		const keys = Object.keys(first.result.inputRequests ?? {})
		const key = keys[0]
		const requestState = first.result.requestState
		if (key === undefined || requestState === undefined) {
			throw new Error('expected the consumer’s key and protected request state')
		}

		// The key travels verbatim from the round the selector composed, and the request travels
		// with it unstamped: the consumer decides the wire, including whether `mode` appears.
		expect(keys).toEqual(['approval'])
		expect(Array.isArray(first.result.inputRequests)).toBe(false)
		expect(first.result.inputRequests?.[key]).toEqual({
			method: 'elicitation/create',
			params: {
				message: 'Approve the reply?',
				requestedSchema: {
					type: 'object',
					properties: { approved: { type: 'boolean' } },
					required: ['approved'],
				},
			},
		})
		expect(typeof requestState).toBe('string')

		const retryParams = {
			name: 'echo',
			arguments: { value: 7 },
			inputResponses: { [key]: { action: 'accept', content: { approved: true } } },
			requestState,
			_meta: {
				[MCP_META_VERSION]: '2026-07-28',
				[MCP_META_CAPABILITIES]: { elicitation: {} },
			},
		}
		const retry = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({ id: 'retry-2', method: 'tools/call', params: retryParams }),
			),
		)

		expect(retry?.result).toEqual({
			content: [{ type: 'text', text: '{"value":7}' }],
			structuredContent: { value: 7 },
			resultType: 'complete',
			_meta: { [MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' } },
		})
		expect(retryParams.requestState).toBe(requestState)
		expect(retryParams).toHaveProperty('inputResponses')
		expect(retryParams.arguments).toEqual({ value: 7 })
		expect(seen).toHaveLength(2)
		expect(seen[1]?.responses).toEqual({
			approval: { action: 'accept', content: { approved: true } },
		})
		expect(seen[1]?.state).toBe('run-42')
		expect(seen[1]?.arguments).toEqual({ value: 7 })
	})

	it('issues one round of several kinds under the consumer’s own keys', async () => {
		const seen: MCPInputContext[] = []
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			input: {
				continuation: new MemoryContinuation(),
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: (context) => {
					seen.push(context)
					return context.responses === undefined ? { requests: MIXED_ROUND } : undefined
				},
			},
		})
		const first = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({ id: 'mixed-1', method: 'tools/call', params: mixedCall() }),
			),
		)
		if (!isMCPInputResult(first?.result)) throw new Error('expected an input-required result')
		const requestState = first.result.requestState
		if (requestState === undefined) throw new Error('expected protected request state')

		expect(first.result.inputRequests).toEqual(MIXED_ROUND)

		const retry = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 'mixed-2',
					method: 'tools/call',
					params: { ...mixedCall(), requestState, inputResponses: MIXED_ANSWERS },
				}),
			),
		)

		expect(resultOf(retry)['resultType']).toBe('complete')
		expect(seen[1]?.responses).toEqual(MIXED_ANSWERS)
	})

	it.each([
		['no declaration at all', {}, { elicitation: {}, roots: {}, sampling: {} }],
		[
			'URL-only elicitation',
			{ elicitation: { url: {} }, sampling: {}, roots: {} },
			{ elicitation: {} },
		],
		['every kind but roots', { elicitation: {}, sampling: {} }, { roots: {} }],
	])('refuses a round the client cannot answer with %s', async (_, capabilities, required) => {
		let executions = 0
		const manager = createToolManager()
		manager.add(
			createTool({
				name: 'echo',
				execute: () => {
					executions += 1
					return 'ran'
				},
			}),
		)
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: manager,
			input: {
				continuation: new MemoryContinuation(),
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: () => ({ requests: MIXED_ROUND }),
			},
		})
		const response = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: {
						name: 'echo',
						_meta: {
							[MCP_META_VERSION]: '2026-07-28',
							[MCP_META_CAPABILITIES]: capabilities,
						},
					},
				}),
			),
		)

		expect(response?.error).toEqual({
			code: MCP_MISSING_CAPABILITY,
			message: 'Server requires a client capability this request did not declare',
			data: { requiredCapabilities: required },
		})
		expect(executions).toBe(0)
	})

	it('rejects mutated state, a reused id, and an omitted response without running the tool', async () => {
		let executions = 0
		const manager = createToolManager()
		manager.add(
			createTool({
				name: 'count',
				execute: () => {
					executions += 1
					return executions
				},
			}),
		)
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: manager,
			input: {
				continuation: new MemoryContinuation(),
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: (context) => (context.responses === undefined ? createRound() : undefined),
			},
		})
		const params = {
			name: 'count',
			_meta: {
				[MCP_META_VERSION]: '2026-07-28',
				[MCP_META_CAPABILITIES]: { elicitation: {} },
			},
		}
		const first = responseOf(
			await mcp.dispatch(createJSONRPCRequest({ id: 11, method: 'tools/call', params })),
		)
		if (!isMCPInputResult(first?.result)) throw new Error('expected input_required')
		const key = Object.keys(first.result.inputRequests ?? {})[0]
		const token = first.result.requestState
		if (key === undefined || token === undefined) throw new Error('missing input state')
		const response = { [key]: { action: 'accept' } }
		const mutated = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`

		const mutatedAnswer = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 12,
					method: 'tools/call',
					params: { ...params, inputResponses: response, requestState: mutated },
				}),
			),
		)
		const reusedAnswer = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 11,
					method: 'tools/call',
					params: { ...params, inputResponses: response, requestState: token },
				}),
			),
		)
		const omittedAnswer = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 13,
					method: 'tools/call',
					params: { ...params, requestState: token },
				}),
			),
		)
		const changedArguments = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 14,
					method: 'tools/call',
					params: {
						...params,
						arguments: { changed: true },
						inputResponses: response,
						requestState: token,
					},
				}),
			),
		)
		const changedName = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 15,
					method: 'tools/call',
					params: {
						...params,
						name: 'other',
						inputResponses: response,
						requestState: token,
					},
				}),
			),
		)
		const changedVersion = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 16,
					method: 'tools/call',
					params: {
						...params,
						inputResponses: response,
						requestState: token,
						_meta: {
							[MCP_META_VERSION]: '2025-11-25',
							[MCP_META_CAPABILITIES]: { elicitation: {} },
						},
					},
				}),
			),
		)
		const changedMethod = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 17,
					method: 'resources/read',
					params: { ...params, inputResponses: response, requestState: token },
				}),
			),
		)
		const changedKey = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 18,
					method: 'tools/call',
					params: {
						...params,
						inputResponses: { wrong: { action: 'accept' } },
						requestState: token,
					},
				}),
			),
		)

		expect(mutatedAnswer?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(reusedAnswer?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(omittedAnswer?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(changedArguments?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(changedName?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(changedVersion?.error?.code).toBe(MCP_UNSUPPORTED_VERSION)
		// A carrier on another method is no longer refused by core for being on another
		// method: continuation semantics belong to whoever registered that method, and this
		// server has registered nothing under `resources/read`, so the answer is `-32601`.
		// The state's `method` binding still exists and is still checked; what changed is that
		// only a registered handler can reach the point where it would matter.
		expect(changedMethod?.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
		expect(changedKey?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(executions).toBe(0)
	})

	it('binds principal and a real short TTL inside the protected payload', async () => {
		let principal = 'operator-1'
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			input: {
				continuation: new MemoryContinuation(),
				ttl: 15,
				principal: () => principal,
				selector: (context) => (context.responses === undefined ? createRound() : undefined),
			},
		})
		const params = {
			name: 'echo',
			_meta: {
				[MCP_META_VERSION]: '2026-07-28',
				[MCP_META_CAPABILITIES]: { elicitation: {} },
			},
		}
		const first = responseOf(
			await mcp.dispatch(createJSONRPCRequest({ id: 20, method: 'tools/call', params })),
		)
		if (!isMCPInputResult(first?.result)) throw new Error('expected input_required')
		const key = Object.keys(first.result.inputRequests ?? {})[0]
		const token = first.result.requestState
		if (key === undefined || token === undefined) throw new Error('missing input state')
		const responses = { [key]: { action: 'accept' } }

		principal = 'operator-2'
		const wrongPrincipal = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 21,
					method: 'tools/call',
					params: { ...params, inputResponses: responses, requestState: token },
				}),
			),
		)
		principal = 'operator-1'
		await waitForDelay(30)
		const expired = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 22,
					method: 'tools/call',
					params: { ...params, inputResponses: responses, requestState: token },
				}),
			),
		)

		expect(wrongPrincipal?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(expired?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
	})

	it('reaches modern input policy and refuses its result at the legacy revision boundary', async () => {
		let selections = 0
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			input: {
				continuation: new MemoryContinuation(),
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: () => {
					selections += 1
					return createRound()
				},
			},
		})
		const legacy = createMCPLegacy(mcp)

		expect(responseOf(await mcp.dispatch(modernRequest('prompts/get')))?.error?.code).toBe(
			JSONRPC_METHOD_NOT_FOUND,
		)
		expect(responseOf(await mcp.dispatch(modernRequest('resources/read')))?.error?.code).toBe(
			JSONRPC_METHOD_NOT_FOUND,
		)
		expect(responseOf(await mcp.dispatch(modernRequest('tools/list')))?.result).toMatchObject({
			resultType: 'complete',
		})
		expect(
			await legacy.handle(
				'{"jsonrpc":"2.0","method":"tools/call","id":4,"params":{"name":"sum","arguments":{"a":2,"b":5}}}',
			),
		).toBe(
			'{"jsonrpc":"2.0","id":4,"error":{"code":-32000,"message":"Legacy protocol 2025-11-25 cannot represent an input-required result"}}',
		)
		expect(selections).toBe(1)
	})
})

describe('MCPServer — the modern method seam', () => {
	it('owns a direct dispatch request before routing and handler observation', async () => {
		const target: JSONRPCRequest = {
			jsonrpc: '2.0',
			method: 'tools/list',
			id: 71,
			params: { _meta: MODERN_METADATA },
		}
		const request = new Proxy(target, {
			get(source, property) {
				if (property === 'method') return 'server/discover'
				return Reflect.get(source, property)
			},
		})
		const answer = responseOf(
			await createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: tools(),
			}).dispatch(request),
		)

		expect(answer?.result).toMatchObject({
			resultType: 'complete',
			tools: expect.any(Array),
		})
	})
	it('registers the built-in modern methods on the registry it dispatches from', () => {
		const mcp = server()

		expect(mcp.methods.method('ping')).toBeUndefined()
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
			buildJSONRPCResult(request.id, { probed: true }),
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
		mcp.methods.add('tools/list', async (request) => buildJSONRPCResult(request.id, { tools: [] }))
		const response = responseOf(await mcp.dispatch(modernRequest('tools/list')))

		expect(response?.result).toEqual({ tools: [] })
	})

	it('routes a translated legacy method through a replaced modern method', async () => {
		const mcp = server()
		mcp.methods.add('tools/list', async (request) =>
			buildJSONRPCResult(request.id, { resultType: 'complete', tools: [] }),
		)

		expect(await mcp.handle('{"jsonrpc":"2.0","method":"tools/list","id":3}')).toBe(
			'{"jsonrpc":"2.0","id":3,"result":{"tools":[]}}',
		)
	})

	it('never reaches a registered method when the modern metadata is unsupported', async () => {
		const mcp = server()
		const seen: JSONRPCInvocation[] = []
		mcp.methods.add('demo/probe', async (request) => {
			seen.push(request)
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
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
		const seen: JSONRPCInvocation[] = []
		mcp.methods.add('demo/probe', async (request) => {
			seen.push(request)
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
		})
		const response = responseOf(
			await mcp.dispatch(createJSONRPCRequest({ method: 'demo/probe', id: 4 })),
		)

		expect(response?.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
		expect(seen).toEqual([])
	})

	// A dispatched method never sees an absent signal. A caller with none to offer
	// still leaves the handler holding a real, never-aborting one, so no handler downstream
	// has to case on absence.
	it('resolves a signal for every handler even when the caller supplied none', async () => {
		const mcp = server()
		const seen: MCPMethodOptions[] = []
		mcp.methods.add('demo/probe', async (request, options) => {
			seen.push(options)
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
		})
		await mcp.dispatch(modernRequest('demo/probe'))

		expect(seen).toHaveLength(1)
		expect(Object.keys(seen[0] ?? {})).toEqual(['signal'])
		expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
		expect(seen[0]?.signal.aborted).toBe(false)
		expect(seen[0]?.caller).toBeUndefined()
	})

	it('passes direct dispatch caller context to the registered handler', async () => {
		const mcp = server()
		const caller = Object.freeze({ subject: 'dispatch-user' })
		const seen: unknown[] = []
		mcp.methods.add('demo/probe', async (request, options) => {
			seen.push(options.caller)
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
		})
		await mcp.dispatch(modernRequest('demo/probe'), { caller })

		expect(seen).toEqual([caller])
	})

	it('passes direct handle caller context to the registered handler', async () => {
		const mcp = server()
		const caller = Object.freeze({ subject: 'handle-user' })
		const seen: unknown[] = []
		mcp.methods.add('demo/probe', async (request, options) => {
			seen.push(options.caller)
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
		})
		await mcp.handle(JSON.stringify(modernRequest('demo/probe')), { caller })

		expect(seen).toEqual([caller])
	})

	// The handler's signal is the request's LIFETIME, not the caller's signal by identity:
	// it composes the caller's abort with the one dispatch fires when the answer ends. What
	// a producer needs is exactly that composition, so identity is the wrong assertion here
	// and the caller's abort still reaching the handler is the right one.
	it('composes the caller’s abort signal into the handler’s lifetime through dispatch', async () => {
		const mcp = server()
		const controller = new AbortController()
		const seen: MCPMethodOptions[] = []
		mcp.methods.add('demo/probe', async (request, options) => {
			seen.push(options)
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
		})
		await mcp.dispatch(modernRequest('demo/probe'), { signal: controller.signal })

		expect(seen[0]?.signal).not.toBe(controller.signal)
		expect(seen[0]?.signal.aborted).toBe(false)
		controller.abort()
		expect(seen[0]?.signal.aborted).toBe(true)
	})

	it('composes the caller’s abort signal into the handler’s lifetime through handle', async () => {
		const mcp = server()
		const controller = new AbortController()
		const seen: MCPMethodOptions[] = []
		mcp.methods.add('demo/probe', async (request, options) => {
			seen.push(options)
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
		})
		await mcp.handle(JSON.stringify(modernRequest('demo/probe')), { signal: controller.signal })
		controller.abort()

		expect(seen[0]?.signal.aborted).toBe(true)
	})

	it('aborts the handler’s lifetime once the stream it produced has closed', async () => {
		const mcp = server()
		const seen: MCPMethodOptions[] = []
		mcp.methods.add('demo/stream', async (request, options) => {
			seen.push(options)
			return progress(request.id)
		})
		const stream = streamOf(await mcp.dispatch(modernRequest('demo/stream', 12)))

		expect(seen[0]?.signal.aborted).toBe(false)
		await drainStream(stream)

		expect(seen[0]?.signal.aborted).toBe(true)
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
		const answer = textOf(await mcp.handle(JSON.stringify(modernRequest('demo/stream', 12))))
		const [messages, response] = await drainText(answer)

		// The string boundary hands back the controlled entity itself, so a transport holding
		// only the serialized arm still has `stop()` to end what it is writing.
		expect(answer).toBeInstanceOf(MCPTextStreamController)
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

	// The seam now says a registered method ANSWERS, and the registry is open — so the
	// one consumer this server cannot assume was typechecked is the one that must not be able
	// to break it. Before this containment, `dispatch(request)` resolved `undefined` against an
	// overload promising a response, and a transport with nothing to write held the peer until
	// its own deadline expired. The handler here reaches the registry the way a JavaScript
	// consumer's does: through the ONE fact a runtime registration can check.
	it('contains a registered handler that answers nothing for a request', async () => {
		const mcp = server()
		const events = createRecorders<MCPServerEventMap, 'error'>(mcp.emitter, ['error'])
		const untyped: unknown = async () => undefined
		if (!isMCPMethodHandler(untyped)) throw new Error('expected a callable handler')
		mcp.methods.add('demo/silent', untyped)

		const response = responseOf(await mcp.dispatch(modernRequest('demo/silent')))

		expect(response?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		// Detail-free on the wire, legible on the channel built for it — the same split every
		// other contained fault takes, reported exactly once.
		expect(response?.error?.message).toBe('Server error')
		expect(events.error.count).toBe(1)
		expect(events.error.calls[0]?.[0]).toBeInstanceOf(Error)
		// The operator's own failure would also end in a `-32603` — dispatch's catch is right
		// there — so the code alone cannot tell a DESIGNED containment from a TypeError raised
		// one line later while narrowing an absent answer. The diagnosis names the offending
		// method; a stray TypeError cannot.
		expect(String(events.error.calls[0]?.[0])).toContain('demo/silent')
	})

	it('contains the same handler through the string boundary', async () => {
		const mcp = server()
		const events = createRecorders<MCPServerEventMap, 'error'>(mcp.emitter, ['error'])
		const untyped: unknown = async () => undefined
		if (!isMCPMethodHandler(untyped)) throw new Error('expected a callable handler')
		mcp.methods.add('demo/silent', untyped)

		const answer = await mcp.handle(JSON.stringify(modernRequest('demo/silent')))

		// A repaired claim is re-asked at every door that reaches the rule. `handle` returns
		// `undefined` for a NOTIFICATION, so a defect here would be indistinguishable from
		// ordinary silence at exactly the boundary a transport reads.
		expect(typeof answer).toBe('string')
		expect(answer).toContain(String(JSONRPC_INTERNAL_ERROR))
		expect(events.error.count).toBe(1)
	})

	// The control, drawn from OUTSIDE the population the narrowing changed. Every registration
	// the narrowing touched is a BUILT-IN; this handler is a consumer's, added through the
	// public `methods.add` after construction, and it must still never be invoked for a
	// notification. If the notification short-circuit were what the deleted ternaries had been
	// standing in for, this is where it would show.
	it('never invokes a consumer-registered handler for a notification', async () => {
		const mcp = server()
		const seen: JSONRPCRequest[] = []
		mcp.methods.add('demo/probe', async (request) => {
			seen.push(request)
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
		})

		expect(
			await mcp.dispatch(createJSONRPCNotification('demo/probe', { _meta: MODERN_METADATA })),
		).toBeUndefined()
		expect(
			await mcp.handle(
				JSON.stringify(createJSONRPCNotification('demo/probe', { _meta: MODERN_METADATA })),
			),
		).toBeUndefined()
		expect(seen).toEqual([])

		// The instrument proves it can see an invocation before the zero above is read.
		await mcp.dispatch(modernRequest('demo/probe'))
		expect(seen).toHaveLength(1)
	})
})

describe('MCPServer — modern subscriptions/listen', () => {
	it('acknowledges the honoured subset, stamps every delivery, and closes with the same id', async () => {
		const controller = new AbortController()
		const notifications: unknown[] = []
		const options: MCPMethodOptions[] = []
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const writer = source.writable.getWriter()
		const mcp = server(undefined, {
			notifications: {
				toolsListChanged: true,
				resourcesListChanged: true,
				resourceSubscriptions: ['resource://kept'],
			},
			producer(filter, dispatch) {
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
		// The producer receives the request's LIFETIME rather than the caller's signal by
		// identity: an aborting caller still reaches it, and so does the stream's own close.
		expect(options[0]?.signal.aborted).toBe(true)
		expect(controller.signal.aborted).toBe(false)
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
		expect(result['protocolVersion']).toBe(MCP_HANDSHAKE_VERSION)
		expect(result['capabilities']).toEqual({ tools: {} })
		expect(result['serverInfo']).toEqual({ name: 'test-server', version: '1.2.3' })
	})

	it('falls back when the requested protocol version requires unsupported batching', async () => {
		const response = responseOf(
			await server().dispatch(createJSONRPCRequest({ params: { protocolVersion: '2025-03-26' } })),
		)

		expect(resultOf(response)['protocolVersion']).toBe(MCP_HANDSHAKE_VERSION)
	})

	it('falls back to the default for an unsupported requested version', async () => {
		const response = responseOf(
			await server().dispatch(createJSONRPCRequest({ params: { protocolVersion: '1999-01-01' } })),
		)

		expect(resultOf(response)['protocolVersion']).toBe(MCP_HANDSHAKE_VERSION)
	})

	it('ignores a non-string requested version (falls back to the default)', async () => {
		const response = responseOf(
			await server().dispatch(createJSONRPCRequest({ params: { protocolVersion: 42 } })),
		)

		expect(resultOf(response)['protocolVersion']).toBe(MCP_HANDSHAKE_VERSION)
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

	it('keeps tools/list in deterministic registry order', async () => {
		const mcp = server()
		const first = responseOf(
			await mcp.dispatch(createJSONRPCRequest({ method: 'tools/list', id: 20 })),
		)
		const second = responseOf(
			await mcp.dispatch(createJSONRPCRequest({ method: 'tools/list', id: 21 })),
		)

		expect(resultOf(second)['tools']).toEqual(resultOf(first)['tools'])
	})

	it('lists an empty tool set for an empty registry', async () => {
		const mcp = createMCPLegacy(
			createMCPServer({
				identity: { name: 'empty', version: '0.0.0' },
				tools: createToolManager(),
			}),
		)
		const response = responseOf(await mcp.dispatch(createJSONRPCRequest({ method: 'tools/list' })))

		expect(resultOf(response)['tools']).toEqual([])
	})
})

describe('MCPServer — tools/call', () => {
	it('forwards caller context to real tool bodies in both eras and preserves absence', async () => {
		const observed: unknown[] = []
		const manager = createToolManager()
		manager.add(
			createTool({
				name: 'caller',
				execute: (_args, caller) => {
					observed.push(caller)
					return caller === undefined ? 'absent' : caller
				},
			}),
		)
		const mcp = createMCPServer({
			identity: { name: 'caller-server', version: '1.0.0' },
			tools: manager,
		})
		const caller = Object.freeze({ subject: 'tool-user' })
		const legacyRequest = createJSONRPCRequest({
			method: 'tools/call',
			id: 'legacy-caller',
			params: { name: 'caller' },
		})
		const modern = createJSONRPCRequest({
			method: 'tools/call',
			id: 'modern-caller',
			params: { name: 'caller', _meta: MODERN_METADATA },
		})

		await mcp.dispatch(modern, { caller })
		const legacy = createMCPLegacy(mcp)
		await legacy.dispatch(legacyRequest, { caller })
		await mcp.dispatch(modern)
		await legacy.dispatch(legacyRequest)

		expect(observed).toEqual([caller, caller, undefined, undefined])
	})

	it('executes a tool and carries its value as structured content and JSON text', async () => {
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
		expect(result['structuredContent']).toBe(7)
		expect(result['isError']).toBeUndefined()
	})

	it('round-trips a structured value unchanged alongside serialized JSON', async () => {
		const response = responseOf(
			await server().dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					id: 3,
					params: { name: 'echo', arguments: { hello: 'world', n: 1 } },
				}),
			),
		)

		const result = resultOf(response)

		expect(result['content']).toEqual([
			{ type: 'text', text: JSON.stringify({ hello: 'world', n: 1 }) },
		])
		expect(result['structuredContent']).toEqual({ hello: 'world', n: 1 })
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
				result: {
					content: [{ type: 'text', text: '7' }],
					structuredContent: 7,
				},
			}),
		)
	})

	// An unreadable id is OMITTED from the envelope, never sent as `null`.
	it('returns a -32700 parse-error response that omits the id it could not read', async () => {
		const reply = await server().handle('{ not json )')

		expect(reply).toBe(
			JSON.stringify({
				jsonrpc: '2.0',
				error: { code: JSONRPC_PARSE_ERROR, message: 'Parse error' },
			}),
		)
		expect(reply).not.toContain('"id"')
	})

	it('returns a -32600 invalid-request response that omits the id it could not read', async () => {
		const reply = await server().handle('{"jsonrpc":"2.0","id":1,"result":{}}')

		expect(reply).toBe(
			JSON.stringify({
				jsonrpc: '2.0',
				error: { code: JSONRPC_INVALID_REQUEST, message: 'Invalid Request' },
			}),
		)
		expect(reply).not.toContain('"id"')
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

describe('MCPServer — request event', () => {
	it('fires request with the method and id at the top of dispatch', async () => {
		const mcp = server()
		const events = createRecorders<MCPServerEventMap, (typeof MCP_EVENTS)[number]>(
			mcp.emitter,
			MCP_EVENTS,
		)
		await mcp.dispatch(modernRequest('server/discover', 1))
		await mcp.dispatch(modernRequest('tools/list', 2))

		expect(events.request.calls).toEqual([
			['server/discover', 1, 'modern'],
			['tools/list', 2, 'modern'],
		])
	})

	it('fires request with no id for a notification, which has none to report', async () => {
		const mcp = server()
		const events = createRecorders<MCPServerEventMap, (typeof MCP_EVENTS)[number]>(
			mcp.emitter,
			MCP_EVENTS,
		)
		await mcp.dispatch(createJSONRPCNotification('notifications/initialized'))

		expect(events.request.calls).toEqual([])
	})

	it('fires request through handle as well (parse → dispatch path)', async () => {
		const mcp = server()
		const events = createRecorders<MCPServerEventMap, (typeof MCP_EVENTS)[number]>(
			mcp.emitter,
			MCP_EVENTS,
		)
		await mcp.handle(JSON.stringify(modernRequest('tools/list', 3)))

		expect(events.request.calls).toEqual([['tools/list', 3, 'modern']])
	})

	it('EMIT SAFETY: a throwing request listener cannot corrupt the dispatch, and routes to the error handler', async () => {
		const errors = createRecorder<readonly [error: unknown, event: string]>()
		const mcp = server(errors.handler)
		mcp.emitter.on('request', () => {
			throw new Error('request observer blew up')
		})

		// THE LOAD-BEARING ASSERTION: the dispatch still produces its response.
		const response = responseOf(await mcp.dispatch(modernRequest('tools/list')))

		expect(response?.result).toMatchObject({ resultType: 'complete', tools: expect.any(Array) })
		// The error handler received (error, event) — note the arg order.
		expect(errors.calls).toEqual([[expect.any(Error), 'request']])
	})

	it('EMIT SAFETY: a throwing error handler neither escapes nor recurses', async () => {
		const errors = createRecorder<readonly [error: unknown, event: string]>()
		const mcp = server((error, event) => {
			errors.handler(error, event)
			throw new Error('error handler blew up too')
		})
		mcp.emitter.on('request', () => {
			throw new Error('request listener blew up')
		})

		// The dispatch STILL produces a response — neither throw escaped.
		const response = responseOf(await mcp.dispatch(modernRequest('tools/list')))

		expect(response?.result).toMatchObject({ resultType: 'complete', tools: expect.any(Array) })
		// Fired exactly once (its own throw was swallowed, not re-entered — no recursion).
		expect(errors.count).toBe(1)
		expect(errors.calls[0]?.[1]).toBe('request')
	})
})

// W02-A — egress. The modern wire retires `-32000`: every internal fault a modern request
// can provoke answers `-32603` and reports its caught value on the server's `error` event,
// while the legacy branch keeps `-32000` untouched. The sweeps below are written against
// the INVARIANT rather than against line numbers, because a migration proved one
// site at a time is a migration that has not been proved.

// One modern fault scenario: the server that produces it and the request that provokes it.
interface FaultScenario {
	readonly name: string
	readonly server: MCPDispatcherInterface
	readonly request: JSONRPCRequest
}

// Reduce any dispatch answer to the error code it finally carries — draining a held-open
// answer to its terminal, because a stream's fault IS its return value.
async function faultOf(
	answer: JSONRPCResponse | MCPStream | undefined,
): Promise<number | undefined> {
	if (answer === undefined) return undefined
	if (Symbol.asyncIterator in answer) return (await drainStream(answer))[1].error?.code
	return answer.error?.code
}

// The string-boundary mirror: `handle` and `dispatch` are different code paths, so every
// sweep runs through both rather than assuming the second mirrors the first.
async function faultOfText(
	answer: string | MCPTextStream | undefined,
): Promise<number | undefined> {
	if (answer === undefined) return undefined
	const text = typeof answer === 'string' ? answer : (await drainText(answer))[1]
	const parsed: unknown = JSON.parse(text)
	return isJSONRPCErrorResponse(parsed) ? parsed.error.code : undefined
}

function modernCall(params: Readonly<Record<string, unknown>>, id: JSONRPCId = 1): JSONRPCRequest {
	return createJSONRPCRequest({
		method: 'tools/call',
		id,
		params: { ...params, _meta: MODERN_METADATA },
	})
}

function faultingServer(execution: () => never): MCPServerInterface {
	return createMCPServer({
		identity: { name: 'test-server', version: '1.2.3' },
		tools: tools(),
		execution,
	})
}

function throwingHandlerServer(): MCPServerInterface {
	const mcp = server()
	mcp.methods.add('demo/boom', () => {
		throw new Error('handler detail must not escape')
	})
	return mcp
}

function throwingSourceServer(): MCPServerInterface {
	return server(undefined, {
		notifications: { toolsListChanged: true },
		producer: () => {
			throw new Error('subscription source detail')
		},
	})
}

function boundedTools(name: string, value: unknown): ToolManagerInterface {
	const manager = createToolManager()
	manager.add(createTool({ name, execute: () => value }))
	return manager
}

// A real execution handler, so the malformed-result scenario proxies a genuine one rather
// than inventing a callable that never had the right shape.
function completeExecution(): MCPCallResult {
	return { resultType: 'complete', content: [{ type: 'text', text: 'complete' }] }
}

// A consumer's own held-open method that parks and never produces anything — the producer
// a wrapping seam has to survive, since nothing about it will ever settle on its own.
async function* parking(): MCPStream {
	await new Promise<void>(() => undefined)
	yield { jsonrpc: '2.0', method: 'notifications/progress' }
	return buildJSONRPCResult('parked-1', { resultType: 'complete' })
}

// The subscription mirror of `parking`: a producer suspended inside its OWN await before it
// ever reaches a `yield`. A generator parked here answers neither `return()` nor `throw()`,
// because both queue behind the `next()` it has not settled — which is exactly the steady
// state of a real subscription with no notification pending.
async function* parkingSource(): AsyncGenerator<JSONRPCNotification> {
	await new Promise<void>(() => undefined)
	yield { jsonrpc: '2.0', method: 'notifications/tools/list_changed' }
}

// Every distinct modern fault the server contains, in one population. A fault absent from
// this list is a site the sweep never visited, so the list is the sweep's own membership
// rule and is stated where a reader meets it.
//
// Membership was measured by line-scoped mutation rather than assumed: each modern
// `-32603` emission was flipped to `-32000` on its own, and every one of them fails a
// scenario below — except the type-narrowing floor in `#normalize`, which is unreachable at
// runtime and says so where it lives. A sweep that visits most sites and cannot name the
// one it missed is a sweep that does not know what it covers.
function modernFaults(): readonly FaultScenario[] {
	const listen: JSONRPCRequest = createJSONRPCRequest({
		method: 'subscriptions/listen',
		id: 'listen-fault',
		params: { notifications: { toolsListChanged: true }, _meta: MODERN_METADATA },
	})
	const elicitMetadata = {
		[MCP_META_VERSION]: '2026-07-28',
		[MCP_META_CAPABILITIES]: { elicitation: {} },
	}
	return [
		{
			name: 'registered handler throw',
			server: throwingHandlerServer(),
			request: modernRequest('demo/boom'),
		},
		{
			name: 'execution provider throw',
			server: faultingServer(() => {
				throw new Error('provider detail must not escape')
			}),
			request: modernCall({ name: 'echo' }),
		},
		{
			name: 'malformed executor result',
			server: createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: tools(),
				execution: new Proxy(completeExecution, { apply: () => 7 }),
			}),
			request: modernCall({ name: 'echo' }),
		},
		{
			name: 'unserializable tool value',
			server: createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: boundedTools('unserializable', { size: 1n }),
			}),
			request: modernCall({ name: 'unserializable' }),
		},
		{
			name: 'produced content beyond the bound',
			server: createMCPServer({
				identity: { name: 'bounded', version: '1.0.0' },
				tools: boundedTools('large', 'x'.repeat(64)),
				limit: { content: 24 },
			}),
			request: modernCall({ name: 'large' }),
		},
		// The value FITS and the wrapped payload does not: `snapshotToolResult` bounds the tool's
		// own value, and the modern content envelope built around it is bounded a second time. A
		// server whose bound sits between the two reaches a site no "oversized value" scenario
		// can, which is why this row exists beside the one above rather than instead of it.
		{
			name: 'wrapped content beyond the bound',
			server: createMCPServer({
				identity: { name: 'bounded', version: '1.0.0' },
				tools: boundedTools('fits', 'x'.repeat(16)),
				limit: { content: 20 },
			}),
			request: modernCall({ name: 'fits' }),
		},
		{
			name: 'subscription capacity exhausted',
			server: createMCPServer({
				identity: { name: 'bounded', version: '1.0.0' },
				tools: tools(),
				limit: { subscriptions: 0 },
				subscription: {
					notifications: { toolsListChanged: true },
					producer: () => new TransformStream<JSONRPCNotification, JSONRPCNotification>().readable,
				},
			}),
			request: listen,
		},
		{ name: 'subscription source throw', server: throwingSourceServer(), request: listen },
		{
			name: 'continuation provider throw',
			server: createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: tools(),
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
				tools: tools(),
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
				tools: tools(),
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
				tools: tools(),
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

// The positive control the sweeps above cannot do without. An assertion that `-32000` is
// ABSENT passes just as loudly when the branch that would emit it never ran, so the same
// assertion is aimed at the legacy branch, where it must find `-32000` every time.
function legacyFaults(): readonly FaultScenario[] {
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
					tools: boundedTools('cycle', cycle),
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
					tools: boundedTools('large', 'x'.repeat(64)),
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

describe('MCPServer — W02-A: the modern internal-error code', () => {
	it('answers every modern fault -32603 and none -32000, through dispatch', async () => {
		const scenarios = modernFaults()
		const codes: Array<number | undefined> = []
		for (const scenario of scenarios) {
			codes.push(await faultOf(await scenario.server.dispatch(scenario.request)))
		}

		expect(codes).toEqual(scenarios.map(() => JSONRPC_INTERNAL_ERROR))
		expect(codes).not.toContain(JSONRPC_SERVER_ERROR)
	})

	it('answers every modern fault -32603 and none -32000, through handle', async () => {
		const scenarios = modernFaults()
		const codes: Array<number | undefined> = []
		for (const scenario of scenarios) {
			codes.push(await faultOfText(await scenario.server.handle(JSON.stringify(scenario.request))))
		}

		expect(codes).toEqual(scenarios.map(() => JSONRPC_INTERNAL_ERROR))
		expect(codes).not.toContain(JSONRPC_SERVER_ERROR)
	})

	// The translated door runs the identical normalization and error-code pipeline.
	it('answers collapsed legacy tool faults -32603 through dispatch and handle', async () => {
		const scenarios = legacyFaults()
		const dispatched: Array<number | undefined> = []
		const handled: Array<number | undefined> = []
		for (const scenario of scenarios) {
			dispatched.push(await faultOf(await scenario.server.dispatch(scenario.request)))
			handled.push(
				await faultOfText(await scenario.server.handle(JSON.stringify(scenario.request))),
			)
		}

		expect(dispatched).toEqual(scenarios.map(() => JSONRPC_INTERNAL_ERROR))
		expect(handled).toEqual(scenarios.map(() => JSONRPC_INTERNAL_ERROR))
		expect(dispatched).not.toContain(JSONRPC_SERVER_ERROR)
	})

	it('publishes the modern code beside the retained legacy one', () => {
		expect(JSONRPC_INTERNAL_ERROR).toBe(-32603)
		expect(JSONRPC_SERVER_ERROR).toBe(-32000)
	})
})

describe('MCPServer — W02-A: the broadened error event', () => {
	it('reports a contained registered-handler throw exactly once and answers detail-free', async () => {
		const mcp = throwingHandlerServer()
		const faults = createRecorders<MCPServerEventMap, 'error'>(mcp.emitter, ['error'])

		const response = responseOf(await mcp.dispatch(modernRequest('demo/boom')))

		expect(response?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(JSON.stringify(response)).not.toContain('handler detail')
		expect(faults.error.count).toBe(1)
		expect(faults.error.calls[0]?.[0]).toBeInstanceOf(Error)
	})

	// NEGATIVE CONTROL for the containment claim: one unique string, asserted ABSENT from
	// the serialized answer and PRESENT on the observation channel. An assertion that only
	// read the code would pass just as well with the whole thrown value on the wire.
	it('carries the caught value to the observer and never to the wire', async () => {
		const detail = 'unique-detail-8f3a2c'
		const thrown = new Error(detail)
		const mcp = faultingServer(() => {
			throw thrown
		})
		const faults = createRecorders<MCPServerEventMap, 'error'>(mcp.emitter, ['error'])

		const serialized = await mcp.handle(JSON.stringify(modernCall({ name: 'echo' })))

		expect(typeof serialized).toBe('string')
		expect(String(serialized)).not.toContain(detail)
		expect(String(serialized)).toContain(String(JSONRPC_INTERNAL_ERROR))
		expect(faults.error.calls).toEqual([[thrown]])
	})

	it('reports a contained subscription-source throw once, as one detail-free terminal', async () => {
		const mcp = throwingSourceServer()
		const faults = createRecorders<MCPServerEventMap, 'error'>(mcp.emitter, ['error'])
		const stream = streamOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'subscriptions/listen',
					id: 'source-fault',
					params: { notifications: { toolsListChanged: true }, _meta: MODERN_METADATA },
				}),
			),
		)

		const [messages, terminal] = await drainStream(stream)

		expect(messages).toHaveLength(1)
		expect(terminal.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(JSON.stringify(terminal)).not.toContain('subscription source detail')
		expect(faults.error.count).toBe(1)
	})

	it('reports nothing for a request that simply completes', async () => {
		const mcp = server()
		const faults = createRecorders<MCPServerEventMap, 'error'>(mcp.emitter, ['error'])

		await mcp.dispatch(modernRequest('tools/list'))

		expect(faults.error.count).toBe(0)
	})
})

describe('MCPServer — W02-A: subscription capacity and containment', () => {
	it('refuses a subscription beyond capacity with -32603 and releases the slot on close', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const writer = source.writable.getWriter()
		const mcp = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: tools(),
			limit: { subscriptions: 1 },
			subscription: { notifications: { toolsListChanged: true }, producer: () => source.readable },
		})
		const params = { notifications: { toolsListChanged: true }, _meta: MODERN_METADATA }
		const first = streamOf(
			await mcp.dispatch(createJSONRPCRequest({ method: 'subscriptions/listen', id: 'a', params })),
		)
		await first.next()
		const second = streamOf(
			await mcp.dispatch(createJSONRPCRequest({ method: 'subscriptions/listen', id: 'b', params })),
		)

		const refused = await second.next()
		if (refused.done !== true) throw new Error('expected the refusal as the terminal')
		expect(refused.value.error?.code).toBe(JSONRPC_INTERNAL_ERROR)

		await writer.close()
		const [, terminal] = await drainStream(first)
		expect(terminal.error).toBeUndefined()
		const third = streamOf(
			await mcp.dispatch(createJSONRPCRequest({ method: 'subscriptions/listen', id: 'c', params })),
		)
		expect((await third.next()).done).toBe(false)
		await third.return(buildJSONRPCResult('c', { resultType: 'complete' }))
	})

	it('owns a produced notification before matching and stamping it', async () => {
		let reads = 0
		const params = new Proxy(
			{ uri: 'resource://kept' },
			{
				get(target, property, receiver) {
					if (property !== 'uri') return Reflect.get(target, property, receiver)
					reads += 1
					return reads === 1 ? 'resource://kept' : 'resource://leaked'
				},
				getOwnPropertyDescriptor(target, property) {
					const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
					if (property !== 'uri' || descriptor === undefined) return descriptor
					reads += 1
					return { ...descriptor, value: reads === 1 ? 'resource://kept' : 'resource://leaked' }
				},
			},
		)
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const writer = source.writable.getWriter()
		const mcp = server(undefined, {
			notifications: { resourceSubscriptions: ['resource://kept'] },
			producer: () => source.readable,
		})
		const stream = streamOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'subscriptions/listen',
					id: 'own-1',
					params: {
						notifications: { resourceSubscriptions: ['resource://kept'] },
						_meta: MODERN_METADATA,
					},
				}),
			),
		)
		await stream.next()
		const drained = drainStream(stream)
		await writer.write({ jsonrpc: '2.0', method: 'notifications/resources/updated', params })
		await writer.close()
		const [messages] = await drained

		// The matcher admitted `resource://kept`; nothing else may be what the client sees.
		for (const message of messages) {
			expect(message.params?.['uri']).toBe('resource://kept')
		}
	})

	it('drops a produced notification carrying a value that is not exact JSON', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const writer = source.writable.getWriter()
		const mcp = server(undefined, {
			notifications: { resourceSubscriptions: ['resource://kept'] },
			producer: () => source.readable,
		})
		const stream = streamOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'subscriptions/listen',
					id: 'own-2',
					params: {
						notifications: { resourceSubscriptions: ['resource://kept'] },
						_meta: MODERN_METADATA,
					},
				}),
			),
		)
		await stream.next()
		const drained = drainStream(stream)
		await writer.write({
			jsonrpc: '2.0',
			method: 'notifications/resources/updated',
			params: { uri: 'resource://kept', leak: () => 'not JSON' },
		})
		await writer.close()
		const [messages, terminal] = await drained

		expect(messages).toEqual([])
		expect(terminal.error).toBeUndefined()
	})

	// The steady state of every live subscription: the producer is suspended inside its OWN
	// await, so nothing a consumer does can resume it — not `throw()`, not `return()`, both of
	// which an async generator queues behind the unanswered `next()`. A capacity slot returned
	// only by code that runs after that resumption is a slot that is never returned, and the
	// ordinary client disconnect is what triggers it.
	it('returns the capacity slot when a caller abandons a producer parked on its own source', async () => {
		const controller = new AbortController()
		const mcp = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: tools(),
			limit: { subscriptions: 1 },
			subscription: { notifications: { toolsListChanged: true }, producer: () => parkingSource() },
		})
		const params = { notifications: { toolsListChanged: true }, _meta: MODERN_METADATA }
		const abandoned = streamOf(
			await mcp.dispatch(
				createJSONRPCRequest({ method: 'subscriptions/listen', id: 'parked-a', params }),
				{ signal: controller.signal },
			),
		)
		await abandoned.next()
		const stuck = abandoned.next()
		await waitForDelay()
		controller.abort(new Error('client went away'))
		await expect(stuck).rejects.toThrow('client went away')
		await waitForDelay()

		const admitted = streamOf(
			await mcp.dispatch(
				createJSONRPCRequest({ method: 'subscriptions/listen', id: 'parked-b', params }),
			),
		)
		const first = await admitted.next()

		expect(first.done).toBe(false)
		admitted.stop()
	})

	// The same leak reached through the OTHER closure: an owner ending the exchange with
	// `stop()` rather than the caller aborting. Both run `MCPStreamController.#release`, so
	// both must return the slot, and a repair proved at one door is a hypothesis at the next.
	it('returns the capacity slot when an owner stops a subscription parked on its source', async () => {
		const mcp = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: tools(),
			limit: { subscriptions: 1 },
			subscription: { notifications: { toolsListChanged: true }, producer: () => parkingSource() },
		})
		const params = { notifications: { toolsListChanged: true }, _meta: MODERN_METADATA }
		const stopped = streamOf(
			await mcp.dispatch(
				createJSONRPCRequest({ method: 'subscriptions/listen', id: 'stopped-a', params }),
			),
		)
		await stopped.next()
		const stuck = stopped.next()
		await waitForDelay()
		stopped.stop()
		await expect(stuck).rejects.toBeInstanceOf(DOMException)
		await waitForDelay()

		const admitted = streamOf(
			await mcp.dispatch(
				createJSONRPCRequest({ method: 'subscriptions/listen', id: 'stopped-b', params }),
			),
		)
		const first = await admitted.next()

		expect(first.done).toBe(false)
		admitted.stop()
	})

	// The negative control the proofs above cannot do without: the same instrument aimed
	// at a server whose capacity is genuinely spent must REFUSE, or a passing admission proves
	// only that the limit was never enforced.
	it('still refuses a second subscription while the first is genuinely live', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const mcp = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: tools(),
			limit: { subscriptions: 1 },
			subscription: {
				notifications: { toolsListChanged: true },
				producer: () => source.readable,
			},
		})
		const params = { notifications: { toolsListChanged: true }, _meta: MODERN_METADATA }
		const live = streamOf(
			await mcp.dispatch(
				createJSONRPCRequest({ method: 'subscriptions/listen', id: 'live-a', params }),
			),
		)
		await live.next()
		const refused = streamOf(
			await mcp.dispatch(
				createJSONRPCRequest({ method: 'subscriptions/listen', id: 'live-b', params }),
			),
		)

		const answer = await refused.next()
		if (answer.done !== true) throw new Error('expected the refusal as the terminal')
		expect(answer.value.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		live.stop()
	})

	it('produces no terminal for a subscription its caller aborted', async () => {
		const controller = new AbortController()
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const mcp = server(undefined, {
			notifications: { toolsListChanged: true },
			producer: () => source.readable,
		})
		const stream = streamOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'subscriptions/listen',
					id: 'aborted',
					params: { notifications: { toolsListChanged: true }, _meta: MODERN_METADATA },
				}),
				{ signal: controller.signal },
			),
		)
		await stream.next()
		const parked = stream.next()
		await waitForDelay()
		controller.abort(new Error('caller went away'))

		await expect(parked).rejects.toThrow('caller went away')
	})
})

describe('MCPServer — W02-A: what the egress boundary keeps doing', () => {
	// Nothing answers a notification, whatever its method — including the one the dated
	// revision reserves for cancellation, which this package recognizes nowhere and must
	// therefore treat as an ordinary unanswered call rather than a special case.
	it('answers no notification, through dispatch or handle', async () => {
		const mcp = server()
		mcp.methods.add('demo/stream', holdOpen)
		const methods = [
			'server/discover',
			'tools/list',
			'tools/call',
			'subscriptions/listen',
			'demo/stream',
			'notifications/initialized',
			'notifications/cancelled',
			'does/not/exist',
		]
		const dispatched: unknown[] = []
		const handled: unknown[] = []
		for (const method of methods) {
			const notification = createJSONRPCNotification(method, { _meta: MODERN_METADATA })
			dispatched.push(await mcp.dispatch(notification))
			handled.push(await mcp.handle(JSON.stringify(notification)))
		}

		expect(dispatched).toEqual(methods.map(() => undefined))
		expect(handled).toEqual(methods.map(() => undefined))
	})

	// Those vectors under the migrated codes: a provider's output is reached through
	// property access that can be revoked or can answer differently each time, and neither
	// escapes the boundary as a throw or as a second reading.
	it('contains a revoked and a drifting executor result as one detail-free -32603', async () => {
		const revocable = Proxy.revocable<Record<string, unknown>>(
			{ id: 'call', name: 'probe', success: true, value: 1 },
			{},
		)
		revocable.revoke()
		let reads = 0
		const drifting = new Proxy(
			{ id: 'call', name: 'probe', success: true, value: 1 },
			{
				getOwnPropertyDescriptor(target, property) {
					const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
					if (property !== 'value' || descriptor === undefined) return descriptor
					reads += 1
					return { ...descriptor, value: reads }
				},
			},
		)
		for (const result of [revocable.proxy, drifting]) {
			const mcp = createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: tools(),
				execution: () => {
					throw result
				},
			})
			const answer = responseOf(await mcp.dispatch(modernCall({ name: 'probe' })))

			expect(answer?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
			expect(answer?.error?.message).toBe('Server error')
		}
	})

	// At the seam a consumer owns: a REGISTERED handler's own generator is controlled
	// too, so a producer that never settles cannot hold the answer open forever.
	it('controls a consumer’s own generator, so stopping it settles against a parked producer', async () => {
		const mcp = server()
		mcp.methods.add('demo/parked', async () => parking())
		const stream = streamOf(await mcp.dispatch(modernRequest('demo/parked', 'parked-1')))
		const reading = stream.next().catch((error: unknown) => error)
		await waitForDelay()

		stream.stop()

		expect(await reading).toBeInstanceOf(DOMException)
	})
})

// W02-B — ingress: admission, binding, and re-entry. Everything below is about what the
// server ADMITS and what it BINDS, as against W02-A's egress, which is about what leaves.
//
// Ordering is proved by NEGATIVE CALL COUNTERS, never by response codes. A refusal answers
// the same code whether the provider ran before it or after it, so a code assertion cannot
// separate "rejected after calling the principal resolver" from "rejected before calling
// it" — only a count can, and that separation is the whole claim of those controls.

// The modern metadata of a client that DOES declare form elicitation, so the capability gate
// is open and the ordering proofs measure something other than the gate.
const FORM_METADATA: Readonly<Record<string, unknown>> = Object.freeze({
	[MCP_META_VERSION]: '2026-07-28',
	[MCP_META_CAPABILITIES]: Object.freeze({ elicitation: {} }),
})

// A schema with one required boolean and one bounded integer beside it — enough shape that
// an accepted response can be wrong in a way only the ISSUED schema knows about.
const APPROVAL_SCHEMA: MCPElicitSchema = {
	type: 'object',
	properties: {
		approved: { type: 'boolean' },
		count: { type: 'integer', minimum: 1, maximum: 5 },
	},
	required: ['approved'],
}

// One MRTR server wired for observation: every provider call keeps what it saw, the
// continuation port keeps every payload it was asked to protect, and the tool records the
// arguments it actually ran with. Real providers and a real ToolManager throughout.
interface InputProbeInterface {
	readonly server: MCPServerInterface
	readonly continuation: MemoryContinuation
	/** The resolved options every `principal` call observed — its length is the call count. */
	readonly principals: readonly MCPMethodOptions[]
	/** Every selector context, in order — its length is the selector's call count. */
	readonly selections: readonly MCPInputContext[]
	/** Every argument record the tool actually executed with — its length is the run count. */
	readonly executions: ReadonlyArray<Readonly<Record<string, unknown>>>
}

function inputProbe(
	options: {
		/** How many form rounds the selector asks for before it lets the call through. */
		readonly rounds?: number
		readonly schema?: MCPElicitSchema
		readonly ttl?: number
		/** Milliseconds the selector awaits before answering. */
		readonly stall?: number
	} = {},
): InputProbeInterface {
	const principals: MCPMethodOptions[] = []
	const selections: MCPInputContext[] = []
	const executions: Array<Readonly<Record<string, unknown>>> = []
	const continuation = new MemoryContinuation()
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
			ttl: options.ttl ?? 1_000,
			principal: (_request, resolved) => {
				principals.push(resolved)
				return 'operator-1'
			},
			selector: async (context) => {
				selections.push(context)
				if (options.stall !== undefined) await waitForDelay(options.stall)
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

// A modern `tools/call` carrying form-capable metadata; `params` names only what varies.
function formCall(id: JSONRPCId, params: Readonly<Record<string, unknown>> = {}): JSONRPCRequest {
	return createJSONRPCRequest({
		id,
		method: 'tools/call',
		params: { name: 'echo', _meta: FORM_METADATA, ...params },
	})
}

// Narrow one produced round to the values a client must echo back, plus what was issued.
function roundOf(response: JSONRPCResponse | undefined): {
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

// A subscription source that ends the moment it is opened — the acknowledgement and the
// terminal with nothing between them, for a scenario whose claim is about what the producer
// RECEIVED rather than about what it produced.
async function* silent(): AsyncGenerator<JSONRPCNotification> {}

// Parse the nth payload the server sealed — the protected state exactly as it wrote it.
function sealedState(probe: InputProbeInterface, index: number): MCPInputState {
	const state = parseMCPInputState(probe.continuation.sealed[index])
	if (state === undefined) throw new Error(`expected sealed state at index ${index}`)
	return state
}

describe('MCPServer — W02-B: admission and the owned argument record', () => {
	// The sleeper: two argument-less calls share ONE frozen record, so a tool that
	// writes to its own `arguments` now fails — wire-visible as a tool failure with no
	// protocol change to point at.
	it('shares one frozen empty argument record, and a tool writing to it fails', async () => {
		const seen: unknown[] = []
		const manager = createToolManager()
		manager.add(
			createTool({
				name: 'observe',
				execute: (args) => {
					seen.push(args)
					return 1
				},
			}),
		)
		manager.add(
			createTool({
				name: 'mutate',
				execute: (args) => {
					const writable: Record<string, unknown> = args
					writable['injected'] = true
					return 2
				},
			}),
		)
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: manager,
		})

		await mcp.dispatch(modernCall({ name: 'observe' }, 'absent-1'))
		await mcp.dispatch(modernCall({ name: 'observe' }, 'absent-2'))
		const mutated = responseOf(await mcp.dispatch(modernCall({ name: 'mutate' }, 'absent-3')))

		expect(seen).toHaveLength(2)
		expect(seen[0]).toBe(EMPTY_MCP_ARGUMENTS)
		expect(seen[0]).toBe(seen[1])
		expect(Object.isFrozen(EMPTY_MCP_ARGUMENTS)).toBe(true)
		expect(Object.getPrototypeOf(EMPTY_MCP_ARGUMENTS)).toBe(null)
		expect(resultOf(mutated)['isError']).toBe(true)
	})

	// ONE argument reference reaches the digest, the selector, the canonical
	// call, and the executor. Identity is the claim — a resnapshot anywhere would hand the
	// selector a different object from the one the tool runs with.
	it('carries one argument reference through digest, selector, call, and execution', async () => {
		const calls: Array<Readonly<Record<string, unknown>>> = []
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			execution: (context) => {
				calls.push(context.call.arguments)
				return { id: context.call.id, name: context.call.name, success: true, value: 1 }
			},
			input: {
				continuation: new MemoryContinuation(),
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: (context) => {
					calls.push(context.arguments)
					return undefined
				},
			},
		})

		await mcp.dispatch(formCall('identity-1', { arguments: { value: 7 } }))

		expect(calls).toHaveLength(2)
		expect(calls[0]).toBe(calls[1])
		expect(calls[0]).toEqual({ value: 7 })
		expect(Object.isFrozen(calls[0])).toBe(true)
	})

	// The clone is taken before any observer or await, so a caller mutating its own
	// request object while a provider is parked changes nothing the server later reads.
	it('owns the dispatched request before any observer, so deferred mutation changes nothing', async () => {
		const observed: Array<readonly [string, JSONRPCId | undefined, string]> = []
		const params: Record<string, unknown> = {
			name: 'echo',
			arguments: { value: 'original' },
			_meta: { ...FORM_METADATA },
		}
		const request: JSONRPCRequest = { jsonrpc: '2.0', method: 'tools/call', id: 'own-1', params }
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			on: {
				request: (method, id, era) => {
					observed.push([method, id, era])
					params['name'] = 'boom'
				},
			},
			input: {
				continuation: new MemoryContinuation(),
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: async () => {
					// Mutating the caller's own object mid-flight, at a real await point.
					params['arguments'] = { value: 'mutated' }
					await waitForDelay()
					return undefined
				},
			},
		})

		const answer = responseOf(await mcp.dispatch(request))

		expect(observed).toEqual([['tools/call', 'own-1', 'modern']])
		expect(resultOf(answer)['structuredContent']).toEqual({ value: 'original' })
	})

	// Both directions: the `request` event fires ahead of the `_meta` bound check, so
	// an observer sees a call the bound check is about to refuse exactly as it sees one that
	// passes. Only SCALARS escape — method, id, era, nothing read out of the request graph.
	it('fires request before the _meta bound check, in both directions, carrying only scalars', async () => {
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			limit: { metadata: 256 },
		})
		const events = createRecorders<MCPServerEventMap, (typeof MCP_EVENTS)[number]>(
			mcp.emitter,
			MCP_EVENTS,
		)

		const refused = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 'bound-1',
					method: 'tools/list',
					params: { _meta: { ...MODERN_METADATA, padding: 'x'.repeat(512) } },
				}),
			),
		)
		const admitted = responseOf(await mcp.dispatch(modernRequest('tools/list', 'bound-2')))

		expect(refused?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(admitted?.result).toMatchObject({ resultType: 'complete' })
		expect(events.request.calls).toEqual([
			['tools/list', 'bound-1', 'modern'],
			['tools/list', 'bound-2', 'modern'],
		])
		for (const call of events.request.calls) {
			for (const value of call) {
				expect(['string', 'number', 'undefined']).toContain(typeof value)
			}
		}
	})

	// `caller` is consumer-asserted and never verified, so it is carried by IDENTITY —
	// a revoked proxy reaches the handler intact precisely because nothing read it.
	it('carries a revoked-proxy caller to a handler by identity', async () => {
		const revocable = Proxy.revocable<Record<string, unknown>>({ subject: 'agent' }, {})
		revocable.revoke()
		const seen: unknown[] = []
		const mcp = server()
		mcp.methods.add('demo/caller', async (request, options) => {
			seen.push(options.caller)
			return buildJSONRPCResult(request.id, {})
		})

		await mcp.dispatch(modernRequest('demo/caller', 'caller-1'), { caller: revocable.proxy })

		expect(seen).toHaveLength(1)
		expect(seen[0]).toBe(revocable.proxy)
	})

	// `__proto__`, `constructor`, and `prototype` are legal own JSON keys. Bounding
	// first and owning second makes them inert DATA rather than a pollution vector — at both
	// doors, because `dispatch` and `handle` are different code paths.
	it('treats hostile own keys as inert data at both doors', async () => {
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
		})
		const hostile = {
			jsonrpc: '2.0',
			method: 'tools/call',
			id: 'hostile-1',
			params: {
				name: 'echo',
				arguments: { __proto__: { polluted: true }, constructor: 'c', prototype: 'p' },
				_meta: MODERN_METADATA,
			},
		}
		const wire = JSON.stringify(hostile)

		const dispatched = responseOf(await mcp.dispatch(createJSONRPCRequest(JSON.parse(wire))))
		const handled = await mcp.handle(wire)

		expect(resultOf(dispatched)['structuredContent']).toEqual({ constructor: 'c', prototype: 'p' })
		expect(typeof handled).toBe('string')
		expect(Object.prototype).not.toHaveProperty('polluted')
		expect({}).not.toHaveProperty('polluted')
	})
})

describe('MCPServer — W02-B: MRTR ordering, binding, and re-entry', () => {
	// The selector may run before the capability is known to be needed — only a
	// selector that ASKS for input makes the client's form capability relevant. Once it has
	// asked, the capability is checked BEFORE the principal resolver, and the counter is the
	// proof: a `-32021` says nothing about whether the resolver already ran.
	it('checks the form capability before the principal resolver is reached', async () => {
		const probe = inputProbe()

		const refused = responseOf(
			await probe.server.dispatch(
				createJSONRPCRequest({
					id: 'order-1',
					method: 'tools/call',
					params: {
						name: 'echo',
						_meta: { [MCP_META_VERSION]: '2026-07-28', [MCP_META_CAPABILITIES]: {} },
					},
				}),
			),
		)

		expect(refused?.error?.code).toBe(MCP_MISSING_CAPABILITY)
		expect(probe.selections).toHaveLength(1)
		expect(probe.principals).toHaveLength(0)
		expect(probe.continuation.sealed).toHaveLength(0)
	})

	// A declaration that PARSES and excludes every kind, and a `_meta` that does not parse at
	// all, are different failures and earn different codes. A legacy-projected call is the
	// first: it arrives with a stamped empty declaration, so it is gated. An unparsable
	// `_meta` is the second, on the first-round door and the retry door alike — the same
	// `-32602` the ingress gives it, in the same words, so one condition has one answer.
	it('separates an empty declaration from an unparsable one, at both MRTR doors', async () => {
		const probe = inputProbe()
		const gated = responseOf(
			await probe.server.dispatch(
				createJSONRPCRequest({
					id: 'reading-1',
					method: 'tools/call',
					params: {
						name: 'echo',
						_meta: { [MCP_META_VERSION]: '2026-07-28', [MCP_META_CAPABILITIES]: {} },
					},
				}),
			),
		)
		const first = responseOf(
			await probe.server.dispatch(
				createJSONRPCRequest({
					id: 'reading-2',
					method: 'tools/call',
					params: {
						name: 'echo',
						_meta: { [MCP_META_VERSION]: '2026-07-28', [MCP_META_CAPABILITIES]: 'not a record' },
					},
				}),
			),
		)
		const continued = inputProbe()
		const issued = responseOf(await continued.server.dispatch(formCall('reading-3')))
		const round = roundOf(issued)
		const retry = responseOf(
			await continued.server.dispatch(
				createJSONRPCRequest({
					id: 'reading-4',
					method: 'tools/call',
					params: {
						name: 'echo',
						requestState: round.requestState,
						inputResponses: { [round.key]: { action: 'accept' } },
						_meta: { [MCP_META_VERSION]: '2026-07-28', [MCP_META_CAPABILITIES]: 'not a record' },
					},
				}),
			),
		)

		expect(gated?.error?.code).toBe(MCP_MISSING_CAPABILITY)
		expect(first?.error).toEqual({
			code: JSONRPC_INVALID_PARAMS,
			message: 'Invalid params: malformed modern request metadata',
		})
		expect(retry?.error).toEqual({
			code: JSONRPC_INVALID_PARAMS,
			message: 'Invalid params: malformed modern request metadata',
		})
		// Neither unparsable call reached the policy at all, so neither cost a selector run:
		// the gated call is the only selection on the first probe, and the issued round is the
		// only one on the second.
		expect(probe.selections).toHaveLength(1)
		expect(continued.selections).toHaveLength(1)
	})

	// This server seals a carrier on every round it issues, so the pair stays required on the
	// retry it accepts: answers with no carrier answer a round this server never sent. The
	// CLIENT half of SEP-2322's stateless arm is `MCPCallOptions.input.state`, which is
	// optional because a different peer may issue a round with no state to return.
	it('refuses a retry carrying answers with no state, and one carrying state with no answers', async () => {
		const probe = inputProbe()
		const issued = responseOf(await probe.server.dispatch(formCall('pairing-1')))
		const round = roundOf(issued)
		const stateless = responseOf(
			await probe.server.dispatch(
				formCall('pairing-2', {
					inputResponses: { [round.key]: { action: 'accept' } },
				}),
			),
		)
		const answerless = responseOf(
			await probe.server.dispatch(formCall('pairing-3', { requestState: round.requestState })),
		)

		expect(stateless?.error).toEqual({
			code: JSONRPC_INVALID_PARAMS,
			message: 'Invalid params: `inputResponses` and `requestState` are required together',
		})
		expect(answerless?.error).toEqual({
			code: JSONRPC_INVALID_PARAMS,
			message: 'Invalid params: `inputResponses` and `requestState` are required together',
		})
		expect(probe.executions).toHaveLength(0)
	})

	// The selector's output is owned and frozen the moment it is produced, so a
	// provider that mutates what it returned changes neither what the client is asked nor
	// what the sealed state binds.
	it('owns the selector’s round and schema immediately', async () => {
		const continuation = new MemoryContinuation()
		const schema: MCPElicitSchema = {
			type: 'object',
			properties: { approved: { type: 'boolean' } },
		}
		const selected: MCPInputRound = createRound(
			{ message: 'Approve?', requestedSchema: schema },
			{
				round: 1,
			},
		)
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			input: {
				continuation,
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: () => selected,
			},
		})

		const first = responseOf(await mcp.dispatch(formCall('own-schema-1')))
		// Deferred mutation of the very objects the selector handed back — a provider is free
		// to keep and rewrite what it returned, and nothing the server issued may follow.
		Reflect.set(schema, 'properties', { approved: { type: 'string' } })
		Reflect.set(selected, 'state', { round: 99 })
		const round = roundOf(first)
		const state = parseMCPInputState(continuation.sealed[0])

		expect(round.issued).toEqual({
			method: 'elicitation/create',
			params: {
				message: 'Approve?',
				requestedSchema: { type: 'object', properties: { approved: { type: 'boolean' } } },
			},
		})
		expect(state?.requests).toEqual({
			approval: {
				method: 'elicitation/create',
				params: {
					message: 'Approve?',
					requestedSchema: { type: 'object', properties: { approved: { type: 'boolean' } } },
				},
			},
		})
		expect(state?.state).toEqual({ round: 1 })
	})

	// The carried state and its verification together, because neither is worth anything alone: the state carries the
	// EXACT issued schema, and the accepted response is checked against THAT schema rather
	// than against the shape of a response in general.
	it('binds the issued schema into protected state and enforces it on the accepted response', async () => {
		const probe = inputProbe({ schema: APPROVAL_SCHEMA })
		const first = responseOf(await probe.server.dispatch(formCall('schema-1')))
		const round = roundOf(first)
		const state = sealedState(probe, 0)
		const answers: Array<JSONRPCResponse | undefined> = []
		const contents: ReadonlyArray<Readonly<Record<string, unknown>>> = [
			{ approved: true, count: 2.5 },
			{ approved: true, count: 9 },
			{ count: 2 },
			{ approved: 'yes' },
		]

		for (const [index, content] of contents.entries()) {
			answers.push(
				responseOf(
					await probe.server.dispatch(
						formCall(`schema-refused-${index}`, {
							requestState: round.requestState,
							inputResponses: { [round.key]: { action: 'accept', content } },
						}),
					),
				),
			)
		}
		const accepted = responseOf(
			await probe.server.dispatch(
				formCall('schema-accepted', {
					requestState: round.requestState,
					inputResponses: {
						[round.key]: { action: 'accept', content: { approved: true, count: 2, extra: 'kept' } },
					},
				}),
			),
		)

		expect(state.requests[round.key]).toEqual({
			method: 'elicitation/create',
			params: { message: 'Approve round 1?', requestedSchema: APPROVAL_SCHEMA },
		})
		expect(answers.map((answer) => answer?.error?.code)).toEqual([
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
		])
		expect(accepted?.result).toMatchObject({ resultType: 'complete' })
		expect(probe.executions).toHaveLength(1)
	})

	// The capability gate is about what the server SENDS, so it measures the round and stands
	// ahead of the seal wherever a round is issued — and on a FIRST round ahead of the principal
	// resolver too, so a client whose round this server may not send costs no principal lookup.
	it('checks the capability before the principal resolver and the seal on a first round', async () => {
		const probe = inputProbe()

		const refused = responseOf(
			await probe.server.dispatch(
				createJSONRPCRequest({
					id: 'first-cap-1',
					method: 'tools/call',
					params: {
						name: 'echo',
						_meta: { [MCP_META_VERSION]: '2026-07-28', [MCP_META_CAPABILITIES]: {} },
					},
				}),
			),
		)

		expect(refused?.error?.code).toBe(MCP_MISSING_CAPABILITY)
		expect(probe.principals).toHaveLength(0)
		expect(probe.continuation.sealed).toHaveLength(0)
		expect(probe.executions).toHaveLength(0)
	})

	// The other half of the same rule: a RETRY answers a round this server already gated, so
	// what the gate measures there is the NEXT round. A retry the selector answers with
	// `undefined` sends nothing, so it runs the tool however the client's declaration narrowed.
	it('gates the next round rather than the answered one on a retry', async () => {
		const probe = inputProbe()
		const first = responseOf(await probe.server.dispatch(formCall('retry-cap-1')))
		const round = roundOf(first)

		const answered = responseOf(
			await probe.server.dispatch(
				createJSONRPCRequest({
					id: 'retry-cap-2',
					method: 'tools/call',
					params: {
						name: 'echo',
						requestState: round.requestState,
						inputResponses: { [round.key]: { action: 'accept' } },
						_meta: { [MCP_META_VERSION]: '2026-07-28', [MCP_META_CAPABILITIES]: {} },
					},
				}),
			),
		)

		expect(answered?.result).toMatchObject({ resultType: 'complete' })
		expect(probe.executions).toHaveLength(1)
	})

	// Distinct failures at the continuation port, distinct answers: a
	// carrier the port cannot recover is the CLIENT's invalid state (`-32602`); a port that
	// opens successfully onto a payload this server never authored is the PROVIDER's contract
	// failure (`-32603`, detail-free, reported once on `error`).
	it('separates an unrecoverable carrier from a malformed opened payload', async () => {
		const probe = inputProbe()
		const faults = createRecorders<MCPServerEventMap, 'error'>(probe.server.emitter, ['error'])
		const first = responseOf(await probe.server.dispatch(formCall('taxonomy-1')))
		const round = roundOf(first)

		const unrecoverable = responseOf(
			await probe.server.dispatch(
				formCall('taxonomy-2', {
					requestState: 'not-a-carrier',
					inputResponses: { [round.key]: { action: 'accept' } },
				}),
			),
		)
		probe.continuation.corrupt('{"principal":"operator-1"}')
		const malformed = responseOf(
			await probe.server.dispatch(
				formCall('taxonomy-3', {
					requestState: round.requestState,
					inputResponses: { [round.key]: { action: 'accept' } },
				}),
			),
		)

		expect(unrecoverable?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(malformed?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(malformed?.error?.message).toBe('Server error')
		expect(faults.error.count).toBe(1)
	})

	// Every structural binding is verified before the principal resolver runs. The
	// counter is the claim — a structurally invalid retry answers `-32602` either way.
	it('verifies every structural binding before resolving the principal', async () => {
		const probe = inputProbe()
		const first = responseOf(await probe.server.dispatch(formCall('structure-1')))
		const round = roundOf(first)
		const principals = probe.principals.length
		const refusals: Array<number | undefined> = []
		const retries: ReadonlyArray<readonly [JSONRPCId, Readonly<Record<string, unknown>>]> = [
			['structure-2', { arguments: { changed: true } }],
			['structure-3', { inputResponses: { unrelated: { action: 'accept' } } }],
			['structure-1', {}],
			['structure-4', { name: 'other' }],
		]

		for (const [id, overrides] of retries) {
			refusals.push(
				responseOf(
					await probe.server.dispatch(
						formCall(id, {
							requestState: round.requestState,
							inputResponses: { [round.key]: { action: 'accept' } },
							...overrides,
						}),
					),
				)?.error?.code,
			)
		}

		expect(refusals).toEqual([
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
		])
		expect(probe.principals).toHaveLength(principals)
		expect(probe.executions).toHaveLength(0)
	})

	// Over three rounds. The ORIGINAL id stays bound while the round and its expiry are
	// re-minted each time — two rounds cannot tell these apart, because round 2
	// binds round 1's id under either rule. Round 3 is where sealing the CURRENT id starts
	// binding round 2's id instead of round 1's.
	it('binds the original id across three rounds while re-minting the round and its expiry', async () => {
		const probe = inputProbe({ rounds: 2, schema: APPROVAL_SCHEMA })

		const first = responseOf(await probe.server.dispatch(formCall('origin-1')))
		const round1 = roundOf(first)
		const second = responseOf(
			await probe.server.dispatch(
				formCall('round-2', {
					requestState: round1.requestState,
					inputResponses: { [round1.key]: { action: 'accept', content: { approved: true } } },
				}),
			),
		)
		const round2 = roundOf(second)
		const third = responseOf(
			await probe.server.dispatch(
				formCall('round-3', {
					requestState: round2.requestState,
					inputResponses: { [round2.key]: { action: 'accept', content: { approved: false } } },
				}),
			),
		)
		const one = sealedState(probe, 0)
		const two = sealedState(probe, 1)

		expect(probe.continuation.sealed).toHaveLength(2)
		expect(one.id).toBe('origin-1')
		expect(two.id).toBe('origin-1')
		expect(two.requests).not.toEqual(one.requests)
		expect(two.requests[round2.key]).toEqual({
			method: 'elicitation/create',
			params: { message: 'Approve round 2?', requestedSchema: APPROVAL_SCHEMA },
		})
		expect(two.expiry).toBeGreaterThanOrEqual(one.expiry)
		expect(two.principal).toBe(one.principal)
		expect(two.version).toBe(one.version)
		expect(two.method).toBe(one.method)
		expect(two.name).toBe(one.name)
		expect(two.digest).toBe(one.digest)
		expect(two.state).toEqual({ round: 2 })
		expect(third?.result).toMatchObject({ resultType: 'complete' })
		expect(probe.executions).toHaveLength(1)
	})

	// Extra response keys are IGNORED — the server assigned exactly one key and cares
	// about exactly that one. Omitting the issued key remains a refusal.
	it('ignores extra inputResponses keys and still requires the issued one', async () => {
		const probe = inputProbe()
		const first = responseOf(await probe.server.dispatch(formCall('extra-1')))
		const round = roundOf(first)

		const extra = responseOf(
			await probe.server.dispatch(
				formCall('extra-2', {
					requestState: round.requestState,
					inputResponses: {
						[round.key]: { action: 'accept' },
						unrelated: { action: 'decline' },
						alsoUnrelated: 'not even a response',
					},
				}),
			),
		)
		const omitted = responseOf(
			await probe.server.dispatch(
				formCall('extra-3', {
					requestState: round.requestState,
					inputResponses: { unrelated: { action: 'decline' } },
				}),
			),
		)

		expect(extra?.result).toMatchObject({ resultType: 'complete' })
		expect(omitted?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(probe.executions).toHaveLength(1)
	})

	// Expiry is rechecked after the selector's await — the LAST provider await
	// before execution — so a continuation that lapsed while the selector was parked never
	// reaches the tool.
	it('rechecks expiry after the selector’s await, so an expired continuation never executes', async () => {
		const probe = inputProbe({ ttl: 20, stall: 60 })
		const first = responseOf(await probe.server.dispatch(formCall('expiry-1')))
		const round = roundOf(first)

		const late = responseOf(
			await probe.server.dispatch(
				formCall('expiry-2', {
					requestState: round.requestState,
					inputResponses: { [round.key]: { action: 'accept' } },
				}),
			),
		)

		expect(late?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(probe.selections).toHaveLength(2)
		expect(probe.executions).toHaveLength(0)
	})

	// The other half of that claim: a further round reseals, and the PRIOR window is rechecked after
	// that seal — a port that took longer than the window it was extending must not hand back
	// a round built on a continuation that has already lapsed.
	it('rechecks the prior expiry after the seal await', async () => {
		const probe = inputProbe({ rounds: 2, ttl: 25 })
		const first = responseOf(await probe.server.dispatch(formCall('reseal-1')))
		const round = roundOf(first)
		probe.continuation.stall(60)

		const second = responseOf(
			await probe.server.dispatch(
				formCall('reseal-2', {
					requestState: round.requestState,
					inputResponses: { [round.key]: { action: 'accept' } },
				}),
			),
		)

		expect(second?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(isMCPInputResult(second?.result)).toBe(false)
	})

	// A FIRST round has no retry to refuse. When the port takes longer to protect the state
	// than the state was good for, the round is dead on arrival either way — but a caller who
	// has sent one request and been told its state "could not be verified for this retry" is
	// being pointed at a round it never made, and will go looking for a carrier it never had.
	it('tells a first-round caller its state expired rather than naming a retry', async () => {
		const probe = inputProbe({ ttl: 20 })
		probe.continuation.stall(60)

		const first = responseOf(await probe.server.dispatch(formCall('unissued-1')))

		expect(first?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(first?.error?.message).toBe(
			'Invalid params: request state expired before it could be issued',
		)
		expect(isMCPInputResult(first?.result)).toBe(false)
	})

	// Its counterpart, and the reason the branch is a branch: a caller that DID send a retry
	// still gets the retry wording, so the split names the round the caller is actually in.
	it('still names the retry when a further round reseals past the prior window', async () => {
		const probe = inputProbe({ rounds: 2, ttl: 25 })
		const first = responseOf(await probe.server.dispatch(formCall('named-1')))
		const round = roundOf(first)
		probe.continuation.stall(60)

		const second = responseOf(
			await probe.server.dispatch(
				formCall('named-2', {
					requestState: round.requestState,
					inputResponses: { [round.key]: { action: 'accept' } },
				}),
			),
		)

		expect(second?.error?.message).toBe(
			'Invalid params: request state could not be verified for this retry',
		)
	})

	// The NEGATIVE CONTROL for a rule this package deliberately does NOT have. There
	// is no consume-once, no session binding, no timer, and no replay store: the same
	// protected state answers twice under two fresh ids. If single use is ever introduced —
	// as an accident or as a design change — this is the row that fires.
	it('introduces no consume-once: one protected state answers twice under fresh ids', async () => {
		const probe = inputProbe()
		const first = responseOf(await probe.server.dispatch(formCall('replay-1')))
		const round = roundOf(first)

		const once = responseOf(
			await probe.server.dispatch(
				formCall('replay-2', {
					requestState: round.requestState,
					inputResponses: { [round.key]: { action: 'accept' } },
				}),
			),
		)
		const twice = responseOf(
			await probe.server.dispatch(
				formCall('replay-3', {
					requestState: round.requestState,
					inputResponses: { [round.key]: { action: 'accept' } },
				}),
			),
		)

		expect(once?.result).toMatchObject({ resultType: 'complete' })
		expect(twice?.result).toMatchObject({ resultType: 'complete' })
		expect(probe.executions).toHaveLength(2)
	})

	// A throwing selector or principal resolver is contained — one detail-free
	// `-32603` on the wire, the caught value on `error`, exactly once.
	it('contains a throwing selector and principal as one detail-free -32603 reported once', async () => {
		for (const failing of ['selector', 'principal'] as const) {
			const mcp = createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: tools(),
				input: {
					continuation: new MemoryContinuation(),
					ttl: 1_000,
					principal: () => {
						if (failing === 'principal') throw new Error(`${failing} provider detail`)
						return 'operator-1'
					},
					selector: () => {
						if (failing === 'selector') throw new Error(`${failing} provider detail`)
						return createRound()
					},
				},
			})
			const faults = createRecorders<MCPServerEventMap, 'error'>(mcp.emitter, ['error'])

			const answer = responseOf(await mcp.dispatch(formCall(`contained-${failing}`)))

			expect(answer?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
			expect(JSON.stringify(answer)).not.toContain('provider detail')
			expect(faults.error.count).toBe(1)
		}
	})

	// `input_required` is produced by the built-in `tools/call` and by nothing else,
	// even under an input policy that would ask on every call it reached.
	it('produces input_required from the built-in tools/call alone', async () => {
		const probe = inputProbe()
		const answers = [
			responseOf(await probe.server.dispatch(modernRequest('server/discover', 'only-1'))),
			responseOf(await probe.server.dispatch(modernRequest('tools/list', 'only-2'))),
		]

		for (const answer of answers) {
			expect(isMCPInputResult(answer?.result)).toBe(false)
		}
		expect(probe.selections).toHaveLength(0)
	})
})

describe('MCPServer — W02-B: custom carriers and the resolved-option seam', () => {
	// The blanket non-tool rejection is gone, so a REGISTERED `prompts/get`
	// receives its continuation carrier as an owned frozen record and owns its own
	// continuation semantics. The negative half is a call COUNTER, not a response code:
	// a carrier core refuses at the door never reaches the handler at all.
	it('delivers an owned carrier to a registered prompts/get and refuses malformed ones first', async () => {
		const seen: JSONRPCInvocation[] = []
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			limit: { metadata: 512 },
		})
		mcp.methods.add('prompts/get', async (request) => {
			seen.push(request)
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
		})
		const malformed = [
			// `_meta` beyond the configured bound — refused before the registry is consulted.
			createJSONRPCRequest({
				id: 'carrier-2',
				method: 'prompts/get',
				params: { requestState: 'x', _meta: { ...MODERN_METADATA, padding: 'y'.repeat(2048) } },
			}),
			// Nested past the depth bound — refused at the dispatch door.
			createJSONRPCRequest({
				id: 'carrier-3',
				method: 'prompts/get',
				params: { requestState: buildNestedRecord(64), _meta: MODERN_METADATA },
			}),
			// A carrier that is not JSON at all.
			createJSONRPCRequest({
				id: 'carrier-4',
				method: 'prompts/get',
				params: { requestState: () => 'nope', _meta: MODERN_METADATA },
			}),
			// An unsupported revision — refused before the registry is consulted.
			createJSONRPCRequest({
				id: 'carrier-5',
				method: 'prompts/get',
				params: {
					requestState: 'x',
					_meta: { [MCP_META_VERSION]: '1999-01-01', [MCP_META_CAPABILITIES]: {} },
				},
			}),
		]
		const refusals: Array<number | undefined> = []

		const answered = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 'carrier-1',
					method: 'prompts/get',
					params: {
						name: 'greeting',
						requestState: 'opaque-carrier',
						inputResponses: { key: { action: 'accept' } },
						_meta: MODERN_METADATA,
					},
				}),
			),
		)
		const delivered = seen[0]
		for (const request of malformed) {
			refusals.push(responseOf(await mcp.dispatch(request))?.error?.code)
		}

		expect(answered?.result).toEqual({ resultType: 'complete' })
		expect(delivered?.params).toEqual({
			name: 'greeting',
			requestState: 'opaque-carrier',
			inputResponses: { key: { action: 'accept' } },
			_meta: MODERN_METADATA,
		})
		expect(Object.isFrozen(delivered?.params)).toBe(true)
		expect(refusals).toEqual([
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_REQUEST,
			JSONRPC_INVALID_REQUEST,
			MCP_UNSUPPORTED_VERSION,
		])
		// The counter is the claim: not one malformed carrier reached the handler.
		expect(seen).toHaveLength(1)
	})

	// Separate claims, deliberately kept apart because one instrument cannot carry them together.
	// The arity check guards the PARAMETER at the registration seam: a member binds the resolved
	// options only where it spends them. `server/discover` and `tools/list` are live registry
	// reads with no await, so they have no cancellation point to spend a signal on and take the
	// request alone; `tools/call` and `subscriptions/listen` take both. `MCPMethodHandler`
	// declares both parameters and admits a handler taking fewer, so the seam stays one contract
	// either way. The arity says nothing about what a member then does with the value —
	// substituting a different options object survives it — which is why the resolved VALUE is
	// proved separately, at the built-ins that own provider hooks, caller identity and signal
	// together.
	it('resolves options into every built-in registration', async () => {
		const listened: MCPMethodOptions[] = []
		const probe = inputProbe()
		const caller = Object.freeze({ subject: 'options-user' })
		const controller = new AbortController()
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			subscription: {
				notifications: {},
				producer: (_notifications, options) => {
					listened.push(options)
					return silent()
				},
			},
		})
		const arities = ['server/discover', 'tools/list', 'tools/call', 'subscriptions/listen'].map(
			(name) => mcp.methods.method(name)?.length,
		)

		await probe.server.dispatch(formCall('propagate-1'), { caller, signal: controller.signal })
		const stream = streamOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 'propagate-2',
					method: 'subscriptions/listen',
					params: { notifications: {}, _meta: MODERN_METADATA },
				}),
				{ caller, signal: controller.signal },
			),
		)
		await drainStream(stream)

		expect(arities).toEqual([1, 1, 2, 2])
		expect(probe.principals).toHaveLength(1)
		expect(probe.principals[0]?.caller).toBe(caller)
		expect(probe.principals[0]?.signal).toBeInstanceOf(AbortSignal)
		expect(listened).toHaveLength(1)
		expect(listened[0]?.caller).toBe(caller)
		expect(listened[0]?.signal).toBeInstanceOf(AbortSignal)
	})
})

// ── W03-A: the stable Tasks extension ────────────────────────────────────────
//
// The extension puts the whole task lifecycle on the CONSUMER's side of a port, so what
// is under test here is a decision and an answer: does this server defer, and does it
// report what the manager created without adding anything of its own. Every control is
// drawn from outside the population its claim describes — the other method family for the
// capability gate, a connect-time declaration for the per-request rule, and a manager that
// binds the request's signal for the lifetime hazard.

const TASK_CAPABILITIES: Readonly<Record<string, unknown>> = Object.freeze({
	extensions: Object.freeze({ [MCP_EXTENSION_TASKS]: Object.freeze({}) }),
})
const TASK_METADATA: Readonly<Record<string, unknown>> = Object.freeze({
	[MCP_META_VERSION]: '2026-07-28',
	[MCP_META_CAPABILITIES]: TASK_CAPABILITIES,
})

const TASK_METHODS = Object.freeze(['tasks/get', 'tasks/update', 'tasks/cancel'] as const)

// A modern `tools/call` whose client DECLARES the tasks extension on the request itself,
// which is the only place the extension recognizes a declaration.
function taskCall(params: Readonly<Record<string, unknown>>, id: JSONRPCId = 1): JSONRPCRequest {
	return createJSONRPCRequest({
		method: 'tools/call',
		id,
		params: { ...params, _meta: TASK_METADATA },
	})
}

// One `tasks/*` request from a client that DECLARED the extension on the request itself.
function taskRequest(
	method: string,
	params: Readonly<Record<string, unknown>>,
	id: JSONRPCId = 1,
): JSONRPCRequest {
	return createJSONRPCRequest({ method, id, params: { ...params, _meta: TASK_METADATA } })
}

// Create one task through the deferral seam and answer the handle the client received —
// the only way a `taskId` legitimately reaches a client, so every lifecycle test below
// starts where a real one does.
async function createdTask(mcp: MCPServerInterface, id: JSONRPCId = 'create'): Promise<string> {
	const answer = resultOf(responseOf(await mcp.dispatch(taskCall({ name: 'echo' }, id))))
	const taskId = answer['taskId']
	if (typeof taskId !== 'string') throw new Error('expected a created task to carry a taskId')
	return taskId
}

function taskServer(
	task: MCPTaskOptions,
	extra: Partial<MCPServerOptions> = {},
): MCPServerInterface {
	return createMCPServer({
		identity: { name: 'test-server', version: '1.2.3' },
		tools: tools(),
		task,
		...extra,
	})
}

// A manager that answers one fixed creation and nothing else — the inert stub for the
// scenarios about what MCP does with what a manager returned.
function fixedTaskManager(created: MCPTask): MCPTaskManagerInterface {
	return {
		start: () => Promise.resolve(created),
		task: () => Promise.resolve(undefined),
		update: () => Promise.resolve(),
		abort: () => Promise.resolve(),
	}
}

describe('MCPServer — W03-A: the stable Tasks extension', () => {
	it('defers a declared call and answers the manager task as a flat modern result', async () => {
		const tasks = new TestTaskManager()
		const mcp = taskServer({ tasks, deferral: () => 'operation-1' })

		const answer = resultOf(
			responseOf(await mcp.dispatch(taskCall({ name: 'echo', arguments: { a: 1 } }, 'defer-1'))),
		)

		expect(answer['resultType']).toBe('task')
		expect(answer['status']).toBe('working')
		expect(answer['ttlMs']).toBeNull()
		expect(answer['taskId']).toBe(tasks.details[0]?.taskId)
		expect(answer['createdAt']).toBe('1970-01-01T00:00:01.000Z')
		expect(answer['lastUpdatedAt']).toBe('1970-01-01T00:00:01.000Z')
		expect(answer['_meta']).toEqual({
			[MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' },
		})
		// FLAT, not `{ task: ... }`, and carrying no terminal payload for a task with no outcome.
		expect(Object.hasOwn(answer, 'task')).toBe(false)
		expect(Object.hasOwn(answer, 'result')).toBe(false)
		expect(Object.hasOwn(answer, 'content')).toBe(false)
	})

	// The `-32003` control, drawn from the OTHER method family: the same undeclared client
	// that would be refused on `tasks/get` must get an ordinary answer here, because deferral
	// is server-decided and this client never asked for one.
	it('refuses a deployment-selected task when the request lacks the capability', async () => {
		const tasks = new TestTaskManager()
		const deferrals: MCPTaskContext[] = []
		const mcp = taskServer({
			tasks,
			deferral: (context) => {
				deferrals.push(context)
				return 'operation-1'
			},
		})

		const answer = responseOf(
			await mcp.dispatch(modernCall({ name: 'echo', arguments: { a: 1 } }, 'plain-1')),
		)?.error

		expect(answer?.code).toBe(MCP_MISSING_CAPABILITY)
		expect(deferrals).toHaveLength(1)
		expect(tasks.starts).toHaveLength(0)
	})

	// The per-request control: the exact shape a session-oriented implementation would
	// wrongly accept — the capability declared during `initialize` and absent from the call.
	it('does not reuse a capability declared at connect time for a later request', async () => {
		const tasks = new TestTaskManager()
		const mcp = taskServer({ tasks, deferral: () => 'operation-1' })

		await mcp.dispatch(
			createJSONRPCRequest({
				id: 'connect-1',
				method: 'initialize',
				params: { protocolVersion: '2025-11-25', capabilities: TASK_CAPABILITIES },
			}),
		)
		const answer = responseOf(await mcp.dispatch(modernCall({ name: 'echo' }, 'connect-2')))?.error

		expect(answer?.code).toBe(MCP_MISSING_CAPABILITY)
		expect(tasks.starts).toHaveLength(0)
	})

	it('runs the call inline when the deferral policy declines', async () => {
		const tasks = new TestTaskManager()
		const mcp = taskServer({ tasks, deferral: () => undefined })

		const answer = resultOf(
			responseOf(await mcp.dispatch(taskCall({ name: 'echo', arguments: { a: 1 } }, 'decline-1'))),
		)

		expect(answer['resultType']).toBe('complete')
		expect(answer['structuredContent']).toEqual({ a: 1 })
		expect(tasks.starts).toHaveLength(0)
	})

	// MCP's OWN behaviour, outside the manager population every other dedup claim is about:
	// whatever the policy minted travels to the manager unchanged, twice.
	it('forwards a repeated operation key to the manager unchanged', async () => {
		const tasks = new TestTaskManager()
		const mcp = taskServer({ tasks, deferral: () => ' Operation/One ' })

		const first = resultOf(responseOf(await mcp.dispatch(taskCall({ name: 'echo' }, 'reuse-1'))))
		const second = resultOf(responseOf(await mcp.dispatch(taskCall({ name: 'echo' }, 'reuse-2'))))

		expect(tasks.starts.map((entry) => entry[0])).toEqual([' Operation/One ', ' Operation/One '])
		expect(second['taskId']).toBe(first['taskId'])
		expect(tasks.details).toHaveLength(1)
	})

	// Precedence, first half: a call still asking its operator a question has not been decided
	// yet, so the input mechanism resolves before the task decision is ever reached.
	it('resolves the multi-round input mechanism before it considers a task', async () => {
		const tasks = new TestTaskManager()
		const deferrals: MCPTaskContext[] = []
		const mcp = taskServer(
			{
				tasks,
				deferral: (context) => {
					deferrals.push(context)
					return 'operation-1'
				},
			},
			{
				input: {
					continuation: new MemoryContinuation(),
					ttl: 1_000,
					principal: () => 'operator-1',
					selector: () => createRound(),
				},
			},
		)

		const answer = resultOf(
			responseOf(
				await mcp.dispatch(
					createJSONRPCRequest({
						id: 'precedence-1',
						method: 'tools/call',
						params: {
							name: 'echo',
							_meta: {
								[MCP_META_VERSION]: '2026-07-28',
								[MCP_META_CAPABILITIES]: { elicitation: {}, ...TASK_CAPABILITIES },
							},
						},
					}),
				),
			),
		)

		expect(answer['resultType']).toBe('input_required')
		expect(deferrals).toHaveLength(0)
		expect(tasks.starts).toHaveLength(0)
	})

	// Precedence, second half: a deferred call has no request-scoped stream left to report
	// progress on, so the task answer replaces the progress stream rather than racing it.
	it('answers a unary task instead of opening a progress stream', async () => {
		const tasks = new TestTaskManager()
		const reported: MCPProgressInterface[] = []
		const mcp = taskServer(
			{ tasks, deferral: () => 'operation-1' },
			{
				execution: (context) => {
					if (context.progress !== undefined) reported.push(context.progress)
					return { id: context.call.id, name: context.call.name, success: true, value: 'inline' }
				},
			},
		)

		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				id: 'progress-1',
				method: 'tools/call',
				params: { name: 'echo', _meta: { ...TASK_METADATA, progressToken: 'token-1' } },
			}),
		)

		expect(answer !== undefined && Symbol.asyncIterator in answer).toBe(false)
		expect(resultOf(responseOf(answer))['resultType']).toBe('task')
		expect(reported).toHaveLength(0)
	})

	// The port's shape, asserted structurally: `MCPTaskContext` carries no cancellation
	// signal, and the accompanying options carry the request's.
	it('supplies the call in hand with no cancellation signal of its own', async () => {
		const tasks = new TestTaskManager()
		const deferrals: MCPTaskContext[] = []
		const mcp = taskServer({
			tasks,
			deferral: (context) => {
				deferrals.push(context)
				return 'operation-1'
			},
		})
		const call = taskCall({ name: 'sum', arguments: { a: 2, b: 3 } }, 'context-1')

		await mcp.dispatch(call, { caller: 'asserted' })

		const context = deferrals[0]
		if (context === undefined) throw new Error('expected the deferral policy to be consulted')
		expect(Object.keys(context).sort()).toEqual(['call', 'request', 'tools'])
		expect(Object.hasOwn(context, 'signal')).toBe(false)
		expect(context.request).toEqual(call)
		expect(context.call).toEqual({
			id: 'context-1',
			name: 'sum',
			arguments: { a: 2, b: 3 },
			caller: 'asserted',
		})
		expect(tasks.starts[0]?.[1]).toBe(context)
		expect(tasks.starts[0]?.[2].signal).toBeInstanceOf(AbortSignal)
		expect(tasks.starts[0]?.[2].caller).toBe('asserted')
	})

	// THE FIXTURE PAIR the port's TSDoc obligation closes on. The managers differ in one
	// flag and are driven identically, including the abort every transport performs the
	// instant the answer is written. A `completed` in the first case would mean the hazard
	// the TSDoc names does not exist and the paragraph must be deleted.
	it('loses the task when the manager binds the request signal to the work', async () => {
		const tasks = new TestTaskManager({ bind: true, work: 30 })
		const mcp = taskServer({ tasks, deferral: () => 'operation-1' })
		const lifetime = new AbortController()

		const answer = resultOf(
			responseOf(
				await mcp.dispatch(taskCall({ name: 'echo' }, 'bound-1'), { signal: lifetime.signal }),
			),
		)
		// Exactly what `createMCPHandler` does: the request's signal ends with the response.
		lifetime.abort()
		await tasks.settle()

		const detail = await tasks.task(String(answer['taskId']))
		// The answer was a perfectly good task handle — which is what makes the loss silent.
		expect(answer['resultType']).toBe('task')
		expect(answer['status']).toBe('working')
		expect(detail?.status).toBe('cancelled')
	})

	it('keeps the task when the manager gives the work a lifetime it owns', async () => {
		const tasks = new TestTaskManager({ bind: false, work: 30 })
		const mcp = taskServer({ tasks, deferral: () => 'operation-1' })
		const lifetime = new AbortController()

		const answer = resultOf(
			responseOf(
				await mcp.dispatch(taskCall({ name: 'echo' }, 'unbound-1'), { signal: lifetime.signal }),
			),
		)
		lifetime.abort()
		await tasks.settle()

		const detail = await tasks.task(String(answer['taskId']))
		expect(answer['resultType']).toBe('task')
		expect(answer['status']).toBe('working')
		expect(detail?.status).toBe('completed')
	})

	// The `-32603` control, drawn from the arm it must not be confused with: a manager that
	// reports a non-`working` status is answering SUCCESSFULLY, so the client learns the
	// status from the result rather than from a protocol error.
	it('answers a successful task result for a task the manager started as input_required', async () => {
		const tasks = new TestTaskManager({ asking: true })
		const mcp = taskServer({ tasks, deferral: () => 'operation-1' })

		const response = responseOf(await mcp.dispatch(taskCall({ name: 'echo' }, 'asking-1')))
		const answer = resultOf(response)

		expect(response?.error).toBeUndefined()
		expect(answer['resultType']).toBe('task')
		expect(answer['status']).toBe('input_required')
		// The requests the task published stay on the TASK, not on this creation answer.
		expect(Object.hasOwn(answer, 'inputRequests')).toBe(false)
	})

	it('contains a deferral policy throw as a detail-free internal error', async () => {
		const tasks = new TestTaskManager()
		const mcp = taskServer({
			tasks,
			deferral: () => {
				throw new Error('deferral policy detail')
			},
		})
		const faults: unknown[] = []
		mcp.emitter.on('error', (error) => void faults.push(error))

		const response = responseOf(await mcp.dispatch(taskCall({ name: 'echo' }, 'throw-1')))

		expect(response?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(JSON.stringify(response)).not.toContain('deferral policy detail')
		expect(faults).toHaveLength(1)
	})

	it('contains a manager start throw as a detail-free internal error', async () => {
		const failing: MCPTaskManagerInterface = {
			start: () => {
				throw new Error('manager start detail')
			},
			task: () => Promise.resolve(undefined),
			update: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		}
		const mcp = taskServer({ tasks: failing, deferral: () => 'operation-1' })
		const faults: unknown[] = []
		mcp.emitter.on('error', (error) => void faults.push(error))

		const response = responseOf(await mcp.dispatch(taskCall({ name: 'echo' }, 'throw-2')))

		expect(response?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(JSON.stringify(response)).not.toContain('manager start detail')
		expect(faults).toHaveLength(1)
	})

	it('refuses a task the manager returned outside the content bound', async () => {
		const oversized = fixedTaskManager({
			taskId: 'task-1',
			status: 'working',
			statusMessage: 'x'.repeat(4_096),
			createdAt: '1970-01-01T00:00:01.000Z',
			lastUpdatedAt: '1970-01-01T00:00:01.000Z',
			ttlMs: null,
		})
		const mcp = taskServer(
			{ tasks: oversized, deferral: () => 'operation-1' },
			{ limit: { content: 512 } },
		)

		const response = responseOf(await mcp.dispatch(taskCall({ name: 'echo' }, 'oversize-1')))

		expect(response?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(response?.error?.message).toBe('Server execution returned an invalid or oversized task')
	})

	// Every optional member is carried only when the manager produced one — an absent
	// `statusMessage` must not become a `null`, and an absent `pollIntervalMs` must not
	// become a number this server invented.
	it('carries the manager optional members exactly as it produced them', async () => {
		const hinted = fixedTaskManager({
			taskId: 'task-2',
			status: 'working',
			statusMessage: 'queued behind two others',
			createdAt: '1970-01-01T00:00:01.000Z',
			lastUpdatedAt: '1970-01-01T00:00:02.000Z',
			ttlMs: 60_000,
			pollIntervalMs: 2_500,
		})
		const mcp = taskServer({ tasks: hinted, deferral: () => 'operation-1' })

		const hintedAnswer = resultOf(
			responseOf(await mcp.dispatch(taskCall({ name: 'echo' }, 'optional-1'))),
		)
		const bare = resultOf(
			responseOf(
				await taskServer({
					tasks: new TestTaskManager(),
					deferral: () => 'operation-1',
				}).dispatch(taskCall({ name: 'echo' }, 'optional-2')),
			),
		)

		expect(hintedAnswer['statusMessage']).toBe('queued behind two others')
		expect(hintedAnswer['pollIntervalMs']).toBe(2_500)
		expect(hintedAnswer['ttlMs']).toBe(60_000)
		expect(Object.hasOwn(bare, 'statusMessage')).toBe(false)
		expect(Object.hasOwn(bare, 'pollIntervalMs')).toBe(false)
	})

	// `undefined` is the policy saying "run this inline", and it is the ONLY spelling of that.
	// An empty key cannot identify an operation, so a manager asked to deduplicate on one would
	// collapse every deferred call onto a single task — a faulty policy the consumer has to
	// hear about, not a second spelling of absence quietly routed down the inline path.
	it('refuses an empty deferral key rather than silently running the call inline', async () => {
		const tasks = new TestTaskManager()
		const inline = taskServer({ tasks: new TestTaskManager(), deferral: () => undefined })
		const faulty = taskServer({ tasks, deferral: () => '' })

		const declined = resultOf(
			responseOf(await inline.dispatch(taskCall({ name: 'echo' }, 'empty-1'))),
		)
		const refused = responseOf(await faulty.dispatch(taskCall({ name: 'echo' }, 'empty-2')))

		// The control, drawn from the answer an empty key must NOT be confused with.
		expect(declined['resultType']).toBe('complete')
		expect(refused?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(refused?.error?.message).toBe('Server execution returned an invalid task key')
		expect(tasks.starts).toHaveLength(0)
	})

	// The legacy wire carries no capability metadata at all, so it can never declare the
	// extension — the era boundary keeps the whole mechanism off the old wire.
	it('refuses a selected task at the legacy revision boundary', async () => {
		const tasks = new TestTaskManager()
		const mcp = createMCPLegacy(taskServer({ tasks, deferral: () => 'operation-1' }))

		const answer = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 'legacy-1',
					method: 'tools/call',
					params: { name: 'echo', arguments: { a: 1 } },
				}),
			),
		)

		expect(answer?.error?.code).toBe(JSONRPC_SERVER_ERROR)
		expect(tasks.starts).toHaveLength(0)
	})

	it('advertises the extension through discovery only when it is configured', async () => {
		const configured = taskServer({ tasks: new TestTaskManager(), deferral: () => undefined })

		const advertised = resultOf(
			responseOf(await configured.dispatch(modernRequest('server/discover', 'discover-1'))),
		)
		const plain = resultOf(
			responseOf(await server().dispatch(modernRequest('server/discover', 'discover-2'))),
		)

		expect(advertised['capabilities']).toEqual({
			tools: {},
			extensions: { [MCP_EXTENSION_TASKS]: {} },
		})
		// Byte-identical to the answer this server gave before the extension existed.
		expect(plain['capabilities']).toEqual({ tools: {} })
	})

	// The real claim: an opt-in extension that is not opted into changes nothing. The
	// CONFIGURED half is the control drawn from outside the unconfigured population — without
	// it, a registration that never happened at all would pass this test unremarked.
	it('leaves an unconfigured server answering exactly what it answered before', async () => {
		const mcp = server()
		const configured = taskServer({ tasks: new TestTaskManager(), deferral: () => undefined })

		const called = resultOf(
			responseOf(await mcp.dispatch(modernCall({ name: 'echo', arguments: { a: 1 } }, 'inert-1'))),
		)
		const missing = await Promise.all(
			TASK_METHODS.map(
				async (method) =>
					responseOf(await mcp.dispatch(modernRequest(method, 'inert-2')))?.error?.code,
			),
		)
		const registered = await Promise.all(
			TASK_METHODS.map(
				async (method) =>
					responseOf(await configured.dispatch(modernRequest(method, 'inert-3')))?.error?.code,
			),
		)

		expect(called['resultType']).toBe('complete')
		expect(called['structuredContent']).toEqual({ a: 1 })
		expect(Object.hasOwn(called, 'taskId')).toBe(false)
		expect(missing).toEqual([
			JSONRPC_METHOD_NOT_FOUND,
			JSONRPC_METHOD_NOT_FOUND,
			JSONRPC_METHOD_NOT_FOUND,
		])
		// Registered, and therefore refusing for a REASON rather than for absence: this client
		// declared no extension, so every one of them answers the capability code.
		expect(registered).toEqual([
			MCP_MISSING_CAPABILITY,
			MCP_MISSING_CAPABILITY,
			MCP_MISSING_CAPABILITY,
		])
	})
})

// ── W03-B: the durable task lifecycle ────────────────────────────────────────
//
// Unary methods over a port this package cannot see inside. What is under test is
// therefore never the task's behaviour — it is the REFUSAL TAXONOMY, and the faithfulness of
// what crosses the seam in each direction. Every control is drawn from outside the population
// its claim describes: `ttlMs: null` for a purge rule written against finite numbers, a
// `failed` task for the code that must not become `-32603`, a second read for the cache this
// server does not hold, and the other method family for the capability gate.

// A manager whose store is a map the test rewrites between reads — the instrument for terminal
// immutability, which is a claim about MCP holding NO cache rather than about a manager
// behaving. `start` answers whatever was seeded under the key it was given.
function mutableTaskManager(details: Map<string, MCPTaskDetail>): MCPTaskManagerInterface {
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

// A manager that resolves `start` BEFORE its write lands — outside the persists-then-resolves
// population entirely rather than a slower member of it.
function deferredWriteTaskManager(): MCPTaskManagerInterface {
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

// A manager that mints the handle FROM the key and deduplicates on the bare key —
// obligations `start`'s TSDoc states and this package cannot enforce, violated together
// because one fixture demonstrates both consequences.
function guessableTaskManager(): MCPTaskManagerInterface {
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

describe('MCPServer — W03-B: reading one durable task', () => {
	it('answers a task snapshot as a complete result, never a task result', async () => {
		const tasks = new TestTaskManager({ asking: true })
		const mcp = taskServer({ tasks, deferral: () => 'operation-1' })
		const taskId = await createdTask(mcp)

		const answer = resultOf(
			responseOf(await mcp.dispatch(taskRequest('tasks/get', { taskId }, 'get-1'))),
		)

		// `complete`, not `task`. Only CREATION announces a task; reading one is an ordinary
		// completed call whose payload happens to be a task — and reasoning by symmetry from
		// `MCPTaskResult` would have got this wrong on every method.
		expect(answer['resultType']).toBe('complete')
		expect(answer['taskId']).toBe(taskId)
		expect(answer['status']).toBe('input_required')
		expect(answer['createdAt']).toBe('1970-01-01T00:00:01.000Z')
		expect(answer['ttlMs']).toBeNull()
		expect(answer['_meta']).toEqual({
			[MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' },
		})
	})

	it('carries each status payload the detail union declares', async () => {
		const details = new Map<string, MCPTaskDetail>([
			[
				'done',
				{
					taskId: 'done',
					status: 'completed',
					createdAt: 'a',
					lastUpdatedAt: 'b',
					ttlMs: null,
					result: { resultType: 'complete', content: [{ type: 'text', text: 'ok' }] },
				},
			],
			[
				'broke',
				{
					taskId: 'broke',
					status: 'failed',
					createdAt: 'a',
					lastUpdatedAt: 'b',
					ttlMs: null,
					error: { code: -32000, message: 'the tool never ran' },
				},
			],
			[
				'stopped',
				{ taskId: 'stopped', status: 'cancelled', createdAt: 'a', lastUpdatedAt: 'b', ttlMs: null },
			],
		])
		const mcp = taskServer({ tasks: mutableTaskManager(details), deferral: () => undefined })

		const answers = await Promise.all(
			[...details.keys()].map(async (taskId) =>
				resultOf(responseOf(await mcp.dispatch(taskRequest('tasks/get', { taskId }, taskId)))),
			),
		)

		expect(answers[0]?.['result']).toEqual({
			resultType: 'complete',
			content: [{ type: 'text', text: 'ok' }],
		})
		expect(answers[1]?.['error']).toEqual({ code: -32000, message: 'the tool never ran' })
		expect(Object.hasOwn(answers[2] ?? {}, 'result')).toBe(false)
		expect(Object.hasOwn(answers[2] ?? {}, 'error')).toBe(false)
		expect(answers.map((answer) => answer['resultType'])).toEqual([
			'complete',
			'complete',
			'complete',
		])
	})

	// THE SHARP CONTROL. Never-existed, purged, and unauthorized are different facts in
	// different stores, and the wire must not be able to tell them apart. Byte equality of
	// the whole serialized envelope is the assertion, not equality of the code: a differing
	// message is exactly the enumeration oracle a bearer `taskId` cannot afford.
	it('answers never-existed, purged, and unauthorized with one byte-identical refusal', async () => {
		const purged = new TestTaskManager({ ttl: 60_000 })
		const guarded = new TestTaskManager({ owner: 'owner-1' })
		const absent = taskServer({ tasks: new TestTaskManager(), deferral: () => 'operation-1' })
		const expiring = taskServer({ tasks: purged, deferral: () => 'operation-1' })
		const owned = taskServer({ tasks: guarded, deferral: () => 'operation-1' })
		const expired = await createdTask(expiring, 'purge-seed')
		const theirs = await createdTask(owned, 'owner-seed')
		purged.purge()

		const responses = await Promise.all([
			absent.dispatch(taskRequest('tasks/get', { taskId: 'never-minted' }, 'same-id')),
			expiring.dispatch(taskRequest('tasks/get', { taskId: expired }, 'same-id')),
			owned.dispatch(taskRequest('tasks/get', { taskId: theirs }, 'same-id'), {
				caller: 'someone-else',
			}),
		])
		const wire = responses.map((response) => JSON.stringify(responseOf(response)))

		expect(new Set(wire).size).toBe(1)
		expect(responseOf(responses[0])?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		// The last store really did hold that task — this is indistinguishability, not
		// managers that all happened to be empty.
		expect(
			await guarded.task(theirs, { signal: AbortSignal.abort(), caller: 'owner-1' }),
		).toBeDefined()
		expect(purged.details).toHaveLength(0)
	})

	// The TTL control, drawn from outside the finite-number population the purge rule is written
	// against: `null` is the extension's spelling for "no expiry", not a zero-length one.
	it('keeps reading a task whose ttlMs is null through a purge that removes the rest', async () => {
		const tasks = new TestTaskManager()
		const mcp = taskServer({ tasks, deferral: () => 'operation-1' })
		const taskId = await createdTask(mcp, 'eternal-seed')

		tasks.purge()
		const answer = resultOf(
			responseOf(await mcp.dispatch(taskRequest('tasks/get', { taskId }, 'eternal-1'))),
		)

		expect(answer['ttlMs']).toBeNull()
		expect(answer['taskId']).toBe(taskId)
	})

	it('refuses an absent, non-string, empty, or over-bound taskId with invalid params', async () => {
		const mcp = taskServer(
			{ tasks: new TestTaskManager(), deferral: () => undefined },
			{ limit: { state: 32 } },
		)

		const refusals = await Promise.all(
			[{}, { taskId: 7 }, { taskId: '' }, { taskId: 'x'.repeat(64) }].map(
				async (params) =>
					responseOf(await mcp.dispatch(taskRequest('tasks/get', params, 'bad-1')))?.error,
			),
		)

		expect(refusals.map((error) => error?.code)).toEqual([
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
		])
		expect(new Set(refusals.map((error) => error?.message))).toEqual(
			new Set(['Invalid params: a bounded string `taskId` is required']),
		)
	})

	// The manager's answer is PROVEN before it reaches the wire, exactly as the creation answer
	// is: a declared return type is a promise, and the manager is the untrusted half.
	it('refuses a snapshot the manager returned malformed or outside the content bound', async () => {
		const oversized = new Map<string, MCPTaskDetail>([
			[
				'big',
				{
					taskId: 'big',
					status: 'working',
					statusMessage: 'x'.repeat(4_096),
					createdAt: 'a',
					lastUpdatedAt: 'b',
					ttlMs: null,
				},
			],
		])
		// Off-contract in a way TypeScript accepts and the wire cannot: a FRACTIONAL `ttlMs`, where
		// the declared type says `number | null` and the schema formats the field `int`. That is
		// exactly the class of defect a declared type cannot catch.
		const malformed = new Map<string, MCPTaskDetail>([
			[
				'lying',
				{
					taskId: 'lying',
					status: 'completed',
					createdAt: 'a',
					lastUpdatedAt: 'b',
					ttlMs: 1_000.5,
					result: { resultType: 'complete' },
				},
			],
		])
		const bounded = taskServer(
			{ tasks: mutableTaskManager(oversized), deferral: () => undefined },
			{ limit: { content: 512 } },
		)
		const lying = taskServer({ tasks: mutableTaskManager(malformed), deferral: () => undefined })

		const large = responseOf(
			await bounded.dispatch(taskRequest('tasks/get', { taskId: 'big' }, 'big-1')),
		)
		const bad = responseOf(
			await lying.dispatch(taskRequest('tasks/get', { taskId: 'lying' }, 'lie-1')),
		)

		expect(large?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(large?.error?.message).toBe('Server execution returned an invalid or oversized task')
		expect(bad?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(bad?.error?.message).toBe('Server execution returned an invalid or oversized task')
	})

	// The `-32603` control, drawn from the arm it must not be confused with: a `failed` task is a
	// SUCCESSFUL read of a task that failed, so the client learns the failure from the payload.
	it('answers a complete result for a failed task rather than an internal error', async () => {
		const details = new Map<string, MCPTaskDetail>([
			[
				'broke',
				{
					taskId: 'broke',
					status: 'failed',
					createdAt: 'a',
					lastUpdatedAt: 'b',
					ttlMs: null,
					error: { code: -32603, message: 'the deferred call could not run' },
				},
			],
		])
		const mcp = taskServer({ tasks: mutableTaskManager(details), deferral: () => undefined })

		const response = responseOf(
			await mcp.dispatch(taskRequest('tasks/get', { taskId: 'broke' }, 'fail-1')),
		)

		expect(response?.error).toBeUndefined()
		expect(resultOf(response)['resultType']).toBe('complete')
		expect(resultOf(response)['status']).toBe('failed')
	})

	// Terminal immutability is the MANAGER's obligation, so what is provable here is the
	// consequence of MCP holding no cache: a manager that mutates a terminal task has BOTH of its
	// snapshots reported faithfully. An instrument that "passed" by caching the first read would
	// be indistinguishable from a correct one without this second read.
	it('reports a mutated terminal task faithfully both times, holding no snapshot of its own', async () => {
		const details = new Map<string, MCPTaskDetail>([
			[
				'settled',
				{
					taskId: 'settled',
					status: 'completed',
					createdAt: 'a',
					lastUpdatedAt: 'b',
					ttlMs: null,
					result: { resultType: 'complete', content: [{ type: 'text', text: 'first' }] },
				},
			],
		])
		const mcp = taskServer({ tasks: mutableTaskManager(details), deferral: () => undefined })

		const before = resultOf(
			responseOf(await mcp.dispatch(taskRequest('tasks/get', { taskId: 'settled' }, 'mutate-1'))),
		)
		details.set('settled', {
			taskId: 'settled',
			status: 'cancelled',
			createdAt: 'a',
			lastUpdatedAt: 'c',
			ttlMs: null,
		})
		const after = resultOf(
			responseOf(await mcp.dispatch(taskRequest('tasks/get', { taskId: 'settled' }, 'mutate-2'))),
		)

		expect(before['status']).toBe('completed')
		expect(after['status']).toBe('cancelled')
		expect(Object.hasOwn(after, 'result')).toBe(false)
	})

	it('carries ttlMs and pollIntervalMs through unchanged and invents neither', async () => {
		const details = new Map<string, MCPTaskDetail>([
			[
				'hinted',
				{
					taskId: 'hinted',
					status: 'working',
					createdAt: 'a',
					lastUpdatedAt: 'b',
					ttlMs: 30_000,
					pollIntervalMs: 2_500,
				},
			],
			[
				'bare',
				{ taskId: 'bare', status: 'working', createdAt: 'a', lastUpdatedAt: 'b', ttlMs: null },
			],
		])
		const mcp = taskServer({ tasks: mutableTaskManager(details), deferral: () => undefined })

		const hinted = resultOf(
			responseOf(await mcp.dispatch(taskRequest('tasks/get', { taskId: 'hinted' }, 'hint-1'))),
		)
		const bare = resultOf(
			responseOf(await mcp.dispatch(taskRequest('tasks/get', { taskId: 'bare' }, 'hint-2'))),
		)

		expect(hinted['ttlMs']).toBe(30_000)
		expect(hinted['pollIntervalMs']).toBe(2_500)
		expect(bare['ttlMs']).toBeNull()
		expect(Object.hasOwn(bare, 'pollIntervalMs')).toBe(false)
	})
})

// The `null` a foreign implementation of the port answers an unknown `taskId` with.
// `MCPTaskManagerInterface.task` declares `undefined`, so this is the one value TypeScript
// cannot put behind that signature and every other language that implements this published
// contract reaches for daily — installed through `Reflect` for exactly that reason, because
// the port's threat model is that a manager's declared types are a promise, not a proof.
function absentTask(): Promise<null> {
	return Promise.resolve(null)
}

// A manager that RECORDS every `update` and `abort` it is asked to perform, over whatever
// `task` read the scenario supplies. Both write methods answer `void`, so what was invoked
// is the only observable that says whether the probe decided before authorizing anything.
function watchedTaskManager(
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

describe('MCPServer — W03-B: answering and stopping one durable task', () => {
	it('forwards every input response verbatim and answers an empty complete result', async () => {
		const forwarded: Array<Readonly<Record<string, unknown>>> = []
		const tasks = new TestTaskManager({ asking: true })
		const mcp = taskServer({
			tasks: {
				start: (key, context, options) => tasks.start(key, context, options),
				task: (id, options) => tasks.task(id, options),
				update: (id, responses, options) => {
					forwarded.push(responses)
					return tasks.update(id, responses, options)
				},
				abort: (id, options) => tasks.abort(id, options),
			},
			deferral: () => 'operation-1',
		})
		const taskId = await createdTask(mcp, 'update-seed')

		const answer = resultOf(
			responseOf(
				await mcp.dispatch(
					taskRequest(
						'tasks/update',
						// One key the task published, one it never did, and one that is nobody's:
						// MCP holds none of the task's keys, so each travels and the manager
						// does the ignoring.
						{ taskId, inputResponses: { approval: { action: 'accept' }, unrelated: 1, '': null } },
						'update-1',
					),
				),
			),
		)

		expect(forwarded).toEqual([{ approval: { action: 'accept' }, unrelated: 1, '': null }])
		expect(answer).toEqual({
			resultType: 'complete',
			_meta: { [MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' } },
		})
		// The provider ignored the keys it did not know, and the task moved on the one it did.
		expect((await tasks.task(taskId))?.status).toBe('working')
	})

	// A second update naming a key the task has already answered is likewise the manager's to
	// ignore: MCP forwards it and reports success, because "already satisfied" is a fact only
	// the task holds.
	it('forwards an already-satisfied key again and still answers success', async () => {
		const tasks = new TestTaskManager({ asking: true })
		const mcp = taskServer({ tasks, deferral: () => 'operation-1' })
		const taskId = await createdTask(mcp, 'repeat-seed')
		const responses = { taskId, inputResponses: { approval: { action: 'accept' } } }

		const first = responseOf(await mcp.dispatch(taskRequest('tasks/update', responses, 'repeat-1')))
		const second = responseOf(
			await mcp.dispatch(taskRequest('tasks/update', responses, 'repeat-2')),
		)

		expect(first?.error).toBeUndefined()
		expect(second?.error).toBeUndefined()
		expect(resultOf(second)['resultType']).toBe('complete')
	})

	it('refuses an update whose inputResponses are absent or not an object', async () => {
		const tasks = new TestTaskManager({ asking: true })
		const mcp = taskServer({ tasks, deferral: () => 'operation-1' })
		const taskId = await createdTask(mcp, 'shape-seed')

		const refusals = await Promise.all(
			[{ taskId }, { taskId, inputResponses: 'yes' }, { taskId, inputResponses: 1 }].map(
				async (params) =>
					responseOf(await mcp.dispatch(taskRequest('tasks/update', params, 'shape-1')))?.error,
			),
		)

		expect(refusals.map((error) => error?.code)).toEqual([
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
		])
		expect(new Set(refusals.map((error) => error?.message))).toEqual(
			new Set(['Invalid params: an `inputResponses` object is required']),
		)
	})

	// Cancellation is ADVISORY. A manager that ignores the ask and reaches `completed` is
	// non-compliant with the extension's intent and perfectly legal on this wire, so the
	// acknowledgement must not claim the task stopped — and it carries no status at all.
	it('acknowledges a cancellation the manager ignores, asserting nothing about the outcome', async () => {
		const details = new Map<string, MCPTaskDetail>([
			[
				'stubborn',
				{ taskId: 'stubborn', status: 'working', createdAt: 'a', lastUpdatedAt: 'b', ttlMs: null },
			],
		])
		const asks: string[] = []
		const stubborn: MCPTaskManagerInterface = {
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
		const mcp = taskServer({ tasks: stubborn, deferral: () => undefined })

		const answer = resultOf(
			responseOf(await mcp.dispatch(taskRequest('tasks/cancel', { taskId: 'stubborn' }, 'stop-1'))),
		)
		const after = resultOf(
			responseOf(await mcp.dispatch(taskRequest('tasks/get', { taskId: 'stubborn' }, 'stop-2'))),
		)

		expect(asks).toEqual(['stubborn'])
		expect(answer).toEqual({
			resultType: 'complete',
			_meta: { [MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' } },
		})
		// The acknowledgement said the ASK was accepted; the task says what actually happened.
		expect(after['status']).toBe('completed')
		expect(Object.hasOwn(answer, 'status')).toBe(false)
	})

	it('stops a cooperating task and reports the cancelled snapshot afterwards', async () => {
		const tasks = new TestTaskManager({ work: 200 })
		const mcp = taskServer({ tasks, deferral: () => 'operation-1' })
		const taskId = await createdTask(mcp, 'cancel-seed')

		await mcp.dispatch(taskRequest('tasks/cancel', { taskId }, 'cancel-1'))
		await tasks.settle()
		const after = resultOf(
			responseOf(await mcp.dispatch(taskRequest('tasks/get', { taskId }, 'cancel-2'))),
		)

		expect(after['status']).toBe('cancelled')
	})

	// `update` and `abort` both answer `void`, so neither can report an unknown task and neither
	// can be where authorization is decided. The read that precedes them is, and its refusal is
	// the one `tasks/get` answers — byte-identical across every method.
	it('refuses an update and a cancellation of an unresolved task identically to a read', async () => {
		const guarded = new TestTaskManager({ owner: 'owner-1' })
		const mcp = taskServer({ tasks: guarded, deferral: () => 'operation-1' })
		const theirs = await createdTask(mcp, 'reject-seed')

		const refusals = await Promise.all(
			TASK_METHODS.map(async (method) =>
				responseOf(
					await mcp.dispatch(
						taskRequest(method, { taskId: theirs, inputResponses: {} }, 'same-id'),
						{ caller: 'someone-else' },
					),
				),
			),
		)

		expect(new Set(refusals.map((response) => JSON.stringify(response))).size).toBe(1)
		expect(refusals[0]?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(refusals[0]?.error?.message).toBe(
			'Invalid params: no task is available for that `taskId`',
		)
	})

	// The same probe, attacked. A read the void-returning methods ACCEPT is a write they
	// AUTHORIZED, so the probe has to be as strong as the one `tasks/get` runs rather than a
	// bare `=== undefined`. Both vectors sit outside the `undefined` this port declares and
	// inside what an implementation of it can really answer: `null`, which is what JavaScript
	// spells "no such task" with and what TypeScript here cannot; and a snapshot the manager
	// returned off-contract, which a declared return type accepts and the union does not.
	it('refuses an update and a cancellation it could not prove, invoking neither', async () => {
		const invoked: string[] = []
		const foreign = watchedTaskManager(() => Promise.resolve(undefined), invoked)
		Reflect.set(foreign, 'task', absentTask)
		const lying = watchedTaskManager(
			() =>
				Promise.resolve({
					taskId: 'lying',
					status: 'completed',
					createdAt: 'a',
					lastUpdatedAt: 'b',
					// Off-contract in a way TypeScript accepts and the published union does not:
					// a fractional `ttlMs`, where the schema formats the field `int`.
					ttlMs: 1_000.5,
					result: { resultType: 'complete' },
				}),
			invoked,
		)
		const ghosted = taskServer({ tasks: foreign, deferral: () => undefined })
		const unproven = taskServer({ tasks: lying, deferral: () => undefined })

		const refusals = await Promise.all([
			ghosted.dispatch(taskRequest('tasks/update', { taskId: 'x', inputResponses: {} }, 'same')),
			ghosted.dispatch(taskRequest('tasks/cancel', { taskId: 'x' }, 'same')),
			unproven.dispatch(taskRequest('tasks/update', { taskId: 'x', inputResponses: {} }, 'same')),
			unproven.dispatch(taskRequest('tasks/cancel', { taskId: 'x' }, 'same')),
		])

		expect(invoked).toEqual([])
		expect(new Set(refusals.map((response) => JSON.stringify(responseOf(response)))).size).toBe(1)
		expect(responseOf(refusals[0])?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(responseOf(refusals[0])?.error?.message).toBe(
			'Invalid params: no task is available for that `taskId`',
		)
	})
})

describe('MCPServer — W03-B: the capability gate on every tasks method', () => {
	// The `-32021` payload, and the reason there is ONE code rather than a separate one: the
	// elicitation refusal and this one are instances of the same condition, told apart by their data.
	it('refuses a non-declaring client with the generic capability code and the tasks payload', async () => {
		const mcp = taskServer({ tasks: new TestTaskManager(), deferral: () => undefined })

		const refusals = await Promise.all(
			TASK_METHODS.map(
				async (method) =>
					responseOf(await mcp.dispatch(modernRequest(method, 'undeclared-1')))?.error,
			),
		)

		expect(refusals.map((error) => error?.code)).toEqual([
			MCP_MISSING_CAPABILITY,
			MCP_MISSING_CAPABILITY,
			MCP_MISSING_CAPABILITY,
		])
		expect(refusals[0]?.data).toEqual({
			requiredCapabilities: { extensions: { [MCP_EXTENSION_TASKS]: {} } },
		})
		expect(new Set(refusals.map((error) => JSON.stringify(error))).size).toBe(1)
	})

	// The same code, a different payload — which is the whole of how a client tells the
	// instances apart, and the reason a separate numeral would have described one fact twice.
	it('distinguishes the elicitation instance from the tasks instance by payload alone', async () => {
		const elicited = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: tools(),
			input: {
				continuation: new MemoryContinuation(),
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: () => createRound(),
			},
		})
		const deferred = taskServer({ tasks: new TestTaskManager(), deferral: () => undefined })

		const forInput = responseOf(
			await elicited.dispatch(modernCall({ name: 'echo' }, 'instance-1')),
		)?.error
		const forTasks = responseOf(
			await deferred.dispatch(modernRequest('tasks/get', 'instance-2')),
		)?.error

		expect(forInput?.code).toBe(forTasks?.code)
		expect(forInput?.code).toBe(MCP_MISSING_CAPABILITY)
		expect(forInput?.data).toEqual({ requiredCapabilities: { elicitation: {} } })
		expect(forTasks?.data).toEqual({
			requiredCapabilities: { extensions: { [MCP_EXTENSION_TASKS]: {} } },
		})
	})

	// The control drawn from the OTHER method family: the same undeclared client that is refused
	// above gets an ordinary `complete` from `tools/call`, because deferral is server-decided and
	// this client never asked for one. Same omission, opposite outcome.
	it('refuses that same undeclared client when deployment policy selects a task', async () => {
		const tasks = new TestTaskManager()
		const mcp = taskServer({ tasks, deferral: () => 'operation-1' })

		const refused = responseOf(await mcp.dispatch(modernRequest('tasks/get', 'contrast-1')))?.error
		const called = responseOf(
			await mcp.dispatch(modernCall({ name: 'echo', arguments: { a: 1 } }, 'contrast-2')),
		)?.error

		expect(refused?.code).toBe(MCP_MISSING_CAPABILITY)
		expect(called?.code).toBe(MCP_MISSING_CAPABILITY)
		expect(tasks.starts).toHaveLength(0)
	})

	// The per-request control: the exact shape a session-oriented implementation would wrongly
	// accept — declared once at connect time and absent from the `tasks/*` request itself.
	it('ignores a capability declared at connect time but not on the tasks request', async () => {
		const tasks = new TestTaskManager()
		const mcp = taskServer({ tasks, deferral: () => 'operation-1' })
		const taskId = await createdTask(mcp, 'session-seed')

		await mcp.dispatch(
			createJSONRPCRequest({
				id: 'session-1',
				method: 'initialize',
				params: { protocolVersion: '2025-11-25', capabilities: TASK_CAPABILITIES },
			}),
		)
		const response = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 'session-2',
					method: 'tasks/get',
					params: { taskId, _meta: MODERN_METADATA },
				}),
			),
		)

		expect(response?.error?.code).toBe(MCP_MISSING_CAPABILITY)
	})

	// The capability precedes the parameters, because the extension binds the refusal to the
	// METHOD: a client that never declared it is refused before its `taskId` is read at all, so
	// a request that is BOTH undeclared and malformed answers the capability code.
	it('refuses a non-declaring client before it inspects the parameters', async () => {
		const mcp = taskServer({ tasks: new TestTaskManager(), deferral: () => undefined })

		const response = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 'order-1',
					method: 'tasks/get',
					params: { taskId: 7, _meta: MODERN_METADATA },
				}),
			),
		)

		expect(response?.error?.code).toBe(MCP_MISSING_CAPABILITY)
	})
})

describe('MCPServer — W03-B: the contract obligations MCP cannot enforce', () => {
	// Durability before return, violated: `start` resolves before the write lands, so the
	// `taskId` this server just handed out is not yet retrievable. MCP's own half of the rule —
	// awaiting `start` before it builds the answer — is intact and is not enough on its own.
	it('hands out a taskId a prompt read cannot find when the manager resolves before it persists', async () => {
		const mcp = taskServer({ tasks: deferredWriteTaskManager(), deferral: () => 'operation-1' })

		const taskId = await createdTask(mcp, 'durable-1')
		const prompt = responseOf(await mcp.dispatch(taskRequest('tasks/get', { taskId }, 'durable-2')))
		await waitForDelay(40)
		const later = responseOf(await mcp.dispatch(taskRequest('tasks/get', { taskId }, 'durable-3')))

		expect(taskId).toBe('task-late')
		expect(prompt?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		// The same handle works once the write lands, which is what makes the window silent.
		expect(resultOf(later)['taskId']).toBe('task-late')
	})

	// Entropy and principal scoping, violated together: a handle derived from the key is a handle
	// a stranger can GUESS, and a key that is not scoped to its principal hands a second
	// principal the first's task without any guessing at all.
	it('lets a second principal reach the first principal task when the manager derives the handle from the key', async () => {
		const mcp = taskServer({ tasks: guessableTaskManager(), deferral: () => 'shared-operation' })

		const mine = resultOf(
			responseOf(
				await mcp.dispatch(taskCall({ name: 'echo' }, 'principal-1'), { caller: 'principal-one' }),
			),
		)
		const theirs = resultOf(
			responseOf(
				await mcp.dispatch(taskCall({ name: 'echo' }, 'principal-2'), { caller: 'principal-two' }),
			),
		)
		const guessed = resultOf(
			responseOf(
				await mcp.dispatch(
					taskRequest('tasks/get', { taskId: 'shared-operation' }, 'principal-3'),
					{
						caller: 'a-stranger',
					},
				),
			),
		)

		// Two principals, one key, ONE task — the cross-principal channel the obligation names.
		expect(theirs['taskId']).toBe(mine['taskId'])
		// And the handle was never a secret to begin with.
		expect(guessed['taskId']).toBe('shared-operation')
	})

	// The corrected manager, driven identically: an opaque handle no caller can predict, and a
	// store that answers `undefined` to a caller the task does not belong to.
	it('keeps a second principal out when the manager mints an opaque handle and scopes it', async () => {
		const tasks = new TestTaskManager({ owner: 'principal-one' })
		const mcp = taskServer({ tasks, deferral: () => 'shared-operation' })

		const mine = resultOf(
			responseOf(
				await mcp.dispatch(taskCall({ name: 'echo' }, 'scoped-1'), { caller: 'principal-one' }),
			),
		)
		const guessed = responseOf(
			await mcp.dispatch(taskRequest('tasks/get', { taskId: 'shared-operation' }, 'scoped-2'), {
				caller: 'principal-two',
			}),
		)
		const theirs = responseOf(
			await mcp.dispatch(taskRequest('tasks/get', { taskId: String(mine['taskId']) }, 'scoped-2'), {
				caller: 'principal-two',
			}),
		)

		expect(String(mine['taskId'])).not.toBe('shared-operation')
		expect(guessed?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		// A guessed handle and a real one this caller may not read are the same answer on the wire.
		expect(JSON.stringify(theirs)).toBe(JSON.stringify(guessed))
	})

	it('contains a manager throw on every tasks method as a detail-free internal error', async () => {
		const failing: MCPTaskManagerInterface = {
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
		const mcp = taskServer({ tasks: failing, deferral: () => undefined })
		const faults: unknown[] = []
		mcp.emitter.on('error', (error) => void faults.push(error))

		const responses = await Promise.all(
			TASK_METHODS.map(async (method) =>
				responseOf(
					await mcp.dispatch(taskRequest(method, { taskId: 'task-1', inputResponses: {} }, method)),
				),
			),
		)

		expect(responses.map((response) => response?.error?.code)).toEqual([
			JSONRPC_INTERNAL_ERROR,
			JSONRPC_INTERNAL_ERROR,
			JSONRPC_INTERNAL_ERROR,
		])
		expect(JSON.stringify(responses)).not.toContain('manager read detail')
		expect(faults).toHaveLength(3)
	})

	// The per-request options every port method receives are the request's own, including the
	// asserted caller a deployment authorizes against — this package has no principal to offer.
	it('hands every tasks method the resolved per-request options', async () => {
		const seen: MCPMethodOptions[] = []
		const tasks = new TestTaskManager({ asking: true })
		const recording: MCPTaskManagerInterface = {
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
		const mcp = taskServer({ tasks: recording, deferral: () => 'operation-1' })
		const taskId = await createdTask(mcp, 'options-seed')

		await mcp.dispatch(taskRequest('tasks/get', { taskId }, 'options-1'), { caller: 'asserted' })
		await mcp.dispatch(taskRequest('tasks/update', { taskId, inputResponses: {} }, 'options-2'), {
			caller: 'asserted',
		})
		await mcp.dispatch(taskRequest('tasks/cancel', { taskId }, 'options-3'), { caller: 'asserted' })

		// One read per method plus the update and the abort themselves.
		expect(seen).toHaveLength(5)
		expect(seen.every((options) => options.caller === 'asserted')).toBe(true)
		expect(seen.every((options) => options.signal instanceof AbortSignal)).toBe(true)
	})

	// A notification is answered by nothing, whatever its method — the registrations carry
	// the same narrowing every other built-in does rather than a second dispatch rule.
	it('answers a tasks notification with nothing at all', async () => {
		const tasks = new TestTaskManager()
		const mcp = taskServer({ tasks, deferral: () => 'operation-1' })

		const answers = await Promise.all(
			TASK_METHODS.map(async (method) =>
				mcp.dispatch(createJSONRPCNotification(method, { taskId: 'x', _meta: TASK_METADATA })),
			),
		)

		expect(answers).toEqual([undefined, undefined, undefined])
	})
})

// The junction of the two families: a `subscriptions/listen` request naming task identifiers.
// The AGREED SET is decided once, at acknowledgement, by reading the consumer's durable store —
// and it is the same set the delivery matcher is handed, so an acknowledgement that names an
// identifier is a promise the stream keeps and an omission is a promise never made.
describe('MCPServer — W03-B: the tasks family on a subscriptions/listen stream', () => {
	// The oracle risk INVERTED: the invariant is not that a caller learns nothing, it is that an
	// omission never says WHICH refusal produced it. The port collapses never-existed, purged,
	// and not-yours into one `undefined`, so the acknowledgement must collapse them too.
	it('omits an identifier the store refuses, with nothing that says which refusal it was', async () => {
		const purged = new TestTaskManager({ ttl: 60_000 })
		purged.seed('task-ghost')
		purged.purge()
		const guarded = new TestTaskManager({ owner: 'owner-1' })
		guarded.seed('task-ghost')
		const request = createSubscriptionRequest('listen-omit', { taskIds: ['task-ghost'] })
		const acknowledgements: string[] = []
		const terminals: string[] = []
		const errors: boolean[] = []

		for (const tasks of [new TestTaskManager(), purged, guarded]) {
			const closed = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
			await closed.writable.close()
			const mcp = taskServer(
				{ tasks, deferral: () => undefined },
				{ subscription: { notifications: {}, producer: () => closed.readable } },
			)
			const [messages, response] = await drainStream(
				streamOf(await mcp.dispatch(request, { caller: 'owner-2' })),
			)
			acknowledgements.push(JSON.stringify(messages))
			terminals.push(JSON.stringify(response))
			errors.push(isJSONRPCErrorResponse(response))
		}

		// The never-existed, the purged, and the unauthorized read produce the SAME bytes, so a
		// caller holding all three acknowledgements can separate none of them.
		expect(new Set(acknowledgements).size).toBe(1)
		expect(JSON.parse(acknowledgements[0] ?? 'null')).toEqual([
			{
				jsonrpc: '2.0',
				method: 'notifications/subscriptions/acknowledged',
				params: { notifications: {}, _meta: { [MCP_META_SUBSCRIPTION]: 'listen-omit' } },
			},
		])
		// And nothing else distinguishes them: no error arm, and one identical terminal.
		expect(errors).toEqual([false, false, false])
		expect(new Set(terminals).size).toBe(1)
		// The omission came from a REFUSED READ rather than from a member nobody looked at.
		expect(purged.reads.calls).toEqual([['task-ghost']])
		expect(guarded.reads.calls).toEqual([['task-ghost']])
	})

	it('acknowledges the resolved identifiers in request order with duplicates intact', async () => {
		const tasks = new TestTaskManager()
		tasks.seed('task-b')
		tasks.seed('task-a')
		const closed = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		await closed.writable.close()
		const mcp = taskServer(
			{ tasks, deferral: () => undefined },
			{ subscription: { notifications: {}, producer: () => closed.readable } },
		)

		const [messages] = await drainStream(
			streamOf(
				await mcp.dispatch(
					createSubscriptionRequest('listen-order', {
						taskIds: ['task-b', 'task-gone', 'task-a', 'task-b'],
					}),
				),
			),
		)

		// Request order survives, the duplicate survives as a duplicate, and only the identifier
		// the store refused is gone.
		expect(messages[0]?.params?.['notifications']).toEqual({
			taskIds: ['task-b', 'task-a', 'task-b'],
		})
		// One read per requested entry, in request order: the resolution deduplicates nothing
		// either, so a normalization added anywhere in the path reddens here.
		expect(tasks.reads.calls).toEqual([['task-b'], ['task-gone'], ['task-a'], ['task-b']])
	})

	// The DERIVED support fact, from both sides. Neither half alone can honour the member, and
	// no third flag records the conclusion — so each half's absence is proven separately.
	it('omits the member entirely when the server cannot push tasks', async () => {
		const tasks = new TestTaskManager()
		tasks.seed('task-a')
		const closed = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		await closed.writable.close()
		// A producer with no manager: nothing can authorize an identifier.
		const unmanaged = server(undefined, { notifications: {}, producer: () => closed.readable })
		// A manager with no producer: nothing can carry a transition.
		const unproduced = taskServer({ tasks, deferral: () => undefined })
		const request = createSubscriptionRequest('listen-off', { taskIds: ['task-a'] })

		const [fromUnmanaged] = await drainStream(streamOf(await unmanaged.dispatch(request)))
		const [fromUnproduced] = await drainStream(streamOf(await unproduced.dispatch(request)))

		expect(fromUnmanaged[0]?.params?.['notifications']).toEqual({})
		expect(fromUnproduced[0]?.params?.['notifications']).toEqual({})
		// A server that cannot push tasks reads no store at all, so the omission is not a
		// resolution that happened to refuse everything.
		expect(tasks.reads.count).toBe(0)
	})

	// The tripwire for the fixed-agreed-set lifetime. A future edit that re-resolves identifiers
	// at delivery puts the durable store on the hot path of every frame, and this is what sees it.
	it('delivers an agreed identifier with no store read at delivery time', async () => {
		const tasks = new TestTaskManager()
		tasks.seed('task-live')
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const writer = source.writable.getWriter()
		const mcp = taskServer(
			{ tasks, deferral: () => undefined },
			{ subscription: { notifications: {}, producer: () => source.readable } },
		)
		const stream = streamOf(
			await mcp.dispatch(createSubscriptionRequest('listen-live', { taskIds: ['task-live'] })),
		)

		const acknowledgement = await stream.next()
		if (acknowledgement.done) throw new Error('expected a subscription acknowledgement')
		// THE POSITIVE CONTROL. Acknowledgement resolves the identifier, so a counter that could
		// not see a store read would read zero here and the silence below would mean nothing.
		const resolved = tasks.reads.count
		const drained = drainStream(stream)
		for (const at of ['1970-01-01T00:00:02.000Z', '1970-01-01T00:00:03.000Z']) {
			await writer.write({
				jsonrpc: '2.0',
				method: 'notifications/tasks',
				params: {
					taskId: 'task-live',
					status: 'working',
					createdAt: '1970-01-01T00:00:01.000Z',
					lastUpdatedAt: at,
					ttlMs: null,
				},
			})
		}
		await writer.close()
		const [messages] = await drained

		expect(resolved).toBe(1)
		expect(acknowledgement.value.params?.['notifications']).toEqual({ taskIds: ['task-live'] })
		expect(
			messages.map((frame) => [frame.params?.['lastUpdatedAt'], frame.params?.['_meta']]),
		).toEqual([
			['1970-01-01T00:00:02.000Z', { [MCP_META_SUBSCRIPTION]: 'listen-live' }],
			['1970-01-01T00:00:03.000Z', { [MCP_META_SUBSCRIPTION]: 'listen-live' }],
		])
		// Delivering two frames read the store exactly as often as delivering none did.
		expect(tasks.reads.count).toBe(resolved)
	})

	it('refuses a malformed taskIds member as invalid params before reading the store', async () => {
		const tasks = new TestTaskManager()
		const closed = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		await closed.writable.close()
		const mcp = taskServer(
			{ tasks, deferral: () => undefined },
			{ subscription: { notifications: {}, producer: () => closed.readable } },
		)

		const refusals = await Promise.all(
			[{ taskIds: 'task-a' }, { taskIds: ['task-a', 7] }, { taskIds: {} }].map(
				async (notifications) =>
					responseOf(
						await mcp.dispatch(
							createJSONRPCRequest({
								method: 'subscriptions/listen',
								id: 'listen-bad',
								params: { notifications, _meta: MODERN_METADATA },
							}),
						),
					)?.error?.code,
			),
		)

		expect(refusals).toEqual([
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
		])
		// A refused request never reaches the resolution, so a malformed array is not a probe.
		expect(tasks.reads.count).toBe(0)
	})
})

describe('the held-open stream contract', () => {
	it('yields notifications, returns a response, and accepts nothing', () => {
		expectTypeOf<MCPStream>().toEqualTypeOf<
			AsyncGenerator<JSONRPCNotification, JSONRPCResponse, unknown>
		>()
		expectTypeOf<MCPTextStream>().toEqualTypeOf<AsyncGenerator<string, string, unknown>>()
	})

	it('binds a subscription producer to the same notification yield type', () => {
		expectTypeOf<Awaited<ReturnType<MCPSubscriptionHandler>>>().toEqualTypeOf<
			AsyncIterable<JSONRPCNotification>
		>()
	})
})

describe('MCP resources/list', () => {
	it('forwards the opaque cursor and stamps each resource page', async () => {
		const resources = new MemoryResourceManager()
		const mcp = createMCPServer({
			identity: { name: 'resources', version: '1.0.0' },
			tools: createToolManager(),
			resources,
			cache: { ttl: 500, scope: 'public' },
		})
		const first = await mcp.dispatch(
			createJSONRPCRequest({ method: 'resources/list', params: { _meta: MODERN_METADATA } }),
		)
		const second = await mcp.dispatch(
			createJSONRPCRequest({
				id: 2,
				method: 'resources/list',
				params: { cursor: 'second', _meta: MODERN_METADATA },
			}),
		)

		expect(first).toMatchObject({
			result: {
				resultType: 'complete',
				ttlMs: 500,
				cacheScope: 'public',
				resources: [{ uri: 'memory://resource/one', name: 'one' }],
				nextCursor: 'second',
			},
		})
		expect(second).toMatchObject({
			result: {
				resultType: 'complete',
				resources: [{ uri: 'memory://resource/two', name: 'two' }],
			},
		})
		expect(resources.cursors).toEqual([undefined, 'second'])
	})

	it('omits nextCursor when the manager page capacity exceeds its remaining item count', async () => {
		const mcp = createMCPServer({
			identity: { name: 'resources', version: '1.0.0' },
			tools: createToolManager(),
			resources: new MemoryResourceManager(),
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'resources/list',
				params: { cursor: 'second', _meta: MODERN_METADATA },
			}),
		)

		expect(answer).not.toHaveProperty('result.nextCursor')
	})
})

describe('MCP resources/read', () => {
	it('reads a concrete URI from an in-memory registry and forwards method options', async () => {
		const resources = new MemoryResourceManager()
		const caller = { principal: 'reader' }
		const mcp = createMCPServer({
			identity: { name: 'resources', version: '1.0.0' },
			tools: createToolManager(),
			resources,
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'resources/read',
				params: { uri: 'memory://resource/one', _meta: MODERN_METADATA },
			}),
			{ caller },
		)

		expect(answer).toMatchObject({
			result: {
				resultType: 'complete',
				contents: [{ uri: 'memory://resource/one', text: 'one' }],
			},
		})
		expect(resources.reads).toEqual([{ uri: 'memory://resource/one' }])
		expect(resources.options[0]?.caller).toBe(caller)
	})

	it('uses -32602 when the resource manager returns undefined', async () => {
		const resources = new MemoryResourceManager()
		const mcp = createMCPServer({
			identity: { name: 'resources', version: '1.0.0' },
			tools: createToolManager(),
			resources,
		})
		const found = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'resources/read',
					params: { uri: 'memory://resource/two', _meta: MODERN_METADATA },
				}),
			),
		)
		const missing = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 2,
					method: 'resources/read',
					params: { uri: 'memory://resource/missing', _meta: MODERN_METADATA },
				}),
			),
		)
		if (found === undefined || missing === undefined) throw new Error('expected resource responses')

		expect(found.error).toBeUndefined()
		expect(missing.error?.code).toBe(JSONRPC_INVALID_PARAMS)
	})

	it('forwards inputResponses and requestState to the resource manager', async () => {
		const resources = new MemoryResourceManager()
		const mcp = createMCPServer({
			identity: { name: 'resources', version: '1.0.0' },
			tools: createToolManager(),
			resources,
		})
		await mcp.dispatch(
			createJSONRPCRequest({
				method: 'resources/read',
				params: {
					uri: 'memory://resource/one',
					inputResponses: { approval: { action: 'accept', content: { approved: true } } },
					requestState: 'opaque',
					_meta: MODERN_METADATA,
				},
			}),
		)

		expect(resources.reads).toEqual([
			{
				uri: 'memory://resource/one',
				inputResponses: { approval: { action: 'accept', content: { approved: true } } },
				requestState: 'opaque',
			},
		])
	})

	it('may answer input_required without changing its result discriminator', async () => {
		const mcp = createMCPServer({
			identity: { name: 'resources', version: '1.0.0' },
			tools: createToolManager(),
			resources: new MemoryResourceManager(),
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'resources/read',
				params: { uri: 'memory://resource/input', _meta: MODERN_METADATA },
			}),
		)

		expect(answer).toMatchObject({
			result: {
				resultType: 'input_required',
				requestState: 'resource-state',
				_meta: {
					'io.modelcontextprotocol/serverInfo': { name: 'resources', version: '1.0.0' },
				},
			},
		})
		expect(answer).not.toHaveProperty('result.ttlMs')
	})

	// The capability rule binds every ISSUER, not one method. A round a manager authored
	// leaves as this server's wire, so it meets the same gate a `tools/call` round meets —
	// and it meets it BEFORE the stamp, so a round the client may not receive is never sent.
	it('refuses a manager round the client did not declare the capability for', async () => {
		const resources = new MemoryResourceManager()
		const mcp = createMCPServer({
			identity: { name: 'resources', version: '1.0.0' },
			tools: createToolManager(),
			resources,
		})
		const refused = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'resources/read',
					params: { uri: 'memory://resource/round', _meta: MODERN_METADATA },
				}),
			),
		)
		const allowed = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 2,
					method: 'resources/read',
					params: {
						uri: 'memory://resource/round',
						_meta: {
							[MCP_META_VERSION]: '2026-07-28',
							[MCP_META_CAPABILITIES]: { roots: {} },
						},
					},
				}),
			),
		)

		expect(refused?.error).toEqual({
			code: MCP_MISSING_CAPABILITY,
			message: 'Server requires a client capability this request did not declare',
			data: { requiredCapabilities: { roots: {} } },
		})
		expect(refused?.result).toBeUndefined()
		expect(allowed?.result).toMatchObject({
			resultType: 'input_required',
			inputRequests: { workspace: { method: 'roots/list' } },
			requestState: 'resource-state',
		})
	})
})

describe('MCP resources/templates/list', () => {
	it('projects the manager-owned RFC 6570 template without expanding it', async () => {
		const mcp = createMCPServer({
			identity: { name: 'resources', version: '1.0.0' },
			tools: createToolManager(),
			resources: new MemoryResourceManager(),
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'resources/templates/list',
				params: { _meta: MODERN_METADATA },
			}),
		)

		expect(answer).toMatchObject({
			result: {
				resultType: 'complete',
				resourceTemplates: [{ uriTemplate: 'memory://resource/{name}', name: 'named' }],
			},
		})
	})
})

describe('MCP resource capability and registration', () => {
	it('advertises and registers resources only when the resource manager is configured', async () => {
		const plain = createMCPServer({
			identity: { name: 'plain', version: '1.0.0' },
			tools: createToolManager(),
		})
		const configured = createMCPServer({
			identity: { name: 'configured', version: '1.0.0' },
			tools: createToolManager(),
			resources: new MemoryResourceManager(),
			subscription: {
				notifications: {
					resourcesListChanged: true,
					resourceSubscriptions: ['memory://resource/one'],
				},
				producer: () => new TransformStream<JSONRPCNotification, JSONRPCNotification>().readable,
			},
		})
		const discovery = await configured.dispatch(
			createJSONRPCRequest({ method: 'server/discover', params: { _meta: MODERN_METADATA } }),
		)

		expect(discovery).toMatchObject({
			result: { capabilities: { resources: { subscribe: true, listChanged: true } } },
		})
		expect(configured.methods.method('resources/list')).toBeTypeOf('function')
		expect(configured.methods.method('resources/read')).toBeTypeOf('function')
		expect(configured.methods.method('resources/templates/list')).toBeTypeOf('function')
		expect(plain.methods.method('resources/list')).toBeUndefined()
		expect(plain.methods.method('resources/read')).toBeUndefined()
		expect(plain.methods.method('resources/templates/list')).toBeUndefined()
	})

	it('keeps prompts/list gated while resources/list succeeds', async () => {
		const mcp = createMCPServer({
			identity: { name: 'resources', version: '1.0.0' },
			tools: createToolManager(),
			resources: new MemoryResourceManager(),
		})
		const listed = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'resources/list',
					params: { _meta: MODERN_METADATA },
				}),
			),
		)
		const prompts = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 2,
					method: 'prompts/list',
					params: { _meta: MODERN_METADATA },
				}),
			),
		)
		if (listed === undefined || prompts === undefined)
			throw new Error('expected resource responses')

		expect(listed.error).toBeUndefined()
		expect(prompts.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
	})
})

describe('MCP resource notifications', () => {
	it('routes only opted-in resource updates and list changes', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const mcp = createMCPServer({
			identity: { name: 'resources', version: '1.0.0' },
			tools: createToolManager(),
			resources: new MemoryResourceManager(),
			subscription: {
				notifications: {
					resourcesListChanged: true,
					resourceSubscriptions: ['memory://resource/one'],
				},
				producer: () => source.readable,
			},
		})
		const stream = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'subscriptions/listen',
				params: {
					notifications: {
						resourcesListChanged: true,
						resourceSubscriptions: ['memory://resource/one', 'memory://resource/two'],
					},
					_meta: MODERN_METADATA,
				},
			}),
		)
		if (!(Symbol.asyncIterator in stream)) throw new Error('expected a resource subscription')
		await stream.next()
		const writer = source.writable.getWriter()
		const updatedResult = stream.next()
		await writer.write({
			jsonrpc: '2.0',
			method: 'notifications/resources/updated',
			params: { uri: 'memory://resource/two' },
		})
		await writer.write({
			jsonrpc: '2.0',
			method: 'notifications/resources/updated',
			params: { uri: 'memory://resource/one' },
		})
		const updated = await updatedResult
		const changedResult = stream.next()
		await writer.write({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' })
		const changed = await changedResult
		await writer.close()

		expect(updated.value).toMatchObject({
			method: 'notifications/resources/updated',
			params: { uri: 'memory://resource/one' },
		})
		expect(changed.value).toMatchObject({ method: 'notifications/resources/list_changed' })
	})
})

describe('MCP prompts/list', () => {
	it('forwards the shared opaque cursor and stamps each prompt page', async () => {
		const prompts = new MemoryPromptManager()
		const mcp = createMCPServer({
			identity: { name: 'prompts', version: '1.0.0' },
			tools: createToolManager(),
			prompts,
			cache: { ttl: 750, scope: 'public' },
		})
		const first = await mcp.dispatch(
			createJSONRPCRequest({ method: 'prompts/list', params: { _meta: MODERN_METADATA } }),
		)
		const second = await mcp.dispatch(
			createJSONRPCRequest({
				id: 2,
				method: 'prompts/list',
				params: { cursor: 'second', _meta: MODERN_METADATA },
			}),
		)

		expect(first).toMatchObject({
			result: {
				resultType: 'complete',
				ttlMs: 750,
				cacheScope: 'public',
				prompts: [{ name: 'greet', arguments: [{ name: 'person', required: true }] }],
				nextCursor: 'second',
			},
		})
		expect(second).toMatchObject({
			result: { resultType: 'complete', prompts: [{ name: 'summarize' }] },
		})
		expect(prompts.cursors).toEqual([undefined, 'second'])
	})

	it('omits nextCursor when page capacity exceeds the remaining prompt count', async () => {
		const mcp = createMCPServer({
			identity: { name: 'prompts', version: '1.0.0' },
			tools: createToolManager(),
			prompts: new MemoryPromptManager(),
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'prompts/list',
				params: { cursor: 'second', _meta: MODERN_METADATA },
			}),
		)

		expect(answer).not.toHaveProperty('result.nextCursor')
	})
})

describe('MCP prompts/get', () => {
	it('resolves string arguments to rich prompt messages and forwards method options', async () => {
		const prompts = new MemoryPromptManager()
		const caller = { principal: 'reader' }
		const mcp = createMCPServer({
			identity: { name: 'prompts', version: '1.0.0' },
			tools: createToolManager(),
			prompts,
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'prompts/get',
				params: {
					name: 'greet',
					arguments: { person: 'Ada' },
					inputResponses: { approval: { action: 'accept' } },
					requestState: 'opaque',
					_meta: MODERN_METADATA,
				},
			}),
			{ caller },
		)

		expect(answer).toMatchObject({
			result: {
				resultType: 'complete',
				description: 'A rendered greeting',
				messages: [
					{ role: 'user', content: { type: 'text', text: 'Hello Ada' } },
					{ role: 'assistant', content: { type: 'resource' } },
				],
			},
		})
		expect(answer).not.toHaveProperty('result.ttlMs')
		expect(answer).not.toHaveProperty('result.cacheScope')
		expect(prompts.requests).toEqual([
			{
				name: 'greet',
				arguments: { person: 'Ada' },
				inputResponses: { approval: { action: 'accept' } },
				requestState: 'opaque',
			},
		])
		expect(prompts.options[0]?.caller).toBe(caller)
	})

	it('may answer input_required without adding prompt cache fields', async () => {
		const mcp = createMCPServer({
			identity: { name: 'prompts', version: '1.0.0' },
			tools: createToolManager(),
			prompts: new MemoryPromptManager(),
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'prompts/get',
				params: { name: 'input', _meta: MODERN_METADATA },
			}),
		)

		expect(answer).toMatchObject({
			result: {
				resultType: 'input_required',
				requestState: 'prompt-state',
				_meta: {
					'io.modelcontextprotocol/serverInfo': { name: 'prompts', version: '1.0.0' },
				},
			},
		})
		expect(answer).not.toHaveProperty('result.ttlMs')
	})

	// The same rule on the other port. A carrier-only result asks nothing and is stamped
	// whatever the client declared, because there is no round to measure.
	it('refuses a manager round the client did not declare the capability for', async () => {
		const mcp = createMCPServer({
			identity: { name: 'prompts', version: '1.0.0' },
			tools: createToolManager(),
			prompts: new MemoryPromptManager(),
		})
		const refused = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'prompts/get',
					params: { name: 'round', _meta: MODERN_METADATA },
				}),
			),
		)
		const allowed = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 2,
					method: 'prompts/get',
					params: {
						name: 'round',
						_meta: {
							[MCP_META_VERSION]: '2026-07-28',
							[MCP_META_CAPABILITIES]: { sampling: {} },
						},
					},
				}),
			),
		)

		expect(refused?.error).toEqual({
			code: MCP_MISSING_CAPABILITY,
			message: 'Server requires a client capability this request did not declare',
			data: { requiredCapabilities: { sampling: {} } },
		})
		expect(refused?.result).toBeUndefined()
		expect(allowed?.result).toMatchObject({
			resultType: 'input_required',
			inputRequests: { context: { method: 'sampling/createMessage', params: {} } },
			requestState: 'prompt-state',
		})
	})

	it('accepts a string, refuses a non-string before lookup, and maps a missing prompt', async () => {
		const prompts = new MemoryPromptManager()
		const mcp = createMCPServer({
			identity: { name: 'prompts', version: '1.0.0' },
			tools: createToolManager(),
			prompts,
		})
		const valid = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'prompts/get',
					params: { name: 'greet', arguments: { person: 'Grace' }, _meta: MODERN_METADATA },
				}),
			),
		)
		const invalid = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 2,
					method: 'prompts/get',
					params: { name: 'greet', arguments: { person: 42 }, _meta: MODERN_METADATA },
				}),
			),
		)
		const missing = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 3,
					method: 'prompts/get',
					params: { name: 'missing', arguments: { person: 'Ada' }, _meta: MODERN_METADATA },
				}),
			),
		)
		if (valid === undefined || invalid === undefined || missing === undefined) {
			throw new Error('expected prompt responses')
		}

		expect(valid.error).toBeUndefined()
		expect(invalid.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(missing.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(prompts.requests).toEqual([
			{ name: 'greet', arguments: { person: 'Grace' } },
			{ name: 'missing', arguments: { person: 'Ada' } },
		])
	})
})

describe('MCP completion/complete', () => {
	it('discriminates prompt and resource references and refuses a missing reference', async () => {
		const completion = new MemoryCompletion()
		const mcp = createMCPServer({
			identity: { name: 'completion', version: '1.0.0' },
			tools: createToolManager(),
			completion,
		})
		const prompt = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'completion/complete',
				params: {
					ref: { type: 'ref/prompt', name: 'greet' },
					argument: { name: 'person', value: 'A' },
					_meta: MODERN_METADATA,
				},
			}),
		)
		const resource = await mcp.dispatch(
			createJSONRPCRequest({
				id: 2,
				method: 'completion/complete',
				params: {
					ref: { type: 'ref/resource', uri: 'memory://resource/{name}' },
					argument: { name: 'name', value: 'o' },
					_meta: MODERN_METADATA,
				},
			}),
		)
		const missing = responseOf(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 3,
					method: 'completion/complete',
					params: {
						ref: { type: 'ref/prompt', name: 'missing' },
						argument: { name: 'person', value: '' },
						_meta: MODERN_METADATA,
					},
				}),
			),
		)
		if (missing === undefined) throw new Error('expected a completion response')

		expect(prompt).toMatchObject({
			result: { resultType: 'complete', completion: { values: ['Ada', 'Grace'], total: 2 } },
		})
		expect(resource).toMatchObject({
			result: { resultType: 'complete', completion: { values: ['one', 'two'] } },
		})
		expect(missing.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(completion.requests.map((request) => request.ref.type)).toEqual([
			'ref/prompt',
			'ref/resource',
			'ref/prompt',
		])
	})

	it('caps a source of more than 100 candidates and marks the projection incomplete', async () => {
		const mcp = createMCPServer({
			identity: { name: 'completion', version: '1.0.0' },
			tools: createToolManager(),
			completion: new MemoryCompletion(),
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'completion/complete',
				params: {
					ref: { type: 'ref/prompt', name: 'many' },
					argument: { name: 'value', value: '' },
					_meta: MODERN_METADATA,
				},
			}),
		)
		const response = responseOf(answer)
		if (response === undefined) throw new Error('expected a completion response')

		expect(response.result?.['completion']).toMatchObject({ hasMore: true })
		expect(response.result?.['completion']).toHaveProperty('values.length', 100)
		expect(isMCPCompletionResult(response.result)).toBe(true)
	})
})

describe('MCP prompt and completion capability gating', () => {
	it('keeps prompt, resource, and completion registration independently gated', async () => {
		const prompts = createMCPServer({
			identity: { name: 'prompts', version: '1.0.0' },
			tools: createToolManager(),
			prompts: new MemoryPromptManager(),
			subscription: {
				notifications: { promptsListChanged: true },
				producer: () => new TransformStream().readable,
			},
		})
		const completion = createMCPServer({
			identity: { name: 'completion', version: '1.0.0' },
			tools: createToolManager(),
			completion: new MemoryCompletion(),
		})
		const listed = responseOf(
			await prompts.dispatch(
				createJSONRPCRequest({ method: 'prompts/list', params: { _meta: MODERN_METADATA } }),
			),
		)
		const resources = responseOf(
			await prompts.dispatch(
				createJSONRPCRequest({
					id: 2,
					method: 'resources/list',
					params: { _meta: MODERN_METADATA },
				}),
			),
		)
		const promptDiscovery = await prompts.dispatch(
			createJSONRPCRequest({
				id: 3,
				method: 'server/discover',
				params: { _meta: MODERN_METADATA },
			}),
		)
		const completionDiscovery = await completion.dispatch(
			createJSONRPCRequest({ method: 'server/discover', params: { _meta: MODERN_METADATA } }),
		)
		if (listed === undefined || resources === undefined)
			throw new Error('expected prompt responses')

		expect(listed.error).toBeUndefined()
		expect(resources.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
		expect(promptDiscovery).toMatchObject({
			result: { capabilities: { prompts: { listChanged: true } } },
		})
		expect(promptDiscovery).not.toHaveProperty('result.capabilities.completions')
		expect(completionDiscovery).toMatchObject({ result: { capabilities: { completions: {} } } })
		expect(completionDiscovery).not.toHaveProperty('result.capabilities.prompts')
		expect(completionDiscovery).not.toHaveProperty('result.capabilities.resources')
		expect(prompts.methods.method('prompts/list')).toBeTypeOf('function')
		expect(prompts.methods.method('prompts/get')).toBeTypeOf('function')
		expect(prompts.methods.method('completion/complete')).toBeUndefined()
		expect(completion.methods.method('completion/complete')).toBeTypeOf('function')
		expect(completion.methods.method('prompts/list')).toBeUndefined()
	})
})
