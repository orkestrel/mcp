import type {
	JSONRPCId,
	JSONRPCInvocation,
	JSONRPCMessage,
	JSONRPCNotification,
	JSONRPCRequest,
} from '@orkestrel/jsonrpc'
import {
	JSONRPC_INTERNAL_ERROR,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_METHOD_NOT_FOUND,
	isJSONRPCId,
	isJSONRPCNotification,
	isJSONRPCResponse,
	isJSONRPCResultResponse,
} from '@orkestrel/jsonrpc'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { ToolContext, ToolInterface } from '@orkestrel/tool'
import type {
	MCPMessageTransportInterface,
	MCPCallOptions,
	MCPCallOutcome,
	MCPClientEventMap,
	MCPClientInterface,
	MCPClientOptions,
	MCPClientCapabilities,
	MCPDiscoverResult,
	MCPIdentity,
	MCPListenOptions,
	MCPModernVersion,
	MCPProgressHandler,
	MCPSubscriptionFilter,
	MCPSubscriptionResult,
	MCPSubscriptionStream,
	MCPTaskClientInterface,
} from './types.js'
import { Emitter } from '@orkestrel/emitter'
import { Tool } from '@orkestrel/tool'
import { MCPConnection } from './MCPConnection.js'
import { MCPTaskClient } from './MCPTaskClient.js'
import {
	attempt,
	cloneJSONRecord,
	isArray,
	isError,
	isInteger,
	isRecord,
	isString,
} from '@orkestrel/contract'
import {
	DEFAULT_MCP_CLIENT_NAME,
	DEFAULT_MCP_CLIENT_VERSION,
	DEFAULT_MCP_REQUEST_TIMEOUT,
	DEFAULT_MCP_SUBSCRIPTION_CAPACITY,
	MCP_META_CAPABILITIES,
	MCP_META_CLIENT,
	MCP_META_SUBSCRIPTION,
	MCP_META_VERSION,
	MCP_MODERN_VERSION,
	MCP_UNSUPPORTED_VERSION,
	SUPPORTED_MODERN_PROTOCOL_VERSIONS,
} from './constants.js'
import { MCPError, isMCPError } from './errors.js'
import {
	buildCallOutcome,
	buildCancelledNotification,
	matchesResultType,
	mcpAnnotationsToTool,
} from './helpers.js'
import { inferVersion } from './inferers.js'
import { parseJSONRPCMessage } from './parsers.js'
import {
	isMCPLegacyResult,
	isMCPModernVersion,
	isMCPProgress,
	isMCPResult,
	isMCPResultMetaObject,
	isMCPServerCapabilities,
	isMCPSubscriptionResult,
	isMCPToolAnnotations,
} from './validators.js'

/**
 * Connects to a remote MCP server over any injected {@link MCPMessageTransportInterface},
 * negotiates the modern revision, and exposes the server's tools as local
 * {@link ToolInterface}s an agent can run.
 *
 * @remarks
 * - **The mirror of `MCPServer`.** The server dispatches requests over a tool registry;
 *   this client issues them over a transport. `connect` probes `server/discover` and exposes
 *   the negotiated `version`; a legacy peer requires an explicit transport adapter.
 *   `tools()` lists the remote tools and wraps each as a
 *   local {@link ToolInterface} whose `execute` calls back through `call`; `call` runs a
 *   remote `tools/call` and reports the arm the peer answered with — a value, a durable
 *   task, or a request for more input (a remote `isError: true` throws locally, so an
 *   agent's {@link import('@orkestrel/tool').ToolManagerInterface} isolates it into a
 *   `success: false` result exactly like a local throw). A wrapped tool cannot hand an agent
 *   a deferred answer, so a non-`'complete'` arm throws there.
 * - **Request↔response correlation.** Each request is tagged with a monotonic numeric
 *   `id` ({@link #nextId}); a single transport `message` subscription resolves / rejects
 *   the matching {@link #pending} entry by `id`. An error response with no `id` rejects
 *   every pending request because the peer could not identify which request failed. A
 *   server-initiated message is re-surfaced on the `notification` event, except a progress
 *   frame claimed by the request that asked
 *   for it; a response correlating to nothing pending is discarded, because the request it
 *   answers has already settled.
 * - **Per-request cancellation.** `call`'s `options.signal` withdraws one caller from one
 *   request: the pending entry rejects on every carrier, and `notifications/cancelled` goes
 *   out only where the transport declares itself duplex — the dated revision defines no
 *   client-to-server notification over Streamable HTTP, where closing the response stream
 *   is the signal instead. It never cancels the connection and never a durable task.
 * - **Durable tasks, no schedule.** `tasks` is the extension's client half — read, answer, and
 *   stop a task the peer deferred a call into. The peer's `pollIntervalMs` hint is carried
 *   untouched and the one-shot read sits beside it; there is no timer, no scheduler, and no
 *   cache, so a client nobody asks writes nothing after the `resultType: 'task'` answer.
 * - **Per-request registrations.** The caller's abort listener and progress handler live on
 *   the {@link #pending} entry, so the single {@link #settle} door releases them on every
 *   exit — the deadline, an abort, a rejecting `send`, the answer itself, and the
 *   teardown's drain — without any of those paths knowing they exist.
 * - **Per-request deadline.** An ordinary `#request` carries `this.#timeout`. The initial
 *   discovery probe uses that same configured deadline, so a silent peer cannot hold
 *   negotiation indefinitely.
 *   `AbortSignal.timeout` (never a raw `setTimeout`) rejects only that pending request, and the
 *   same deadline bounds the wait on the transport's `close`, the one wait no drain and no signal
 *   can reach. It bounds the wait rather than the close, which keeps running, so a retry joins it
 *   instead of shutting one connection down twice.
 * - **Transport-agnostic.** Imports only core siblings (JSON-RPC + the tool vocabulary);
 *   the concrete transport is injected. Wire fields are narrowed with the contract
 *   guards (no `as`).
 * - **Observable.** The owned `emitter` fires `connect` / `disconnect` /
 *   `notification` / `error`; the emitter isolates a listener throw and routes it to its
 *   `error` handler (the `error` option), so a listener throw can never escape.
 *
 * @example
 * ```ts
 * const client = new MCPClient({ transport, identity: { name: 'agent', version: '1.0.0' } })
 * await client.connect()
 * const tools = await client.tools()
 * agent.context.tools.add(tools) // the remote tools are now the agent's
 * const outcome = await client.call('search', { query: 'mcp' })
 * if (outcome.resultType === 'complete') use(outcome.value)
 * ```
 */
export class MCPClient implements MCPClientInterface {
	readonly #emitter: Emitter<MCPClientEventMap>
	readonly #transport: MCPMessageTransportInterface
	readonly #identity: MCPIdentity
	readonly #capabilities: MCPClientCapabilities
	readonly #pin: MCPModernVersion | undefined
	readonly #timeout: number
	// The stable Tasks extension's client half, built once and held. It is given this client's
	// own correlated-request door rather than a second path to the peer, so a task read shares
	// the id space, the pending table, the deadline, and the `disconnect` drain with every other
	// request — and `#request` stays private, because publishing it would be a general
	// arbitrary-method capability nothing has asked for. The declared cost of that choice: a
	// consumer who registers `prompts/get` on the server's open registry cannot reach it with
	// this client, and the guide records the asymmetry rather than leaving it to be discovered.
	readonly #tasks: MCPTaskClientInterface
	// The in-flight requests, keyed by JSON-RPC id, each holding its promise settlers —
	// resolved on the matching response, rejected on an error response, the deadline, an
	// abort, or `disconnect`. Genuinely private glue: the whole settler shape lives inline here
	// and nowhere else — `#openSubscription` builds its subscription entry as an argument to
	// `set` and reads it back, so this declaration types that literal instead of being copied
	// beside it.
	//
	// The entry is also where every per-request REGISTRATION lives, and that placement is the
	// whole reason the exits nobody enumerates are already covered. `#settle` is the single
	// door out of a pending request — the deadline, an abort, a rejecting `transport.send`, an
	// answered response and the teardown's drain all arrive through it — so a listener or
	// handler recorded here is released by all of them at once, without any of them knowing it
	// exists. Registering one anywhere else (in `call`, in a `finally`, in the abort listener)
	// would leak on whichever exit its author did not think of.
	readonly #pending = new Map<
		JSONRPCId,
		{
			readonly resolve?: (value: unknown) => void
			readonly reject?: (reason?: unknown) => void
			readonly method: string
			readonly deadline?: AbortSignal
			readonly timeout?: () => void
			// The CALLER's cancellation signal and this request's listener on it. The signal is
			// the caller's and outlives the request, so the listener is removed rather than left
			// to `once`: one controller may be driving several calls.
			readonly signal?: AbortSignal
			readonly abort?: () => void
			// The caller's progress consumer, claimed by an inbound `notifications/progress`
			// naming this request's token. It needs no explicit release — dropping the entry is
			// the release, and a frame arriving afterwards finds nothing and stays a notification.
			readonly progress?: MCPProgressHandler
			readonly subscription?: {
				readonly queue: JSONRPCNotification[]
				readonly capacity: number
				waiter?: PromiseWithResolvers<JSONRPCNotification | MCPSubscriptionResult>
				terminal?: MCPSubscriptionResult
				failure?: { readonly reason: unknown }
			}
		}
	>()
	#nextId = 0
	#connection: MCPConnection | undefined
	readonly #teardowns = new Set<Promise<void>>()
	#offer: MCPModernVersion

	constructor(options: MCPClientOptions) {
		const requested: unknown = options.version
		const on = options.on
		const error = options.error
		if (requested !== undefined && !isMCPModernVersion(requested)) {
			throw new MCPError('Unsupported protocol version', MCP_UNSUPPORTED_VERSION, {
				supported: SUPPORTED_MODERN_PROTOCOL_VERSIONS,
				requested,
			})
		}
		this.#emitter = new Emitter<MCPClientEventMap>({
			...(on === undefined ? {} : { on }),
			...(error === undefined ? {} : { error }),
		})
		this.#transport = options.transport
		this.#identity = options.identity ?? {
			name: DEFAULT_MCP_CLIENT_NAME,
			version: DEFAULT_MCP_CLIENT_VERSION,
		}
		this.#capabilities = options.capabilities ?? {}
		this.#pin = requested
		this.#offer = requested ?? MCP_MODERN_VERSION
		this.#timeout = options.timeout ?? DEFAULT_MCP_REQUEST_TIMEOUT
		this.#tasks = new MCPTaskClient({
			request: this.#request.bind(this),
			timeout: this.#timeout,
		})
		// One message subscription for the client's whole life: a response settles its
		// pending request by id; anything else is a server notification.
		this.#transport.emitter.on('message', (message) => this.#receive(message))
		this.#transport.emitter.on('close', () => this.#loseTransport())
	}

	get emitter(): EmitterInterface<MCPClientEventMap> {
		return this.#emitter
	}

	get connected(): boolean {
		return this.#connection?.connected ?? false
	}

	get version(): MCPModernVersion | undefined {
		return this.#connection?.version
	}

	get transport(): MCPMessageTransportInterface {
		return this.#transport
	}

	get tasks(): MCPTaskClientInterface {
		return this.#tasks
	}

	async connect(): Promise<void> {
		for (;;) {
			const [closing] = this.#teardowns
			if (closing !== undefined) {
				await closing.catch(() => undefined)
				continue
			}
			const current = this.#connection
			if (current === undefined) break
			if (current.connected) return
			if (!current.settled) {
				if (!current.superseded) return current.negotiation
				await current.negotiation.catch(() => undefined)
				continue
			}
			if (current.owed) {
				await this.#teardown()
				continue
			}
			break
		}
		const connection = new MCPConnection(this.#transport, (current) => this.#negotiate(current))
		this.#connection = connection
		await connection.negotiation
	}

	async discover(): Promise<MCPDiscoverResult> {
		const negotiated = this.#connection?.version
		const version = isMCPModernVersion(negotiated) ? negotiated : this.#offer
		const received = await this.#request('server/discover', undefined, this.#timeout, version)
		const owned = attempt(() => cloneJSONRecord(received))
		if (!owned.success) {
			throw new MCPError('MCP server returned a malformed discovery result', JSONRPC_INVALID_PARAMS)
		}
		const result = owned.value
		const advertised = result['supportedVersions']
		const capabilities = result['capabilities']
		const ttl = result['ttlMs']
		const scope = result['cacheScope']
		const instructions = result['instructions']
		const metadata = result['_meta']
		const resultType = result['resultType']
		if (
			!isArray(advertised) ||
			!advertised.every(isString) ||
			!isMCPServerCapabilities(capabilities) ||
			!isInteger(ttl) ||
			ttl < 0 ||
			(scope !== 'public' && scope !== 'private') ||
			// REQUIRED, not merely constrained. The dated schema puts `resultType` on every
			// modern result and `server/discover` exists only in the modern era, so tolerating
			// its absence buys compatibility with no peer that exists — while synthesizing the
			// missing value would hand the caller a fact the peer never sent. A peer that speaks
			// modern discovery badly therefore fails CLOSED: `#receive` has already settled the
			// era to modern by the time this runs, so the refusal rejects the connection instead
			// of degrading it quietly to legacy.
			resultType !== 'complete' ||
			(instructions !== undefined && !isString(instructions)) ||
			(metadata !== undefined && !isMCPResultMetaObject(metadata))
		) {
			throw new MCPError(
				'MCP server returned a malformed discovery result',
				JSONRPC_INVALID_PARAMS,
				result,
			)
		}
		const supportedVersions: MCPModernVersion[] = []
		for (const candidate of advertised) {
			if (isMCPModernVersion(candidate)) supportedVersions.push(candidate)
		}
		const retained = Object.freeze(supportedVersions)
		return Object.freeze({
			supportedVersions: retained,
			capabilities,
			resultType,
			ttlMs: ttl,
			cacheScope: scope,
			...(instructions === undefined ? {} : { instructions }),
			...(metadata === undefined ? {} : { _meta: metadata }),
		})
	}

	async disconnect(): Promise<void> {
		const [closing] = this.#teardowns
		if (closing !== undefined) return closing
		const connection = this.#connection
		if (
			connection === undefined ||
			(!connection.connected && connection.settled && !connection.owed)
		) {
			return
		}
		await this.#teardown()
	}

	async tools(): Promise<readonly ToolInterface[]> {
		const result = await this.#request('tools/list', undefined, this.#timeout)
		// The wire shape is `{ tools: MCPToolDescriptor[] }` — narrow it: a
		// non-record / non-array `tools` yields no tools rather than throwing.
		if (!isRecord(result) || !isArray(result['tools'])) return []
		const tools: ToolInterface[] = []
		for (const descriptor of result['tools']) {
			if (!isRecord(descriptor) || !isString(descriptor['name'])) continue
			const name = descriptor['name']
			tools.push(this.#tool(name, descriptor))
		}
		return tools
	}

	listen(
		notifications: MCPSubscriptionFilter | undefined,
		options: MCPListenOptions,
	): MCPSubscriptionStream {
		const signal = options.signal
		const capacity = options.capacity ?? DEFAULT_MCP_SUBSCRIPTION_CAPACITY
		return this.#openSubscription(notifications, signal, capacity)
	}

	async call(
		name: string,
		args: Readonly<Record<string, unknown>>,
		options?: MCPCallOptions,
	): Promise<MCPCallOutcome> {
		const input = options?.input
		const result = await this.#request(
			'tools/call',
			{
				name,
				arguments: args,
				// `requestState` rides only when the caller has one. A peer may issue a round
				// with no state to return, and SEP-2322 requires the retry to answer that round
				// while omitting the parameter — sending an empty or invented carrier instead
				// would be this client authoring state the peer never sealed.
				...(input === undefined
					? {}
					: {
							...(input.state === undefined ? {} : { requestState: input.state }),
							inputResponses: input.responses,
						}),
			},
			this.#timeout,
			undefined,
			options,
		)
		return buildCallOutcome(name, result)
	}

	async *#openSubscription(
		notifications: MCPSubscriptionFilter | undefined,
		signal: AbortSignal,
		capacity: number,
	): MCPSubscriptionStream {
		signal.throwIfAborted()
		if (!isInteger(capacity) || capacity < 1) {
			throw new MCPError(
				'MCP subscription capacity must be a positive integer',
				JSONRPC_INVALID_PARAMS,
			)
		}
		const method = 'subscriptions/listen'
		// The one session-bound write that does NOT travel `#request`: a subscription builds
		// its own frame so it can own the pending entry's queue, so it carries the refusal at
		// its own entry. A generator's body runs at its first `next()`, so that is where a
		// consumer meets this — there is no earlier moment `listen` could refuse at without
		// making the stream eager.
		const opening = this.#refuse(method)
		if (opening !== undefined) throw opening
		this.#nextId += 1
		const id = this.#nextId
		const modern = this.#connection?.version
		const request: JSONRPCRequest = {
			jsonrpc: '2.0',
			id,
			method,
			params: {
				notifications: notifications ?? {},
				...(modern === undefined
					? {}
					: {
							_meta: {
								[MCP_META_VERSION]: modern,
								[MCP_META_CAPABILITIES]: this.#capabilities,
								[MCP_META_CLIENT]: this.#identity,
							},
						}),
			},
		}
		const abort = this.#abortSubscription.bind(this, id, signal)
		signal.addEventListener('abort', abort, { once: true })
		this.#pending.set(id, {
			method,
			signal,
			abort,
			subscription: { queue: [], capacity },
		})
		// ONE declaration of the subscription shape, and it is `#pending`'s: the literal above
		// takes its type from the map's value type rather than restating it here. The loop below
		// then drives the object the map holds, read back ONCE — `#settle` deletes the entry
		// before it writes `waiter` / `terminal` / `failure` onto that same object, so a later
		// read of the map would find nothing and a second literal would be a second shape to
		// drift. The refusal answers the map's `get` type, which cannot know what the preceding statement set.
		const subscription = this.#pending.get(id)?.subscription
		if (subscription === undefined) throw new Error('MCP subscription state is missing')
		this.#transport.send(request).catch((error: unknown) => this.#settle(id, error, true))
		try {
			for (;;) {
				if (subscription.failure !== undefined) throw subscription.failure.reason
				// A queued frame outranks a terminal that has already landed: graceful closure ends
				// what the peer will SEND, never what the consumer has yet to read, so the frames
				// still queued behind it are delivered before the result returns. Failure keeps its
				// precedence over both, and pays nothing for it — `#settle` empties the queue on
				// that path, so there is no frame left to drain and the reason is the whole answer.
				const queued = subscription.queue.shift()
				if (queued !== undefined) {
					yield queued
					continue
				}
				if (subscription.terminal !== undefined) return subscription.terminal
				const waiter = Promise.withResolvers<JSONRPCNotification | MCPSubscriptionResult>()
				subscription.waiter = waiter
				const frame = await waiter.promise
				if ('method' in frame) yield frame
				else return frame
			}
		} finally {
			this.#cancelSubscription(id, new Error('MCP subscription closed by its consumer'))
		}
	}

	// Refuse a session-bound request while there is no session to correlate it against. Writing
	// it instead leaves the caller on the request deadline — `DEFAULT_MCP_REQUEST_TIMEOUT`, 30
	// seconds, unless a caller shortened it — for a connection that has already ended, and a
	// closed carrier drops the frame without reporting it, so nothing ever answers. The code is
	// machine-readable because the caller's next move differs from the timeout's: reconnect,
	// rather than retry.
	//
	// It sits at `#request`, the door EVERY correlated request travels, rather than on the
	// methods that happen to have been written first. `call` and `tools` are two of that door's
	// callers; the task client is a third, holding the same bound request function; and each
	// `tasks/*` method would otherwise have had to remember a guard of its own. A door a caller
	// can be added to without noticing is a door the refusal belongs at.
	//
	// `server/discover` is deliberately outside it. It is the round trip a connection is BUILT
	// from, so refusing it would refuse `connect` itself; an attempt in flight publishes
	// `#connection` before `#negotiate` runs, which is what lets the handshake's own requests
	// through, and a bare `discover()` on a client that has never connected is a probe this
	// package publishes on purpose.
	//
	// An attempt exempts its own requests only while it is the CURRENT one. `connect` is
	// emitted from inside the attempt, so the attempt is still published when a listener runs,
	// and a transport that listener loses — a closed port, a stopped page server —
	// supersedes it at once while the negotiation remains pending. An exemption
	// reading only whether SOME attempt is in flight would admit every request issued after
	// that loss, and each would reach a carrier that drops the frame and answer nothing until
	// its deadline. Reading the connection's superseded latch is the same decision
	// `#negotiate` and `connect` already take to tell a joinable attempt from a superseded one.
	//
	// A `disconnect` issued from that same listener is the OTHER sequence, and this gate is not
	// what answers it. `#teardown` defers its close through the microtask queue, so the
	// transport is still open and the connection has not been superseded when the listener's next request
	// is issued: that request is admitted, entered as pending, and rejected by the teardown's
	// own drain. It settles well inside its deadline rather than refusing, and it never parks.
	//
	// It BUILDS the refusal rather than throwing it, because its two doors owe their caller
	// different shapes: `#request` is declared to reject, which is the contract
	// `MCPRequestFunction` publishes to whoever holds it, and a generator's entry throws. One
	// reading, two deliveries, and no second copy of the rule to drift.
	#refuse(method: string): MCPError | undefined {
		if (method === 'server/discover') return undefined
		const current = this.#connection
		if (current?.connected || (current !== undefined && !current.settled && !current.superseded)) {
			return undefined
		}
		return new MCPError(
			`MCP client is not connected, so '${method}' was not issued`,
			JSONRPC_INVALID_REQUEST,
		)
	}

	// Issue a request and await its correlated response, bounded by the per-request
	// deadline. A monotonic numeric id keys the pending settlers; `AbortSignal.timeout` (never a
	// raw `setTimeout`) rejects the pending request if the server never answers. The transport
	// `send` is awaited so a write failure rejects here rather than leaving a pending request to
	// time out.
	//
	// `options` carries the CALLER's per-request registrations, and each is recorded on
	// the pending entry rather than around this call, so the single `#settle` door releases
	// them on every exit — including the exits nobody enumerates, a rejecting `send` and the
	// teardown's drain. The request's own id doubles as its progress token: it is already
	// unique per request, already travels this exact channel, and needs no second counter to
	// drift against.
	#request(
		method: string,
		params: Readonly<Record<string, unknown>> | undefined,
		deadline: number | undefined,
		version?: MCPModernVersion,
		options?: MCPCallOptions,
	): Promise<unknown> {
		const refusal = this.#refuse(method)
		if (refusal !== undefined) return Promise.reject(refusal)
		this.#nextId += 1
		const id = this.#nextId
		const timeout = deadline
		const caller = options?.signal
		const report = options?.progress
		const modern = version ?? this.#connection?.version
		const metadata = {
			...(modern === undefined
				? {}
				: {
						[MCP_META_VERSION]: modern,
						[MCP_META_CAPABILITIES]: this.#capabilities,
						[MCP_META_CLIENT]: this.#identity,
					}),
			// Stamped only where a caller is listening: the token is what asks the peer to
			// report at all, so an unwatched request stays exactly the request it was.
			...(report === undefined ? {} : { progressToken: id }),
		}
		const stamped =
			Object.keys(metadata).length === 0 ? params : { ...(params ?? {}), _meta: metadata }
		const request: JSONRPCRequest = {
			jsonrpc: '2.0',
			id,
			method,
			...(stamped === undefined ? {} : { params: stamped }),
		}
		return new Promise<unknown>((resolve, reject) => {
			// A caller that arrived ALREADY aborted is refused before anything is written. An
			// unsent request has no id the peer could be told about, so there is nothing to
			// cancel, nothing to correlate, and nothing to release.
			if (caller?.aborted === true) {
				const reason: unknown = caller.reason
				reject(new Error(`MCP request '${method}' was aborted`, { cause: reason }))
				return
			}
			const expiry = timeout === undefined ? undefined : AbortSignal.timeout(timeout)
			const expire =
				timeout === undefined ? undefined : this.#timeoutRequest.bind(this, id, method, timeout)
			if (expire !== undefined) expiry?.addEventListener('abort', expire, { once: true })
			const abort =
				caller === undefined ? undefined : this.#abortRequest.bind(this, id, method, caller)
			if (abort !== undefined) caller?.addEventListener('abort', abort, { once: true })
			this.#pending.set(id, {
				resolve,
				reject,
				method,
				...(expiry === undefined ? {} : { deadline: expiry }),
				...(expire === undefined ? {} : { timeout: expire }),
				...(caller === undefined ? {} : { signal: caller }),
				...(abort === undefined ? {} : { abort }),
				...(report === undefined ? {} : { progress: report }),
			})
			this.#transport.send(request).catch((error: unknown) => {
				this.#settle(id, isError(error) ? error : new Error(String(error)), true)
			})
		})
	}

	// Handle one inbound transport message: a correlated response settles its pending request by
	// id (an error response rejects, a result resolves), while an error whose id is `null` rejects
	// every pending request because the peer could not identify which one failed. A `notifications/progress` frame
	// naming an in-flight request goes to that request's progress handler; anything else
	// server-initiated is re-surfaced on the `notification` event.
	//
	// A RESPONSE whose id matches nothing pending is discarded instead. Every way to reach
	// that state is the same shape — the request settled first, by its deadline, by an abort,
	// or by the teardown's drain — and MCP is explicit that a late answer to a cancelled
	// request is to be ignored, not treated as a fault. Publishing it as a `notification`
	// would announce a response as a server-initiated message, which it is not.
	#receive(message: JSONRPCMessage): void {
		const parsed = parseJSONRPCMessage(message)
		// A JSON-RPC result is any value, and an MCP result is an object of one era's shape.
		const owned =
			parsed !== undefined &&
			isJSONRPCResultResponse(parsed) &&
			!isMCPResult(parsed.result) &&
			!isMCPLegacyResult(parsed.result)
				? undefined
				: parsed
		if (owned === undefined) {
			const correlated = attempt(() => {
				if (!isRecord(message)) return undefined
				const descriptor = Reflect.getOwnPropertyDescriptor(message, 'id')
				if (
					descriptor === undefined ||
					descriptor.enumerable !== true ||
					!Object.hasOwn(descriptor, 'value')
				)
					return undefined
				const id = descriptor.value
				return isJSONRPCId(id) ? id : undefined
			})
			if (correlated.success && correlated.value !== undefined) {
				const pending = this.#pending.get(correlated.value)
				if (pending?.method === 'server/discover') {
					this.#settle(
						correlated.value,
						new MCPError(
							'MCP server returned a malformed discovery result',
							JSONRPC_INVALID_PARAMS,
						),
						true,
					)
					return
				}
			}
			this.#emitter.emit(
				'error',
				new MCPError('MCP transport delivered a malformed message', JSONRPC_INVALID_PARAMS),
			)
			return
		}
		if (isJSONRPCResponse(owned) && owned.id === null && owned.error !== undefined) {
			for (const id of this.#pending.keys()) {
				this.#settle(
					id,
					new MCPError(
						`MCP server returned an error without a request id: ${owned.error.message}`,
						owned.error.code,
						owned.error.data,
					),
					true,
				)
			}
			return
		}
		if (isJSONRPCResponse(owned) && owned.id !== null) {
			const correlation = owned.id
			const pending = this.#pending.get(correlation)
			if (pending !== undefined) {
				if (owned.error !== undefined) {
					this.#settle(
						correlation,
						new MCPError(owned.error.message, owned.error.code, owned.error.data),
						true,
					)
				} else if (pending.subscription !== undefined) {
					if (
						!isMCPSubscriptionResult(owned.result) ||
						owned.result['_meta'][MCP_META_SUBSCRIPTION] !== correlation
					) {
						this.#settle(
							correlation,
							new MCPError(
								'MCP server returned a malformed subscription result',
								JSONRPC_INVALID_PARAMS,
								owned.result,
							),
							true,
						)
					} else this.#settle(correlation, owned.result, false)
				} else {
					const resultType = isRecord(owned.result) ? owned.result['resultType'] : undefined
					const metadata = isRecord(owned.result) ? owned.result['_meta'] : undefined
					if (metadata !== undefined && !isMCPResultMetaObject(metadata)) {
						this.#settle(
							correlation,
							new MCPError('MCP server returned invalid result metadata', JSONRPC_INVALID_PARAMS),
							true,
						)
						return
					}
					if (
						isRecord(owned.result) &&
						Object.hasOwn(owned.result, 'resultType') &&
						!matchesResultType(pending.method, resultType)
					) {
						this.#settle(
							correlation,
							new MCPError(
								`MCP result type '${String(resultType)}' is not supported`,
								JSONRPC_INVALID_PARAMS,
								{ resultType },
							),
							true,
						)
					} else {
						this.#settle(correlation, owned.result, false)
					}
				}
				return
			}
			return
		}
		// A server-initiated message. A progress frame a caller is waiting on is claimed by
		// that caller; everything else is surfaced for the consumer to react to.
		if ('method' in owned && this.#reportProgress(owned)) return
		if ('method' in owned && this.#routeSubscription(owned)) return
		this.#emitter.emit('notification', owned)
	}

	#routeSubscription(message: JSONRPCInvocation): boolean {
		if (!isJSONRPCNotification(message)) return false
		const metadata = message.params?.['_meta']
		if (!isRecord(metadata)) return false
		const id = metadata[MCP_META_SUBSCRIPTION]
		if (!isJSONRPCId(id)) return false
		const subscription = this.#pending.get(id)?.subscription
		if (subscription === undefined) return true
		const waiter = subscription.waiter
		if (waiter !== undefined) {
			delete subscription.waiter
			waiter.resolve(message)
			return true
		}
		if (subscription.queue.length >= subscription.capacity) {
			this.#cancelSubscription(
				id,
				new MCPError('MCP subscription frame queue overflow', JSONRPC_INTERNAL_ERROR),
			)
			return true
		}
		subscription.queue.push(message)
		return true
	}

	// Route one inbound `notifications/progress` frame to the request whose caller asked for
	// it, reporting whether the frame was claimed. Unclaimed means exactly one of: the frame
	// is not a progress frame, it names no token this client minted, it names a request that
	// has already settled (whose registration went with it), or its caller supplied no
	// handler — all of which leave it an ordinary server notification.
	#reportProgress(message: JSONRPCInvocation): boolean {
		if (message.method !== 'notifications/progress') return false
		const params = message.params
		const token = isRecord(params) ? params['progressToken'] : undefined
		if (!isJSONRPCId(token)) return false
		const report = this.#pending.get(token)?.progress
		if (report === undefined || !isMCPProgress(params)) return false
		// The handler is the consumer's, so its throw is contained here and surfaced on the
		// client's own `error` channel rather than escaping into the transport's delivery.
		const reported = attempt(() => report(params))
		if (!reported.success) this.#emitter.emit('error', reported.error)
		return true
	}

	// Wrap one remote tool descriptor as a local tool: map `inputSchema` → `parameters`
	// (the inverse of the server's rename), carry display metadata and mapped hints,
	// and bind `execute` and its context signal to a remote `tools/call` through `call`.
	#tool(name: string, descriptor: Readonly<Record<string, unknown>>): ToolInterface {
		const inputSchema = descriptor['inputSchema']
		const description = descriptor['description']
		const title = descriptor['title']
		const annotations = descriptor['annotations']
		const projected = isMCPToolAnnotations(annotations) ? mcpAnnotationsToTool(annotations) : {}
		return new Tool({
			name,
			...(isString(title) ? { title } : {}),
			...(isString(description) ? { description } : {}),
			...(isRecord(inputSchema) ? { parameters: inputSchema } : {}),
			...(Object.keys(projected).length === 0 ? {} : { annotations: projected }),
			execute: this.#execute.bind(this, name),
		})
	}

	// The agent-facing edge of `call`. A wrapped tool owes its caller a VALUE, and the
	// deferred arms have none: the request is over and the answer is somewhere the agent
	// cannot wait for. Throwing is the one shape an agent's registry already absorbs — it
	// becomes a `success: false` result the model can read — where returning `undefined`
	// would read as a tool that succeeded and produced nothing.
	async #execute(
		name: string,
		args: Readonly<Record<string, unknown>>,
		context: ToolContext,
	): Promise<unknown> {
		const outcome = await this.call(name, args, { signal: context.signal })
		if (outcome.resultType !== 'complete') {
			throw new Error(`MCP tool '${name}' answered '${outcome.resultType}' and has no inline value`)
		}
		return outcome.value
	}

	// One connection owns the attempt that `connect` published. Every
	// re-ask below asks the same question a suspended negotiation must ask before it writes
	// anything: is this still the current attempt, or did a `disconnect` supersede it?
	async #discover(connection: MCPConnection): Promise<MCPDiscoverResult> {
		try {
			try {
				return await this.discover()
			} catch (error) {
				// Re-ask BEFORE the offer moves: this branch writes a SECOND discovery and
				// creates a second pending entry, and `#closeConnection` drains `#pending`
				// exactly once — a retry issued after that drain has nothing left to settle it,
				// so a superseded attempt would never settle at all.
				if (connection.superseded) {
					throw new Error('MCP client disconnected', { cause: error })
				}
				if (!isMCPError(error) || error.code !== MCP_UNSUPPORTED_VERSION) throw error
				if (this.#pin !== undefined) throw error
				const supported = isRecord(error.context) ? error.context['supported'] : undefined
				const retry = isArray(supported)
					? inferVersion(supported.filter((version): version is string => isString(version)))
					: undefined
				if (retry === undefined) throw error
				this.#offer = retry
				return await this.discover()
			}
		} catch (error) {
			if (connection.superseded) throw error
			if (!isMCPError(error) || error.code !== JSONRPC_METHOD_NOT_FOUND) throw error
			throw new MCPError(
				'MCP server does not support modern negotiation; wrap the transport with createMCPLegacyClientTransport to connect to a legacy peer',
				error.code,
				error.context,
			)
		}
	}

	async #negotiate(connection: MCPConnection): Promise<void> {
		await this.#transport.start()
		connection.claim()
		try {
			if (connection.superseded) throw new Error('MCP client disconnected')
			const discovery = await this.#discover(connection)

			const version =
				this.#pin === undefined
					? inferVersion(discovery.supportedVersions)
					: isMCPModernVersion(this.#pin) && discovery.supportedVersions.includes(this.#pin)
						? this.#pin
						: undefined
			if (this.#pin !== undefined && version === undefined) {
				throw new MCPError(
					'MCP server does not support the pinned protocol version',
					MCP_UNSUPPORTED_VERSION,
					{
						supported: discovery.supportedVersions,
						requested: this.#pin,
					},
				)
			}
			if (version === undefined) {
				throw new MCPError(
					'MCP server supports no compatible protocol version',
					MCP_UNSUPPORTED_VERSION,
					{
						supported: discovery.supportedVersions,
					},
				)
			}
			if (connection.superseded) throw new Error('MCP client disconnected')
			connection.accept(version)
			this.#emitter.emit('connect')
		} catch (error) {
			if (connection.owed) {
				try {
					await this.#closeTransport(connection)
				} catch (fault) {
					this.#emitter.emit('error', fault)
				}
			}
			throw error
		}
	}

	// Publish before work starts, so reentrant callers join the same teardown.
	async #teardown(): Promise<void> {
		const [running] = this.#teardowns
		if (running !== undefined) return await running
		const teardown = Promise.resolve().then(() => this.#closeConnection())
		this.#teardowns.add(teardown)
		try {
			await teardown
		} finally {
			this.#teardowns.delete(teardown)
		}
	}

	// Supersede before draining requests. An unfinished start closes what it opens later.
	async #closeConnection(): Promise<void> {
		const connection = this.#connection
		if (connection === undefined) return
		const announced = connection.connected
		connection.supersede()
		for (const id of this.#pending.keys()) {
			this.#settle(id, new Error('MCP client disconnected'), true)
		}
		try {
			if (connection.owed) await this.#closeTransport(connection)
		} finally {
			if (announced) this.#emitter.emit('disconnect')
		}
	}

	// Bound the wait, leaving the connection's close running and joinable after a timeout.
	async #closeTransport(connection: MCPConnection): Promise<void> {
		const closing = connection.close()
		const timeout = this.#timeout
		const deadline = AbortSignal.timeout(timeout)
		await Promise.race([
			closing,
			new Promise<never>((_, reject) => {
				deadline.addEventListener(
					'abort',
					() => reject(new Error(`MCP transport close timed out after ${timeout}ms`)),
					{ once: true },
				)
			}),
		])
	}

	#timeoutRequest(id: JSONRPCId, method: string, timeout: number): void {
		this.#settle(id, new Error(`MCP request '${method}' timed out after ${timeout}ms`), true)
	}

	// The caller withdrew from ONE request. What follows are independent effects, neither
	// the other's precondition: the caller stops waiting, always, on every carrier; and the peer is TOLD,
	// only where the carrier can carry a client-initiated notification. Cancellation is
	// ADVISORY in MCP — every receiver obligation is `SHOULD` or `MAY` — so the telling is
	// courtesy, the local settle is the contract, and a peer that answers anyway is answering
	// a request nothing is waiting for.
	//
	// The frame goes first and is never awaited. It carries no id, so nothing answers it and
	// no deadline watches it; a caller that has already stopped waiting must not be made to
	// wait again on the courtesy. A write that fails is surfaced for observation only.
	//
	// Registering nothing here is deliberate: this listener runs INSIDE the request's
	// lifetime, and anything it registered would have to be released on the exits this
	// listener never sees. `#settle` releases the listener itself.
	#abortRequest(id: JSONRPCId, method: string, signal: AbortSignal): void {
		if (this.#pending.get(id) === undefined) return
		const reason: unknown = signal.reason
		if (this.#transport.duplex) {
			this.#transport
				.send(buildCancelledNotification(id, isString(reason) ? reason : undefined))
				.catch((error: unknown) => this.#emitter.emit('error', error))
		}
		this.#settle(id, new Error(`MCP request '${method}' was aborted`, { cause: reason }), true)
	}

	#abortSubscription(id: JSONRPCId, signal: AbortSignal): void {
		this.#cancelSubscription(id, signal.reason)
	}

	#cancelSubscription(id: JSONRPCId, reason: unknown): void {
		if (this.#pending.get(id)?.subscription === undefined) return
		if (this.#transport.duplex) {
			this.#transport
				.send(buildCancelledNotification(id, isString(reason) ? reason : undefined))
				.catch((error: unknown) => this.#emitter.emit('error', error))
		}
		this.#settle(id, reason, true)
	}

	#loseTransport(): void {
		const connection = this.#connection
		const announced = connection?.connected
		connection?.release()
		for (const id of this.#pending.keys()) {
			this.#settle(id, new Error('MCP transport closed'), true)
		}
		if (announced) this.#emitter.emit('disconnect')
	}

	#settle(id: JSONRPCId, value: unknown, failed: boolean): void {
		const pending = this.#pending.get(id)
		if (pending === undefined) return
		this.#pending.delete(id)
		if (pending.deadline !== undefined && pending.timeout !== undefined) {
			pending.deadline.removeEventListener('abort', pending.timeout)
		}
		// The caller's signal is the CALLER's and outlives this request — one controller may be
		// driving several calls — so its listener is removed rather than left to `once`. The
		// progress handler needs no line here: it lives on the entry this call already dropped.
		if (pending.signal !== undefined && pending.abort !== undefined) {
			pending.signal.removeEventListener('abort', pending.abort)
		}
		const subscription = pending.subscription
		if (subscription !== undefined) {
			const waiter = subscription.waiter
			delete subscription.waiter
			if (failed) {
				subscription.queue.length = 0
				if (waiter === undefined) subscription.failure = { reason: value }
				else waiter.reject(value)
			} else if (isMCPSubscriptionResult(value)) {
				if (waiter === undefined) subscription.terminal = value
				else waiter.resolve(value)
			}
			return
		}
		if (failed) pending.reject?.(value)
		else pending.resolve?.(value)
	}
}
