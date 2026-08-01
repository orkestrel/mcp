import type { EmitterInterface } from '@orkestrel/emitter'
import type {
	JSONRPCRequest,
	JSONRPCResponse,
	MCPElicitation,
	MCPCallResult,
	MCPDispatchOptions,
	MCPIdentity,
	MCPMethodManagerInterface,
	MCPServerEventMap,
	MCPServerInterface,
	MCPServerOptions,
	MCPStream,
	MCPTextStream,
	SubscriptionFilter,
} from './types.js'
import { Emitter } from '@orkestrel/emitter'
import { isRecord, isString } from '@orkestrel/contract'
import { signToken, verifyToken } from '@orkestrel/server'
import {
	DEFAULT_MCP_CACHE_TTL,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_METHOD_NOT_FOUND,
	JSONRPC_PARSE_ERROR,
	MCP_META_SERVER,
	MCP_MISSING_CAPABILITY,
	MCP_UNSUPPORTED_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
} from './constants.js'
import {
	buildCallResult,
	buildDiscoverResult,
	buildInitializeResult,
	buildJSONRPCError,
	buildJSONRPCResult,
	buildModernResult,
	buildSubscriptionAcknowledgement,
	buildSubscriptionFilter,
	buildSubscriptionResult,
	buildToolDescriptors,
	matchesSubscriptionNotification,
	serializeStream,
	stampSubscriptionNotification,
} from './helpers.js'
import { inferEra } from './inferers.js'
import { MCPMethodManager } from './MCPMethodManager.js'
import { parseJSONRPCMessage, parseMCPInputState, parseRequestContext } from './parsers.js'
import {
	isElicitRequestFormParams,
	isElicitResult,
	isFormElicitationSupported,
	isModernRequest,
	isSubscriptionFilter,
} from './validators.js'

/**
 * A transport-agnostic Model Context Protocol server — dispatches JSON-RPC 2.0
 * requests over a live {@link ToolManagerInterface}, with NO transport coupling.
 *
 * @remarks
 * - **Two entry points.** `dispatch(request)` runs an already-parsed request and
 *   resolves a {@link JSONRPCResponse} — or `undefined` for a NOTIFICATION (a
 *   request with no `id`). `handle(message)` is the string boundary: it
 *   `JSON.parse`s the raw message (a failure → a `-32700` response), narrows it to
 *   a request (a non-request → a `-32600` response), dispatches, and serializes the
 *   response back to a string (`undefined` for a notification).
 * - **Dual-era dispatch.** A request carrying the reserved modern version key uses
 *   modern metadata validation and the registered method seam. Every other request
 *   uses the legacy `initialize` / `ping` / `tools/list` / `tools/call` switch. The
 *   wire era is selected per request and never stored.
 * - **One modern seam.** `server/discover`, `tools/list`, `tools/call`, and
 *   `subscriptions/listen` are
 *   registered on `methods` at construction and resolved from it on every dispatch —
 *   the same path a later method or a consumer's own takes, with an unregistered
 *   method still answering `-32601`.
 * - **Provider-agnostic.** Imports only core siblings — JSON-RPC + the tool registry,
 *   no HTTP, no model. Wire fields are narrowed via the contracts guards (no `as`).
 * - **Observable (§13).** The owned `emitter` fires `request` at the top of every
 *   dispatch; the emitter isolates a listener throw and routes it to its `error` handler
 *   (the `error` option), so a listener throw can never escape the dispatch.
 *
 * @example
 * ```ts
 * const tools = createToolManager()
 * tools.add(createTool({ name: 'add', execute: (a) => Number(a.x) + Number(a.y) }))
 * const server = new MCPServer({ identity: { name: 'demo', version: '1.0.0' }, tools })
 * await server.handle('{"jsonrpc":"2.0","method":"ping","id":1}') // '{"jsonrpc":"2.0","id":1,"result":{}}'
 * ```
 */
export class MCPServer implements MCPServerInterface {
	readonly #emitter: Emitter<MCPServerEventMap>
	readonly #options: MCPServerOptions
	readonly #methods: MCPMethodManager

	constructor(options: MCPServerOptions) {
		this.#emitter = new Emitter<MCPServerEventMap>({
			...(options.on !== undefined ? { on: options.on } : {}),
			...(options.error !== undefined ? { error: options.error } : {}),
		})
		this.#options = options
		this.#methods = new MCPMethodManager()
		this.#register()
	}

	get emitter(): EmitterInterface<MCPServerEventMap> {
		return this.#emitter
	}

	get identity(): MCPIdentity {
		return this.#options.identity
	}

	get methods(): MCPMethodManagerInterface {
		return this.#methods
	}

	async dispatch(
		request: JSONRPCRequest,
		options: MCPDispatchOptions = {},
	): Promise<JSONRPCResponse | MCPStream | undefined> {
		const id = request.id ?? null
		const modern = isModernRequest(request)
		const era = modern ? 'modern' : 'legacy'
		this.#emitter.emit('request', request.method, id, era)
		// JSON-RPC: a request with NO `id` is a NOTIFICATION — it is handled (the
		// `request` event already fired) but NEVER produces a response, whatever its
		// method (`notifications/initialized`, a fire-and-forget `ping`, an unknown
		// method — all silent). So short-circuit here, and the branches below only ever
		// run for an id-bearing request that expects a reply.
		if (request.id === undefined) {
			return undefined
		}
		return modern ? this.#modern(request, id, options) : this.#legacy(request, id)
	}

	async handle(
		message: string,
		options?: MCPDispatchOptions,
	): Promise<string | MCPTextStream | undefined> {
		let parsed: unknown
		try {
			parsed = JSON.parse(message)
		} catch {
			return JSON.stringify(buildJSONRPCError(null, JSONRPC_PARSE_ERROR, 'Parse error'))
		}
		const decoded = parseJSONRPCMessage(parsed)
		// Only a REQUEST is dispatchable — a response (or any non-message) is invalid input.
		if (decoded === undefined || !('method' in decoded)) {
			return JSON.stringify(buildJSONRPCError(null, JSONRPC_INVALID_REQUEST, 'Invalid Request'))
		}
		const answer = await this.dispatch(decoded, options)
		if (answer === undefined) return undefined
		// The ONE narrowing point (§4.3): a held-open answer becomes the string mirror of
		// itself, so the string boundary stays a mirror of the typed core.
		return Symbol.asyncIterator in answer ? serializeStream(answer) : JSON.stringify(answer)
	}

	async #legacy(request: JSONRPCRequest, id: string | number | null): Promise<JSONRPCResponse> {
		switch (request.method) {
			case 'initialize': {
				const requested = request.params?.['protocolVersion']
				return buildJSONRPCResult(
					id,
					buildInitializeResult(
						this.#options.identity.name,
						this.#options.identity.version,
						isString(requested) ? requested : undefined,
					),
				)
			}
			case 'ping':
				return buildJSONRPCResult(id, {})
			case 'tools/list':
				return buildJSONRPCResult(id, {
					tools: buildToolDescriptors(this.#options.tools),
				})
			case 'tools/call': {
				const result = await this.#runTool(request, id)
				return 'jsonrpc' in result ? result : buildJSONRPCResult(id, result)
			}
			default:
				return buildJSONRPCError(
					id,
					JSONRPC_METHOD_NOT_FOUND,
					`Method not found: ${request.method}`,
				)
		}
	}

	// Register the built-in modern methods on the seam `#modern` resolves from — the
	// point of the seam is that these four are not special: they are the first four
	// registrations, and a later one (or a consumer's) replaces or joins them in place.
	#register(): void {
		this.#methods.add('server/discover', (request) => this.#discover(request))
		this.#methods.add('tools/list', (request) => this.#list(request))
		this.#methods.add('tools/call', (request, options) => this.#call(request, options))
		this.#methods.add('subscriptions/listen', (request, options) =>
			this.#subscribe(request, options),
		)
	}

	async #modern(
		request: JSONRPCRequest,
		id: string | number | null,
		options: MCPDispatchOptions,
	): Promise<JSONRPCResponse | MCPStream | undefined> {
		const context = parseRequestContext(request)
		if (context === undefined) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: malformed modern request metadata',
			)
		}
		if (inferEra(context.version) === undefined) {
			return buildJSONRPCError(
				id,
				MCP_UNSUPPORTED_VERSION,
				`Unsupported protocol version: ${context.version}`,
				{ supported: SUPPORTED_PROTOCOL_VERSIONS, requested: context.version },
			)
		}
		const handler = this.#methods.method(request.method)
		if (handler === undefined) {
			return buildJSONRPCError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${request.method}`)
		}
		return handler(request, options)
	}

	// The built-in `server/discover` handler.
	async #discover(request: JSONRPCRequest): Promise<JSONRPCResponse> {
		return buildJSONRPCResult(request.id ?? null, buildDiscoverResult(this.#options))
	}

	// The built-in modern `tools/list` handler — a cacheable result, so it carries both
	// schema-coupled cache stamps.
	async #list(request: JSONRPCRequest): Promise<JSONRPCResponse> {
		return buildJSONRPCResult(
			request.id ?? null,
			buildModernResult(
				{ tools: buildToolDescriptors(this.#options.tools) },
				this.#options.identity,
				this.#options.cache?.ttl ?? DEFAULT_MCP_CACHE_TTL,
				this.#options.cache?.scope,
			),
		)
	}

	// The built-in modern `tools/call` handler — stamped, and NOT cacheable, so it
	// carries no cache fields.
	async #call(request: JSONRPCRequest, options: MCPDispatchOptions = {}): Promise<JSONRPCResponse> {
		const id = request.id ?? null
		const input = await this.#input(request, options)
		if (input !== undefined) return input
		const result = await this.#runTool(request, id)
		return 'jsonrpc' in result
			? result
			: buildJSONRPCResult(id, buildModernResult(result, this.#options.identity))
	}

	// The built-in modern `tools/call` input mechanism. It is deliberately reachable
	// only from `#call`: the other modern handlers cannot produce `input_required`.
	async #input(
		request: JSONRPCRequest,
		options: MCPDispatchOptions,
	): Promise<JSONRPCResponse | undefined> {
		const configured = this.#options.input
		if (configured === undefined) return undefined
		const id = request.id
		if (id === undefined) return undefined
		const params = request.params
		const name = params?.['name']
		if (!isString(name)) return undefined
		const rawArguments = params?.['arguments']
		const args = isRecord(rawArguments) ? rawArguments : {}
		const requestState = params?.['requestState']
		const inputResponses = params?.['inputResponses']
		if (requestState === undefined && inputResponses === undefined) {
			const elicitation = await configured.elicit({ request, name, arguments: args }, options)
			if (elicitation === undefined) return undefined
			const principal = await configured.principal(request)
			return this.#required(request, name, elicitation, principal)
		}
		if (!isString(requestState) || !isRecord(inputResponses)) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: `inputResponses` and `requestState` are required together',
			)
		}
		const verified = await verifyToken(requestState, configured.secret)
		const state = parseMCPInputState(verified)
		const principal = await configured.principal(request)
		if (
			state === undefined ||
			state.principal !== principal ||
			state.ttl !== configured.ttl ||
			state.origin === id ||
			state.name !== name ||
			!Object.hasOwn(inputResponses, state.key)
		) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: request state could not be verified for this retry',
			)
		}
		const response = inputResponses[state.key]
		if (!isElicitResult(response)) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: the elicitation response is missing or malformed',
			)
		}
		const elicitation = await configured.elicit(
			{
				request,
				name,
				arguments: args,
				response,
				...(state.state !== undefined ? { state: state.state } : {}),
			},
			options,
		)
		return elicitation === undefined
			? undefined
			: this.#required(request, name, elicitation, principal)
	}

	// Build one form-mode round and seal the call-in-hand state. The random map key is
	// minted here, never accepted from the consumer, and is carried inside the HMAC payload.
	async #required(
		request: JSONRPCRequest,
		name: string,
		elicitation: MCPElicitation,
		principal: string,
	): Promise<JSONRPCResponse> {
		const id = request.id
		if (id === undefined) {
			return buildJSONRPCError(null, JSONRPC_INVALID_REQUEST, 'Invalid Request')
		}
		const context = parseRequestContext(request)
		if (context === undefined || !isFormElicitationSupported(context.capabilities)) {
			return buildJSONRPCError(
				id,
				MCP_MISSING_CAPABILITY,
				'Server requires the elicitation capability for this request',
				{ requiredCapabilities: { elicitation: {} } },
			)
		}
		if (
			!isElicitRequestFormParams(elicitation.request) ||
			principal.length === 0 ||
			!Number.isFinite(this.#options.input?.ttl) ||
			(this.#options.input?.ttl ?? 0) <= 0
		) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: elicitation policy returned an invalid form or signing context',
			)
		}
		const configured = this.#options.input
		if (configured === undefined) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: input is not configured',
			)
		}
		const key = crypto.randomUUID()
		const protectedState = JSON.stringify({
			principal,
			ttl: configured.ttl,
			origin: id,
			key,
			name,
			...(elicitation.state !== undefined ? { state: elicitation.state } : {}),
		})
		const requestState = await signToken(protectedState, {
			secret: configured.secret,
			ttl: configured.ttl,
		})
		return buildJSONRPCResult(id, {
			resultType: 'input_required',
			inputRequests: {
				[key]: {
					method: 'elicitation/create',
					params: { ...elicitation.request, mode: 'form' },
				},
			},
			requestState,
			_meta: { [MCP_META_SERVER]: this.#options.identity },
		})
	}

	// The built-in modern `subscriptions/listen` handler validates the client's filter,
	// then returns the event-driven generator that owns acknowledgement and closure order.
	async #subscribe(
		request: JSONRPCRequest,
		options: MCPDispatchOptions,
	): Promise<JSONRPCResponse | MCPStream> {
		const id = request.id
		if (id === undefined) {
			return buildJSONRPCError(null, JSONRPC_INVALID_REQUEST, 'Invalid Request')
		}
		const requested = request.params?.['notifications']
		if (!isSubscriptionFilter(requested)) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: a valid `notifications` filter is required',
			)
		}
		return this.#subscription(requested, id, options)
	}

	async *#subscription(
		requested: SubscriptionFilter,
		id: string | number,
		options: MCPDispatchOptions,
	): MCPStream {
		const configured = this.#options.subscription
		const notifications = buildSubscriptionFilter(requested, configured?.notifications ?? {})
		yield buildSubscriptionAcknowledgement(notifications, id)
		if (configured !== undefined) {
			const source = await configured.listen(notifications, options)
			for await (const notification of source) {
				if (matchesSubscriptionNotification(notification, notifications)) {
					yield stampSubscriptionNotification(notification, id)
				}
			}
		}
		return buildSubscriptionResult(id, this.#options.identity)
	}

	// Run a `tools/call`: narrow `params.name` (string) + `params.arguments` (record,
	// default `{}`) with no `as`, execute the tool (the manager isolates a throw into
	// `success: false`), and map the result to an MCP tool-call result. Shared by both
	// eras — only the result STAMPING differs between them.
	async #runTool(
		request: JSONRPCRequest,
		id: string | number | null,
	): Promise<MCPCallResult | JSONRPCResponse> {
		const params = request.params
		const name = params?.['name']
		if (!isString(name)) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: a string `name` is required',
			)
		}
		const rawArguments = params?.['arguments']
		const args = isRecord(rawArguments) ? rawArguments : {}
		const callId = request.id === undefined ? crypto.randomUUID() : String(request.id)
		const result = await this.#options.tools.execute({ id: callId, name, arguments: args })
		return buildCallResult(result)
	}
}
