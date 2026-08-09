import type { EmitterInterface } from '@orkestrel/emitter'
import type { ToolInterface } from '@orkestrel/tool'
import type {
	MCPClientTransportInterface,
	JSONRPCId,
	JSONRPCInvocation,
	JSONRPCMessage,
	JSONRPCRequest,
	MCPCallOptions,
	MCPCallOutcome,
	MCPClientEventMap,
	MCPClientInterface,
	MCPClientOptions,
	MCPClientCapabilities,
	MCPDiscoverResult,
	MCPEra,
	MCPIdentity,
	MCPProgressHandler,
	MCPTaskClientInterface,
	MCPVersion,
} from './types.js'
import { Emitter } from '@orkestrel/emitter'
import { Tool } from '@orkestrel/tool'
import { MCPTaskClient } from './MCPTaskClient.js'
import {
	attempt,
	cloneJSONRecord,
	isArray,
	isInteger,
	isRecord,
	isString,
} from '@orkestrel/contract'
import {
	DEFAULT_MCP_CLIENT_NAME,
	DEFAULT_MCP_CLIENT_VERSION,
	DEFAULT_MCP_PROBE_TIMEOUT,
	DEFAULT_MCP_REQUEST_TIMEOUT,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_METHOD_NOT_FOUND,
	MCP_META_CAPABILITIES,
	MCP_META_CLIENT,
	MCP_META_VERSION,
	MCP_MODERN_VERSION,
	MCP_PROTOCOL_VERSION,
	MCP_UNSUPPORTED_VERSION,
} from './constants.js'
import { MCPError, isMCPError } from './errors.js'
import { buildCallOutcome, buildCancelledNotification, matchesResultType } from './helpers.js'
import { inferEra, inferVersion } from './inferers.js'
import { parseJSONRPCMessage } from './parsers.js'
import {
	isJSONRPCId,
	isJSONRPCResponse,
	isMCPProgress,
	isMCPResultMetaObject,
	isMCPServerCapabilities,
	isMCPVersion,
} from './validators.js'

/**
 * A transport-agnostic Model Context Protocol CLIENT — connects to a REMOTE MCP server
 * over an injected {@link MCPClientTransportInterface}, negotiates the modern or legacy
 * wire era, and exposes the server's tools as local {@link ToolInterface}s an agent can run.
 *
 * @remarks
 * - **The mirror of `MCPServer`.** The server DISPATCHES requests over a tool registry;
 *   this client ISSUES them over a transport. `connect` probes `server/discover` unless
 *   pinned legacy, falls back to `initialize` only for a legacy peer, and exposes the
 *   negotiated `version`; `tools()` lists the remote tools and wraps each as a
 *   local {@link ToolInterface} whose `execute` calls back through `call`; `call` runs a
 *   remote `tools/call` and reports the arm the peer answered with — a value, a durable
 *   task, or a request for more input (a remote `isError: true` throws locally, so an
 *   agent's {@link import('@orkestrel/tool').ToolManagerInterface} isolates it into a
 *   `success: false` result just like a local throw). A wrapped tool cannot hand an agent
 *   a deferred answer, so a non-`'complete'` arm throws there.
 * - **Request↔response correlation.** Each request is tagged with a monotonic numeric
 *   `id` ({@link #nextId}); a single transport `message` subscription resolves / rejects
 *   the matching {@link #pending} entry by `id`. An error response with no `id` rejects
 *   every pending request because the peer could not identify which request failed. A
 *   server-initiated message is re-surfaced on the `notification` event, except a progress
 *   frame claimed by the request that asked
 *   for it; a RESPONSE correlating to nothing pending is discarded, because the request it
 *   answers has already settled.
 * - **Per-request cancellation.** `call`'s `options.signal` withdraws ONE caller from ONE
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
 *   discovery probe uses that same 30-second default, or the shorter probe deadline where
 *   `timeout` was configured, so a silent peer cannot hold negotiation indefinitely.
 *   `AbortSignal.timeout` (never a raw `setTimeout`) rejects only that pending request, and the
 *   same deadline bounds the WAIT on the transport's `close`, the one wait no drain and no signal
 *   can reach. It bounds the wait rather than the close, which keeps running, so a retry joins it
 *   instead of shutting one connection down twice.
 * - **Transport-agnostic.** Imports only core siblings (JSON-RPC + the tool vocabulary);
 *   the concrete transport is injected. Wire fields are narrowed via the contracts
 *   guards (no `as`).
 * - **Observable (§13).** The owned `emitter` fires `connect` / `disconnect` /
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
	readonly #transport: MCPClientTransportInterface
	readonly #identity: MCPIdentity
	readonly #capabilities: MCPClientCapabilities
	readonly #pin: MCPVersion | undefined
	readonly #timeout: number
	readonly #probe: number
	// The draft Tasks extension's client half, built once and held. It is given this client's
	// own correlated-request door rather than a second path to the peer, so a task read shares
	// the id space, the pending table, the deadline, and the `disconnect` drain with every other
	// request — and `#request` stays private, because publishing it would be a general
	// arbitrary-method capability nothing has asked for. The declared cost of that choice: a
	// consumer who registers `prompts/get` on the server's open registry cannot reach it with
	// this client, and the guide records the asymmetry rather than leaving it to be discovered.
	readonly #tasks: MCPTaskClientInterface
	// The in-flight requests, keyed by JSON-RPC id, each holding its promise settlers —
	// resolved on the matching response, rejected on an error response, the deadline, an
	// abort, or `disconnect`. Genuinely private glue (§5): the settler shape lives inline here.
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
			readonly resolve: (value: unknown) => void
			readonly reject: (reason?: unknown) => void
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
		}
	>()
	#nextId = 0
	#connected = false
	// WHICH attempt owns the connection this client opened on the transport, if any: the generation
	// whose `start()` opened it. One fact, so a claim asks `is this connection MINE` and never `is
	// SOMETHING open` — the question a superseded attempt resuming over a connection a LATER attempt
	// opened would otherwise answer yes to. Both close sites read and clear it in ONE synchronous
	// stretch before awaiting `close()`, and a close still running is joined rather than repeated, so
	// `close()` (not contractually idempotent) runs once per connection; and whichever of them meets
	// a close that FAILED — or one that merely outran its deadline, which says the shutdown did not
	// answer and never that it did not happen — keeps the claim, because a connection that did not
	// close, or never confirmed that it had, is still owed one. Which is also why `connect` refuses
	// to open while a claim is standing.
	#owner: number | undefined = undefined
	// The `transport.close()` this client stopped waiting for, while it is still running. A deadline
	// ends the WAIT, never the close, so the promise is retained rather than a verdict about it: the
	// next caller that owes this connection a close JOINS this one under a fresh deadline instead of
	// issuing a second shutdown over it, and the transport's own eventual answer — the only
	// authority on whether the connection ended — settles the claim it left standing.
	#closing: Promise<void> | undefined = undefined
	// The in-flight connect attempt: the negotiation a second caller JOINS, and the generation
	// it was published under, so a caller can tell an attempt it may join from one a teardown
	// already superseded and must merely outwait. Genuinely private glue (§5), like `#pending`'s
	// settler shape.
	#connecting: { readonly negotiation: Promise<void>; readonly generation: number } | undefined =
		undefined
	// The in-flight disconnect, published BEFORE its work starts.
	#disconnecting: Promise<void> | undefined = undefined
	#generation = 0
	// Settled by every teardown, and replaced in the same stretch. A raw wire write — a
	// notification, which carries no id and therefore no `#pending` entry — is the one await
	// the teardown's drain cannot reach and no deadline is watching, so an attempt races its
	// own raw write against this and stops waiting on a transport that may never answer.
	#supersession = Promise.withResolvers<void>()
	#version: MCPVersion | undefined = undefined
	#era: MCPEra | undefined = undefined
	#offer: MCPVersion

	constructor(options: MCPClientOptions) {
		this.#emitter = new Emitter<MCPClientEventMap>({
			...(options.on !== undefined ? { on: options.on } : {}),
			...(options.error !== undefined ? { error: options.error } : {}),
		})
		this.#transport = options.transport
		this.#identity = options.identity ?? {
			name: DEFAULT_MCP_CLIENT_NAME,
			version: DEFAULT_MCP_CLIENT_VERSION,
		}
		this.#capabilities = options.capabilities ?? {}
		this.#pin = options.version
		this.#offer = options.version ?? MCP_MODERN_VERSION
		this.#timeout = options.timeout ?? DEFAULT_MCP_REQUEST_TIMEOUT
		this.#probe =
			options.timeout === undefined
				? DEFAULT_MCP_REQUEST_TIMEOUT
				: Math.min(options.timeout, DEFAULT_MCP_PROBE_TIMEOUT)
		this.#tasks = new MCPTaskClient({
			request: this.#request.bind(this),
			timeout: this.#timeout,
		})
		// One message subscription for the client's whole life: a response settles its
		// pending request by id; anything else is a server notification.
		this.#transport.emitter.on('message', (message) => this.#receive(message))
	}

	get emitter(): EmitterInterface<MCPClientEventMap> {
		return this.#emitter
	}

	get connected(): boolean {
		return this.#connected
	}

	get version(): MCPVersion | undefined {
		return this.#version
	}

	get transport(): MCPClientTransportInterface {
		return this.#transport
	}

	get tasks(): MCPTaskClientInterface {
		return this.#tasks
	}

	on<K extends keyof MCPClientEventMap>(
		event: K,
		handler: (...args: MCPClientEventMap[K]) => void,
	): void {
		this.#emitter.on(event, handler)
	}

	async connect(): Promise<void> {
		// Wait out everything that must finish before a NEW attempt may open the next connection: a
		// teardown in flight, an attempt a teardown already superseded, and a close this client
		// still OWES. A CURRENT attempt is joined — one handshake, one outcome, shared. A SUPERSEDED
		// one is outwaited instead: its caller asked for the connection that teardown ended, this
		// caller is asking for a fresh one, and running beside it would open a second connection
		// with one owner. Re-read after every wait, because what was in flight when this caller
		// arrived is not what is in flight when it resumes, and two callers resuming together must
		// not both open.
		for (;;) {
			const closing = this.#disconnecting
			if (closing !== undefined) {
				await closing.catch(() => undefined)
				continue
			}
			if (this.#connected) return
			const inflight = this.#connecting
			if (inflight === undefined) {
				// The claim a `close()` that faulted — or that outran its deadline — left standing:
				// that connection did not close, or never confirmed that it had, so it is still owned,
				// and this is the second door onto the rule `disconnect` already enforces — the door
				// that never asked. Opening here would `start()` a connection beside it and leave the
				// first with no claim and no public path. The debt is settled through the same slot
				// `disconnect` publishes, so a caller arriving mid-retry joins one teardown instead
				// of racing it; the retry joins a close still running rather than issuing another;
				// and a close that fails AGAIN rejects THIS caller with that fault, leaving the debt
				// owned for whoever asks next. Read only once no attempt is in flight: a LIVE attempt
				// legitimately holds the claim while it negotiates, and closing there would tear down
				// the very connection this caller is waiting on.
				if (this.#owner === undefined) break
				await this.#teardown()
				continue
			}
			if (inflight.generation === this.#generation) return inflight.negotiation
			await inflight.negotiation.catch(() => undefined)
		}
		this.#generation += 1
		const generation = this.#generation
		// Published before `#negotiate` — and so before the injected `transport.start()` —
		// runs: a transport that re-enters `connect()` joins this attempt instead of opening
		// another. Building the record around `this.#negotiate(...)` directly does NOT close that
		// door, because an async function runs synchronously to its first await, so `start()`
		// would already have been called before the assignment.
		const negotiation = Promise.resolve().then(() => this.#negotiate(generation))
		const published = { negotiation, generation }
		this.#connecting = published
		try {
			await negotiation
		} finally {
			// Only this attempt's own gate: a settling attempt must never unpublish a live one.
			if (this.#connecting === published) this.#connecting = undefined
		}
	}

	async discover(): Promise<MCPDiscoverResult> {
		const received = await this.#request(
			'server/discover',
			undefined,
			this.#probe,
			this.#version ?? this.#offer,
		)
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
		const supportedVersions: MCPVersion[] = []
		for (const version of advertised) {
			if (isMCPVersion(version)) supportedVersions.push(version)
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
		const closing = this.#disconnecting
		if (closing !== undefined) return closing
		// Three things are worth tearing down: an announced connection, an attempt still in
		// flight, and a connection whose `close()` faulted or never answered — that one is still
		// owned, and both this path and the next `connect()` can reach it.
		if (!this.#connected && this.#connecting === undefined && this.#owner === undefined) return
		await this.#teardown()
	}

	async tools(): Promise<readonly ToolInterface[]> {
		const result = await this.#request('tools/list', undefined, this.#timeout)
		// The wire shape is `{ tools: MCPToolDescriptor[] }` — narrow it (§14): a
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

	async call(
		name: string,
		args: Readonly<Record<string, unknown>>,
		options?: MCPCallOptions,
	): Promise<MCPCallOutcome> {
		const result = await this.#request(
			'tools/call',
			{ name, arguments: args },
			this.#timeout,
			undefined,
			options,
		)
		return buildCallOutcome(name, result)
	}

	// Issue a request and await its correlated response, bounded by the per-request
	// deadline. A monotonic numeric id keys the pending settlers; `AbortSignal.timeout`
	// (the taverna idiom — never a raw setTimeout) rejects the pending request if the
	// server never answers. The transport `send` is awaited so a write failure rejects
	// here rather than leaving a pending request to time out.
	//
	// `options` carries the CALLER's two per-request registrations, and both are recorded on
	// the pending entry rather than around this call, so the single `#settle` door releases
	// them on every exit — including the two nobody enumerates, a rejecting `send` and the
	// teardown's drain. The request's own id doubles as its progress token: it is already
	// unique per request, already travels this exact channel, and needs no second counter to
	// drift against.
	#request(
		method: string,
		params: Readonly<Record<string, unknown>> | undefined,
		deadline: number | undefined,
		version?: MCPVersion,
		options?: MCPCallOptions,
	): Promise<unknown> {
		this.#nextId += 1
		const id = this.#nextId
		const timeout = deadline
		const caller = options?.signal
		const report = options?.progress
		const modern = version ?? (this.#era === 'modern' ? this.#version : undefined)
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
			let expiry: AbortSignal | undefined
			let expire: (() => void) | undefined
			if (timeout !== undefined) {
				expiry = AbortSignal.timeout(timeout)
				expire = this.#timeoutRequest.bind(this, id, method, timeout)
				expiry.addEventListener('abort', expire, { once: true })
			}
			let abort: (() => void) | undefined
			if (caller !== undefined) {
				abort = this.#abortRequest.bind(this, id, method, caller)
				caller.addEventListener('abort', abort, { once: true })
			}
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
				this.#settle(id, error instanceof Error ? error : new Error(String(error)), true)
			})
		})
	}

	// Handle one inbound transport message: a correlated response settles its pending request by
	// id (an error response rejects, a result resolves), while an id-less error rejects every
	// pending request because the peer could not identify which one failed. A `notifications/progress` frame
	// naming an in-flight request goes to that request's progress handler; anything else
	// server-initiated is re-surfaced on the `notification` event.
	//
	// A RESPONSE whose id matches nothing pending is discarded instead. Every way to reach
	// that state is the same shape — the request settled first, by its deadline, by an abort,
	// or by the teardown's drain — and MCP is explicit that a late answer to a cancelled
	// request is to be ignored, not treated as a fault. Publishing it as a `notification`
	// would announce a response as a server-initiated message, which it is not.
	#receive(message: JSONRPCMessage): void {
		const owned = parseJSONRPCMessage(message)
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
					this.#era = 'modern'
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
		if (isJSONRPCResponse(owned) && owned.id === undefined && owned.error !== undefined) {
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
		if (isJSONRPCResponse(owned) && owned.id !== undefined) {
			const correlation = owned.id
			const pending = this.#pending.get(correlation)
			if (pending !== undefined) {
				if (
					pending.method === 'server/discover' &&
					(owned.error === undefined ||
						(owned.error.code !== JSONRPC_METHOD_NOT_FOUND &&
							owned.error.code !== JSONRPC_INVALID_REQUEST))
				) {
					this.#era = 'modern'
				}
				if (owned.error !== undefined) {
					this.#settle(
						correlation,
						new MCPError(owned.error.message, owned.error.code, owned.error.data),
						true,
					)
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
		this.#emitter.emit('notification', owned)
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
	// (the inverse of the server's rename, no `as`), carry `description` when present,
	// and bind `execute` to a remote `tools/call` via `call`.
	#tool(name: string, descriptor: Readonly<Record<string, unknown>>): ToolInterface {
		const inputSchema = descriptor['inputSchema']
		const description = descriptor['description']
		const options: {
			name: string
			description?: string
			parameters?: Readonly<Record<string, unknown>>
			execute: (args: Readonly<Record<string, unknown>>) => Promise<unknown>
		} = {
			name,
			execute: this.#execute.bind(this, name),
		}
		if (isString(description)) options.description = description
		if (isRecord(inputSchema)) options.parameters = inputSchema
		return new Tool(options)
	}

	// The agent-facing edge of `call`. A wrapped tool owes its caller a VALUE, and the two
	// deferred arms have none: the request is over and the answer is somewhere the agent
	// cannot wait for. Throwing is the one shape an agent's registry already absorbs — it
	// becomes a `success: false` result the model can read — where returning `undefined`
	// would read as a tool that succeeded and produced nothing.
	async #execute(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
		const outcome = await this.call(name, args)
		if (outcome.resultType !== 'complete') {
			throw new Error(`MCP tool '${name}' answered '${outcome.resultType}' and has no inline value`)
		}
		return outcome.value
	}

	// One connect attempt, stamped with the generation `connect` published it under. Every
	// re-ask below asks the same question a suspended negotiation must ask before it writes
	// anything: is this still the current attempt, or did a `disconnect` supersede it?
	async #negotiate(generation: number): Promise<void> {
		await this.#transport.start()
		// Claimed when the open COMPLETES — an abandoned `start()` that succeeds later still opened
		// something and must still be closable — and never over a claim already standing. A standing
		// claim names a connection an earlier attempt opened and no `close()` has confirmed, so
		// overwriting it would leave that connection with no claim and no public path while this
		// attempt reported itself connected over the same transport. `connect` refuses to open while
		// a close is owed, so this is the second lock on that door rather than the door itself.
		if (this.#owner !== undefined) {
			throw new Error('MCP client owes a connection it has not closed')
		}
		this.#owner = generation
		try {
			if (generation !== this.#generation) throw new Error('MCP client disconnected')
			if (this.#era === 'legacy' || (this.#pin !== undefined && inferEra(this.#pin) === 'legacy')) {
				await this.#initialize(generation, this.#pin ?? MCP_PROTOCOL_VERSION)
				return
			}

			let discovery: MCPDiscoverResult
			try {
				try {
					discovery = await this.discover()
				} catch (error) {
					// Re-ask BEFORE the offer moves: this branch writes a SECOND discovery and
					// creates a second pending entry, and `#closeConnection` drains `#pending`
					// exactly once — a retry issued after that drain has nothing left to settle it,
					// so a superseded attempt would never settle at all.
					if (generation !== this.#generation) {
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
					discovery = await this.discover()
				}
			} catch (error) {
				if (generation !== this.#generation) throw error
				const fallback =
					this.#pin !== MCP_MODERN_VERSION &&
					this.#era === undefined &&
					(!isMCPError(error) || error.code !== MCP_UNSUPPORTED_VERSION)
				if (!fallback) throw error
				await this.#initialize(generation, MCP_PROTOCOL_VERSION)
				return
			}

			const version = inferVersion(discovery.supportedVersions)
			if (version === undefined) {
				throw new MCPError(
					'MCP server supports no compatible protocol version',
					MCP_UNSUPPORTED_VERSION,
					{
						supported: discovery.supportedVersions,
					},
				)
			}
			if (generation !== this.#generation) throw new Error('MCP client disconnected')
			this.#version = version
			this.#era = 'modern'
			this.#connected = true
			this.#emitter.emit('connect')
		} catch (error) {
			// A superseded attempt must STILL close a connection IT opened, because `#closeConnection`
			// skipped that close — nothing was open yet when it ran. But it closes only its OWN:
			// the claim is this attempt's generation, so an attempt resuming over a connection a later
			// attempt opened matches nothing and closes nothing. Claiming is synchronous, so the
			// winner is decided before either side suspends.
			if (this.#owner === generation) {
				this.#owner = undefined
				try {
					await this.#closeTransport()
				} catch (fault) {
					// The connection did not close — or never confirmed that it had — so its ownership
					// is not discarded: `disconnect` and the next `connect` are the paths left that can
					// close it. Two failures owed to two audiences: this observer learns the transport
					// fault, and the caller below still learns why the connection did not happen.
					this.#owner = generation
					this.#emitter.emit('error', fault)
				}
			}
			throw error
		}
	}

	// Publish the teardown BEFORE its work starts, and unpublish it only once that work has settled.
	// While it is published every `disconnect` joins it and every `connect` waits for it, which is
	// what keeps one close and one open from running together. Shared by `disconnect` and by the
	// `connect` that finds a close still owed, so both travel one slot and one queue.
	async #teardown(): Promise<void> {
		const teardown = Promise.resolve().then(() => this.#closeConnection())
		this.#disconnecting = teardown
		try {
			await teardown
		} finally {
			this.#disconnecting = undefined
		}
	}

	// Invalidate any in-flight connect FIRST, so it cannot install `connected` over a connection
	// this is closing. This does NOT await the attempt: an attempt suspended inside the injected
	// `start()` would hold the teardown open for as long as that transport takes to open. What
	// unwinds the attempt instead is rejecting every pending request AND settling the supersession
	// signal — together they reach every await an attempt can be parked in once the transport has
	// opened — and `#owner` decides which side closes. The attempt's gate stays published: it is
	// the attempt itself that clears it, once it has settled, so a new `connect()` outwaits it
	// rather than running beside it.
	async #closeConnection(): Promise<void> {
		this.#generation += 1
		// Replace, then settle: the settled signal releases every attempt parked in a raw write
		// right now, and the fresh one belongs to whatever attempt comes next — an attempt racing
		// an already settled signal would abandon its own writes before making them.
		const supersession = this.#supersession
		this.#supersession = Promise.withResolvers<void>()
		supersession.resolve()
		const announced = this.#connected
		this.#connected = false
		this.#version = undefined
		for (const id of this.#pending.keys()) {
			this.#settle(id, new Error('MCP client disconnected'), true)
		}
		// One rule covers both faults this teardown can meet: `disconnect` announces the loss of
		// a connection this client ANNOUNCED, so an attempt that never emitted `connect` emits no
		// `disconnect` either — and where it IS owed, a failing `close()` still reaches the
		// caller without swallowing the announcement.
		const owner = this.#owner
		this.#owner = undefined
		try {
			if (owner !== undefined) await this.#closeTransport()
		} catch (fault) {
			// The connection did not close — or never confirmed that it had — so it is still owned,
			// and a caller can still reach it: a client that discarded its claim here would leave a
			// real connection open for the process's life with no public path left to close it. Where
			// the fault was the deadline the close is still running, so the next caller joins it and
			// the transport's own answer, not this one, decides whether the debt survives.
			this.#owner = owner
			throw fault
		} finally {
			if (announced) this.#emitter.emit('disconnect')
		}
	}

	// The transport's own `close()` — the one await nothing else in this client can reach. The drain
	// settles a pending request, a request deadline settles one the peer ignores, and the
	// supersession signal settles a raw write; a shutdown the transport accepts and never answers is
	// deaf to all three, and while a teardown is published it would hold `disconnect` AND every
	// later `connect` for the process's life. So the WAIT carries the same deadline every other
	// transport wait carries — the wait, never the close, which keeps running and may still end the
	// connection. That difference is the whole design here: a fault means the shutdown did NOT
	// happen, a deadline means this client stopped waiting to hear whether it did, and treating the
	// second as the first is what would send a second `close()` over a connection the first is still
	// closing.
	async #closeTransport(): Promise<void> {
		// Join the close already running; issue one only when none is.
		let closing = this.#closing
		if (closing === undefined) {
			closing = this.#transport.close()
			this.#closing = closing
			void closing.then(
				() => this.#discharge(true),
				() => this.#discharge(false),
			)
		}
		const timeout = this.#timeout
		const deadline = AbortSignal.timeout(timeout)
		await Promise.race([
			closing,
			// `_` is the unused `resolve`: this side of the race only ever rejects. `race` keeps a
			// handler on both sides, so a deadline that fires after the close returned rejects
			// nothing unhandled.
			new Promise<never>((_, reject) => {
				deadline.addEventListener(
					'abort',
					() => reject(new Error(`MCP transport close timed out after ${timeout}ms`)),
					{ once: true },
				)
			}),
		])
	}

	// The retained close finally answered, possibly long after its caller stopped waiting for it,
	// and only it can say what happened: a close that RESOLVED ended the connection, so the claim it
	// left standing is discharged here and the next `connect` may open; one that REJECTED ended
	// nothing, so the claim stays owed and the next caller issues a fresh `close()` rather than
	// joining a dead one. Nothing can have re-claimed the connection meanwhile — opening requires no
	// standing claim, and while this close runs the claim is either held or held open by a published
	// teardown — so the discharge can only ever clear the claim this close belonged to.
	#discharge(closed: boolean): void {
		this.#closing = undefined
		if (closed) this.#owner = undefined
	}

	async #initialize(generation: number, version: MCPVersion): Promise<void> {
		const result = await this.#request(
			'initialize',
			{
				protocolVersion: version,
				capabilities: {},
				clientInfo: this.#identity,
			},
			this.#timeout,
		)
		const protocol = isRecord(result) ? result['protocolVersion'] : undefined
		if (protocol === undefined) {
			throw new Error('MCP server returned no protocol version')
		}
		if (!isString(protocol)) {
			throw new Error('MCP server returned a malformed protocol version')
		}
		if (!isMCPVersion(protocol) || inferEra(protocol) !== 'legacy') {
			throw new Error(`MCP server negotiated unsupported protocol version '${protocol}'`)
		}
		// Two re-asks, asking different questions: the first keeps a superseded attempt from
		// writing to a transport a `disconnect` is already closing, the second keeps it from
		// installing after that write. Install only after the handshake's last wire write
		// lands: a failed notification must leave nothing behind for the rejecting
		// `connect()` to strand.
		if (generation !== this.#generation) throw new Error('MCP client disconnected')
		// This notification carries no id, so it creates no `#pending` entry and no deadline
		// watches it: a peer that accepts the write and never answers would hold this attempt
		// for the client's whole life, and a teardown's drain has nothing to settle. Racing the
		// supersession signal ends the WAIT, never the write — the write may still land in the
		// background, and the re-ask below is what decides this attempt's outcome. `race` keeps a
		// handler on both sides, so a write that fails after being raced away rejects nothing
		// unhandled.
		await Promise.race([
			this.#transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' }),
			this.#supersession.promise,
		])
		if (generation !== this.#generation) throw new Error('MCP client disconnected')
		this.#version = protocol
		this.#era = 'legacy'
		this.#connected = true
		this.#emitter.emit('connect')
	}

	#timeoutRequest(id: JSONRPCId, method: string, timeout: number): void {
		this.#settle(id, new Error(`MCP request '${method}' timed out after ${timeout}ms`), true)
	}

	// The caller withdrew from ONE request. Two things happen and neither is the other's
	// precondition: the caller stops waiting, always, on every carrier; and the peer is TOLD,
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

	#settle(id: JSONRPCId, value: unknown, failed: boolean): void {
		const pending = this.#pending.get(id)
		if (pending === undefined) return
		this.#pending.delete(id)
		if (pending.deadline !== undefined && pending.timeout !== undefined) {
			pending.deadline.removeEventListener('abort', pending.timeout)
		}
		// The caller's signal is the CALLER's and outlives this request — one controller may be
		// driving several calls — so its listener is removed rather than left to `once`. The
		// progress handler needs no line here: it lives on the entry that was just dropped.
		if (pending.signal !== undefined && pending.abort !== undefined) {
			pending.signal.removeEventListener('abort', pending.abort)
		}
		if (failed) pending.reject(value)
		else pending.resolve(value)
	}
}
