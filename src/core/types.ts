import type { EmitterErrorHandler, EmitterHooks, EmitterInterface } from '@orkestrel/emitter'
import type { TokenSecret } from '@orkestrel/server'
import type { ToolInterface, ToolManagerInterface } from '@orkestrel/tool'

// JSON-RPC 2.0 wire types (https://www.jsonrpc.org/specification) — the envelope
// the Model Context Protocol speaks. A request carries a `method` and optional
// `params`; an `id` correlates it with its response, and its ABSENCE marks a
// notification (no response). A response carries the same `id` and EITHER a
// `result` OR an `error`, never both.

/**
 * A JSON-RPC 2.0 request — a `method` call with optional `params`, correlated to
 * its response by `id`.
 *
 * @remarks
 * `jsonrpc` is the literal `'2.0'`. An ABSENT `id` marks a NOTIFICATION — a
 * fire-and-forget call the server handles WITHOUT producing a response (e.g.
 * `notifications/initialized`). `params` is an open record forwarded to the
 * method handler (the handler narrows the fields it reads, §14).
 */
export interface JSONRPCRequest {
	readonly jsonrpc: '2.0'
	readonly method: string
	/** Correlates the request with its response; ABSENT ⇒ a notification (no response). */
	readonly id?: string | number
	/** The method's open argument record (narrowed by the handler, §14). */
	readonly params?: Readonly<Record<string, unknown>>
}

/**
 * A JSON-RPC 2.0 error object — the `error` member of a failed
 * {@link JSONRPCResponse}.
 *
 * @remarks
 * `code` is one of the reserved JSON-RPC codes (see `./constants.js`); `message`
 * is a short human description; `data` is an OPTIONAL machine-readable payload
 * carrying extra detail.
 */
export interface JSONRPCErrorData {
	readonly code: number
	readonly message: string
	readonly data?: unknown
}

/**
 * A JSON-RPC 2.0 response — the same `id` as its request, carrying EITHER a
 * `result` (success) OR an `error` (failure), never both.
 *
 * @remarks
 * `id` is `null` only when the request could not be parsed or its id read (a
 * parse / invalid-request error), per the spec; otherwise it echoes the
 * request's id. `result` is the method's return value (an open `unknown`);
 * `error` is a {@link JSONRPCErrorData}.
 */
export interface JSONRPCResponse {
	readonly jsonrpc: '2.0'
	readonly id: string | number | null
	readonly result?: unknown
	readonly error?: JSONRPCErrorData
}

/** A JSON-RPC 2.0 message on the wire — a {@link JSONRPCRequest} or a {@link JSONRPCResponse}. */
export type JSONRPCMessage = JSONRPCRequest | JSONRPCResponse

// MCP protocol shapes — the result payloads the dispatch methods return, mapped
// onto the JSON-RPC `result` member.

/** A protocol revision supported by this MCP package. */
export type MCPVersion = '2026-07-28' | '2025-11-25' | '2025-06-18'

/** The wire era selected by an MCP request's structure. */
export type MCPEra = 'modern' | 'legacy'

/** One content item of an MCP {@link MCPCallResult} — a `text` block carrying the tool's output. */
export interface MCPContent {
	readonly type: 'text'
	readonly text: string
}

/**
 * The MCP `tools/call` result — the executed tool's output as `content` blocks,
 * with `isError` flagging a tool failure.
 *
 * @remarks
 * A success carries the tool's value unchanged as `structuredContent` alongside
 * its serialized form in one `text` content block. A value-less success omits
 * `structuredContent`. A tool FAILURE (the `success: false` branch the registry
 * isolated) carries its `error` text in `content` AND sets `isError: true`, so the
 * model sees the failure as a tool result it can react to rather than a protocol
 * error.
 */
export interface MCPCallResult {
	readonly content: readonly MCPContent[]
	/** The successful tool value in its original structure; absent when no value was returned. */
	readonly structuredContent?: unknown
	/** `true` when the tool failed — its error text is in `content`. */
	readonly isError?: boolean
	/** The modern result discriminator; absent on a legacy result. */
	readonly resultType?: 'complete'
	/** Open modern protocol metadata, including reserved namespaced keys. */
	readonly _meta?: Readonly<Record<string, unknown>>
}

/** The primitive value shapes accepted in an MCP form elicitation response. */
export type ElicitValue = string | number | boolean | readonly string[]

/** One titled value in a form elicitation's single- or multi-select schema. */
export interface ElicitChoice {
	readonly const: string
	readonly title: string
}

/** One restricted primitive schema accepted by MCP form-mode elicitation. */
export type ElicitPrimitiveSchema =
	| {
			readonly type: 'boolean'
			readonly title?: string
			readonly description?: string
			readonly default?: boolean
	  }
	| {
			readonly type: 'number' | 'integer'
			readonly title?: string
			readonly description?: string
			readonly minimum?: number
			readonly maximum?: number
			readonly default?: number
	  }
	| {
			readonly type: 'string'
			readonly title?: string
			readonly description?: string
			readonly minLength?: number
			readonly maxLength?: number
			readonly format?: 'uri' | 'email' | 'date' | 'date-time'
			readonly default?: string
			readonly enum?: readonly string[]
			readonly enumNames?: readonly string[]
			readonly oneOf?: readonly ElicitChoice[]
	  }
	| {
			readonly type: 'array'
			readonly title?: string
			readonly description?: string
			readonly minItems?: number
			readonly maxItems?: number
			readonly default?: readonly string[]
			readonly items:
				| {
						readonly type: 'string'
						readonly enum: readonly string[]
				  }
				| {
						readonly anyOf: readonly ElicitChoice[]
				  }
	  }

/** The restricted top-level object schema carried by a form-mode elicitation request. */
export interface ElicitRequestedSchema extends Readonly<Record<string, unknown>> {
	readonly $schema?: string
	readonly type: 'object'
	readonly properties: Readonly<Record<string, ElicitPrimitiveSchema>>
	readonly required?: readonly string[]
}

/** The parameters of a form-mode `elicitation/create` request. */
export interface ElicitRequestFormParams {
	readonly mode?: 'form'
	readonly message: string
	readonly requestedSchema: ElicitRequestedSchema
}

/** The parameters of a URL-mode `elicitation/create` request. */
export interface ElicitRequestURLParams {
	readonly mode: 'url'
	readonly message: string
	readonly url: string
}

/** The mode-discriminated parameters of an `elicitation/create` request. */
export type ElicitRequestParams = ElicitRequestFormParams | ElicitRequestURLParams

/** An embedded MCP request asking the client to elicit input from its operator. */
export interface ElicitRequest {
	readonly method: 'elicitation/create'
	readonly params: ElicitRequestParams
}

/** The result supplied by a client for one embedded {@link ElicitRequest}. */
export interface ElicitResult {
	readonly action: 'accept' | 'decline' | 'cancel'
	readonly content?: Readonly<Record<string, ElicitValue>>
}

/**
 * One embedded multi-round-trip request.
 *
 * @remarks
 * This package produces only {@link ElicitRequest}. The deprecated sampling and roots
 * requests remain legal protocol union members and therefore retain their open parameter
 * records here without gaining package-owned producers.
 */
export type InputRequest =
	| ElicitRequest
	| {
			readonly method: 'sampling/createMessage'
			readonly params: Readonly<Record<string, unknown>>
	  }
	| {
			readonly method: 'roots/list'
			readonly params?: Readonly<Record<string, unknown>>
	  }

/** A server-keyed map of embedded requests the client must fulfil. */
export type InputRequests = Readonly<Record<string, InputRequest>>

/** A map of client results keyed by the corresponding server-assigned input-request key. */
export type InputResponses = Readonly<Record<string, unknown>>

/**
 * An incomplete modern result carrying input requests, protected request state, or both.
 *
 * @remarks
 * The two-arm union enforces the protocol's at-least-one-of rule at the type boundary:
 * every value has `inputRequests`, `requestState`, or both.
 */
export type InputRequiredResult =
	| {
			readonly resultType: 'input_required'
			readonly inputRequests: InputRequests
			readonly requestState?: string
			readonly _meta?: Readonly<Record<string, unknown>>
	  }
	| {
			readonly resultType: 'input_required'
			readonly inputRequests?: InputRequests
			readonly requestState: string
			readonly _meta?: Readonly<Record<string, unknown>>
	  }

/** A successful JSON-RPC response to `tools/call`. */
export interface CallToolResultResponse {
	readonly jsonrpc: '2.0'
	readonly id: string | number
	readonly result: MCPCallResult | InputRequiredResult
}

/** The integrity-protected payload carried inside an opaque `requestState` token. */
export interface MCPInputState {
	readonly principal: string
	readonly ttl: number
	readonly origin: string | number
	readonly key: string
	readonly name: string
	readonly state?: string
}

/** The call-in-hand context supplied to an {@link MCPInputHandler}. */
export interface MCPInputContext {
	readonly request: JSONRPCRequest
	readonly name: string
	readonly arguments: Readonly<Record<string, unknown>>
	readonly response?: ElicitResult
	readonly state?: string
}

/** One consumer-requested form elicitation, before MCP assigns its map key and signs state. */
export interface MCPElicitation {
	readonly request: ElicitRequestFormParams
	readonly state?: string
}

/**
 * Decide whether the current `tools/call` needs operator input.
 *
 * @param context - The original call plus a verified response/state on a retry
 * @param options - The per-request execution options
 * @returns A form elicitation to send, or `undefined` to continue into the tool registry
 */
export type MCPInputHandler = (
	context: MCPInputContext,
	options: MCPDispatchOptions,
) => MCPElicitation | undefined | Promise<MCPElicitation | undefined>

/** Derive the deployment-authenticated principal bound into signed request state. */
export type MCPPrincipalHandler = (request: JSONRPCRequest) => string | Promise<string>

/** Consumer policy for the server's multi-round-trip input mechanism. */
export interface MCPInputOptions {
	/** HMAC secret or `[current, ...older]` rotation list used by `signToken` / `verifyToken`. */
	readonly secret: TokenSecret
	/** Token lifetime in milliseconds; required so MCP never invents an expiry policy. */
	readonly ttl: number
	/** Resolve the authenticated principal for the call in hand. */
	readonly principal: MCPPrincipalHandler
	/** Decide whether the call needs a form elicitation, including on verified retries. */
	readonly elicit: MCPInputHandler
}

/**
 * One entry of the MCP `tools/list` result — a tool's `name`, optional
 * `description`, and its JSON-Schema `inputSchema`.
 *
 * @remarks
 * The wire renaming of a `ToolDefinition`: `name` / `description` carry through,
 * and `parameters` becomes `inputSchema` (the MCP field name), defaulting to an
 * empty object schema (`{ type: 'object' }`) when a tool declares none.
 */
export interface MCPToolDescriptor {
	readonly name: string
	readonly description?: string
	readonly inputSchema: Readonly<Record<string, unknown>>
}

/**
 * The MCP `tools/list` result — tool descriptors plus optional modern result
 * stamps.
 *
 * @remarks
 * The wire field names remain verbatim. A modern result requires `resultType`,
 * `ttlMs`, and `cacheScope`; they remain optional here because the same result
 * shape also models the unstamped legacy response.
 */
export interface MCPListResult {
	readonly tools: readonly MCPToolDescriptor[]
	readonly resultType?: 'complete'
	readonly ttlMs?: number
	readonly cacheScope?: 'public' | 'private'
	readonly _meta?: Readonly<Record<string, unknown>>
}

/** The identity (`name` / `version`) of an MCP server or client. */
export interface MCPIdentity {
	readonly name: string
	readonly version: string
}

/**
 * The validated per-request context projected from a modern request's reserved
 * `_meta` keys.
 *
 * @remarks
 * `version` remains a string so a syntactically valid but unsupported revision
 * reaches the dedicated unsupported-version path. `capabilities` is an open wire
 * record; `identity` is optional because client information is recommended but
 * not required.
 */
export interface MCPRequestContext {
	readonly version: string
	readonly capabilities: Readonly<Record<string, unknown>>
	readonly identity?: MCPIdentity
}

/** The mandatory modern `server/discover` result. */
export interface MCPDiscoverResult {
	readonly supportedVersions: readonly MCPVersion[]
	readonly capabilities: Readonly<Record<string, unknown>>
	readonly resultType: 'complete'
	readonly ttlMs: number
	readonly cacheScope: 'public' | 'private'
	readonly instructions?: string
	readonly _meta?: Readonly<Record<string, unknown>>
}

/** The notification families a client may opt in to on a `subscriptions/listen` stream. */
export interface SubscriptionFilter {
	/** Receive `notifications/tools/list_changed` when the server produces it. */
	readonly toolsListChanged?: boolean
	/** Receive `notifications/prompts/list_changed` when the server produces it. */
	readonly promptsListChanged?: boolean
	/** Receive `notifications/resources/list_changed` when the server produces it. */
	readonly resourcesListChanged?: boolean
	/** Receive `notifications/resources/updated` for these resource URIs. */
	readonly resourceSubscriptions?: readonly string[]
}

/** The required metadata on a graceful `subscriptions/listen` result. */
export interface SubscriptionsListenResultMetaObject extends Readonly<Record<string, unknown>> {
	/** The JSON-RPC id of the `subscriptions/listen` request whose stream is closing. */
	readonly 'io.modelcontextprotocol/subscriptionId': string | number
}

/** The terminating result returned when a `subscriptions/listen` stream closes gracefully. */
export interface SubscriptionsListenResult {
	readonly resultType: 'complete'
	readonly _meta: SubscriptionsListenResultMetaObject
}

// THE MODERN METHOD SEAM — the per-request execution options a handler receives,
// the held-open result arms, and the registrable method contract the modern
// dispatch branch runs every method through. The legacy branch keeps its own
// fixed switch: its method set is frozen by a shipped revision and never grows.

/** Per-request execution options every dispatched handler receives. */
export interface MCPDispatchOptions {
	/** Aborts when the bound transport can observe that the caller's request has ended. */
	readonly signal?: AbortSignal
}

/**
 * Produce notifications for one honoured `subscriptions/listen` filter.
 *
 * @remarks
 * The producer parks on its own event source while idle and ends its iterable to close the
 * subscription gracefully. `options.signal` is the per-request cancellation signal; a
 * producer that needs cancellation observes it directly rather than polling.
 *
 * @param notifications - The requested filter intersected with the server's supported filter
 * @param options - The per-request execution options
 * @returns An event-driven source of server notifications
 */
export type MCPSubscriptionHandler = (
	notifications: SubscriptionFilter,
	options: MCPDispatchOptions,
) => AsyncIterable<JSONRPCRequest> | Promise<AsyncIterable<JSONRPCRequest>>

/** Configuration for the server's built-in `subscriptions/listen` method. */
export interface MCPSubscriptionOptions {
	/** The notification filter this server can actually honour. */
	readonly notifications: SubscriptionFilter
	/** Open the producer for one honoured filter. */
	readonly listen: MCPSubscriptionHandler
}

/**
 * A held-open modern result: each `yield` is a notification (a {@link JSONRPCRequest}
 * with no `id`); the `return` value is the terminating response.
 *
 * @remarks
 * Held-open closure is a RESULT in the modern revision, not an out-of-band event, so it
 * arrives where a result arrives — the generator's `return`. Consuming a stream and
 * consuming a unary response therefore end the same way, and a transport narrows the two
 * apart at ONE point (`Symbol.asyncIterator in result`), at the place that already pumps
 * messages onto the wire.
 */
export type MCPStream = AsyncGenerator<JSONRPCRequest, JSONRPCResponse>

/** The string-boundary mirror of {@link MCPStream} — the same sequence, already serialized. */
export type MCPTextStream = AsyncGenerator<string, string>

/**
 * One modern method, registered on the seam that dispatches it.
 *
 * @remarks
 * `undefined` answers nothing (the notification arm); an {@link MCPStream} holds the
 * request open. `options.signal` aborts when the caller's request ends — what a handler
 * does with it is the handler's decision, never this package's.
 *
 * @param request - The parsed modern request being dispatched
 * @param options - The per-request execution options (see {@link MCPDispatchOptions})
 * @returns The terminating response, a held-open {@link MCPStream}, or `undefined` for no answer
 */
export type MCPMethodHandler = (
	request: JSONRPCRequest,
	options: MCPDispatchOptions,
) => Promise<JSONRPCResponse | MCPStream | undefined>

/**
 * The modern method registry an {@link MCPServerInterface} dispatches through — the ONE
 * seam carrying both the built-in methods and any method a consumer adds.
 *
 * @remarks
 * `server/discover`, `tools/list`, `tools/call`, and `subscriptions/listen` are registered here at construction,
 * so they travel the SAME path as every later method: there is no second dispatch route
 * and no precedence puzzle. `add` under an existing name REPLACES that method — a
 * consumer overriding a built-in is an ordinary registration, not a special case. A name
 * with no handler is not an error state to model: {@link method} answers `undefined` and
 * the dispatch branch turns that into `-32601`.
 */
export interface MCPMethodManagerInterface {
	/**
	 * Register one modern method — replacing any handler already under that name.
	 *
	 * @param name - The JSON-RPC method name to answer (e.g. `'tools/call'`)
	 * @param handler - The handler dispatched for that method
	 */
	add(name: string, handler: MCPMethodHandler): void
	/**
	 * Find the handler registered for one method name.
	 *
	 * @param name - The JSON-RPC method name to resolve
	 * @returns The registered handler, or `undefined` when the method is unregistered
	 */
	method(name: string): MCPMethodHandler | undefined
}

/**
 * The push observation surface (§13) of an {@link MCPServerInterface} — the
 * dispatch moments a fire-and-forget observer (logging, tracing) subscribes to
 * via `server.emitter.on`.
 *
 * @remarks
 * `request` fires at the TOP of every `dispatch` with the method, correlating id
 * (`null` for a notification), and structurally selected wire era, BEFORE the
 * method runs — so an observer sees every inbound call. Listener isolation is the emitter's (§13): a
 * listener throw is routed to the emitter's `error` handler (the `error` option),
 * never onto this map, so a buggy observer can never corrupt a dispatch. Declared as
 * a `type` alias (§4.5) so the type-literal satisfies `EventMap` structurally.
 */
export type MCPServerEventMap = {
	/** A request is being dispatched — its method, correlating id, and structural wire era. */
	readonly request: readonly [method: string, id: string | number | null, era: MCPEra]
	/**
	 * A transport-level fault surfaced while a bound {@link MCPTransportInterface} was
	 * piping a reply out (a `send` throw or rejection from {@link bindServer}). A DOMAIN
	 * event (a genuine I/O fault), distinct from the emitter's own listener-error channel.
	 */
	readonly error: readonly [error: unknown]
}

/**
 * Options for `createMCPServer` — the server {@link MCPIdentity}, the live
 * {@link ToolManagerInterface} it exposes, optional `instructions`, and the
 * reserved `on` hooks (§8).
 *
 * @remarks
 * `identity` identifies the server in the `initialize` handshake (`serverInfo`).
 * `tools` is the live registry the server dispatches `tools/list` / `tools/call`
 * over — its `definitions()` advertise the tools and its `execute()` runs a call
 * (the manager already isolates a tool throw into a `success: false` result, so
 * the server adds none). `instructions` is the optional human guidance exposed
 * by `server/discover`. `cache` configures the modern cache stamps: `ttl` is the
 * freshness lifetime in milliseconds and `scope` defaults to `'private'`. `on`
 * is the §8 reserved key: initial listeners for the server's
 * {@link MCPServerEventMap}, wired at construction. `input` enables modern
 * `tools/call` multi-round trips: the consumer decides when input is needed and
 * supplies principal/signing/TTL policy, while MCP assigns the request key and
 * owns the protected wire round trip.
 */
export interface MCPServerOptions {
	readonly on?: EmitterHooks<MCPServerEventMap>
	/** The emitter's listener-error handler (AGENTS §13) — a listener throw routes here, not to a domain event. */
	readonly error?: EmitterErrorHandler
	readonly identity: MCPIdentity
	/** The live tool registry the server exposes over `tools/list` / `tools/call`. */
	readonly tools: ToolManagerInterface
	/** Optional human guidance exposed by `server/discover`. */
	readonly instructions?: string
	/** Modern cache stamps; omitted values use the protocol-safe defaults. */
	readonly cache?: {
		readonly ttl?: number
		readonly scope?: 'public' | 'private'
	}
	/** Optional multi-round-trip input mechanism; all signing and expiry policy is consumer-supplied. */
	readonly input?: MCPInputOptions
	/** Optional event-driven producer for the modern `subscriptions/listen` method. */
	readonly subscription?: MCPSubscriptionOptions
}

/**
 * A transport-agnostic Model Context Protocol server — dispatches JSON-RPC 2.0
 * requests (the fixed legacy methods plus the modern subscription method) over a live
 * {@link ToolManagerInterface}, with NO transport coupling (a transport layer
 * pumps strings through `handle`).
 *
 * @remarks
 * - **Two entry points.** `dispatch(request)` is the TYPED core: it takes an
 *   already-parsed {@link JSONRPCRequest}, runs the method, and resolves a
 *   {@link JSONRPCResponse} — or an {@link MCPStream} for a held-open modern method, or
 *   `undefined` for a NOTIFICATION (a request with no `id`). `handle(message)` is the
 *   STRING boundary: it `JSON.parse`s the raw message, narrows it to a request,
 *   dispatches, and serializes the answer back to a string (or an {@link MCPTextStream},
 *   the same sequence already serialized) — turning a parse failure into a `-32700`
 *   response and a non-request into a `-32600` response, and returning `undefined` for a
 *   notification.
 * - **One method seam.** Every modern method — the built-in `server/discover` /
 *   `tools/list` / `tools/call` / `subscriptions/listen` included — is registered on `methods` and dispatched
 *   from it, so a method added later travels the identical path and an unregistered one
 *   still answers `-32601`.
 * - **Provider-agnostic.** Imports only core siblings; it speaks JSON-RPC + the
 *   tool registry, with no HTTP, no model, and no backend coupling.
 * - **Observable (§13).** The owned `emitter` ({@link MCPServerEventMap}) fires
 *   `request` per dispatch; the emitter isolates a listener throw and routes it to its
 *   `error` handler (the `error` option, §13), never the dispatch.
 */
export interface MCPServerInterface {
	readonly emitter: EmitterInterface<MCPServerEventMap>
	readonly identity: MCPIdentity
	/** The modern method registry this server dispatches through (built-ins included). */
	readonly methods: MCPMethodManagerInterface
	/**
	 * Dispatch an already-parsed request — run its method and resolve the answer, or
	 * `undefined` for a notification (a request with no `id`).
	 *
	 * @remarks
	 * A held-open modern method answers with an {@link MCPStream} instead of a response:
	 * narrow the two apart with `Symbol.asyncIterator in result`. `options` is optional,
	 * so a caller that cannot abort simply never supplies one.
	 *
	 * @param request - The parsed JSON-RPC request to dispatch
	 * @param options - Per-request execution options (see {@link MCPDispatchOptions})
	 * @returns The response, a held-open {@link MCPStream}, or `undefined` for a notification
	 */
	dispatch(
		request: JSONRPCRequest,
		options?: MCPDispatchOptions,
	): Promise<JSONRPCResponse | MCPStream | undefined>
	/**
	 * Handle a raw message string — parse it, dispatch, and serialize the answer.
	 *
	 * @remarks
	 * A `JSON.parse` failure resolves a serialized `-32700` (Parse error) response;
	 * a parsed value that is not a valid request resolves a serialized `-32600`
	 * (Invalid Request) response; a notification resolves `undefined` (no response). A
	 * held-open method resolves an {@link MCPTextStream} — the typed stream's mirror,
	 * already serialized — so a transport writes each message with no second parse.
	 *
	 * @param message - The raw JSON-RPC message string
	 * @param options - Per-request execution options (see {@link MCPDispatchOptions})
	 * @returns The serialized response string, an {@link MCPTextStream}, or `undefined` for a notification
	 */
	handle(message: string, options?: MCPDispatchOptions): Promise<string | MCPTextStream | undefined>
}

// MCP TRANSPORT PORT — the environment-agnostic duplex message channel an
// environment face hands the pure engine (`bindServer` / `bindClient` in
// `./helpers.js`). Framing (WS frames, SSE events, stdio lines, `postMessage`
// payloads) is entirely the transport's concern; parsing and validation of the
// JSON-RPC string it carries remain entirely the core's.

/**
 * A duplex message channel an environment face provides to the pure engine — the
 * one port `bindServer` and `bindClient` (`./helpers.js`) pipe an
 * {@link MCPServerInterface} / {@link MCPClientInterface} over.
 *
 * @remarks
 * Messages are already-serialized JSON-RPC strings; the transport owns framing
 * (a WS text frame, an SSE `data:` event, a newline-terminated stdio line, a
 * `postMessage` payload) and never parses the string itself. `listen` and
 * `closed` each register THE SINGLE handler for their event — a second call
 * REPLACES the first (matching the emitter-free, minimal-surface carrier idiom
 * `bindServer` / `bindClient` themselves rely on), not an additive subscription
 * list.
 */
export interface MCPTransportInterface {
	/** Deliver one outbound JSON-RPC message (already serialized). */
	readonly send: (message: string) => void | Promise<void>
	/** Register the single inbound-message handler — a second call REPLACES the first. */
	readonly listen: (handler: (message: string) => void) => void
	/** Register the single closed handler — a second call REPLACES the first. */
	readonly closed: (handler: () => void) => void
	/** Close the underlying channel. */
	readonly close: () => void | Promise<void>
}

// MCP CLIENT (the egress side) — the mirror of the server, split the same way: a
// transport-agnostic {@link MCPClientInterface} that drives a REMOTE MCP server
// (`initialize` / `tools/list` / `tools/call`) over an injected {@link
// ClientTransportInterface}, exposing each remote tool as a local {@link
// ToolInterface} an agent can run. The transport speaks only the JSON-RPC wire (a
// concrete one — the HTTP transport — lives ONE layer out in `src/server/mcp`,
// mirroring the server's core-vs-HTTP split); the client owns the request↔response
// correlation, the per-request deadline, and the tool mapping, with no transport
// coupling.

/**
 * The observable events of a {@link ClientTransportInterface} (§13) — the moments the
 * {@link MCPClientInterface} (and any tracer) subscribes to via `transport.emitter.on`.
 *
 * @remarks
 * - `message` — a JSON-RPC message ARRIVED from the remote server (a response the
 *   client correlates to a pending request by `id`, or a server-initiated
 *   notification). The transport decodes the wire bytes (a JSON body or an SSE
 *   `data:` event) and emits the parsed {@link JSONRPCMessage}.
 * - `close` — the transport's connection ended (a stream closed, `close()` ran).
 * - `error` — a transport-level fault (a malformed message, a network error); the
 *   payload is typed `unknown` (§13). This is a DOMAIN event, distinct from the emitter's
 *   own listener-error channel: a listener throw is routed to the emitter's `error` handler
 *   (the `error` option), never onto this map. Declared as a `type` alias (§4.5) so the
 *   type-literal satisfies `EventMap` structurally.
 */
export type ClientTransportEventMap = {
	/** A JSON-RPC message arrived from the remote server (a response, or a notification). */
	readonly message: readonly [message: JSONRPCMessage]
	/** The transport's connection ended. */
	readonly close: readonly []
	/** A transport-level fault — the caught error (typed `unknown`, §13). */
	readonly error: readonly [error: unknown]
}

/**
 * A transport-agnostic carrier for the MCP CLIENT — pumps JSON-RPC messages to a
 * remote server and surfaces the server's replies on its `emitter`'s `message`
 * event, with NO knowledge of the protocol it carries.
 *
 * @remarks
 * The mirror of the server's "a transport pumps strings through `handle`": here the
 * {@link MCPClientInterface} hands the transport one {@link JSONRPCMessage} via
 * `send`, and the transport delivers each decoded reply back through the
 * `message` event the client subscribed to. The minimal carrier surface (§21): a
 * `start` (open the connection / arm any reader), `send` (write one message),
 * and `close` (tear down). `session` exposes a server-assigned session id once a
 * stateful transport has one (`undefined` for the stateless v1) — reserved for the
 * later sessions tier. Concrete transports (the HTTP transport over `fetch`, a future
 * WebSocket one) live in `src/server/mcp`; the in-process loopback transport in the
 * tests is one too.
 */
export interface ClientTransportInterface {
	readonly emitter: EmitterInterface<ClientTransportEventMap>
	/** A server-assigned session id once a stateful transport has one; `undefined` otherwise. */
	readonly session: string | undefined
	/**
	 * Open the transport — establish the connection and arm any reply reader.
	 *
	 * @returns Resolves once the transport is ready to `send`
	 */
	start(): Promise<void>
	/**
	 * Send one JSON-RPC message to the remote server.
	 *
	 * @remarks
	 * Each decoded reply is surfaced on the `emitter`'s `message` event — `send`
	 * itself resolves once the message has been written (and, for a request/response
	 * transport, its synchronous reply emitted), not when a logical response arrives;
	 * the {@link MCPClientInterface} awaits the response through its `id` correlation.
	 *
	 * @param message - The message to write to the wire
	 * @returns Resolves once the message has been sent
	 */
	send(message: JSONRPCMessage): Promise<void>
	/**
	 * Close the transport — end the connection and release resources.
	 *
	 * @returns Resolves once the transport is closed
	 */
	close(): Promise<void>
}

/**
 * The push observation surface (§13) of an {@link MCPClientInterface} — the moments a
 * fire-and-forget observer (logging, tracing) subscribes to via `client.emitter.on`.
 *
 * @remarks
 * - `connect` — the `initialize` handshake completed (the client is connected).
 * - `disconnect` — the client disconnected (every pending request rejected, the
 *   transport closed).
 * - `notification` — a server-initiated JSON-RPC NOTIFICATION arrived (a `message`
 *   that is not a response to a pending request) — forwarded for the consumer to
 *   react to (e.g. a `notifications/tools/list_changed`).
 * - `error` — a client-level fault surfaced for observation (typed `unknown`, §13). This is
 *   a DOMAIN event, distinct from the emitter's own listener-error channel: a listener throw
 *   is routed to the emitter's `error` handler (the `error` option), never onto this map.
 *   Declared as a `type` alias (§4.5) so the literal satisfies `EventMap`.
 */
export type MCPClientEventMap = {
	/** The `initialize` handshake completed — the client is connected. */
	readonly connect: readonly []
	/** The client disconnected — pending requests rejected, the transport closed. */
	readonly disconnect: readonly []
	/** A server-initiated notification arrived (not a response to a pending request). */
	readonly notification: readonly [message: JSONRPCMessage]
	/** A client-level fault surfaced for observation (typed `unknown`, §13). */
	readonly error: readonly [error: unknown]
}

/**
 * Options for `createMCPClient` — the {@link ClientTransportInterface} to drive, the
 * optional client {@link MCPIdentity}, the per-request `timeout`, and the reserved
 * `on` hooks (§8).
 *
 * @remarks
 * - `transport` — the carrier the client drives a remote MCP server over (REQUIRED;
 *   a concrete one from `src/server/mcp`, or an in-process loopback).
 * - `identity` — identifies the client in the `initialize` handshake (`clientInfo`);
 *   defaults to {@link import('./constants.js').DEFAULT_MCP_CLIENT_NAME} /
 *   {@link import('./constants.js').DEFAULT_MCP_CLIENT_VERSION}.
 * - `capabilities` — the open client-capability record carried by every modern
 *   request; defaults to an empty record when the modern client implementation lands.
 * - `version` — an optional protocol pin; absence lets the modern client negotiate.
 * - `timeout` — the per-request deadline in milliseconds: a `tools/list` / `tools/call`
 *   / `initialize` that the server does not answer within it REJECTS (the pending
 *   request is settled by an `AbortSignal.timeout(timeout)` deadline — never a raw
 *   `setTimeout`). Defaults to {@link
 *   import('./constants.js').DEFAULT_MCP_REQUEST_TIMEOUT}.
 * - `on` — the §8 reserved key: initial listeners for the client's
 *   {@link MCPClientEventMap}, wired at construction.
 */
export interface MCPClientOptions {
	readonly on?: EmitterHooks<MCPClientEventMap>
	/** The emitter's listener-error handler (AGENTS §13) — a listener throw routes here, not to a domain event. */
	readonly error?: EmitterErrorHandler
	readonly transport: ClientTransportInterface
	readonly identity?: MCPIdentity
	/** The open client-capability record carried by modern requests. */
	readonly capabilities?: Readonly<Record<string, unknown>>
	/** An optional protocol revision pin; absence permits negotiation. */
	readonly version?: MCPVersion
	/** The per-request deadline in milliseconds (default {@link import('./constants.js').DEFAULT_MCP_REQUEST_TIMEOUT}). */
	readonly timeout?: number
}

/**
 * A transport-agnostic Model Context Protocol CLIENT — connects to a REMOTE MCP
 * server over an injected {@link ClientTransportInterface}, negotiates the
 * modern or legacy wire era, and exposes the server's tools as local
 * {@link ToolInterface}s an agent can run.
 *
 * @remarks
 * - **The mirror of {@link MCPServerInterface}.** Where the server DISPATCHES requests
 *   over a tool registry, the client ISSUES them over a transport: `connect` probes
 *   `server/discover` first unless pinned to a legacy revision, falling back to the
 *   legacy `initialize` handshake only when the peer does not speak the modern era.
 *   The negotiated revision is exposed through `version`; `tools()` lists
 *   the remote tools and wraps each as a local {@link ToolInterface} whose `execute`
 *   calls back through `call`; `call(name, args)` runs a remote `tools/call` and
 *   returns the tool's value (a remote tool FAILURE — `isError: true` — throws locally,
 *   so the agent's {@link ToolManagerInterface} isolates it into a `success: false`
 *   result just like a local throw).
 * - **Request↔response correlation.** Every request is tagged with a monotonic numeric
 *   `id`; the client subscribes to the transport's `message` event and resolves /
 *   rejects the matching pending request by that `id`. A message that is NOT a response
 *   to a pending request is a server NOTIFICATION — surfaced on `notification`.
 * - **Per-request deadline.** Each request races an `AbortSignal.timeout(timeout)`
 *   deadline: a server that never replies REJECTS the pending request once the
 *   deadline fires, never hanging.
 * - **Transport-agnostic.** Imports only core siblings — JSON-RPC + the tool vocabulary
 *   + the timeout primitive — with no HTTP and no model; the concrete transport is
 *   injected. Wire fields are narrowed via the contracts guards (no `as`).
 * - **Observable (§13).** The owned `emitter` fires `connect` / `disconnect` /
 *   `notification` / `error`; the emitter isolates a listener throw and routes it to its
 *   `error` handler (the `error` option, §13), never the client.
 */
export interface MCPClientInterface {
	readonly emitter: EmitterInterface<MCPClientEventMap>
	/** Whether era negotiation has completed and the client is connected. */
	readonly connected: boolean
	/** The negotiated protocol revision, or `undefined` while disconnected. */
	readonly version: MCPVersion | undefined
	/** The injected transport the client drives the remote server over. */
	readonly transport: ClientTransportInterface
	/**
	 * Subscribe a listener to one of the client's {@link MCPClientEventMap} events —
	 * the convenience forward to `emitter.on` (§13).
	 *
	 * @param event - The event name to subscribe to
	 * @param handler - The listener for that event's argument tuple
	 */
	on<K extends keyof MCPClientEventMap>(
		event: K,
		handler: (...args: MCPClientEventMap[K]) => void,
	): void
	/**
	 * Connect to the remote server — open the transport and negotiate the modern or
	 * legacy wire era without exposing that choice to the caller.
	 *
	 * @remarks
	 * Idempotent — a second `connect` while already connected is a no-op. An unpinned
	 * client probes `server/discover`; a pinned legacy client and a legacy fallback run
	 * `initialize` and send `notifications/initialized`. On success {@link version}
	 * contains a supported revision and the `connect` event fires.
	 *
	 * @returns Resolves once the handshake completes and the client is connected
	 */
	connect(): Promise<void>
	/**
	 * Discover a modern server's supported revisions and capabilities.
	 *
	 * @remarks
	 * The request carries the modern per-request metadata stamp. Unknown revisions in
	 * the peer's advertisement are ignored because {@link MCPDiscoverResult} exposes
	 * only revisions this client can negotiate.
	 *
	 * @returns The validated modern discovery result
	 */
	discover(): Promise<MCPDiscoverResult>
	/**
	 * Disconnect from the remote server — reject every pending request and close the
	 * transport.
	 *
	 * @remarks
	 * Idempotent — a second `disconnect` while already disconnected is a no-op. The
	 * `disconnect` event fires and {@link protocol} becomes `undefined`.
	 *
	 * @returns Resolves once the transport is closed
	 */
	disconnect(): Promise<void>
	/**
	 * List the remote server's tools, each wrapped as a local {@link ToolInterface}
	 * whose `execute` runs the remote `tools/call` via {@link call}.
	 *
	 * @remarks
	 * Runs `tools/list` and maps each descriptor: `name` (narrowed to a string),
	 * `description`, and `inputSchema` → `parameters` (the inverse of the server's
	 * `parameters` → `inputSchema` rename). Add the returned tools to an agent's
	 * {@link ToolManagerInterface} to give it the remote tools.
	 *
	 * @returns The remote tools as local {@link ToolInterface}s, in server order
	 */
	tools(): Promise<readonly ToolInterface[]>
	/**
	 * Call a remote tool by name and return its value — runs `tools/call`, concats the
	 * result's `text` content blocks, and either parses the JSON value or throws.
	 *
	 * @remarks
	 * The inverse of the server's `buildCallResult`: a SUCCESS parses the concatenated
	 * `text` as JSON (falling back to the raw string when it is not JSON); a remote tool
	 * FAILURE (`isError: true`) THROWS an `Error` carrying the error text — so an agent's
	 * {@link ToolManagerInterface} isolates the remote failure into a `success: false`
	 * result exactly as it would a local tool throw.
	 *
	 * @param name - The remote tool's name
	 * @param args - The arguments record forwarded as the call's `arguments`
	 * @returns The remote tool's value (parsed JSON, or the raw text)
	 */
	call(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown>
}
