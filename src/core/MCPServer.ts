import type { EmitterInterface } from '@orkestrel/emitter'
import type { ToolCall } from '@orkestrel/tool'
import type { JSONValue } from '@orkestrel/contract'
import type {
	JSONRPCErrorResponse,
	JSONRPCId,
	JSONRPCInvocation,
	JSONRPCNotification,
	JSONRPCRequest,
	JSONRPCResponse,
	MCPCallResult,
	MCPCompletion,
	MCPCompletionManagerInterface,
	MCPCompletionParams,
	MCPDispatchOptions,
	MCPIdentity,
	MCPInputRequestMap,
	MCPInputResponse,
	MCPInputResponseMap,
	MCPInputResult,
	MCPInputRound,
	MCPLimitOptions,
	MCPListResult,
	MCPMethodManagerInterface,
	MCPMethodOptions,
	MCPPaginationParams,
	MCPPromptGetParams,
	MCPPromptGetResult,
	MCPPromptManagerInterface,
	MCPPromptPage,
	MCPRequestContext,
	MCPResourceManagerInterface,
	MCPResourcePage,
	MCPResourceReadParams,
	MCPResourceReadResult,
	MCPResourceTemplatePage,
	MCPServerEventMap,
	MCPServerInterface,
	MCPServerOptions,
	MCPStream,
	MCPStreamControllerInterface,
	MCPSubscriptionFilter,
	MCPTaskContext,
	MCPTaskManagerInterface,
	MCPTaskResult,
	MCPTextStreamControllerInterface,
} from './types.js'
import { Emitter } from '@orkestrel/emitter'
import {
	isJSONValue,
	isRecord,
	isString,
	isUndefined,
	parseJSON,
	sanitizeBudget,
} from '@orkestrel/contract'
import { snapshotJSON, snapshotToolResult } from './cloners.js'
import {
	DEFAULT_MCP_CACHE_TTL,
	DEFAULT_MCP_LIMITS,
	EMPTY_MCP_ARGUMENTS,
	JSONRPC_INTERNAL_ERROR,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_METHOD_NOT_FOUND,
	JSONRPC_PARSE_ERROR,
	MCP_EXTENSION_TASKS,
	MCP_META_SERVER,
	MCP_MISSING_CAPABILITY,
	MCP_UNSUPPORTED_VERSION,
	SUPPORTED_MODERN_PROTOCOL_VERSIONS,
} from './constants.js'
import {
	buildDiscoverResult,
	buildJSONRPCError,
	buildJSONRPCResult,
	buildMethodOptions,
	buildModernResult,
	buildSubscriptionAcknowledgement,
	buildSubscriptionFilter,
	buildSubscriptionResult,
	buildToolCall,
	buildToolDescriptors,
	computeMissingCapabilities,
	digestJSON,
	isTaskSupported,
	matchesSubscriptionNotification,
	serializeJSON,
	stampSubscriptionNotification,
} from './helpers.js'
import { MCPMethodManager } from './MCPMethodManager.js'
import { MCPProgressReporter } from './MCPProgressReporter.js'
import { MCPStreamController } from './MCPStreamController.js'
import { MCPTextStreamController } from './MCPTextStreamController.js'
import { inferRequestEra } from './inferers.js'
import { parseJSONRPCMessage, parseMCPInputState, parseRequestContext } from './parsers.js'
import {
	isAbsoluteURI,
	isBoundedJSON,
	isBoundedString,
	isJSONRPCNotification,
	isMCPCallResult,
	isMCPCompletion,
	isMCPCompletionParams,
	isMCPInputRequestMap,
	isMCPInputResponse,
	isMCPInputResult,
	isMCPModernVersion,
	isModernRequest,
	isMCPPaginationParams,
	isMCPPromptGetResult,
	isMCPPromptPage,
	isMCPResourceContents,
	isMCPResourcePage,
	isMCPResourceTemplatePage,
	isMCPStringArguments,
	isMCPSubscriptionFilter,
	isMCPTaskDetail,
	isMCPTaskResult,
} from './validators.js'

/**
 * A transport-agnostic Model Context Protocol server — dispatches JSON-RPC 2.0
 * requests over a live {@link ToolManagerInterface}, with NO transport coupling.
 *
 * @remarks
 * - **`dispatch` and `handle`.** `dispatch(invocation)` runs an already-parsed invocation and
 *   resolves a {@link JSONRPCResponse} for a request — or `undefined` for a
 *   {@link JSONRPCNotification}, which carries no `id` and is answered by nothing.
 *   `handle(message)` is the string boundary: it
 *   `JSON.parse`s the raw message (a failure → a `-32700` response), narrows it to
 *   an invocation (a non-invocation → a `-32600` response, with the unreadable `id`
 *   OMITTED rather than nulled), dispatches, and serializes the
 *   response back to a string (`undefined` for a notification).
 * - **One modern seam.** `server/discover`, `tools/list`, `tools/call`, and
 *   `subscriptions/listen` are always registered; `resources/*`, `prompts/*`, and
 *   `completion/complete` register independently when their respective host ports are
 *   configured — plus `tasks/get`, `tasks/update`, and `tasks/cancel` when the stable Tasks
 *   extension is configured — and every method is resolved from the registry on
 *   every dispatch: the same path a later method or a consumer's own takes, with an
 *   unregistered method still answering `-32601`.
 * - **Provider-agnostic.** Imports only core siblings — JSON-RPC + the tool registry,
 *   no HTTP, no model. Wire fields are narrowed with the contract guards (no `as`).
 * - **Observable.** The owned `emitter` fires `request` at the top of every
 *   dispatch; the emitter isolates a listener throw and routes it to its `error` handler
 *   (the `error` option), so a listener throw can never escape the dispatch.
 *
 * @example
 * ```ts
 * const tools = createToolManager()
 * tools.add(createTool({ name: 'add', execute: (a) => Number(a.x) + Number(a.y) }))
 * const server = new MCPServer({ identity: { name: 'demo', version: '1.0.0' }, tools })
 * await server.handle('{"jsonrpc":"2.0","method":"server/discover","id":1,"params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}')
 * // The result advertises only `2026-07-28`; wrap with `createMCPLegacy` to serve initialize or ping.
 * ```
 */
export class MCPServer implements MCPServerInterface {
	readonly #emitter: Emitter<MCPServerEventMap>
	readonly #options: MCPServerOptions
	readonly #methods: MCPMethodManager
	readonly #limits: Required<MCPLimitOptions>
	#subscriptions = 0

	constructor(options: MCPServerOptions) {
		this.#emitter = new Emitter<MCPServerEventMap>({
			...(options.on !== undefined ? { on: options.on } : {}),
			...(options.error !== undefined ? { error: options.error } : {}),
		})
		this.#options = options
		// Frozen because it is PUBLISHED (`limit`): the boundary checks below and whatever
		// stands in front of this server read one object, so a consumer cannot move a bound
		// out from under a check that already ran.
		this.#limits = Object.freeze({
			message: sanitizeBudget(options.limit?.message, DEFAULT_MCP_LIMITS.message),
			metadata: sanitizeBudget(options.limit?.metadata, DEFAULT_MCP_LIMITS.metadata),
			keys: sanitizeBudget(options.limit?.keys, DEFAULT_MCP_LIMITS.keys),
			state: sanitizeBudget(options.limit?.state, DEFAULT_MCP_LIMITS.state),
			content: sanitizeBudget(options.limit?.content, DEFAULT_MCP_LIMITS.content),
			subscriptions: sanitizeBudget(options.limit?.subscriptions, DEFAULT_MCP_LIMITS.subscriptions),
			depth: sanitizeBudget(options.limit?.depth, DEFAULT_MCP_LIMITS.depth),
		})
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

	get limit(): Required<MCPLimitOptions> {
		return this.#limits
	}

	dispatch(
		request: JSONRPCRequest,
		options?: MCPDispatchOptions,
	): Promise<JSONRPCResponse | MCPStreamControllerInterface>
	dispatch(notification: JSONRPCNotification, options?: MCPDispatchOptions): Promise<undefined>
	dispatch(
		invocation: JSONRPCInvocation,
		options?: MCPDispatchOptions,
	): Promise<JSONRPCResponse | MCPStreamControllerInterface | undefined>
	async dispatch(
		invocation: JSONRPCInvocation,
		options: MCPDispatchOptions = {},
	): Promise<JSONRPCResponse | MCPStreamControllerInterface | undefined> {
		const decoded = parseJSONRPCMessage(invocation, {
			bytes: this.#limits.message,
			depth: this.#limits.depth,
		})
		if (decoded === undefined || !('method' in decoded)) {
			return buildJSONRPCError(undefined, JSONRPC_INVALID_REQUEST, 'Invalid Request')
		}
		return this.#dispatch(decoded, options)
	}

	// The ONE ingress. It resolves the caller's options into the options every method,
	// input, principal, and subscription producer downstream observes, so the
	// request's cancellation signal is decided here and nowhere else — and it is the ONE
	// wrapping seam too: whatever a built-in or a consumer's own method produces, the stream
	// that leaves here is controlled, so cancellation is arbitrated in one place rather than
	// per producer.
	async #dispatch(
		invocation: JSONRPCInvocation,
		options: MCPDispatchOptions,
	): Promise<JSONRPCResponse | MCPStreamControllerInterface | undefined> {
		// The era is READ off the invocation rather than assumed: an invocation of either
		// published wire shape reaches this ingress (`#modern` refuses the one it cannot
		// dispatch, further down), so an observer partitioning by era sees what arrived instead
		// of what this seam expects. One derivation, `inferRequestEra`, shared with the HTTP
		// ingress that routes on the same fact.
		this.#emitter.emit('request', invocation.method, invocation.id, inferRequestEra(invocation))
		// A NOTIFICATION is handled (the `request` event already fired) but NEVER produces
		// a response, whatever its method (`notifications/initialized`, a fire-and-forget
		// `ping`, an unknown method — all silent). So short-circuit here, and the branches
		// below only ever run for a request that expects a reply.
		if (invocation.id === undefined) {
			return undefined
		}
		const id = invocation.id
		const metadata = invocation.params?.['_meta']
		if (
			metadata !== undefined &&
			!isBoundedJSON(metadata, {
				bytes: this.#limits.metadata,
				keys: this.#limits.keys,
				depth: this.#limits.depth,
			})
		) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: `_meta` exceeds the configured limit or contains an unsafe value',
			)
		}
		const closure = new AbortController()
		const resolved = buildMethodOptions(options, closure.signal)
		try {
			const answer = await this.#modern(invocation, resolved)
			return Symbol.asyncIterator in answer
				? new MCPStreamController(answer, resolved.signal, closure)
				: answer
		} catch (error) {
			return this.#contain(error, id)
		}
	}

	async handle(
		message: string,
		options?: MCPDispatchOptions,
	): Promise<string | MCPTextStreamControllerInterface | undefined> {
		if (!isBoundedString(message, this.#limits.message)) {
			return JSON.stringify(buildJSONRPCError(undefined, JSONRPC_PARSE_ERROR, 'Parse error'))
		}
		const parsed = parseJSON(message)
		if (parsed === undefined) {
			return JSON.stringify(buildJSONRPCError(undefined, JSONRPC_PARSE_ERROR, 'Parse error'))
		}
		const decoded = parseJSONRPCMessage(parsed, {
			bytes: this.#limits.message,
			depth: this.#limits.depth,
		})
		// Only an INVOCATION is dispatchable — a response (or any non-message) is invalid input.
		if (decoded === undefined || !('method' in decoded)) {
			return JSON.stringify(
				buildJSONRPCError(undefined, JSONRPC_INVALID_REQUEST, 'Invalid Request'),
			)
		}
		const answer = await this.#dispatch(decoded, options ?? {})
		if (answer === undefined) return undefined
		// The ONE narrowing point: a held-open answer becomes the string mirror of
		// itself, so the string boundary stays a mirror of the typed core.
		return Symbol.asyncIterator in answer
			? new MCPTextStreamController(answer)
			: JSON.stringify(answer)
	}

	// Register the built-in modern methods on the seam `#modern` resolves from — the
	// point of the seam is that they are not special: they are the first registrations,
	// and a later one (or a consumer's) replaces or joins them in place. The conditional
	// block at the end is the same statement about an OPT-IN surface: an extension that
	// was not configured adds no registration, so it is absent rather than refused.
	//
	// The seam carries the REQUEST arm, so no registration narrows anything: dispatch
	// short-circuits a notification before this registry is read at all, so every handler here
	// — and every handler a consumer adds — is invoked only for a call that expects an answer.
	// Each of these registrations once opened with an `invocation.id === undefined`
	// ternary answering `undefined` for a case that cannot arrive; the seam's own type now says
	// that, so the guards are gone rather than restated per member.
	//
	// A registration BINDS the resolved options only where it spends them. `MCPMethodHandler`
	// declares both parameters, and a handler that takes fewer still satisfies it, so the two
	// live registry reads — `server/discover` and `tools/list`, neither of which awaits
	// anything and so has no cancellation point to spend a signal on — bind the request alone
	// rather than an unused `_options` the seam does not require.
	#register(): void {
		this.#methods.add('server/discover', async (request) => this.#discover(request))
		this.#methods.add('tools/list', async (request) => this.#list(request))
		this.#methods.add('tools/call', async (request, options) => this.#call(request, options))
		this.#methods.add('subscriptions/listen', async (request, options) =>
			this.#subscribe(request, options),
		)
		const resources = this.#options.resources
		if (resources !== undefined) {
			this.#methods.add('resources/list', async (request, options) =>
				this.#resources(request, resources, options),
			)
			this.#methods.add('resources/read', async (request, options) =>
				this.#read(request, resources, options),
			)
			this.#methods.add('resources/templates/list', async (request, options) =>
				this.#templates(request, resources, options),
			)
		}
		const prompts = this.#options.prompts
		if (prompts !== undefined) {
			this.#methods.add('prompts/list', async (request, options) =>
				this.#prompts(request, prompts, options),
			)
			this.#methods.add('prompts/get', async (request, options) =>
				this.#prompt(request, prompts, options),
			)
		}
		const completion = this.#options.completion
		if (completion !== undefined) {
			this.#methods.add('completion/complete', async (request, options) =>
				this.#suggest(request, completion, options),
			)
		}
		// The stable Tasks extension's methods register ONLY when a consumer configured
		// the extension. An unconfigured server never registers them, so they resolve to nothing
		// and the modern branch answers `-32601` through the same unregistered-method path any
		// other unknown method takes — the honest reply from a server that does not implement an
		// optional extension, and the reason an unconfigured server is unchanged by all of this.
		//
		// The manager is captured HERE rather than read per request, because the registration is
		// already a snapshot of construction-time configuration: a handler that exists at all is
		// proof `task` was configured when this server was built, and reading a second, later
		// value would let the two disagree.
		const configured = this.#options.task
		if (configured === undefined) return
		const tasks = configured.tasks
		this.#methods.add('tasks/get', async (request, options) => this.#task(request, tasks, options))
		this.#methods.add('tasks/update', async (request, options) =>
			this.#update(request, tasks, options),
		)
		this.#methods.add('tasks/cancel', async (request, options) =>
			this.#abort(request, tasks, options),
		)
	}

	async #modern(
		request: JSONRPCRequest,
		options: MCPMethodOptions,
	): Promise<JSONRPCResponse | MCPStream> {
		const id = request.id
		const method = request.method
		if (!isModernRequest(request)) {
			if (this.#methods.method(method) === undefined) {
				return buildJSONRPCError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`)
			}
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: request declares no protocol version',
			)
		}
		const context = parseRequestContext(request, {
			bytes: this.#limits.message,
			depth: this.#limits.depth,
		})
		if (context === undefined) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: malformed modern request metadata',
			)
		}
		if (!isMCPModernVersion(context.version)) {
			return buildJSONRPCError(
				id,
				MCP_UNSUPPORTED_VERSION,
				`Unsupported protocol version: ${context.version}`,
				{ supported: SUPPORTED_MODERN_PROTOCOL_VERSIONS, requested: context.version },
			)
		}
		// No blanket rejection of a continuation carrier on a non-tool method. Core owns the
		// carrier's SHAPE, BOUNDS, and OWNERSHIP for every invocation — a malformed one never
		// gets this far — and the continuation SEMANTICS belong to whoever registered the
		// method. A `prompts/get` this server refused to let a consumer implement was a limit
		// core had no standing to impose.
		const handler = this.#methods.method(request.method)
		if (handler === undefined) {
			return buildJSONRPCError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${request.method}`)
		}
		const answer = await handler(request, options)
		// A registered method OWES this request an answer, and the seam's type says so — but the
		// registry is open, so the one thing this server cannot assume is that a consumer's
		// handler was typechecked against it. An absent answer is contained here rather than
		// forwarded, because forwarding it resolves `dispatch(request)` as `undefined` against an
		// overload that promises a response, and a transport with nothing to write holds the peer
		// until its own deadline expires. So it is a FAULT, reported once on `error` like every
		// other contained fault and answered with the same detail-free `-32603` envelope.
		if (answer === undefined) {
			return this.#contain(
				new Error(`MCP method '${request.method}' resolved no answer for a request`),
				id,
			)
		}
		return answer
	}

	// The built-in `server/discover` handler: a live read of server configuration with no
	// await, so it has no cancellation point to spend the request's signal on and takes no
	// options. The uniform seam is the registration above, not this private leaf.
	async #discover(request: JSONRPCRequest): Promise<JSONRPCResponse> {
		return buildJSONRPCResult(request.id, buildDiscoverResult(this.#options))
	}

	// The built-in modern `tools/list` handler — a cacheable result, so it carries both
	// schema-coupled cache stamps. It takes no options for the same reason `#discover` takes
	// none: a live registry read with no await to cancel.
	async #list(request: JSONRPCRequest): Promise<JSONRPCResponse> {
		const result: MCPListResult = buildModernResult(
			{ tools: buildToolDescriptors(this.#options.tools) },
			this.#options.identity,
			this.#options.cache?.ttl ?? DEFAULT_MCP_CACHE_TTL,
			this.#options.cache?.scope,
		)
		return buildJSONRPCResult(request.id, result)
	}

	// The built-in modern `resources/list` handler — a cacheable paged projection over the
	// consumer's resource manager, so the page it returns carries both cache stamps. The page
	// is owned before it is read: a manager is consumer-written, so an oversized or malformed
	// one is answered `-32603` rather than forwarded.
	async #resources(
		request: JSONRPCRequest,
		manager: MCPResourceManagerInterface,
		options: MCPMethodOptions,
	): Promise<JSONRPCResponse> {
		if (!isMCPPaginationParams(request.params ?? {})) {
			return buildJSONRPCError(
				request.id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: `cursor` must be a string when present',
			)
		}
		const cursor = request.params?.['cursor']
		const pagination: MCPPaginationParams = isString(cursor) ? { cursor } : {}
		const page = await manager.resources(pagination, options)
		const captured = snapshotJSON(page, {
			bytes: this.#limits.content,
			keys: this.#limits.keys,
			depth: this.#limits.depth,
		})
		if (captured === undefined || !isMCPResourcePage(captured[0])) {
			return buildJSONRPCError(
				request.id,
				JSONRPC_INTERNAL_ERROR,
				'Server resource manager returned an invalid or oversized page',
			)
		}
		const owned: MCPResourcePage = captured[0]
		const result = buildModernResult(
			{
				resources: owned.resources,
				...(owned.nextCursor === undefined ? {} : { nextCursor: owned.nextCursor }),
			},
			this.#options.identity,
			this.#options.cache?.ttl ?? DEFAULT_MCP_CACHE_TTL,
			this.#options.cache?.scope,
		)
		return buildJSONRPCResult(request.id, result)
	}

	async #read(
		request: JSONRPCRequest,
		manager: MCPResourceManagerInterface,
		options: MCPMethodOptions,
	): Promise<JSONRPCResponse> {
		const uri = request.params?.['uri']
		const inputResponses = request.params?.['inputResponses']
		const requestState = request.params?.['requestState']
		if (
			!isAbsoluteURI(uri) ||
			(!isUndefined(inputResponses) && !isRecord(inputResponses)) ||
			(!isUndefined(requestState) && !isBoundedString(requestState, this.#limits.state))
		) {
			return buildJSONRPCError(
				request.id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: `uri` is required and continuation fields must be valid when present',
			)
		}
		const params: MCPResourceReadParams = {
			uri,
			...(isRecord(inputResponses) ? { inputResponses } : {}),
			...(isString(requestState) ? { requestState } : {}),
		}
		const read = await manager.resource(params, options)
		if (read === undefined) {
			return buildJSONRPCError(request.id, JSONRPC_INVALID_PARAMS, `Resource not found: ${uri}`)
		}
		const captured = snapshotJSON(read, {
			bytes: this.#limits.content,
			keys: this.#limits.keys,
			depth: this.#limits.depth,
		})
		if (captured === undefined) {
			return buildJSONRPCError(
				request.id,
				JSONRPC_INTERNAL_ERROR,
				'Server resource manager returned invalid or oversized contents',
			)
		}
		if (isMCPInputResult(captured[0])) {
			const input: MCPInputResult = captured[0]
			return this.#forward(input, request)
		}
		if (
			!Array.isArray(captured[0]) ||
			!captured[0].every((entry) => isMCPResourceContents(entry))
		) {
			return buildJSONRPCError(
				request.id,
				JSONRPC_INTERNAL_ERROR,
				'Server resource manager returned invalid or oversized contents',
			)
		}
		const result: MCPResourceReadResult = buildModernResult(
			{ contents: captured[0] },
			this.#options.identity,
			this.#options.cache?.ttl ?? DEFAULT_MCP_CACHE_TTL,
			this.#options.cache?.scope,
		)
		return buildJSONRPCResult(request.id, result)
	}

	async #templates(
		request: JSONRPCRequest,
		manager: MCPResourceManagerInterface,
		options: MCPMethodOptions,
	): Promise<JSONRPCResponse> {
		if (!isMCPPaginationParams(request.params ?? {})) {
			return buildJSONRPCError(
				request.id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: `cursor` must be a string when present',
			)
		}
		const cursor = request.params?.['cursor']
		const pagination: MCPPaginationParams = isString(cursor) ? { cursor } : {}
		const page = await manager.templates(pagination, options)
		const captured = snapshotJSON(page, {
			bytes: this.#limits.content,
			keys: this.#limits.keys,
			depth: this.#limits.depth,
		})
		if (captured === undefined || !isMCPResourceTemplatePage(captured[0])) {
			return buildJSONRPCError(
				request.id,
				JSONRPC_INTERNAL_ERROR,
				'Server resource manager returned an invalid or oversized template page',
			)
		}
		const owned: MCPResourceTemplatePage = captured[0]
		const result = buildModernResult(
			{
				resourceTemplates: owned.resourceTemplates,
				...(owned.nextCursor === undefined ? {} : { nextCursor: owned.nextCursor }),
			},
			this.#options.identity,
			this.#options.cache?.ttl ?? DEFAULT_MCP_CACHE_TTL,
			this.#options.cache?.scope,
		)
		return buildJSONRPCResult(request.id, result)
	}

	async #prompts(
		request: JSONRPCRequest,
		manager: MCPPromptManagerInterface,
		options: MCPMethodOptions,
	): Promise<JSONRPCResponse> {
		if (!isMCPPaginationParams(request.params ?? {})) {
			return buildJSONRPCError(
				request.id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: `cursor` must be a string when present',
			)
		}
		const cursor = request.params?.['cursor']
		const pagination: MCPPaginationParams = isString(cursor) ? { cursor } : {}
		const page = await manager.prompts(pagination, options)
		const captured = snapshotJSON(page, {
			bytes: this.#limits.content,
			keys: this.#limits.keys,
			depth: this.#limits.depth,
		})
		if (captured === undefined || !isMCPPromptPage(captured[0])) {
			return buildJSONRPCError(
				request.id,
				JSONRPC_INTERNAL_ERROR,
				'Server prompt manager returned an invalid or oversized page',
			)
		}
		const owned: MCPPromptPage = captured[0]
		const result = buildModernResult(
			{
				prompts: owned.prompts,
				...(owned.nextCursor === undefined ? {} : { nextCursor: owned.nextCursor }),
			},
			this.#options.identity,
			this.#options.cache?.ttl ?? DEFAULT_MCP_CACHE_TTL,
			this.#options.cache?.scope,
		)
		return buildJSONRPCResult(request.id, result)
	}

	async #prompt(
		request: JSONRPCRequest,
		manager: MCPPromptManagerInterface,
		options: MCPMethodOptions,
	): Promise<JSONRPCResponse> {
		const name = request.params?.['name']
		const argumentsValue = request.params?.['arguments']
		const inputResponses = request.params?.['inputResponses']
		const requestState = request.params?.['requestState']
		if (
			!isString(name) ||
			(!isUndefined(argumentsValue) && !isMCPStringArguments(argumentsValue)) ||
			(!isUndefined(inputResponses) && !isRecord(inputResponses)) ||
			(!isUndefined(requestState) && !isBoundedString(requestState, this.#limits.state))
		) {
			return buildJSONRPCError(
				request.id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: `name` is required, argument values must be strings, and continuation fields must be valid when present',
			)
		}
		const params: MCPPromptGetParams = {
			name,
			...(isMCPStringArguments(argumentsValue) ? { arguments: argumentsValue } : {}),
			...(isRecord(inputResponses) ? { inputResponses } : {}),
			...(isString(requestState) ? { requestState } : {}),
		}
		const prompt = await manager.prompt(params, options)
		if (prompt === undefined) {
			return buildJSONRPCError(request.id, JSONRPC_INVALID_PARAMS, `Prompt not found: ${name}`)
		}
		const captured = snapshotJSON(prompt, {
			bytes: this.#limits.content,
			keys: this.#limits.keys,
			depth: this.#limits.depth,
		})
		if (captured === undefined) {
			return buildJSONRPCError(
				request.id,
				JSONRPC_INTERNAL_ERROR,
				'Server prompt manager returned an invalid or oversized result',
			)
		}
		if (isMCPInputResult(captured[0])) {
			const input: MCPInputResult = captured[0]
			return this.#forward(input, request)
		}
		if (!isMCPPromptGetResult(captured[0])) {
			return buildJSONRPCError(
				request.id,
				JSONRPC_INTERNAL_ERROR,
				'Server prompt manager returned an invalid or oversized result',
			)
		}
		const result: MCPPromptGetResult = captured[0]
		return buildJSONRPCResult(request.id, {
			...result,
			_meta: {
				...(result['_meta'] ?? {}),
				[MCP_META_SERVER]: this.#options.identity,
			},
		})
	}

	async #suggest(
		request: JSONRPCRequest,
		manager: MCPCompletionManagerInterface,
		options: MCPMethodOptions,
	): Promise<JSONRPCResponse> {
		const input = request.params ?? {}
		if (!isMCPCompletionParams(input)) {
			return buildJSONRPCError(
				request.id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: a valid completion reference, string argument, and string context are required',
			)
		}
		const params: MCPCompletionParams = {
			ref: input.ref,
			argument: input.argument,
			...(input.context === undefined ? {} : { context: input.context }),
		}
		const generated = await manager.complete(params, options)
		if (generated === undefined) {
			return buildJSONRPCError(request.id, JSONRPC_INVALID_PARAMS, 'Completion reference not found')
		}
		const candidate: unknown = generated
		if (!isRecord(candidate) || !Array.isArray(candidate['values'])) {
			return buildJSONRPCError(
				request.id,
				JSONRPC_INTERNAL_ERROR,
				'Server completion manager returned invalid or oversized candidates',
			)
		}
		const values = candidate['values']
		const truncated = values.length > 100
		const projected = {
			values: values.slice(0, 100),
			...(candidate['total'] === undefined ? {} : { total: candidate['total'] }),
			...(truncated
				? { hasMore: true }
				: candidate['hasMore'] === undefined
					? {}
					: { hasMore: candidate['hasMore'] }),
		}
		const captured = snapshotJSON(projected, {
			bytes: this.#limits.content,
			depth: this.#limits.depth,
		})
		if (captured === undefined || !isMCPCompletion(captured[0])) {
			return buildJSONRPCError(
				request.id,
				JSONRPC_INTERNAL_ERROR,
				'Server completion manager returned invalid or oversized candidates',
			)
		}
		const completion: MCPCompletion = captured[0]
		return buildJSONRPCResult(request.id, {
			resultType: 'complete',
			completion,
			_meta: { [MCP_META_SERVER]: this.#options.identity },
		})
	}

	// The built-in modern `tools/call` handler — stamped, and NOT cacheable, so it carries no
	// cache fields.
	async #call(
		request: JSONRPCRequest,
		options: MCPMethodOptions,
	): Promise<JSONRPCResponse | MCPStream> {
		const id = request.id
		const params = request.params
		const rawArguments = params?.['arguments']
		if (params !== undefined && Object.hasOwn(params, 'arguments') && !isRecord(rawArguments)) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: `arguments` must be an object when present',
			)
		}
		// ONE reference from here on: the digest, the input selector, the canonical call, and
		// the executor all read this exact object. An absent `arguments` resolves to the one
		// shared frozen record rather than a fresh empty object per call.
		const args = isRecord(rawArguments) ? rawArguments : EMPTY_MCP_ARGUMENTS
		const input = await this.#input(request, args, options)
		if (input !== undefined) return input
		const call = buildToolCall(request, options.caller, args)
		if (call === undefined) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: a string `name` is required',
			)
		}
		const deferred = await this.#defer(request, call, options)
		if (deferred !== undefined) return deferred
		const token = params?.['_meta']
		const progressToken = isRecord(token) ? token['progressToken'] : undefined
		if (
			this.#options.execution !== undefined &&
			(isString(progressToken) ||
				(typeof progressToken === 'number' && Number.isInteger(progressToken)))
		) {
			return this.#progress(request, call, progressToken, options)
		}
		const result = await this.#execute(request, call, options.signal)
		return 'jsonrpc' in result ? result : buildJSONRPCResult(id, result)
	}

	// The task decision, and the WHOLE of this server's half of the stable Tasks extension.
	//
	// Its position between `#input` and `#progress` is the ordering the extension implies.
	// MRTR runs FIRST because a call still asking its operator a question has not yet been
	// decided — deferring it would durably store a call whose arguments are not settled, and
	// the extension says pre-creation input belongs to the original request. Progress runs
	// LAST because a task and progress are alternative answers to the same request: a deferred call has
	// no request-scoped stream left to report progress on, because the request ends the moment
	// the task handle is written.
	//
	// The server policy decides first whether this call is a task. A client that cannot accept
	// that selected outcome is then refused before the manager starts work; skipping the policy
	// would silently bypass deployment task policy rather than merely choose an inline result.
	//
	// Nothing about the task's WORK is here: no store, no timer, no status. All of them belong
	// to the manager, which is also the only party that outlives this request.
	async #defer(
		request: JSONRPCRequest,
		call: ToolCall,
		options: MCPMethodOptions,
	): Promise<JSONRPCResponse | undefined> {
		const configured = this.#options.task
		if (configured === undefined) return undefined
		const deferral: MCPTaskContext = { request, call, tools: this.#options.tools }
		const key = await configured.defer(deferral, options)
		// `undefined` is the policy saying "run this inline", and it is the ONLY spelling of that.
		// An empty key cannot identify an operation, and a manager asked to deduplicate on one
		// collapses every deferred call onto a single task — so it is a FAULTY policy the
		// consumer hears about, not a second spelling of absence quietly routed down the inline
		// path where nobody would ever find it.
		if (isUndefined(key)) return undefined
		if (!isString(key) || key.length === 0) {
			return buildJSONRPCError(
				request.id,
				JSONRPC_INTERNAL_ERROR,
				'Server execution returned an invalid task key',
			)
		}
		const context = parseRequestContext(request, {
			bytes: this.#limits.message,
			depth: this.#limits.depth,
		})
		if (context === undefined || !isTaskSupported(context.capabilities)) {
			return buildJSONRPCError(
				request.id,
				MCP_MISSING_CAPABILITY,
				'Client does not support the required Tasks extension',
				{ requiredCapabilities: { extensions: { [MCP_EXTENSION_TASKS]: {} } } },
			)
		}
		// AWAITED before the answer is built, which is this server's entire half of the
		// durability rule: whatever the manager must do to make the task retrievable, it has
		// done by the time a `taskId` exists to hand out.
		const created = await configured.tasks.start(key, deferral, options)
		// Each declared member is read EXACTLY ONCE and nothing else is copied. That is the
		// ownership seam for this answer, and it is narrower than a JSON snapshot: a manager
		// that mutates the object it returned, answers differently on a second read, or hangs
		// extra keys off it changes neither the answer nor its size.
		const result: MCPTaskResult = {
			resultType: 'task',
			taskId: created.taskId,
			status: created.status,
			...(created.statusMessage === undefined ? {} : { statusMessage: created.statusMessage }),
			createdAt: created.createdAt,
			lastUpdatedAt: created.lastUpdatedAt,
			ttlMs: created.ttlMs,
			...(created.pollIntervalMs === undefined ? {} : { pollIntervalMs: created.pollIntervalMs }),
			_meta: { [MCP_META_SERVER]: this.#options.identity },
		}
		// The projection bounds the SHAPE; this bounds the SIZE and re-proves the shape at
		// runtime, because the manager's declared types are a promise rather than a proof.
		const captured = snapshotJSON(result, {
			bytes: this.#limits.content,
			keys: this.#limits.keys,
			depth: this.#limits.depth,
		})
		return captured !== undefined && isMCPTaskResult(captured[0])
			? buildJSONRPCResult(request.id, captured[0])
			: buildJSONRPCError(
					request.id,
					JSONRPC_INTERNAL_ERROR,
					'Server execution returned an invalid or oversized task',
				)
	}

	// The resolved signal is already the request's LIFETIME — dispatch aborts it the moment
	// this stream closes — so the executor observes it directly and this method composes no
	// second cancellation source of its own.
	async *#progress(
		request: JSONRPCRequest,
		call: ToolCall,
		token: string | number,
		options: MCPMethodOptions,
	): MCPStream {
		const signal = options.signal
		const reporter = new MCPProgressReporter(
			token,
			{
				bytes: this.#limits.content,
				keys: this.#limits.keys,
				depth: this.#limits.depth,
			},
			signal,
		)
		const execution = this.#execute(request, call, signal, reporter)
		try {
			while (true) {
				const outcome = await Promise.race([reporter.take(), execution])
				if ('method' in outcome) {
					yield outcome
					continue
				}
				return 'jsonrpc' in outcome ? outcome : buildJSONRPCResult(request.id, outcome)
			}
		} catch (error) {
			if (signal.aborted) throw signal.reason ?? error
			throw error
		} finally {
			void execution.catch(() => undefined)
			reporter.stop()
		}
	}

	async #execute(
		request: JSONRPCRequest,
		call: ToolCall,
		signal: AbortSignal,
		progress?: MCPProgressReporter,
	): Promise<MCPCallResult | JSONRPCResponse> {
		let result: unknown
		try {
			result =
				this.#options.execution === undefined
					? await this.#options.tools.execute(call)
					: await this.#options.execution({
							request,
							call,
							tools: this.#options.tools,
							signal,
							...(progress === undefined ? {} : { progress }),
						})
		} catch (error) {
			return this.#contain(error, request.id)
		}
		const captured = snapshotJSON(result, {
			bytes: this.#limits.content,
			keys: this.#limits.keys,
			depth: this.#limits.depth,
		})
		if (captured !== undefined && isMCPCallResult(captured[0])) return captured[0]
		return this.#normalize(captured?.[0] ?? result, request.id)
	}

	// The built-in modern `tools/call` input mechanism, and the FIRST round of it. It is
	// deliberately reachable only from `#call`: the other modern handlers cannot produce
	// `input_required`.
	//
	// Order is the whole security property here, and it is: selector, own, capability,
	// principal, seal. The selector runs before the capability is known to be needed, because
	// only a selector that ASKS for something makes the client's declaration relevant at all,
	// and WHICH declaration matters is not knowable until the round exists; everything after
	// it runs only once the answer is yes.
	async #input(
		request: JSONRPCRequest,
		args: Readonly<Record<string, unknown>>,
		options: MCPMethodOptions,
	): Promise<JSONRPCResponse | undefined> {
		const configured = this.#options.input
		if (configured === undefined) return undefined
		const id = request.id
		const params = request.params
		const name = params?.['name']
		if (!isString(name)) return undefined
		const digest = await digestJSON(args, {
			bytes: this.#limits.content,
			keys: this.#limits.keys,
			depth: this.#limits.depth,
		})
		if (digest === undefined) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: tool arguments are too large or unsafe',
			)
		}
		if (params?.['requestState'] !== undefined || params?.['inputResponses'] !== undefined) {
			return this.#retry(request, name, digest, args, options)
		}
		const selected = await configured.selector({ request, name, arguments: args }, options)
		if (selected === undefined) return undefined
		const round = this.#ownRound(selected)
		const context = parseRequestContext(request, {
			bytes: this.#limits.message,
			depth: this.#limits.depth,
		})
		if (round === undefined) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: input policy returned an invalid round or continuation context',
			)
		}
		const refusal = this.#gate(round, context, id)
		if (refusal !== undefined) return refusal
		const principal = await configured.principal(request, options)
		return this.#required(request, name, digest, round, principal, id, undefined)
	}

	// The capability rule, which is about SENDING: a server never issues a request kind the
	// client's declared capabilities exclude. So it is checked against the ROUND rather than
	// against the method, at every place a round leaves this server — the first `tools/call`
	// round, a further round on a retry, and a round a `prompts/get` or `resources/read`
	// manager authored — and at each of them it stands ahead of the seal or the stamp, so a
	// round this server may not send costs no continuation write.
	//
	// An UNPARSABLE modern context is a different failure and gets the different answer: a
	// request whose `_meta` did not survive parsing declared nothing to measure, which is the
	// malformed-metadata refusal `#modern` already gives it at the ingress, in the same words.
	// A request carrying a STAMPED EMPTY declaration is not that case — an empty declaration
	// parses, and it excludes every kind, so it is gated rather than refused as malformed.
	#gate(
		round: MCPInputRound,
		context: MCPRequestContext | undefined,
		id: JSONRPCId,
	): JSONRPCErrorResponse | undefined {
		if (context === undefined) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: malformed modern request metadata',
			)
		}
		const missing = computeMissingCapabilities(round.requests, context.capabilities)
		if (missing === undefined) return undefined
		return buildJSONRPCError(
			id,
			MCP_MISSING_CAPABILITY,
			'Server requires a client capability this request did not declare',
			{ requiredCapabilities: missing },
		)
	}

	// A `prompts/get` or `resources/read` manager may answer with an `MCPInputResult` of its
	// own, and that result leaves as THIS server's wire. So the round it carries meets the same
	// capability gate a `tools/call` round meets: the rule binds every issuer, not one method,
	// and a round the client's declared capabilities exclude must not be stamped and sent from
	// a port either. A result carrying only a continuation carrier asks nothing, so there is
	// nothing to measure and the stamp is all that is left to do.
	#forward(input: MCPInputResult, request: JSONRPCRequest): JSONRPCResponse {
		const requests = input.inputRequests
		if (requests !== undefined) {
			const context = parseRequestContext(request, {
				bytes: this.#limits.message,
				depth: this.#limits.depth,
			})
			const refusal = this.#gate({ requests }, context, request.id)
			if (refusal !== undefined) return refusal
		}
		return buildJSONRPCResult(request.id, {
			...input,
			_meta: {
				...(input['_meta'] ?? {}),
				[MCP_META_SERVER]: this.#options.identity,
			},
		})
	}

	// The retry ingress and its verification. Every structural binding is verified before the
	// principal resolver runs: a retry this server was always going to refuse must not cost a
	// principal lookup or whatever audit record that writes. The capability gate does NOT stand
	// here, because a retry answers a round this server already issued and already gated; what
	// the gate measures is the NEXT round, and that does not exist until the selector answers.
	//
	// The failure taxonomy is deliberate. A carrier the port cannot recover is the CLIENT's
	// invalid state; a port that throws, or that opens successfully onto a payload this server
	// never authored, is the PROVIDER's contract failure — the client never wrote those bytes
	// and cannot act on being told they were wrong.
	async #retry(
		request: JSONRPCRequest,
		name: string,
		digest: string,
		args: Readonly<Record<string, unknown>>,
		options: MCPMethodOptions,
	): Promise<JSONRPCResponse | undefined> {
		const configured = this.#options.input
		if (configured === undefined) return undefined
		const id = request.id
		const requestState = request.params?.['requestState']
		const inputResponses = request.params?.['inputResponses']
		if (!isBoundedString(requestState, this.#limits.state) || !isRecord(inputResponses)) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: `inputResponses` and `requestState` are required together',
			)
		}
		const context = parseRequestContext(request, {
			bytes: this.#limits.message,
			depth: this.#limits.depth,
		})
		if (context === undefined) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: malformed modern request metadata',
			)
		}
		const verified = await configured.continuation.open(requestState)
		if (verified === undefined) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: request state could not be recovered',
			)
		}
		if (!isBoundedString(verified, this.#limits.state) || verified.length === 0) {
			return this.#contain(
				new Error('Continuation port opened a value outside the configured state bound'),
				id,
			)
		}
		const state = parseMCPInputState(verified)
		if (state === undefined) {
			return this.#contain(new Error('Continuation port opened a malformed protected payload'), id)
		}
		if (
			state.expiry <= Date.now() ||
			state.id === id ||
			state.version !== context.version ||
			state.method !== request.method ||
			state.name !== name ||
			state.digest !== digest
		) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: request state could not be verified for this retry',
			)
		}
		// The issued ROUND is enforced, not merely carried: every key it assigned is answered,
		// and each answer answers the question that was actually asked under that key. Extra
		// response keys are IGNORED — the server reads exactly the keys it assigned — so a
		// client batching unrelated answers is not refused for it.
		const responses = this.#checkAnswers(state.requests, inputResponses)
		if (responses === undefined) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: an input response is missing or malformed',
			)
		}
		const principal = await configured.principal(request, options)
		if (!isString(principal) || principal.length === 0 || state.principal !== principal) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: request state could not be verified for this retry',
			)
		}
		const selected = await configured.selector(
			{
				request,
				name,
				arguments: args,
				responses,
				...(state.state !== undefined ? { state: state.state } : {}),
			},
			options,
		)
		// The recheck after the LAST provider await, and so also the one immediately before
		// execution: a continuation that lapsed while a provider was parked must not reach the
		// tool, and the window is a wall-clock deadline rather than a one-time admission.
		if (state.expiry <= Date.now()) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: request state could not be verified for this retry',
			)
		}
		if (selected === undefined) return undefined
		const round = this.#ownRound(selected)
		if (round === undefined) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: input policy returned an invalid round or continuation context',
			)
		}
		const refusal = this.#gate(round, context, id)
		if (refusal !== undefined) return refusal
		// The ORIGINAL id and the prior window travel into the next round: the id because a
		// multi-round exchange is one correlated call, the window because a further round
		// EXTENDS a continuation rather than resurrecting one.
		return this.#required(request, name, digest, round, principal, state.id, state.expiry)
	}

	// Check one client's answers against the exact round that asked for them, and own the
	// result. Every issued key must be answered — an unanswered round is a refusal here rather
	// than a re-issue, so a tool never runs on a question the client left open — and each
	// answer is checked against the request filed under its own key, so an elicitation answer
	// cannot settle a sampling request by arriving in its place.
	#checkAnswers(
		requests: MCPInputRequestMap,
		responses: Readonly<Record<string, unknown>>,
	): MCPInputResponseMap | undefined {
		const answered: Record<string, MCPInputResponse> = {}
		for (const [key, issued] of Object.entries(requests)) {
			const response = responses[key]
			if (!Object.hasOwn(responses, key) || !isMCPInputResponse(response, issued)) return undefined
			answered[key] = response
		}
		return Object.freeze(answered)
	}

	// Own the selector's output the moment it is produced. The issued round is snapshotted and
	// frozen HERE, before capability, principal, or seal, so a provider that mutates what it
	// returned changes neither the questions the client is asked nor the round the sealed state
	// binds — the two would otherwise be free to disagree. An EMPTY round is refused: a round
	// asking nothing would seal state no retry could ever satisfy.
	#ownRound(round: unknown): MCPInputRound | undefined {
		const owned = snapshotJSON(round, {
			bytes: this.#limits.content,
			keys: this.#limits.keys,
			depth: this.#limits.depth,
		})
		if (owned === undefined || !isRecord(owned[0])) return undefined
		const requests = owned[0]['requests']
		const state = owned[0]['state']
		if (!isMCPInputRequestMap(requests) || Object.keys(requests).length === 0) return undefined
		if (!isUndefined(state) && !isJSONValue(state)) return undefined
		return isUndefined(state) ? { requests } : { requests, state }
	}

	// Issue one round and seal the call-in-hand state. The round's keys are the CONSUMER's,
	// because they are how it correlates each answer, and they travel inside protected state so
	// a retry is checked against the exact questions this server asked.
	// `origin` is the FIRST round's id, which stays bound however many rounds follow;
	// `previous` is the window a further round is extending, rechecked around the seal await.
	async #required(
		request: JSONRPCRequest,
		name: string,
		digest: string,
		round: MCPInputRound,
		principal: unknown,
		origin: JSONRPCId,
		previous: number | undefined,
	): Promise<JSONRPCResponse> {
		const id = request.id
		const configured = this.#options.input
		const context = parseRequestContext(request, {
			bytes: this.#limits.message,
			depth: this.#limits.depth,
		})
		if (
			configured === undefined ||
			context === undefined ||
			!isString(principal) ||
			principal.length === 0 ||
			!Number.isFinite(configured.ttl) ||
			configured.ttl <= 0
		) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: input policy returned an invalid round or continuation context',
			)
		}
		if (previous !== undefined && previous <= Date.now()) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: request state could not be verified for this retry',
			)
		}
		const expiry = Date.now() + configured.ttl
		const protectedState = {
			principal,
			expiry,
			id: origin,
			version: context.version,
			method: request.method,
			requests: round.requests,
			name,
			digest,
			...(round.state !== undefined ? { state: round.state } : {}),
		}
		if (
			!isBoundedJSON(protectedState, {
				bytes: this.#limits.state,
				depth: this.#limits.depth,
			})
		) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: request state exceeds the configured limit',
			)
		}
		const serialized = serializeJSON(protectedState, {
			bytes: this.#limits.state,
			depth: this.#limits.depth,
		})
		if (serialized === undefined) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: request state exceeds the configured limit',
			)
		}
		const requestState = await configured.continuation.seal(serialized)
		if (!isBoundedString(requestState, this.#limits.state) || requestState.length === 0) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: request state exceeds the configured limit',
			)
		}
		// Around the seal await, both windows: the one just minted, and the one this round is
		// extending. A port that took longer to protect the state than the state was good for
		// must not hand the client a round already dead on arrival. The windows are also
		// different things to say: a FIRST round has no retry to refuse, and telling that caller
		// its state failed verification points it at a round it never made.
		if (expiry <= Date.now() || (previous !== undefined && previous <= Date.now())) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				previous === undefined
					? 'Invalid params: request state expired before it could be issued'
					: 'Invalid params: request state could not be verified for this retry',
			)
		}
		return buildJSONRPCResult(id, {
			resultType: 'input_required',
			inputRequests: round.requests,
			requestState,
			_meta: { [MCP_META_SERVER]: this.#options.identity },
		})
	}

	// The built-in modern `subscriptions/listen` handler validates the client's filter,
	// then returns the event-driven generator that owns acknowledgement and closure order.
	async #subscribe(
		request: JSONRPCRequest,
		options: MCPMethodOptions,
	): Promise<JSONRPCResponse | MCPStream> {
		const id = request.id
		const requested = request.params?.['notifications']
		if (!isMCPSubscriptionFilter(requested)) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: a valid `notifications` filter is required',
			)
		}
		return this.#subscription(requested, id, options)
	}

	async *#subscription(
		requested: MCPSubscriptionFilter,
		id: JSONRPCId,
		options: MCPMethodOptions,
	): MCPStream {
		if (this.#subscriptions >= this.#limits.subscriptions) {
			return buildJSONRPCError(
				id,
				JSONRPC_INTERNAL_ERROR,
				'Server limit reached: too many live subscriptions',
			)
		}
		this.#subscriptions += 1
		// Capacity is returned on the ONE event that always happens: the end of the exchange.
		// It CANNOT be returned by the `finally` alone, because the `finally` requires this
		// generator to resume, and the steady state of a live subscription is parked inside
		// `await iterator.next()` on a producer suspended in its own await — where the consumer's
		// `throw()` and this generator's own `return()` are both queued behind a `next()` nobody
		// will answer. `MCPStreamController` aborts the request's lifetime from every closure it
		// has, so this signal fires for a completed exchange, a failed producer, a `stop()`, and
		// a vanished client alike. The controller is the once-flag: `abort()` is idempotent and
		// its listener runs at most once, so the `finally` below is the same release, not a
		// second one.
		const slot = new AbortController()
		slot.signal.addEventListener('abort', () => void (this.#subscriptions -= 1), { once: true })
		if (options.signal.aborted) slot.abort()
		else options.signal.addEventListener('abort', () => slot.abort(), { once: true })
		try {
			const task = this.#options.task
			const configured = this.#options.subscription
			const tasks = task !== undefined && configured !== undefined
			let notifications = buildSubscriptionFilter(requested, configured?.notifications ?? {}, tasks)
			const requestedTaskIds = notifications.taskIds
			if (requestedTaskIds !== undefined) {
				const resolved: string[] = []
				if (task !== undefined) {
					for (const taskId of requestedTaskIds) {
						if ((await task.tasks.task(taskId, options)) !== undefined) resolved.push(taskId)
					}
				}
				const { taskIds: _dropped, ...rest } = notifications
				notifications = resolved.length > 0 ? { ...rest, taskIds: resolved } : rest
			}
			yield buildSubscriptionAcknowledgement(notifications, id)
			if (configured !== undefined) {
				const source = await configured.listen(notifications, options)
				const iterator = source[Symbol.asyncIterator]()
				// The iterator is held rather than hidden inside `for await` because ending the
				// ITERATOR is the only cleanup this loop can still ask of a producer parked on its
				// own event source. It is an ASK, not a guarantee: a producer suspended inside its
				// own await queues that `return()` behind it and may never run it — which is why
				// nothing after the park is load-bearing here, and why the slot is returned from
				// the signal above rather than from anything this loop reaches.
				options.signal.addEventListener(
					'abort',
					() => void iterator.return?.(undefined)?.catch(() => undefined),
					{ once: true },
				)
				for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
					// Own the produced object BEFORE any decision reads it. The matcher and the
					// stamper each read `method`, `params.uri`, and `params._meta`; a hostile
					// producer answering differently per read would otherwise have one value admit
					// the notification and another value ride out on the wire.
					const owned = parseJSONRPCMessage(next.value, {
						bytes: this.#limits.message,
						depth: this.#limits.depth,
					})
					if (owned === undefined || !isJSONRPCNotification(owned)) continue
					if (matchesSubscriptionNotification(owned, notifications)) {
						yield stampSubscriptionNotification(owned, id)
					}
				}
			}
			return buildSubscriptionResult(id, this.#options.identity)
		} catch (error) {
			// An abort is a cancellation, not a fault: it produces no terminal and reports
			// nothing. Anything else is the producer failing while the request was still live,
			// which the client learns as one detail-free terminal.
			if (options.signal.aborted) throw error
			return this.#contain(error, id)
		} finally {
			slot.abort()
		}
	}

	// THE SHARED INGRESS of every `tasks/*` method: the capability the extension requires
	// on every one of them, then the handle they all name. It answers the validated `taskId` or
	// the refusal that ends the request, and a `string` is the WHOLE discriminator — so nothing
	// a consumer's manager can produce is ever mistaken for an envelope this server built.
	//
	// The capability is checked FIRST and unconditionally, because the extension binds it to the
	// METHOD rather than to one call's parameters: a client that never declared the extension is
	// refused before its parameters are read at all. The code is the GENERIC
	// missing-required-client-capability code, the same one the input path answers — the
	// tasks and input refusals are told apart by `data.requiredCapabilities` alone, because
	// they are instances of the same condition rather than distinct conditions. (The extension's
	// own prose examples show `-32003`; the dated core schema fixes `-32021`, and a peer
	// implements the dated schema.)
	#readTaskId(request: JSONRPCRequest): string | JSONRPCErrorResponse {
		const id = request.id
		const context = parseRequestContext(request, {
			bytes: this.#limits.message,
			depth: this.#limits.depth,
		})
		if (context === undefined || !isTaskSupported(context.capabilities)) {
			return buildJSONRPCError(
				id,
				MCP_MISSING_CAPABILITY,
				'Server requires the tasks extension capability for this request',
				{ requiredCapabilities: { extensions: { [MCP_EXTENSION_TASKS]: {} } } },
			)
		}
		// Bounded by the same budget a protected `requestState` spends: both are opaque handles a
		// client echoes back, and neither has a length this package gets to choose.
		const taskId = request.params?.['taskId']
		if (!isBoundedString(taskId, this.#limits.state) || taskId.length === 0) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: a bounded string `taskId` is required',
			)
		}
		return taskId
	}

	// The built-in `tasks/get` handler — the ONE read of a durable task, and the only `tasks/*`
	// method that puts a manager's value on the wire.
	//
	// The refusal for a `taskId` that resolved to nothing is byte-identical here, on
	// `tasks/update`, and on `tasks/cancel`, and it is the same answer for a task that never
	// existed, one whose TTL purged it, and one this caller is not entitled to see: the port
	// answers `undefined` for each of them, so this server cannot tell them apart even in
	// principle. That is what makes a `taskId` unprobeable — a second code, or a second message,
	// would turn the manager's store into an enumeration oracle.
	//
	// The snapshot bounds and owns the manager's answer BEFORE the stamp, because the manager is
	// the untrusted half: `resultType: 'complete'` and the server identity are this server's own
	// and add a fixed, tiny amount outside the consumer's content budget.
	async #task(
		request: JSONRPCRequest,
		tasks: MCPTaskManagerInterface,
		options: MCPMethodOptions,
	): Promise<JSONRPCResponse> {
		const id = request.id
		const taskId = this.#readTaskId(request)
		if (!isString(taskId)) return taskId
		const found = await tasks.task(taskId, options)
		if (found === undefined) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: no task is available for that `taskId`',
			)
		}
		const owned = snapshotJSON(found, {
			bytes: this.#limits.content,
			keys: this.#limits.keys,
			depth: this.#limits.depth,
		})
		if (owned === undefined || !isMCPTaskDetail(owned[0])) {
			return buildJSONRPCError(
				id,
				JSONRPC_INTERNAL_ERROR,
				'Server execution returned an invalid or oversized task',
			)
		}
		// `complete`, not `task`. Only the CREATION answer carries `resultType: 'task'`; reading
		// a task is an ordinary completed method call whose payload happens to be a task.
		return buildJSONRPCResult(id, buildModernResult(owned[0], this.#options.identity))
	}

	// The built-in `tasks/update` handler — the client answering the input requests an
	// `input_required` task published.
	//
	// The responses are forwarded VERBATIM. Which keys a task recognizes is the task's own
	// knowledge and this server holds none of it, so a key the task never published and a key
	// it has already answered are the manager's to IGNORE rather than this server's to refuse.
	// A server that guessed would refuse a legal update the moment a manager published a new key.
	// The record itself needs no snapshot: `params` arrived bounded, frozen, and owned from the
	// single parse at ingress.
	//
	// Note what this is NOT. It is a second multi-round-trip mechanism, and it carries none of
	// the protections the built-in one does — no `requestState`, no argument digest, no
	// expiry, no principal binding — because MCP does not own the task's input channel. The
	// manager does, and every one of those bindings would have to be the manager's.
	//
	// The read below is PROVEN with the same guard `tasks/get` proves its answer with, not
	// merely compared against `undefined`. `update` answers `void`, so a read this method
	// accepts is a write it authorized, and `undefined` is only ONE of the ways an
	// implementation of this port says "no such task" — `null` is the ordinary JavaScript
	// spelling and the declared return type is a promise rather than a proof. Anything that
	// is not a well-formed task is not a task this caller may act on, and the refusal stays
	// byte-identical to the one an unknown `taskId` earns.
	async #update(
		request: JSONRPCRequest,
		tasks: MCPTaskManagerInterface,
		options: MCPMethodOptions,
	): Promise<JSONRPCResponse> {
		const id = request.id
		const taskId = this.#readTaskId(request)
		if (!isString(taskId)) return taskId
		const responses = request.params?.['inputResponses']
		if (!isRecord(responses)) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: an `inputResponses` object is required',
			)
		}
		if (!isMCPTaskDetail(await tasks.task(taskId, options))) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: no task is available for that `taskId`',
			)
		}
		await tasks.update(taskId, responses, options)
		return buildJSONRPCResult(id, buildModernResult({}, this.#options.identity))
	}

	// The built-in `tasks/cancel` handler. Cancellation is ADVISORY: this server ASKS, and the
	// acknowledgement reports that the request was accepted, never that the task stopped. A
	// manager whose work cannot be interrupted — or whose task already finished — legally reaches
	// `completed` afterwards, and this server asserts nothing about which happened.
	//
	// The `task` read that precedes it is the existence-and-authorization probe, not a state
	// machine: `abort` answers `void`, so it has no way to say "unknown" and the probe is the
	// only place either fact can be established. That is why the read is PROVEN with the same
	// guard `tasks/get` proves its answer with rather than compared against `undefined`: a
	// probe accepting any value a manager happened to return authorizes a cancellation of a
	// task nobody proved exists. Nothing here reads `status`, because there is no transition
	// logic in this package to hold one.
	async #abort(
		request: JSONRPCRequest,
		tasks: MCPTaskManagerInterface,
		options: MCPMethodOptions,
	): Promise<JSONRPCResponse> {
		const id = request.id
		const taskId = this.#readTaskId(request)
		if (!isString(taskId)) return taskId
		if (!isMCPTaskDetail(await tasks.task(taskId, options))) {
			return buildJSONRPCError(
				id,
				JSONRPC_INVALID_PARAMS,
				'Invalid params: no task is available for that `taskId`',
			)
		}
		await tasks.abort(taskId, options)
		return buildJSONRPCResult(id, buildModernResult({}, this.#options.identity))
	}

	// The ONE containment seam. Every fault the server catches passes through here exactly
	// once, and the two halves of containment happen together so they cannot drift apart: the
	// caught value goes to the application on `error`, and the peer gets a detail-free envelope.
	#contain(error: unknown, id: JSONRPCId): JSONRPCErrorResponse {
		this.#emitter.emit('error', error)
		return buildJSONRPCError(id, JSONRPC_INTERNAL_ERROR, 'Server error')
	}

	#normalize(result: unknown, id: JSONRPCId): MCPCallResult | JSONRPCResponse {
		const snapshot = snapshotToolResult(result, {
			bytes: this.#limits.content,
			keys: this.#limits.keys,
			depth: this.#limits.depth,
		})
		if (snapshot === undefined) {
			return buildJSONRPCError(
				id,
				JSONRPC_INTERNAL_ERROR,
				'Server execution returned an invalid tool result',
			)
		}
		const owned = snapshot[0]
		let payload: Readonly<Record<string, JSONValue>>
		if (!owned.success) {
			payload = { content: [{ type: 'text', text: owned.error }], isError: true }
		} else if (owned.value === undefined) {
			payload = { content: [{ type: 'text', text: '' }] }
		} else {
			const text = snapshot[1]
			// UNREACHABLE at runtime, and kept anyway: `snapshotToolResult` pairs a defined
			// success with the canonical text and the owned value of ONE `snapshotJSON`, so a
			// defined `owned.value` always arrives with its string and always is exact JSON.
			// `ToolSuccess.value` is nevertheless declared `unknown`, so this is the narrowing
			// that reaches `structuredContent` without an assertion. Deleting it would require
			// one, and silently omitting `structuredContent` instead would answer a shape the
			// tool did not produce. Line-scoped mutation confirms it: flipping this code is the
			// only modern emission the fault sweep cannot kill. Narrowing `ToolResult['value']`
			// upstream is what would remove it.
			if (text === undefined || !isJSONValue(owned.value)) {
				return buildJSONRPCError(
					id,
					JSONRPC_INTERNAL_ERROR,
					'Server could not serialize tool content',
				)
			}
			payload = {
				content: [{ type: 'text', text }],
				structuredContent: owned.value,
			}
		}
		const captured = snapshotJSON(payload, {
			bytes: this.#limits.content,
			keys: this.#limits.keys,
			depth: this.#limits.depth,
		})
		const candidate =
			captured !== undefined && isRecord(captured[0])
				? buildModernResult(captured[0], this.#options.identity)
				: undefined
		return candidate !== undefined && isMCPCallResult(candidate)
			? candidate
			: buildJSONRPCError(
					id,
					JSONRPC_INTERNAL_ERROR,
					'Server limit exceeded: tool content is too large or unsafe',
				)
	}
}
