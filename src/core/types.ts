import type { EmitterErrorHandler, EmitterHooks, EmitterInterface } from '@orkestrel/emitter'
import type { JSONValue } from '@orkestrel/contract'
import type { ToolCall, ToolInterface, ToolManagerInterface, ToolResult } from '@orkestrel/tool'

// Wire-modelling types carry protocol field names verbatim. Everywhere the library
// speaks for itself, the repository naming laws bind fully (`identity`, `instructions`,
// `cache.ttl`, `version`, `discover()`, and `era`).

// JSON-RPC 2.0 wire types (https://www.jsonrpc.org/specification) — the envelope
// the Model Context Protocol speaks. An INVOCATION is either a request (a `method`
// call carrying an `id` that correlates it with its response) or a notification (the
// same call with NO `id`, answered by nothing). A RESPONSE is either a result arm or
// an error arm, never both.
//
// Several members below are declared `?: never`. That is not an optional value: it is
// the protocol's own prohibition expressed in the type system, so the shape a
// carrier must not have cannot be built or assigned. `id?: never` is why a stream
// cannot yield a request, and `result?: never` / `error?: never` are why a response
// cannot carry both arms. Each also makes its member a DISCRIMINANT, so
// `invocation.id === undefined` and `response.error === undefined` narrow the union
// at the one place a caller asks.

/** A JSON-RPC 2.0 correlation id — the value a request and its response share. */
export type JSONRPCId = string | number

/**
 * A JSON-RPC 2.0 request — a `method` call with optional `params`, correlated to
 * its response by the `id` it REQUIRES.
 *
 * @remarks
 * `jsonrpc` is the literal `'2.0'`. A call with no `id` is not a request at all: it
 * is a {@link JSONRPCNotification}, a distinct type. `params` is an open record
 * forwarded to the method handler (the handler narrows the fields it reads).
 */
export interface JSONRPCRequest {
	readonly jsonrpc: '2.0'
	readonly method: string
	/** Correlates the request with its response. */
	readonly id: JSONRPCId
	/** The method's open argument record (narrowed by the handler). */
	readonly params?: Readonly<Record<string, unknown>>
}

/**
 * A JSON-RPC 2.0 notification — a fire-and-forget `method` call that is answered by
 * nothing (for example, `notifications/initialized`).
 *
 * @remarks
 * A notification MUST NOT carry an `id`, so `id` is declared `never`: a
 * {@link JSONRPCRequest} is not assignable here, which is what keeps a
 * request off a notification stream.
 */
export interface JSONRPCNotification {
	readonly jsonrpc: '2.0'
	readonly method: string
	/** Forbidden — an id is what makes a call a {@link JSONRPCRequest} instead. */
	readonly id?: never
	/** The method's open argument record (narrowed by the handler). */
	readonly params?: Readonly<Record<string, unknown>>
}

/**
 * One inbound JSON-RPC call — the common dispatch input.
 *
 * @remarks
 * Narrow the arms apart on the id: `invocation.id === undefined` is the notification
 * arm, and anything else is a {@link JSONRPCRequest}.
 */
export type JSONRPCInvocation = JSONRPCRequest | JSONRPCNotification

/**
 * A JSON-RPC 2.0 error object — the `error` member of a
 * {@link JSONRPCErrorResponse}.
 *
 * @remarks
 * `code` is one of the reserved JSON-RPC codes (see `./constants.js`); `message`
 * is a short human description; `data` is an OPTIONAL machine-readable payload
 * carrying extra detail.
 */
export interface JSONRPCError {
	readonly code: number
	readonly message: string
	readonly data?: unknown
}

/**
 * The success arm of a JSON-RPC 2.0 response — the request's `id` echoed with the
 * method's `result`.
 *
 * @remarks
 * A result answers a request, and a request always has a readable `id`, so `id` is
 * REQUIRED here. `result` is an {@link MCPResult} on the modern wire and an
 * {@link MCPLegacyResult} on the legacy one; `error` is forbidden.
 */
export interface JSONRPCResultResponse {
	readonly jsonrpc: '2.0'
	readonly id: JSONRPCId
	readonly result: MCPResult | MCPLegacyResult
	/** Forbidden — an answer carries a result or an error, never both. */
	readonly error?: never
}

/**
 * The failure arm of a JSON-RPC 2.0 response — the request's `id` echoed with the
 * {@link JSONRPCError} that ended it.
 *
 * @remarks
 * `id` is OMITTED, never `null`, when the request could not be parsed or its id
 * read: MCP overrides the base specification here, so a modern peer receives an
 * envelope with no `id` member at all. `result` is forbidden.
 */
export interface JSONRPCErrorResponse {
	readonly jsonrpc: '2.0'
	/** The failed request's id; ABSENT when no id could be read. */
	readonly id?: JSONRPCId
	readonly error: JSONRPCError
	/** Forbidden — an answer carries a result or an error, never both. */
	readonly result?: never
}

/**
 * A JSON-RPC 2.0 response — the answer to one {@link JSONRPCRequest}.
 *
 * @remarks
 * The arms are mutually exclusive in the type and in their guards. Narrow them
 * apart with `response.error === undefined`.
 */
export type JSONRPCResponse = JSONRPCResultResponse | JSONRPCErrorResponse

/**
 * A JSON-RPC 2.0 message on the wire — a {@link JSONRPCInvocation} or a
 * {@link JSONRPCResponse}.
 *
 * @remarks
 * `'method' in message` narrows to the invocation half; the response half carries
 * no `method`.
 */
export type JSONRPCMessage = JSONRPCInvocation | JSONRPCResponse

// MCP protocol shapes — the result payloads the dispatch methods return, mapped
// onto the JSON-RPC `result` member.

/**
 * One modern MCP result — the open contract every dated-revision result satisfies.
 *
 * @remarks
 * The dated schema requires a `resultType` on EVERY modern result and leaves the
 * rest of the object open, so this contract does the same: `resultType` is a string
 * rather than a closed union because the protocol keeps issuing new ones (`task`
 * alongside `complete` and `input_required`), and the index signature is the
 * schema's own openness rather than a gap in this package's knowledge.
 *
 * Concrete results — {@link MCPCallResult}, {@link MCPDiscoverResult},
 * {@link MCPListResult}, {@link MCPPromptListResult}, {@link MCPPromptGetResult},
 * {@link MCPCompletionResult}, {@link MCPInputResult}, and
 * {@link MCPSubscriptionResult} — stay CLOSED and keep their literal
 * `resultType`, so a caller that knows which method it called still narrows to a
 * literal through that result's guard. Openness lives here, at the arm a server may
 * answer any registered method through, and nowhere else.
 */
export interface MCPResult {
	/** The result's protocol discriminator (`'complete'`, `'input_required'`, or a later value). */
	readonly resultType: string
	/** Open modern protocol metadata, including reserved namespaced keys. */
	readonly _meta?: MCPResultMetaObject
	readonly [key: string]: unknown
}

/**
 * One legacy-era result — the payload of an answer produced by the fixed legacy
 * method switch.
 *
 * @remarks
 * The legacy revision has no result-discriminator concept, so a legacy result
 * carries NO `resultType`. That absence is the whole distinction, which is why it is
 * declared `never` rather than optional: an {@link MCPResult} is not assignable
 * here, this type is not assignable to {@link MCPResult}, and
 * `result.resultType === undefined` narrows a {@link JSONRPCResultResponse}'s
 * `result` to the legacy arm.
 *
 * This arm exists only for the optional legacy server decorator and client transport adapter.
 */
export interface MCPLegacyResult {
	/** Forbidden — the legacy revision has no result discriminator. */
	readonly resultType?: never
	readonly [key: string]: unknown
}

/** A modern protocol revision supported by the bare MCP server. */
export type MCPModernVersion = '2026-07-28'

/** A legacy protocol revision supported by the optional legacy decorators. */
export type MCPLegacyVersion = '2025-11-25' | '2025-06-18'

/** A protocol revision supported by an MCP package surface. */
export type MCPVersion = MCPModernVersion | MCPLegacyVersion

/**
 * Exact finite JSON metadata carried by MCP `_meta` envelopes.
 *
 * @remarks
 * The `Object` suffix is not a role suffix from the type table — it NAMES THE SHAPE.
 * `_meta` is a JSON object whose values are exact JSON, and a reader who sees
 * `MCPMeta` cannot tell that from a key, a string, or an entry. The same holds for
 * {@link MCPResultMetaObject} and {@link MCPSubscriptionResultMetaObject}, which are
 * that object narrowed by one reserved key each.
 */
export type MCPMetaObject = Readonly<Record<string, JSONValue>>

/** The dated logging levels accepted by MCP request metadata. */
export type MCPLoggingLevel =
	| 'debug'
	| 'info'
	| 'notice'
	| 'warning'
	| 'error'
	| 'critical'
	| 'alert'
	| 'emergency'

/** The open dated client-capability declaration carried by modern requests. */
export type MCPClientCapabilities = Readonly<Record<string, MCPMetaObject>> & {
	readonly experimental?: Readonly<Record<string, MCPMetaObject>>
	readonly roots?: MCPMetaObject
	readonly sampling?: MCPMetaObject & {
		readonly context?: MCPMetaObject
		readonly tools?: MCPMetaObject
	}
	readonly elicitation?: MCPMetaObject & {
		readonly form?: MCPMetaObject
		readonly url?: MCPMetaObject
	}
	readonly extensions?: Readonly<Record<string, MCPMetaObject>>
}

/** The open dated server-capability declaration returned by discovery. */
export type MCPServerCapabilities = Readonly<Record<string, MCPMetaObject>> & {
	readonly experimental?: Readonly<Record<string, MCPMetaObject>>
	readonly logging?: MCPMetaObject
	readonly completions?: MCPMetaObject
	readonly prompts?: MCPMetaObject & { readonly listChanged?: boolean }
	readonly resources?: MCPMetaObject & {
		readonly subscribe?: boolean
		readonly listChanged?: boolean
	}
	readonly tools?: MCPMetaObject & { readonly listChanged?: boolean }
	readonly extensions?: Readonly<Record<string, MCPMetaObject>>
}

/**
 * The wire era selected by an MCP request's structure.
 *
 * @remarks
 * `'modern'` and `'legacy'`, and not the boolean such a union would usually be: this is
 * a genuine protocol discriminant, not a behavioural switch. It names which
 * published wire shape a request took — a fact the request already carries — and it
 * is emitted on {@link MCPServerEventMap}'s `request` event, where an observer logs
 * or partitions by it. A boolean `modern` would publish the same fact under a name
 * that stops being readable the day another era exists.
 */
export type MCPEra = 'modern' | 'legacy'

/** The intended recipient of annotated MCP content. */
export type MCPRole = 'user' | 'assistant'

/** Optional audience, importance, and modification hints attached to MCP content. */
export interface MCPAnnotations {
	readonly audience?: readonly MCPRole[]
	readonly priority?: number
	readonly lastModified?: string
}

/** One sized, themed icon associated with an MCP resource link. */
export type MCPIcon = MCPMetaObject & {
	readonly src: string
	readonly mimeType?: string
	readonly sizes?: readonly string[]
	readonly theme?: 'light' | 'dark'
}

/** A textual MCP content block. */
export interface MCPTextContent {
	readonly type: 'text'
	readonly text: string
	readonly annotations?: MCPAnnotations
	readonly _meta?: MCPMetaObject
}

/** A base64-encoded image MCP content block. */
export interface MCPImageContent {
	readonly type: 'image'
	readonly data: string
	readonly mimeType: string
	readonly annotations?: MCPAnnotations
	readonly _meta?: MCPMetaObject
}

/** A base64-encoded audio MCP content block. */
export interface MCPAudioContent {
	readonly type: 'audio'
	readonly data: string
	readonly mimeType: string
	readonly annotations?: MCPAnnotations
	readonly _meta?: MCPMetaObject
}

/** A link to an MCP resource, including its exact dated-schema metadata. */
export interface MCPResourceLink {
	readonly type: 'resource_link'
	readonly name: string
	readonly title?: string
	readonly icons?: readonly MCPIcon[]
	readonly uri: string
	readonly description?: string
	readonly mimeType?: string
	readonly annotations?: MCPAnnotations
	readonly size?: number
	readonly _meta?: MCPMetaObject
}

/** One resource descriptor advertised by `resources/list`. */
export interface MCPResource {
	readonly uri: string
	readonly name: string
	readonly title?: string
	readonly description?: string
	readonly mimeType?: string
	readonly annotations?: MCPAnnotations
	readonly size?: number
	readonly icons?: readonly MCPIcon[]
	readonly _meta?: MCPMetaObject
}

/** One RFC 6570 resource-template descriptor advertised by `resources/templates/list`. */
export interface MCPResourceTemplate {
	readonly uriTemplate: string
	readonly name: string
	readonly title?: string
	readonly description?: string
	readonly mimeType?: string
	readonly annotations?: MCPAnnotations
	readonly icons?: readonly MCPIcon[]
	readonly _meta?: MCPMetaObject
}

/** One argument descriptor advertised with an MCP prompt. */
export interface MCPPromptArgument {
	readonly name: string
	readonly title?: string
	readonly description?: string
	readonly required?: boolean
}

/** One prompt descriptor advertised by `prompts/list`. */
export interface MCPPrompt {
	readonly name: string
	readonly title?: string
	readonly description?: string
	readonly arguments?: readonly MCPPromptArgument[]
	readonly icons?: readonly MCPIcon[]
	readonly _meta?: MCPMetaObject
}

/** One user or assistant message returned by `prompts/get`. */
export interface MCPPromptMessage {
	readonly role: 'user' | 'assistant'
	readonly content: MCPContent
}

/** Embedded textual resource contents. */
export interface MCPTextResource {
	readonly uri: string
	readonly mimeType?: string
	readonly _meta?: MCPMetaObject
	readonly text: string
}

/** Embedded base64-encoded resource contents. */
export interface MCPBlobResource {
	readonly uri: string
	readonly mimeType?: string
	readonly _meta?: MCPMetaObject
	readonly blob: string
}

/**
 * Resource contents returned by `resources/read`.
 *
 * @remarks
 * The wire has no tag field. Presence of `text` or `blob` is the structural
 * discriminator, and each arm forbids the other member so a value can carry exactly one.
 */
export type MCPResourceContents =
	| (MCPTextResource & { readonly blob?: never })
	| (MCPBlobResource & { readonly text?: never })

/** An MCP content block carrying embedded text or blob resource contents. */
export interface MCPEmbeddedResource {
	readonly type: 'resource'
	readonly resource: MCPTextResource | MCPBlobResource
	readonly annotations?: MCPAnnotations
	readonly _meta?: MCPMetaObject
}

/** One exact dated-schema tool content block. */
export type MCPContent =
	| MCPTextContent
	| MCPImageContent
	| MCPAudioContent
	| MCPResourceLink
	| MCPEmbeddedResource

/**
 * A `tools/call` result BEFORE the modern stamp — the executed tool's output as
 * `content` blocks, with `isError` flagging a tool failure.
 *
 * @remarks
 * The name states the whole distinction: this is the tool-call result WITHOUT
 * `resultType`, which is the only shape the legacy revision has for one.
 * {@link MCPCallResult} is this payload plus the modern `'complete'` stamp, so
 * stamping is the one difference between the modern and legacy answers to `tools/call`.
 * `MCPServer` produces it before modern stamping, and `MCPLegacy` projects the
 * stamped answer back to this shape.
 *
 * A success carries the tool's value unchanged as `structuredContent` alongside
 * its serialized form in one `text` content block. A value-less success omits
 * `structuredContent`. A tool FAILURE (the `success: false` branch the registry
 * isolated) carries its `error` text in `content` AND sets `isError: true`, so the
 * model sees the failure as a tool result it can react to rather than a protocol
 * error.
 */
export type MCPUnstampedCallResult = {
	readonly content: readonly MCPContent[]
	/** The successful tool value in its original structure; absent when no value was returned. */
	readonly structuredContent?: JSONValue
	/** `true` when the tool failed — its error text is in `content`. */
	readonly isError?: boolean
	/** Open modern protocol metadata, including reserved namespaced keys. */
	readonly _meta?: MCPResultMetaObject
}

/** A required complete modern `tools/call` result. */
export type MCPCallResult = MCPUnstampedCallResult & { readonly resultType: 'complete' }

/** The primitive value shapes accepted in an MCP form elicitation response. */
export type MCPElicitValue = string | number | boolean | readonly string[]

/** One titled value in a form elicitation's single- or multi-select schema. */
export interface MCPElicitChoice {
	readonly const: string
	readonly title: string
}

/** One restricted single-field schema accepted by MCP form-mode elicitation. */
export type MCPElicitFieldSchema =
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
	  }
	| {
			readonly type: 'string'
			readonly title?: string
			readonly description?: string
			readonly enum: readonly string[]
			readonly default?: string
	  }
	| {
			readonly type: 'string'
			readonly title?: string
			readonly description?: string
			readonly oneOf: readonly MCPElicitChoice[]
			readonly default?: string
	  }
	| {
			readonly type: 'string'
			readonly title?: string
			readonly description?: string
			readonly enum: readonly string[]
			readonly enumNames: readonly string[]
			readonly default?: string
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
						readonly anyOf: readonly MCPElicitChoice[]
				  }
	  }

/** The restricted top-level object schema carried by a form-mode elicitation request. */
export interface MCPElicitSchema extends Readonly<Record<string, unknown>> {
	readonly $schema?: string
	readonly type: 'object'
	readonly properties: Readonly<Record<string, MCPElicitFieldSchema>>
	readonly required?: readonly string[]
}

/** The parameters of a form-mode `elicitation/create` request. */
export interface MCPElicitForm {
	readonly mode?: 'form'
	readonly message: string
	readonly requestedSchema: MCPElicitSchema
}

/** The parameters of a URL-mode `elicitation/create` request. */
export interface MCPElicitURL {
	readonly mode: 'url'
	readonly message: string
	readonly url: string
}

/** The mode-discriminated parameters of an `elicitation/create` request. */
export type MCPElicitParams = MCPElicitForm | MCPElicitURL

/** An embedded MCP request asking the client to elicit input from its operator. */
export interface MCPElicitRequest {
	readonly method: 'elicitation/create'
	readonly params: MCPElicitParams
}

/** The result supplied by a client for one embedded {@link MCPElicitRequest}. */
export interface MCPElicitResult {
	readonly action: 'accept' | 'decline' | 'cancel'
	readonly content?: Readonly<Record<string, MCPElicitValue>>
}

/**
 * One embedded multi-round-trip request.
 *
 * @remarks
 * This package produces only {@link MCPElicitRequest}. The deprecated sampling and roots
 * requests remain legal protocol union members and therefore retain their open parameter
 * records here without gaining package-owned producers.
 */
export type MCPInputRequest =
	| MCPElicitRequest
	| {
			readonly method: 'sampling/createMessage'
			readonly params: Readonly<Record<string, unknown>>
	  }
	| {
			readonly method: 'roots/list'
			readonly params?: Readonly<Record<string, unknown>>
	  }

/** A server-keyed map of embedded requests the client must fulfil. */
export type MCPInputRequestMap = Readonly<Record<string, MCPInputRequest>>

/**
 * An incomplete modern result carrying input requests, protected request state, or both.
 *
 * @remarks
 * The union enforces the protocol's at-least-one-of rule at the type boundary:
 * every value has `inputRequests`, `requestState`, or both.
 */
export type MCPInputResult =
	| {
			readonly resultType: 'input_required'
			readonly inputRequests: MCPInputRequestMap
			readonly requestState?: string
			readonly _meta?: MCPResultMetaObject
	  }
	| {
			readonly resultType: 'input_required'
			readonly inputRequests?: MCPInputRequestMap
			readonly requestState: string
			readonly _meta?: MCPResultMetaObject
	  }

/**
 * The integrity-protected payload carried inside an opaque `requestState` token.
 *
 * @remarks
 * `id` is the FIRST round's request id and stays bound across every later round, so a
 * multi-round exchange remains one correlated call rather than a chain whose origin is lost
 * after the second hop. `schema` is the EXACT schema that was issued with the round it
 * protects: a schema that is bound but never enforced buys nothing, so an accepted response
 * is checked against this member by {@link isElicitContent} before the tool runs. `key`,
 * `expiry`, and `schema` are re-minted every round; `principal`, `id`, `version`, `method`,
 * `name`, and `digest` are the bindings that must not move.
 */
export interface MCPInputState {
	readonly principal: string
	readonly expiry: number
	readonly id: JSONRPCId
	readonly version: string
	readonly method: string
	readonly key: string
	readonly name: string
	readonly digest: string
	/** The exact schema issued with this round, enforced on the accepted response. */
	readonly schema: MCPElicitSchema
	readonly state?: JSONValue
}

/** The call-in-hand context supplied to an {@link MCPInputHandler}. */
export interface MCPInputContext {
	readonly request: JSONRPCRequest
	readonly name: string
	readonly arguments: Readonly<Record<string, unknown>>
	readonly response?: MCPElicitResult
	readonly state?: JSONValue
}

/** One consumer-requested form elicitation, before MCP assigns its map key and signs state. */
export interface MCPElicitation {
	readonly request: MCPElicitForm
	readonly state?: JSONValue
}

/** Host-neutral integrity and storage port for opaque MRTR continuation state. */
export interface MCPContinuationInterface {
	/** Protects a canonical state string and returns the opaque client carrier. */
	seal(value: string): Promise<string>
	/** Recovers a protected canonical state string, or `undefined` when invalid. */
	open(value: string): Promise<string | undefined>
}

/**
 * Decides whether the current `tools/call` needs operator input.
 *
 * @param context - The original call plus a verified response/state on a retry
 * @param options - The resolved per-request method options
 * @returns A form elicitation to send, or `undefined` to continue into the tool registry
 */
export type MCPInputHandler = (
	context: MCPInputContext,
	options: MCPMethodOptions,
) => MCPElicitation | undefined | Promise<MCPElicitation | undefined>

/**
 * Derives the deployment-authenticated principal bound into signed request state.
 *
 * @param request - The parsed `tools/call` request
 * @param options - The resolved per-request method options
 * @returns The authenticated principal to bind into protected state
 */
export type MCPPrincipalHandler = (
	request: JSONRPCRequest,
	options: MCPMethodOptions,
) => string | Promise<string>

/** Consumer policy for the server's multi-round-trip input mechanism. */
export interface MCPInputOptions {
	/** Host-neutral integrity/storage port for the opaque continuation carrier. */
	readonly continuation: MCPContinuationInterface
	/** Continuation lifetime in milliseconds; required so MCP never invents an expiry policy. */
	readonly ttl: number
	/** Resolves the authenticated principal for the call in hand. */
	readonly principal: MCPPrincipalHandler
	/** Decides whether the call needs a form elicitation, including on verified retries. */
	readonly elicit: MCPInputHandler
}

/** One official request-scoped progress payload. */
export interface MCPProgress {
	readonly progress: number
	readonly total?: number
	readonly message?: string
}

/** Backpressured request-scoped progress reporter supplied to an explicit executor. */
export interface MCPProgressInterface {
	/** Reports one finite, strictly increasing progress value and awaits its consumption. */
	report(progress: MCPProgress): Promise<void>
}

/**
 * Receives one progress report a peer published for a request this client issued.
 *
 * @remarks
 * The RECEIVING half of {@link MCPProgressInterface}, and deliberately not its mirror:
 * the reporter awaits consumption because a server must not outrun the stream carrying
 * its frames, while a client consuming an already-delivered frame has nothing left to
 * push back on. So this returns `void` — a handler that throws is isolated by nothing
 * and would surface on the client's `error` event, and one that needs to await
 * something owns that lifetime itself.
 *
 * The handler is registered for the LIFETIME OF ONE REQUEST and is released the moment
 * that request settles, whichever way it settles. A frame that arrives afterwards is a
 * late frame for a request nobody is waiting on, and reaches the `notification` event
 * like any other unclaimed server-initiated message.
 */
export type MCPProgressHandler = (progress: MCPProgress) => void

/** The explicit, host-neutral context for one modern tool execution. */
export interface MCPExecutionContext {
	readonly request: JSONRPCRequest
	readonly call: ToolCall
	readonly tools: ToolManagerInterface
	readonly signal: AbortSignal
	readonly progress?: MCPProgressInterface
}

/** Executes one canonical tool call or return a fully formed complete MCP result. */
export type MCPExecutionHandler = (
	context: MCPExecutionContext,
) => ToolResult | MCPCallResult | Promise<ToolResult | MCPCallResult>

// THE TASKS EXTENSION — a `tools/call` policy, beside the input
// mechanism and the execution handler above. A TASK is a durable operation that
// OUTLIVES the request that created it: the server answers `resultType: 'task'`
// immediately, and the client comes back for the outcome later.
//
// The extension is the STABLE, immutable snapshot dated 2026-07-28
// (`io.modelcontextprotocol/tasks`), whose generated schema id is
// `https://modelcontextprotocol.io/ext-tasks/2026-07-28/schema.json`. That snapshot is
// fixed, so every type in this family is written against it and a later revision arrives
// as its own dated snapshot rather than as a change to this one.
//
// The whole of it is CONSUMER-OWNED. This package decides one thing — whether the
// call in hand is deferred — and otherwise carries requests to the manager below
// and its answers back: `tasks/get` reports a snapshot, `tasks/update` forwards
// responses verbatim, `tasks/cancel` forwards an advisory ask.
// It stores no task, runs no timer, and derives no status, because a durable
// operation outlives the process that answered the request and MCP has no durable
// place to keep one. Read that as the contract it is: everything a task does
// between creation and its terminal status happens somewhere this package cannot
// see, so every obligation the extension states lands on the manager below rather
// than on the server.

/**
 * The lifecycle state of one durable task.
 *
 * @remarks
 * `completed`, `failed`, and `cancelled` are TERMINAL: a task that reaches one never
 * moves again. `failed` reports that the deferred call could not be executed at all —
 * a JSON-RPC-level failure. A tool that RAN and returned an error is `completed`
 * carrying an `isError: true` result, exactly as an inline `tools/call` would answer,
 * because the deferral must not change what the tool's own failure means.
 *
 * `input_required` collides by spelling with {@link MCPInputResult}'s `resultType`
 * and is a DIFFERENT mechanism: that one suspends a live request and resumes through
 * a protected `requestState` on the next `tools/call`, while this one suspends a
 * durable task and resumes through `tasks/update`. Neither spelling is this package's
 * to change — both are on the wire.
 */
export type MCPTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled'

/**
 * One durable task's wire snapshot — the payload a deferred `tools/call` answers with.
 *
 * @remarks
 * Every field name here is a WIRE SPELLING carried verbatim from the extension's
 * schema, so the compound-member prohibition does not reach them; the type NAME is
 * this library's own. `ttlMs` is `null` — not absent — when the task has no expiry,
 * because the schema distinguishes absence from `null`. `createdAt` and `lastUpdatedAt` are
 * described as ISO 8601 instants, though the generated schema validates only a
 * string, so this package carries whatever the manager produced without reformatting
 * it. `pollIntervalMs` is the manager's hint about how often the client can ask
 * again; a manager that pushes notifications instead simply omits it.
 */
export type MCPTask = {
	/** The durable handle a later `tasks/get` / `tasks/update` / `tasks/cancel` names. */
	readonly taskId: string
	readonly status: MCPTaskStatus
	/** Optional human-readable detail about the current status. */
	readonly statusMessage?: string
	readonly createdAt: string
	readonly lastUpdatedAt: string
	/** Remaining lifetime in milliseconds, or `null` when the task does not expire. */
	readonly ttlMs: number | null
	/** Suggested milliseconds between polls; absent when the manager suggests none. */
	readonly pollIntervalMs?: number
}

/**
 * One task snapshot together with whatever its status carries — the shape `tasks/get`
 * and a task notification report.
 *
 * @remarks
 * The union is the schema's own: `input_required` carries the requests to answer,
 * `completed` carries the deferred call's result, `failed` carries the JSON-RPC error
 * that ended it, and `working` / `cancelled` carry nothing extra. Narrow on `status`.
 *
 * `result` is an OPEN RECORD rather than an {@link MCPResult} or an
 * {@link MCPCallResult}, because the schema declares it one: a completed task's payload
 * is whatever the deferred method answered, and the extension constrains nothing inside
 * it — not even a `resultType`. Only `tools/call` can be deferred today, and the
 * extension says nothing that fixes the payload to one method forever, so a reader that
 * knows which call it deferred narrows this record with that method's own guard.
 */
export type MCPTaskDetail =
	| (MCPTask & { readonly status: 'working' })
	| (MCPTask & { readonly status: 'input_required'; readonly inputRequests: MCPInputRequestMap })
	| (MCPTask & {
			readonly status: 'completed'
			readonly result: Readonly<Record<string, unknown>>
	  })
	| (MCPTask & { readonly status: 'failed'; readonly error: JSONRPCError })
	| (MCPTask & { readonly status: 'cancelled' })

/**
 * The wire answer to `tasks/get` — one snapshot under the completed-result stamp.
 *
 * @remarks
 * DISTINCT from {@link MCPTaskDetail}, and the distinction is the whole point. A detail is
 * what the consumer's {@link MCPTaskManagerInterface} answers, unstamped, because a durable
 * store knows nothing about the request that read it. This is what a `tasks/get` REPLY
 * carries: the schema types that reply as the detail intersected with the standard result,
 * so `resultType: 'complete'` is required rather than incidental and a peer that omits it
 * has answered something other than the method's declared result.
 *
 * `complete`, not `task`. Only the creation answer ({@link MCPTaskResult}) carries
 * `resultType: 'task'`; reading a task is an ordinary completed call whose payload happens
 * to be a task.
 */
export type MCPTaskDetailResult = MCPTaskDetail & {
	readonly resultType: 'complete'
	/** Open modern protocol metadata, including reserved namespaced keys. */
	readonly _meta?: MCPResultMetaObject
}

/**
 * The parameters of a `notifications/tasks` frame — one snapshot, flat, optionally stamped
 * with the subscription that delivered it.
 *
 * @remarks
 * FLAT, and that is the schema's shape rather than a choice: the extension types these
 * parameters as the notification envelope intersected with the detail, so every task field
 * sits directly under `params` and no `task` wrapper member exists. Narrow on `status`
 * exactly as with {@link MCPTaskDetail}.
 *
 * The index signature is the envelope's own openness, carried through. `_meta` is optional
 * because the reserved subscription stamp is present only on a frame delivered down a
 * `subscriptions/listen` stream and absent on one delivered any other way — see
 * {@link MCPNotificationMetaObject}.
 */
export type MCPTaskNotificationParams = MCPTaskDetail & {
	/** Open notification metadata, including the reserved subscription stamp. */
	readonly _meta?: MCPNotificationMetaObject
	readonly [key: string]: unknown
}

/**
 * The modern `tools/call` result announcing that the call became a durable task.
 *
 * @remarks
 * The only result in this package whose `resultType` is `'task'`. It is FLAT — the
 * task's fields sit beside the discriminator rather than under a `task` member — and
 * it carries no terminal payload, because a task that has just been created has no
 * outcome yet. The outcome arrives through {@link MCPTaskDetail}.
 */
export type MCPTaskResult = MCPTask & {
	readonly resultType: 'task'
	/** Open modern protocol metadata, including reserved namespaced keys. */
	readonly _meta?: MCPResultMetaObject
}

/**
 * The call-in-hand context supplied to an {@link MCPTaskHandler} and to
 * {@link MCPTaskManagerInterface.start}.
 *
 * @remarks
 * It carries NO cancellation signal, and that absence is deliberate rather than an
 * omission. The signal on the accompanying {@link MCPMethodOptions} is the REQUEST's
 * lifetime, and a deferred request ends the moment its `resultType: 'task'` answer is
 * written — a transport aborts it as soon as the response body is flushed. A manager
 * that plumbs `options.signal` into the task's work therefore loses every task it
 * creates, milliseconds after creating it, and the loss looks exactly like a client
 * that disconnected. Use `options.signal` for work that must finish before the
 * ANSWER is written, and give the task's own work a lifetime the manager owns.
 *
 * `call` is the canonical tool call the deferral is standing in for, so a manager
 * needs nothing from `request.params` to run the work; `request` is supplied whole
 * because the deferral decision legitimately reads metadata the call does not carry.
 * `tools` is the same live registry the inline path would have executed against.
 */
export interface MCPTaskContext {
	readonly request: JSONRPCRequest
	readonly call: ToolCall
	readonly tools: ToolManagerInterface
}

/**
 * The consumer-owned durable store behind the Tasks extension — the port this package
 * creates tasks through and reads them back from.
 *
 * @remarks
 * There is deliberately NO plural accessor. The extension defines no `tasks/list`, and
 * a port that could enumerate tasks would invite one; the absence is how this contract
 * states the non-goal.
 *
 * {@link task} answers `undefined` for a task that never existed, one whose TTL purged
 * it, AND one this caller is not entitled to see. They are indistinguishable ON
 * PURPOSE: they all become the same `-32602`, so a `taskId` cannot be probed for
 * existence. A manager that distinguishes them — by throwing for the unauthorized case,
 * say — turns its own store into an enumeration oracle no matter what this package does.
 *
 * Every method receives the resolved per-request options and is expected to
 * AUTHORIZE the call itself: the extension requires authorization on each task request,
 * and this package has no principal of its own to check one against.
 */
export interface MCPTaskManagerInterface {
	/**
	 * Creates — or return the existing — durable task for one stable operation key.
	 *
	 * @remarks
	 * The obligations this package cannot enforce, and one consequence that is easy
	 * to miss:
	 *
	 * - **Durability before return.** The returned task MUST already be retrievable by
	 *   {@link task} when this resolves. This package awaits `start` before it builds the
	 *   answer, which is its whole half of that rule; a manager that resolves before its
	 *   write lands hands the client a `taskId` that a prompt `tasks/get` cannot find.
	 * - **A `taskId` must resist enumeration.** It is a bearer handle over a durable
	 *   operation. Mint it from a cryptographic source; do not derive it from `key`, from
	 *   a counter, or from anything a caller can predict.
	 * - **Deduplicate by key, and SCOPE THE KEY TO ITS PRINCIPAL.** Returning the existing
	 *   task for a repeated key is what makes a retried call idempotent. But a key that is
	 *   not scoped to the caller means two principals submitting the same key receive the
	 *   SAME task — one principal reading another's work through a handle it merely
	 *   guessed. This package forwards `key` unchanged, exactly as the handler produced
	 *   it, and has no principal to scope it by; the scoping belongs here, or in the
	 *   handler that mints the key.
	 *
	 * @param key - The stable operation key, forwarded unchanged from {@link MCPTaskHandler}
	 * @param context - The call in hand (see {@link MCPTaskContext} — it carries no signal)
	 * @param options - The resolved per-request method options
	 * @returns The durable task, already retrievable by {@link task}
	 */
	start(key: string, context: MCPTaskContext, options: MCPMethodOptions): Promise<MCPTask>
	/**
	 * Reads one task's current snapshot.
	 *
	 * @remarks
	 * EVERY `tasks/*` method runs through here first, not only `tasks/get`. {@link update}
	 * and {@link abort} answer `void`, so neither has a way to say "no such task" and neither
	 * can be the place authorization is decided; this is. Expect one read of the named task
	 * before every update and every cancellation, and expect an `undefined` answer to end that
	 * request before the second call is made.
	 *
	 * @param id - The `taskId` the client asked about
	 * @param options - The resolved per-request method options
	 * @returns The task's detail, or `undefined` when it is unknown, purged, or not this caller's
	 */
	task(id: string, options: MCPMethodOptions): Promise<MCPTaskDetail | undefined>
	/**
	 * Answers the input requests an `input_required` task is waiting on.
	 *
	 * @remarks
	 * Responses are keyed by the request keys the task published. A key the task does not
	 * recognize, or has already been answered, is IGNORED rather than refused, and a
	 * partial set of answers is acceptable. This package forwards the client's record
	 * VERBATIM — it holds none of the task's keys, so the ignoring is this method's to do.
	 *
	 * This is the SECOND multi-round-trip mechanism in the package, and it is the weaker one.
	 * The elicitation path binds each round with a sealed `requestState`, an argument digest,
	 * an absolute expiry, and the resolved principal; this path has none of them, because MCP
	 * neither issued the question nor owns the channel it is answered on. Anything equivalent
	 * has to live here: bind each published key to the principal that may answer it, expire
	 * unanswered keys, and treat a response that arrives after the task moved on as stale.
	 *
	 * @param id - The `taskId` the responses belong to
	 * @param responses - The client's answers, keyed by the task's own request keys
	 * @param options - The resolved per-request method options
	 */
	update(
		id: string,
		responses: Readonly<Record<string, unknown>>,
		options: MCPMethodOptions,
	): Promise<void>
	/**
	 * Asks one task to stop.
	 *
	 * @remarks
	 * Cancellation is COOPERATIVE: a task that has already finished, or one whose work
	 * cannot be interrupted, may legally reach `completed` after this resolves. The
	 * acknowledgement says the request was accepted, never that the task stopped.
	 *
	 * @param id - The `taskId` to stop
	 * @param options - The resolved per-request method options
	 */
	abort(id: string, options: MCPMethodOptions): Promise<void>
}

/**
 * Decides whether the `tools/call` in hand becomes a durable task.
 *
 * @remarks
 * Deferral is entirely the SERVER's decision. The extension gives a client no flag and
 * no parameter to ask for a task; the client only declares that it can cope with one.
 * So this handler is where the policy lives — long-running tool, queue depth, caller
 * tier, time of day — and it is consulted only for a client that declared the
 * capability on the request in hand.
 *
 * The returned string is the STABLE OPERATION KEY the manager deduplicates on: the same
 * logical call must produce the same key, and two different calls must not. Mint it from
 * the CALLER and the canonical call — never from `call.id`, which is the client's own
 * JSON-RPC request id: a retry of one logical call changes it, so dedup never fires, and
 * two principals whose clients both started counting at 1 collide on it.
 *
 * Returning `undefined` runs the call inline in the ordinary way, which is always a legal
 * answer, and it is the only spelling of that answer. An empty string is not a second one:
 * it cannot identify an operation, so it is refused as `-32603` rather than quietly routed
 * down the inline path where nobody would find it.
 *
 * @param context - The call in hand (see {@link MCPTaskContext} — it carries no signal)
 * @param options - The resolved per-request method options
 * @returns The stable operation key to defer under, or `undefined` to run the call inline
 */
export type MCPTaskHandler = (
	context: MCPTaskContext,
	options: MCPMethodOptions,
) => string | undefined | Promise<string | undefined>

/**
 * Consumer policy for the server's stable Tasks extension.
 *
 * @remarks
 * Supplying this is what turns the extension on: an unconfigured server advertises
 * nothing, defers nothing, and answers the `tasks/*` methods `-32601` — the honest
 * reply from a server that does not implement an optional extension.
 */
export interface MCPTaskOptions {
	/** The durable store the server creates tasks in and reads them back from. */
	readonly tasks: MCPTaskManagerInterface
	/** Decides whether the call in hand is deferred, and under which stable key. */
	readonly defer: MCPTaskHandler
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

/** Shared cursor parameters for every paginated modern list method. */
export interface MCPPaginationParams {
	/** Opaque cursor returned by the preceding page. */
	readonly cursor?: string
}

/** Shared cursor result fields for every paginated modern list method. */
export interface MCPPaginationResult {
	/** Opaque cursor for the following page; absent when this is the final page. */
	readonly nextCursor?: string
}

/** One consumer-owned page projected by `resources/list`. */
export interface MCPResourcePage extends MCPPaginationResult {
	readonly resources: readonly MCPResource[]
}

/** One consumer-owned page projected by `resources/templates/list`. */
export interface MCPResourceTemplatePage extends MCPPaginationResult {
	readonly resourceTemplates: readonly MCPResourceTemplate[]
}

/** One consumer-owned page projected by `prompts/list`. */
export interface MCPPromptPage extends MCPPaginationResult {
	readonly prompts: readonly MCPPrompt[]
}

/** Parameters accepted by `resources/read`. */
export interface MCPResourceReadParams {
	readonly uri: string
	readonly inputResponses?: Readonly<Record<string, unknown>>
	readonly requestState?: string
}

/** Parameters accepted by `prompts/get`. */
export interface MCPPromptGetParams {
	readonly name: string
	readonly arguments?: Readonly<Record<string, string>>
	readonly inputResponses?: Readonly<Record<string, unknown>>
	readonly requestState?: string
}

/** The complete cacheable `resources/list` result. */
export type MCPResourceListResult = MCPResourcePage & {
	readonly resultType: 'complete'
	readonly ttlMs: number
	readonly cacheScope: 'public' | 'private'
	readonly _meta?: MCPResultMetaObject
}

/** The complete cacheable `resources/read` result. */
export type MCPResourceReadResult = {
	readonly contents: readonly MCPResourceContents[]
	readonly resultType: 'complete'
	readonly ttlMs: number
	readonly cacheScope: 'public' | 'private'
	readonly _meta?: MCPResultMetaObject
}

/** The complete cacheable `resources/templates/list` result. */
export type MCPResourceTemplateListResult = MCPResourceTemplatePage & {
	readonly resultType: 'complete'
	readonly ttlMs: number
	readonly cacheScope: 'public' | 'private'
	readonly _meta?: MCPResultMetaObject
}

/** The complete cacheable `prompts/list` result. */
export type MCPPromptListResult = MCPPromptPage & {
	readonly resultType: 'complete'
	readonly ttlMs: number
	readonly cacheScope: 'public' | 'private'
	readonly _meta?: MCPResultMetaObject
}

/** The complete, non-cacheable `prompts/get` result. */
export interface MCPPromptGetResult {
	readonly resultType: 'complete'
	readonly description?: string
	readonly messages: readonly MCPPromptMessage[]
	readonly _meta?: MCPResultMetaObject
}

/**
 * Consumer-supplied resource registry port.
 *
 * @remarks
 * MCP owns no storage. The host may back this port with memory, a workspace, a database,
 * or any other registry. The list methods carry the shared cursor contract verbatim;
 * `resource` returns `undefined` when the URI does not resolve and may instead return an
 * {@link MCPInputResult} for a modern multi-round interaction.
 */
export interface MCPResourceManagerInterface {
	/**
	 * Reads one resource page.
	 *
	 * @param pagination - The optional opaque cursor
	 * @param options - The resolved per-request options
	 * @returns The advertised resources and optional following-page cursor
	 */
	resources(
		pagination: MCPPaginationParams,
		options: MCPMethodOptions,
	): MCPResourcePage | Promise<MCPResourcePage>
	/**
	 * Reads one concrete resource URI.
	 *
	 * @param params - The URI and optional multi-round response carrier
	 * @param options - The resolved per-request options
	 * @returns Resource contents, an input-required result, or `undefined` when not found
	 */
	resource(
		params: MCPResourceReadParams,
		options: MCPMethodOptions,
	):
		| readonly MCPResourceContents[]
		| MCPInputResult
		| undefined
		| Promise<readonly MCPResourceContents[] | MCPInputResult | undefined>
	/**
	 * Reads one resource-template page.
	 *
	 * @remarks
	 * `uriTemplate` values are RFC 6570 strings. Expansion belongs to the manager that resolves
	 * the later concrete URI; MCP does not expand a template or impose a storage policy.
	 *
	 * @param pagination - The optional opaque cursor
	 * @param options - The resolved per-request options
	 * @returns The advertised templates and optional following-page cursor
	 */
	templates(
		pagination: MCPPaginationParams,
		options: MCPMethodOptions,
	): MCPResourceTemplatePage | Promise<MCPResourceTemplatePage>
}

/**
 * Consumer-supplied prompt registry port.
 *
 * @remarks
 * MCP owns no prompt storage. The host projects one shared-cursor page at a time and resolves
 * a named prompt to its messages, an input-required result, or `undefined` when not found.
 */
export interface MCPPromptManagerInterface {
	/**
	 * Reads one prompt page.
	 *
	 * @param pagination - The optional opaque cursor
	 * @param options - The resolved per-request options
	 * @returns The advertised prompts and optional following-page cursor
	 */
	prompts(
		pagination: MCPPaginationParams,
		options: MCPMethodOptions,
	): MCPPromptPage | Promise<MCPPromptPage>
	/**
	 * Resolves one named prompt.
	 *
	 * @param params - The prompt name, string arguments, and optional multi-round response carrier
	 * @param options - The resolved per-request options
	 * @returns A complete prompt result, an input-required result, or `undefined` when not found
	 */
	prompt(
		params: MCPPromptGetParams,
		options: MCPMethodOptions,
	):
		| MCPPromptGetResult
		| MCPInputResult
		| undefined
		| Promise<MCPPromptGetResult | MCPInputResult | undefined>
}

/** A completion reference to one named prompt. */
export interface MCPPromptReference {
	readonly type: 'ref/prompt'
	readonly name: string
}

/** A completion reference to one resource-template URI descriptor. */
export interface MCPResourceTemplateReference {
	readonly type: 'ref/resource'
	readonly uri: string
}

/** The prompt or resource-template reference accepted by `completion/complete`. */
export type MCPCompletionReference = MCPPromptReference | MCPResourceTemplateReference

/** The argument fragment being completed. */
export interface MCPCompletionArgument {
	readonly name: string
	readonly value: string
}

/** Previously resolved string arguments supplied as completion context. */
export interface MCPCompletionContext {
	readonly arguments?: Readonly<Record<string, string>>
}

/** Parameters accepted by `completion/complete`. */
export interface MCPCompletionParams {
	readonly ref: MCPCompletionReference
	readonly argument: MCPCompletionArgument
	readonly context?: MCPCompletionContext
}

/** One completion candidate set before the protocol's 100-value projection cap. */
export interface MCPCompletion {
	readonly values: readonly string[]
	readonly total?: number
	readonly hasMore?: boolean
}

/** The complete `completion/complete` result. */
export interface MCPCompletionResult {
	readonly resultType: 'complete'
	readonly completion: MCPCompletion
	readonly _meta?: MCPResultMetaObject
}

/**
 * Consumer-supplied completion port for prompt and resource-template arguments.
 *
 * @remarks
 * The host owns reference lookup and template-variable knowledge. MCP forwards the reference
 * verbatim and performs no template parsing or expansion. Returning `undefined` means the
 * referenced prompt or resource template does not exist.
 */
export interface MCPCompletionManagerInterface {
	/**
	 * Completes one argument against its host-owned reference.
	 *
	 * @param params - The reference, argument fragment, and optional resolved context
	 * @param options - The resolved per-request options
	 * @returns Completion candidates or `undefined` when the reference is not found
	 */
	complete(
		params: MCPCompletionParams,
		options: MCPMethodOptions,
	): MCPCompletion | undefined | Promise<MCPCompletion | undefined>
}

/**
 * The MCP `tools/list` result — tool descriptors plus optional modern result
 * stamps.
 *
 * @remarks
 * The wire field names remain verbatim. A modern result requires `resultType`,
 * `ttlMs`, and `cacheScope`; the unstamped legacy `tools/list` answer is an
 * {@link MCPLegacyResult} instead, so none of them is optional here.
 */
export type MCPListResult = {
	readonly tools: readonly MCPToolDescriptor[]
	readonly resultType: 'complete'
	readonly ttlMs: number
	readonly cacheScope: 'public' | 'private'
	readonly _meta?: MCPResultMetaObject
}

/** The complete dated identity of an MCP server or client. */
export type MCPIdentity = MCPMetaObject & {
	readonly name: string
	readonly version: string
	readonly title?: string
	readonly description?: string
	readonly websiteUrl?: string
	readonly icons?: readonly MCPIcon[]
}

/** Open result metadata with the dated reserved server identity field. */
export type MCPResultMetaObject = MCPMetaObject & {
	readonly 'io.modelcontextprotocol/serverInfo'?: MCPIdentity
}

/**
 * Open notification metadata with the dated reserved subscription field.
 *
 * @remarks
 * The subscription id is OPTIONAL here, and that is the schema's own split rather than
 * this package hedging. A frame delivered down a `subscriptions/listen` stream carries the
 * stamp naming the listen request that agreed to it; the same notification delivered any
 * other way carries no stamp, because there is no subscription to name. A required key
 * would refuse a frame the protocol permits.
 *
 * Compare {@link MCPSubscriptionResultMetaObject}, where the same key is REQUIRED: that one
 * sits on the terminating result of a stream, so a subscription always exists to name.
 */
export type MCPNotificationMetaObject = MCPMetaObject & {
	/** The JSON-RPC id of the `subscriptions/listen` request whose stream delivered the frame. */
	readonly 'io.modelcontextprotocol/subscriptionId'?: JSONRPCId
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
	readonly capabilities: MCPClientCapabilities
	readonly identity?: MCPIdentity
}

/** The mandatory modern `server/discover` result. */
export type MCPDiscoverResult = {
	readonly supportedVersions: readonly MCPModernVersion[]
	readonly capabilities: MCPServerCapabilities
	readonly resultType: 'complete'
	readonly ttlMs: number
	readonly cacheScope: 'public' | 'private'
	readonly instructions?: string
	readonly _meta?: MCPResultMetaObject
}

/**
 * The notification families a client may opt in to on a `subscriptions/listen` stream.
 *
 * @remarks
 * Every key here is a WIRE SPELLING, carried verbatim from the dated schema's
 * `params.notifications` object. They are the one place in this file where the
 * compound-key prohibition does not apply, because these strings are not this
 * package's to choose: grouping them into `{ tools: { changed } }` would read better
 * and would speak a protocol no peer implements. The type NAME is the library's own
 * and takes the `MCP` prefix; the keys are the protocol's and do not change.
 */
export interface MCPSubscriptionFilter {
	/** Receives `notifications/tools/list_changed` when the server produces it. */
	readonly toolsListChanged?: boolean
	/** Receives `notifications/prompts/list_changed` when the server produces it. */
	readonly promptsListChanged?: boolean
	/** Receives `notifications/resources/list_changed` when the server produces it. */
	readonly resourcesListChanged?: boolean
	/** Receives `notifications/resources/updated` for these resource URIs. */
	readonly resourceSubscriptions?: readonly string[]
	/**
	 * Receives `notifications/tasks` for these task identifiers.
	 *
	 * @remarks
	 * The wire placement is `params.notifications.taskIds`, beside `resourceSubscriptions`,
	 * and that placement is THIS PACKAGE'S READING rather than a settled fact: the Tasks
	 * extension declares the fragment carrying this member without composing it into the
	 * `subscriptions/listen` request, so no source states where the fragment lands. The
	 * spelling itself is the schema's and is carried verbatim under the same wire-key
	 * exemption as its siblings.
	 *
	 * The server honours the member only when a consumer configured BOTH a task manager and
	 * a subscription producer: the manager resolves each requested identifier before the
	 * acknowledgement agrees to it, and the producer is what a transition frame arrives
	 * through. Either one missing leaves nothing to deliver, so the acknowledgement omits
	 * the member. That fact is DERIVED from the two configured options at the moment the
	 * listen request is answered; no third flag records it, so it cannot drift from them.
	 */
	readonly taskIds?: readonly string[]
}

/** The required metadata on a graceful `subscriptions/listen` result. */
export type MCPSubscriptionResultMetaObject = MCPResultMetaObject & {
	/** The JSON-RPC id of the `subscriptions/listen` request whose stream is closing. */
	readonly 'io.modelcontextprotocol/subscriptionId': JSONRPCId
}

/** The terminating result returned when a `subscriptions/listen` stream closes gracefully. */
export type MCPSubscriptionResult = {
	readonly resultType: 'complete'
	readonly _meta: MCPSubscriptionResultMetaObject
}

/** A client subscription's owned notifications and graceful terminal result. */
export type MCPSubscriptionStream = AsyncGenerator<
	JSONRPCNotification,
	MCPSubscriptionResult,
	unknown
>

/** Per-subscription cancellation and bounded buffering policy. */
export interface MCPListenOptions {
	/** Aborts the subscription and rejects its pending read with the signal reason. */
	readonly signal: AbortSignal
	/** The maximum number of delivered frames retained while no read is parked. */
	readonly capacity?: number
}

// THE MODERN METHOD SEAM — the per-request execution options a handler receives,
// the held-open result arms, and the registrable method contract the modern
// dispatch branch runs every method through. `MCPLegacy` keeps the legacy
// revision's fixed method switch outside this server.

/**
 * Per-request execution options every dispatched handler receives.
 *
 * @remarks
 * `caller` is consumer-ASSERTED and NEVER VERIFIED. Sessions mint transport identity, not
 * caller identity, and nothing in MCP authenticates this value. This package carries it
 * opaquely without inspecting, validating, or serializing it. A consumer must narrow it with
 * its own total guard and treat absence as unauthenticated.
 */
export interface MCPDispatchOptions {
	/** Aborts when the bound transport can observe that the caller's request has ended. */
	readonly signal?: AbortSignal
	/** Consumer-asserted caller context, forwarded opaquely and never protocol-verified. */
	readonly caller?: unknown
}

/**
 * The RESOLVED per-request options one dispatched method receives.
 *
 * @remarks
 * The mirror of {@link MCPDispatchOptions} on the far side of dispatch: a CALLER may
 * have no signal to offer, but a dispatched method always has one to observe, so
 * `signal` is REQUIRED here. Dispatch resolves it once, at the single ingress, and
 * supplies the same value to every handler, elicitation, principal, and subscription
 * producer the request reaches — none of them may reinvent a cancellation source or
 * treat absence as a case.
 *
 * Distinct from {@link MCPExecutionContext}, which is scoped to one tool execution
 * and carries the call and registry alongside the signal.
 *
 * The resolved signal is the request's LIFETIME, not merely the caller's: it aborts when
 * the caller's own signal aborts AND when the answer this request produced is finished —
 * a held-open stream that completed, that its consumer returned, or that an owner stopped.
 * A producer parked on an event that will never arrive is woken by exactly that, which is
 * why a custom stream producer observes this signal for its own cleanup instead of
 * relying on the consumer to iterate it to the end.
 *
 * `caller` is consumer-ASSERTED and NEVER VERIFIED, and is carried by identity: this
 * package neither inspects, validates, clones, nor serializes it.
 */
export interface MCPMethodOptions {
	/** Aborts when the caller's request ends, or when the answer it produced is finished. */
	readonly signal: AbortSignal
	/** Consumer-asserted caller context, forwarded opaquely and never protocol-verified. */
	readonly caller?: unknown
}

/**
 * Produces notifications for one honoured `subscriptions/listen` filter.
 *
 * @remarks
 * The producer parks on its own event source while idle and ends its iterable to close the
 * subscription gracefully. `options.signal` is the per-request cancellation signal; a
 * producer that needs cancellation observes it directly rather than polling.
 *
 * @param notifications - The requested filter intersected with the server's supported filter
 * @param options - The resolved per-request method options
 * @returns An event-driven source of server notifications
 */
export type MCPSubscriptionHandler = (
	notifications: MCPSubscriptionFilter,
	options: MCPMethodOptions,
) => AsyncIterable<JSONRPCNotification> | Promise<AsyncIterable<JSONRPCNotification>>

/** Configuration for the server's built-in `subscriptions/listen` method. */
export interface MCPSubscriptionOptions {
	/** The notification filter this server can actually honour. */
	readonly notifications: MCPSubscriptionFilter
	/** Opens the producer for one honoured filter. */
	readonly listen: MCPSubscriptionHandler
}

/**
 * A held-open modern result: each `yield` is a {@link JSONRPCNotification}; the
 * `return` value is the terminating response.
 *
 * @remarks
 * A stream yields NOTIFICATIONS and never requests — the yield type forbids an `id`,
 * so a producer cannot put a call the peer is expected to answer onto a stream that
 * has no way to carry the answer back.
 *
 * Held-open closure is a RESULT in the modern revision, not an out-of-band event, so it
 * arrives where a result arrives — the generator's `return`. Consuming a stream and
 * consuming a unary response therefore end the same way, and a transport narrows a stream
 * from a response at ONE point (`Symbol.asyncIterator in answer`), at the place that already pumps
 * messages onto the wire. The `TNext` type parameter is stated explicitly because a stream
 * accepts nothing back from its consumer.
 */
export type MCPStream = AsyncGenerator<JSONRPCNotification, JSONRPCResponse, unknown>

/** The string-boundary mirror of {@link MCPStream} — the same sequence, already serialized. */
export type MCPTextStream = AsyncGenerator<string, string, unknown>

/**
 * A held-open modern result whose cancellation ONE owner arbitrates — the arm every
 * stream leaving `MCPServer.dispatch` takes.
 *
 * @remarks
 * The generator protocol states what a stream yields and says nothing about who ends one,
 * and a native async generator answers that badly: `return()` and `throw()` QUEUE behind a
 * `next()` the producer has not answered yet, so a consumer walking away from a source
 * parked on an event that will never arrive waits forever for its own cancellation. A
 * controller settles the consumer's read ITSELF, aborts the request's signal before it
 * delegates cleanup to the producer, contains every promise the producer settles late, and
 * makes every closure path idempotent.
 *
 * {@link stop} is the operation the protocol has no member for: end the exchange with NO
 * terminal, from an owner that is not the consumer of the iteration — a transport whose
 * connection closed, a pump whose write failed. `return(value)` says "here is the answer";
 * `stop()` says "there will be no answer", and that is exactly the difference a cancelled
 * request and a completed one must not blur.
 *
 * **Ending a controlled exchange is the obligation of whoever is handed it, on EVERY exit —
 * including the exits where nothing was cancelled.** One of these holds a producer, a request
 * lifetime, and (for the built-in `subscriptions/listen`) one of a finite number of live
 * server slots, and a consumer that simply walks away releases none of them: no signal fires
 * when nobody aborts anything. So an owner releases through {@link stop} or
 * {@link MCPStreamControllerInterface.[Symbol.asyncDispose] | asyncDispose} on the normal
 * return, on a mid-loop throw, and on a transport that closed underneath the pump alike —
 * which is what `await using`, or the `try … finally` that spells it on the supported Node
 * floor, is for.
 *
 * A conforming {@link MCPStreamControllerInterface.[Symbol.asyncDispose] | asyncDispose}
 * releases the producer, request lifetime, and live slot BEFORE it may reject. Throwing before
 * release would let a disposal fault mask the pump's original failure while leaking the exchange.
 *
 * There is deliberately NO owner of last resort — no finalizer, no timer, no timeout. One
 * would convert a missing obligation into a nondeterministic one and hide the very defect
 * this sentence exists to make visible, and GC timing is not a lifecycle.
 */
export interface MCPStreamControllerInterface extends MCPStream {
	/**
	 * Reads the next notification, or the terminating response that ends the exchange.
	 *
	 * @remarks
	 * At most ONE read is outstanding against the producer, and a rival read is refused
	 * rather than queued: two live consumers on one held-open answer would split a sequence
	 * neither could reassemble. A read parked on the producer settles the moment the exchange
	 * closes, however long the producer takes to notice.
	 *
	 * @returns The next notification, or the terminal response as the iteration's `return`
	 */
	next(): Promise<IteratorResult<JSONRPCNotification, JSONRPCResponse>>
	/**
	 * Ends the exchange because the consumer already has its answer.
	 *
	 * @param value - The terminal the consumer is ending on
	 * @returns That terminal as the iteration's `return`
	 */
	return(
		value: JSONRPCResponse | PromiseLike<JSONRPCResponse>,
	): Promise<IteratorResult<JSONRPCNotification, JSONRPCResponse>>
	/**
	 * Ends the exchange with a failure the consumer is raising.
	 *
	 * @param error - The failure to end the exchange with
	 * @returns Never — the returned promise always rejects with the supplied failure
	 */
	throw(error: unknown): Promise<IteratorResult<JSONRPCNotification, JSONRPCResponse>>
	/**
	 * Ends the exchange permanently, with no terminal response.
	 *
	 * @remarks
	 * Idempotent, and never a way to deliver an answer: a read parked on the producer
	 * settles with the request's abort reason, a later read settles the same way, and the
	 * producer is signalled through the request's own signal rather than waited on.
	 *
	 * @returns Nothing
	 */
	stop(): void
	/**
	 * Ends the exchange when the scope that owns it exits.
	 *
	 * @remarks
	 * The scoped spelling of {@link stop}, and the member a pump discharges its ownership
	 * through in a `finally` — so the normal return, the mid-loop throw, and the abandoned
	 * exchange all release by the same statement. Idempotent and safe after a terminal: an
	 * exchange that already ended is not reopened by being disposed. If disposal rejects, the
	 * exchange has already been released; a failure may report cleanup, never prevent it.
	 *
	 * @returns Resolves once the exchange has ended
	 */
	[Symbol.asyncDispose](): Promise<void>
}

/**
 * The string-boundary mirror of {@link MCPStreamControllerInterface} — the same exchange,
 * already serialized.
 *
 * @remarks
 * A TRANSLATION boundary and nothing more: it serializes each message, and every lifecycle
 * decision — cancellation, abort, closure — ends the controlled typed stream beneath it, so
 * the string face never becomes a second cancellation engine with its own queue to fall
 * behind. `stop()` reaches the typed producer, which is why a transport holding only the
 * serialized arm can still end the exchange it is writing.
 *
 * {@link MCPTextStreamControllerInterface.return} is the one member that narrows rather than
 * passes through, and the narrowing is inherent: it is handed a STRING, so it has no typed
 * terminal to close the exchange on and never parses one back out of its argument. The typed
 * exchange therefore ends with NO terminal while this face answers its own consumer with the
 * supplied text — so a cooperating producer runs its cancellation path here where the typed
 * {@link MCPStreamControllerInterface.return} would have run its normal return.
 *
 * **The ownership obligation is identical and it is not discharged twice.** Whoever is handed
 * this face ends it on EVERY exit, and every closure member here reaches the TYPED exchange
 * beneath — so releasing the serialized arm releases the producer, the request lifetime, and
 * the live server slot behind it. A serialized pump therefore owns exactly what a typed pump
 * owns, and neither has an owner of last resort to fall back on.
 *
 * A conforming {@link MCPTextStreamControllerInterface.[Symbol.asyncDispose] | asyncDispose}
 * releases the typed producer, request lifetime, and live slot BEFORE it may reject. Throwing
 * before delegating would let a disposal fault mask the pump's original failure while leaking
 * the exchange.
 */
export interface MCPTextStreamControllerInterface extends MCPTextStream {
	/**
	 * Reads the next serialized message, or the serialized terminating response.
	 *
	 * @returns The next message as a string, or the terminal as the iteration's `return`
	 */
	next(): Promise<IteratorResult<string, string>>
	/**
	 * Ends the exchange because the consumer already has its answer.
	 *
	 * @remarks
	 * The typed exchange ends with NO terminal: a string is not a {@link JSONRPCResponse}, and
	 * this face never parses one back out of its argument. The supplied text is the answer to
	 * THIS consumer alone.
	 *
	 * @param value - The serialized terminal the consumer is ending on
	 * @returns That terminal as the iteration's `return`
	 */
	return(value: string | PromiseLike<string>): Promise<IteratorResult<string, string>>
	/**
	 * Ends the exchange with a failure the consumer is raising.
	 *
	 * @param error - The failure to end the exchange with
	 * @returns Never — the returned promise always rejects with the supplied failure
	 */
	throw(error: unknown): Promise<IteratorResult<string, string>>
	/**
	 * Ends the exchange permanently, with no terminal response, through the typed stream.
	 *
	 * @returns Nothing
	 */
	stop(): void
	/**
	 * Ends the typed exchange when the scope that owns this face exits.
	 *
	 * @remarks
	 * Delegates downward exactly as {@link stop} does, so a pump holding only the serialized
	 * arm still releases the producer and the request lifetime from its `finally`. If disposal
	 * rejects, that release has already completed; a failure may report cleanup, never prevent it.
	 *
	 * @returns Resolves once the typed exchange has ended
	 */
	[Symbol.asyncDispose](): Promise<void>
}

/**
 * One modern method, registered on the seam that dispatches it.
 *
 * @remarks
 * A registered method answers a {@link JSONRPCRequest} — with a terminating
 * {@link JSONRPCResponse}, or by holding the exchange open as an {@link MCPStream}. It is
 * invoked for nothing else: dispatch short-circuits a {@link JSONRPCNotification} BEFORE the
 * registry is read, so the notification arm never arrives here and no handler has to narrow
 * one away.
 *
 * The seam is this narrow because the future a wider one was kept for is structurally
 * unavailable. The only client-to-server notification the core protocol defines is
 * `notifications/cancelled`, and a handler acting on one must reach the OTHER request's
 * `AbortController` — which dispatch creates per request, AFTER the notification
 * short-circuit, and publishes to no registry and no member. Admitting a cancellation
 * handler therefore needs a live request-id-to-controller registry — new cross-request
 * server state — before the parameter's width ever becomes the obstacle.
 *
 * Answering is not optional either, and that is a runtime rule as well as a type. A handler
 * resolving `undefined` for a request contradicts `dispatch`'s own overloads and leaves the
 * caller waiting until its deadline, so dispatch CONTAINS one as `-32603` plus a single
 * `error` event rather than passing the absence on.
 *
 * `options.signal` is already resolved and always present — what a handler does with it
 * is the handler's decision, never this package's. `options.caller` is consumer-asserted
 * and never verified by this package.
 *
 * @param request - The parsed modern request being dispatched
 * @param options - The resolved per-request method options (see {@link MCPMethodOptions})
 * @returns The terminating response, or a held-open {@link MCPStream}
 */
export type MCPMethodHandler = (
	request: JSONRPCRequest,
	options: MCPMethodOptions,
) => Promise<JSONRPCResponse | MCPStream>

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
	 * Registers one modern method — replacing any handler already under that name.
	 *
	 * @param name - The JSON-RPC method name to answer (for example, `'tools/call'`)
	 * @param handler - The handler dispatched for that method
	 */
	add(name: string, handler: MCPMethodHandler): void
	/**
	 * Finds the handler registered for one method name.
	 *
	 * @param name - The JSON-RPC method name to resolve
	 * @returns The registered handler, or `undefined` when the method is unregistered
	 */
	method(name: string): MCPMethodHandler | undefined
}

/**
 * The push observation surface of an {@link MCPServerInterface} — the
 * dispatch moments a fire-and-forget observer (logging, tracing) subscribes to
 * through `server.emitter.on`.
 *
 * @remarks
 * `request` fires at the TOP of every `dispatch` with the method, correlating id
 * (ABSENT for a notification, which has none), and structurally selected wire era, BEFORE the
 * method runs — so an observer sees every inbound call. Listener isolation is the emitter's: a
 * listener throw is routed to the emitter's `error` handler (the `error` option),
 * never onto this map, so a buggy observer can never corrupt a dispatch. Declared as
 * a `type` alias so the type-literal satisfies `EventMap` structurally.
 */
export type MCPServerEventMap = {
	/**
	 * An invocation is being dispatched — its method, correlating id (absent for a
	 * notification), and structural wire era.
	 *
	 * @remarks
	 * Fires ahead of the `_meta` bound check, so an observer sees a call the server is about
	 * to refuse for exceeding its metadata budget exactly as it sees one that passes — an
	 * observation surface that skipped the refused calls could not be used to account for
	 * inbound traffic. Only SCALARS are reported: nothing read out of the request graph
	 * escapes here, so a listener can never observe a value the ownership seam has not yet
	 * bounded.
	 */
	readonly request: readonly [method: string, id: JSONRPCId | undefined, era: MCPEra]
	/**
	 * An operational fault the server CONTAINED — the caught value, exactly once per fault.
	 *
	 * @remarks
	 * Every fault this server answers with an internal-error response reports here first: a
	 * throwing execution provider, a throwing registered method handler, a throwing
	 * subscription source, a throwing continuation or principal provider, and a transport
	 * fault surfaced while a bound {@link MCPTransportInterface} was piping a reply out (a
	 * `send` throw or rejection from `bindServer`).
	 *
	 * This is the ONE place a caught detail is legible. The wire answer is detail-free by
	 * construction, so an operator who wants to know WHY a request failed subscribes here;
	 * a peer never learns it. Payload typed `unknown` because a thrown value is.
	 *
	 * A DOMAIN event, distinct from the emitter's own listener-error channel: a listener
	 * that throws while observing this event is routed to the emitter's `error` handler
	 * (the `error` option) and never back onto this map.
	 */
	readonly error: readonly [error: unknown]
}

/** Configurable hostile-input and live-resource bounds for an MCP server. */
export interface MCPLimitOptions {
	/** Maximum UTF-8 bytes accepted by the raw string boundary. */
	readonly message?: number
	/** Maximum serialized UTF-8 bytes accepted in one `_meta` value. */
	readonly metadata?: number
	/** Maximum total enumerable keys accepted across one `_meta` value. */
	readonly keys?: number
	/** Maximum UTF-8 bytes accepted in one protected `requestState`. */
	readonly state?: number
	/** Maximum serialized UTF-8 bytes accepted from one complete produced tool-call result. */
	readonly content?: number
	/** Maximum simultaneously live built-in subscription streams. */
	readonly subscriptions?: number
	/** Maximum nesting depth accepted by bounded JSON values. */
	readonly depth?: number
}

/** Limits applied by {@link isBoundedJSON} to one JSON value. */
export interface MCPJSONLimitOptions {
	/** Maximum serialized UTF-8 bytes. */
	readonly bytes: number
	/** Maximum total enumerable keys; omitted when bytes alone bound breadth. */
	readonly keys?: number
	/** Maximum array/object nesting depth. */
	readonly depth: number
}

/**
 * Options for `createMCPServer` — the server {@link MCPIdentity}, the live
 * {@link ToolManagerInterface} it exposes, optional `instructions`, and the
 * reserved `on` hooks.
 *
 * @remarks
 * `identity` identifies the server in the `initialize` handshake (`serverInfo`).
 * `tools` is the live registry the server dispatches `tools/list` / `tools/call`
 * over — its `definitions()` advertise the tools and its `execute()` runs a call
 * (the manager already isolates a tool throw into a `success: false` result, so
 * the server adds none). `resources` is the optional consumer-owned registry the
 * modern resource methods project without taking ownership of storage. `prompts`
 * supplies the equivalent prompt registry for `prompts/list` and `prompts/get`.
 * `completion` supplies independent host-owned lookup and candidate generation for
 * `completion/complete`; the server never parses or expands a resource-template URI.
 * `instructions` is the optional human guidance exposed
 * by `server/discover`. `cache` configures the modern cache stamps: `ttl` is the
 * freshness lifetime in milliseconds and `scope` defaults to `'private'`. `on`
 * is the reserved `on` key: initial listeners for the server's
 * {@link MCPServerEventMap}, wired at construction. `input` enables modern
 * `tools/call` multi-round trips: the consumer decides when input is needed and
 * supplies principal/continuation/TTL policy, while MCP assigns the request key and
 * owns the protected wire round trip. `task` enables the stable Tasks extension: the
 * consumer supplies the durable store and the deferral decision, while MCP owns the
 * capability gate and the `resultType: 'task'` answer. `limit` configures the server's
 * hostile-input and live-subscription bounds; every omitted leaf uses
 * {@link DEFAULT_MCP_LIMITS}.
 */
export interface MCPServerOptions {
	readonly on?: EmitterHooks<MCPServerEventMap>
	/** The emitter's listener-error handler — a listener throw routes here, not to a domain event. */
	readonly error?: EmitterErrorHandler
	readonly identity: MCPIdentity
	/** The live tool registry the server exposes over `tools/list` / `tools/call`. */
	readonly tools: ToolManagerInterface
	/** Optional consumer-owned resource registry exposed over the modern resource methods. */
	readonly resources?: MCPResourceManagerInterface
	/** Optional consumer-owned prompt registry exposed over the modern prompt methods. */
	readonly prompts?: MCPPromptManagerInterface
	/** Optional host-owned prompt and resource-template completion provider. */
	readonly completion?: MCPCompletionManagerInterface
	/**
	 * Optional explicit execution policy above the canonical live tool registry.
	 *
	 * @remarks
	 * This is also the ONLY way a tool observes cancellation. The default path calls
	 * {@link ToolManagerInterface.execute}, whose signature takes a call and nothing else, so
	 * there is no seam to hand a signal through — a server with no `execution` runs its tool to
	 * completion even after the request that asked for it has ended, and abandons the result.
	 * An {@link MCPExecutionHandler} receives `signal` on its {@link MCPExecutionContext} and
	 * can stop the work itself.
	 */
	readonly execution?: MCPExecutionHandler
	/** Optional human guidance exposed by `server/discover`. */
	readonly instructions?: string
	/** Modern cache stamps; omitted values use the protocol-safe defaults. */
	readonly cache?: {
		readonly ttl?: number
		readonly scope?: 'public' | 'private'
	}
	/** Optional multi-round-trip input mechanism; all continuation and expiry policy is consumer-supplied. */
	readonly input?: MCPInputOptions
	/** Optional event-driven producer for the modern `subscriptions/listen` method. */
	readonly subscription?: MCPSubscriptionOptions
	/**
	 * Optional Tasks extension; the durable store and the deferral decision are consumer-supplied.
	 *
	 * @remarks
	 * Omitting it leaves every existing path untouched — nothing is advertised, no call is
	 * deferred, and `tasks/*` stays unregistered. The extension is the STABLE, immutable
	 * snapshot dated 2026-07-28, so the shape this option admits is fixed.
	 */
	readonly task?: MCPTaskOptions
	/** Hostile-input and live-resource bounds; omitted leaves use secure defaults. */
	readonly limit?: MCPLimitOptions
}

/** Construction options for the removable legacy protocol decorator. */
export interface MCPLegacyOptions {
	/** The sole dispatcher and execution engine. */
	readonly dispatcher: MCPDispatcherInterface
	/** The identity returned by the legacy `initialize` handshake. */
	readonly identity: MCPIdentity
}

/**
 * The minimal transport-facing MCP dispatch surface.
 *
 * @remarks
 * A transport-facing dispatcher needs the resolved message limit and the `dispatch` and
 * `handle` doors. It also shares the server emitter because a binder that owns a message pump has
 * no response channel for a contained transport fault and must report that fault as an event.
 */
export interface MCPDispatcherInterface {
	/** The shared server observation surface, including contained transport faults. */
	readonly emitter: EmitterInterface<MCPServerEventMap>
	/** The resolved bounds the dispatcher enforces. */
	readonly limit: Required<MCPLimitOptions>
	/**
	 * Dispatches a parsed JSON-RPC request.
	 *
	 * @param request - The parsed request
	 * @param options - Optional execution context
	 * @returns The response or a controlled held-open response
	 */
	dispatch(
		request: JSONRPCRequest,
		options?: MCPDispatchOptions,
	): Promise<JSONRPCResponse | MCPStreamControllerInterface>
	/**
	 * Dispatches a parsed JSON-RPC notification.
	 *
	 * @param notification - The parsed notification
	 * @param options - Optional execution context
	 * @returns `undefined`, because notifications receive no response
	 */
	dispatch(notification: JSONRPCNotification, options?: MCPDispatchOptions): Promise<undefined>
	/**
	 * Dispatches an invocation whose arm is not statically known.
	 *
	 * @param invocation - The parsed invocation
	 * @param options - Optional execution context
	 * @returns A response, controlled held-open response, or `undefined`
	 */
	dispatch(
		invocation: JSONRPCInvocation,
		options?: MCPDispatchOptions,
	): Promise<JSONRPCResponse | MCPStreamControllerInterface | undefined>
	/**
	 * Handles a raw JSON-RPC string.
	 *
	 * @param message - The raw message
	 * @param options - Optional execution context
	 * @returns A serialized response, controlled serialized stream, or `undefined`
	 */
	handle(
		message: string,
		options?: MCPDispatchOptions,
	): Promise<string | MCPTextStreamControllerInterface | undefined>
}

/**
 * A transport-agnostic Model Context Protocol server — dispatches JSON-RPC 2.0
 * modern requests over a live
 * {@link ToolManagerInterface}, with NO transport coupling (a transport layer
 * pumps strings through `handle`).
 *
 * @remarks
 * - **`dispatch` and `handle`.** `dispatch(invocation)` is the TYPED core: it takes an
 *   already-parsed {@link JSONRPCInvocation}, runs the method, and resolves a
 *   {@link JSONRPCResponse} — or an {@link MCPStream} for a held-open modern method — for
 *   a {@link JSONRPCRequest}, and `undefined` for a {@link JSONRPCNotification}. Its
 *   overloads say exactly that, so a caller dispatching a request never handles an
 *   `undefined` answer and a caller dispatching a notification never handles a response.
 *   `handle(message)` is the STRING boundary: it `JSON.parse`s the raw message, narrows it
 *   to an invocation, dispatches, and serializes the answer back to a string (or an
 *   {@link MCPTextStream}, the same sequence already serialized) — turning a parse failure
 *   into a `-32700` response and a non-invocation into a `-32600` response, and returning
 *   `undefined` for a notification. Both error envelopes OMIT the `id` they could not read.
 * - **One method seam.** Every modern method — the built-in `server/discover` /
 *   `tools/list` / `tools/call` / `subscriptions/listen` and configured resource methods
 *   included — is registered on `methods` and dispatched
 *   from it, so a method added later travels the identical path and an unregistered one
 *   still answers `-32601`.
 * - **Provider-agnostic.** Imports only core siblings; it speaks JSON-RPC + the
 *   tool registry, with no HTTP, no model, and no backend coupling.
 * - **Observable.** The owned `emitter` ({@link MCPServerEventMap}) fires
 *   `request` per dispatch; the emitter isolates a listener throw and routes it to its
 *   `error` handler (the `error` option), never the dispatch.
 */
export interface MCPServerInterface extends MCPDispatcherInterface {
	readonly identity: MCPIdentity
	/** The modern method registry this server dispatches through (built-ins included). */
	readonly methods: MCPMethodManagerInterface
	/**
	 * The bounds this server actually enforces — every leaf resolved, none optional.
	 *
	 * @remarks
	 * Derived from {@link MCPServerOptions.limit} at construction and stored nowhere else, so
	 * it cannot drift from the value the boundary checks read. It is published because the
	 * code in front of the server needs the SAME number: a binder that decodes an inbound
	 * message before handing it on must refuse at the byte the server would have refused at,
	 * and the alternative — a second configured copy of one bound, on the binder's own options
	 * — is a second number that will disagree the first time either is changed.
	 */
	readonly limit: Required<MCPLimitOptions>
	/**
	 * Dispatches an already-parsed request — runs its method and resolves its answer.
	 *
	 * @remarks
	 * A held-open modern method answers with a CONTROLLED stream instead of a response:
	 * narrow a stream from a response with `Symbol.asyncIterator in answer`. Whatever the method
	 * produced, what leaves here is an {@link MCPStreamControllerInterface} — dispatch is
	 * the one wrapping seam — so a caller may end the exchange promptly without waiting on
	 * the producer. `options` is optional, so a caller that cannot abort simply never
	 * supplies one; dispatch resolves the signal every method observes.
	 *
	 * @param request - The parsed JSON-RPC request to dispatch
	 * @param options - Per-request execution options (see {@link MCPDispatchOptions})
	 * @returns The response, or a held-open {@link MCPStreamControllerInterface}
	 */
	dispatch(
		request: JSONRPCRequest,
		options?: MCPDispatchOptions,
	): Promise<JSONRPCResponse | MCPStreamControllerInterface>
	/**
	 * Dispatches an already-parsed notification — runs its method and answers nothing.
	 *
	 * @param notification - The parsed JSON-RPC notification to dispatch
	 * @param options - Per-request execution options (see {@link MCPDispatchOptions})
	 * @returns `undefined` — a notification never receives a reply
	 */
	dispatch(notification: JSONRPCNotification, options?: MCPDispatchOptions): Promise<undefined>
	/**
	 * Dispatches an already-parsed invocation whose arm is not statically known.
	 *
	 * @remarks
	 * The union arm a transport uses when it has narrowed a message no further than
	 * {@link JSONRPCInvocation}. A value that is not structurally an invocation at
	 * RUNTIME — which only a caller defeating these types can produce — answers a
	 * `-32600` error response with no `id`.
	 *
	 * @param invocation - The parsed JSON-RPC invocation to dispatch
	 * @param options - Per-request execution options (see {@link MCPDispatchOptions})
	 * @returns The response, a held-open {@link MCPStreamControllerInterface}, or `undefined` for a notification
	 */
	dispatch(
		invocation: JSONRPCInvocation,
		options?: MCPDispatchOptions,
	): Promise<JSONRPCResponse | MCPStreamControllerInterface | undefined>
	/**
	 * Handles a raw message string — parses it, dispatches it, and serializes the answer.
	 *
	 * @remarks
	 * A `JSON.parse` failure resolves a serialized `-32700` (Parse error) response;
	 * a parsed value that is not a valid invocation resolves a serialized `-32600`
	 * (Invalid Request) response — each with its unreadable `id` OMITTED, never `null`;
	 * a notification resolves `undefined` (no response). A
	 * held-open method resolves an {@link MCPTextStreamControllerInterface} — the controlled
	 * typed stream's mirror, already serialized — so a transport writes each message with no
	 * second parse and can still end the exchange it is writing.
	 *
	 * The vague-verb prohibition (`process`, `handle`) governs STANDALONE helpers,
	 * which carry no entity to supply their object. Here the entity does: `server.handle`
	 * reads as "the server handles this message", and it is the string-boundary twin of
	 * {@link dispatch} — one verb per entry point, the same act at the typed and string levels.
	 *
	 * @param message - The raw JSON-RPC message string
	 * @param options - Per-request execution options (see {@link MCPDispatchOptions})
	 * @returns The serialized response string, an {@link MCPTextStreamControllerInterface}, or `undefined` for a notification
	 */
	handle(
		message: string,
		options?: MCPDispatchOptions,
	): Promise<string | MCPTextStreamControllerInterface | undefined>
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
 *
 * `closed` reads as an adjective where the naming law asks for a verb, and it is
 * KEPT: it is a registrar for the port's terminal event, paired with `listen` for
 * the other one, and no verb states that without lying. `close()` is already taken
 * by the imperative on the line below it, `end`/`stop` would read as a second way to
 * close, and `onClose` is the `on`-prefixed shape the rules reject outright. The
 * shape that would need no such name is an emitter, which this port deliberately
 * refuses — a carrier this thin is implemented by hand at every host, and one
 * replaceable handler per event is the whole point of it.
 */
export interface MCPTransportInterface {
	/** Delivers one outbound JSON-RPC message (already serialized). */
	readonly send: (message: string) => void | Promise<void>
	/** Registers the single inbound-message handler — a second call REPLACES the first. */
	readonly listen: (handler: (message: string) => void) => void
	/** Registers the single closed handler — a second call REPLACES the first. */
	readonly closed: (handler: () => void) => void
	/** Closes the underlying channel. */
	readonly close: () => void | Promise<void>
}

// MCP CLIENT (the egress side) — the mirror of the server, split the same way: a
// transport-agnostic {@link MCPClientInterface} that drives a REMOTE MCP server
// (`initialize` / `tools/list` / `tools/call`) over an injected {@link
// MCPClientTransportInterface}, exposing each remote tool as a local {@link
// ToolInterface} an agent can run. The transport speaks only the JSON-RPC wire (a
// concrete one — the HTTP transport — lives ONE layer out in `src/server/mcp`,
// mirroring the server's core-vs-HTTP split); the client owns the request↔response
// correlation, the per-request deadline, and the tool mapping, with no transport
// coupling.

/**
 * The observable events of a {@link MCPClientTransportInterface} — the moments the
 * {@link MCPClientInterface} (and any tracer) subscribes to through `transport.emitter.on`.
 *
 * @remarks
 * - `message` — a JSON-RPC message ARRIVED from the remote server (a response the
 *   client correlates to a pending request by `id`, or a server-initiated
 *   notification). The transport decodes the wire bytes (a JSON body or an SSE
 *   `data:` event) and emits the parsed {@link JSONRPCMessage}.
 * - `close` — the transport's connection ended (a stream closed, `close()` ran).
 * - `error` — a transport-level fault (a malformed message, a network error); the
 *   payload is typed `unknown`. This is a DOMAIN event, distinct from the emitter's
 *   own listener-error channel: a listener throw is routed to the emitter's `error` handler
 *   (the `error` option), never onto this map. Declared as a `type` alias so the
 *   type-literal satisfies `EventMap` structurally.
 */
export type MCPClientTransportEventMap = {
	/** A JSON-RPC message arrived from the remote server (a response, or a notification). */
	readonly message: readonly [message: JSONRPCMessage]
	/** The transport's connection ended. */
	readonly close: readonly []
	/** A transport-level fault — the caught error (typed `unknown`). */
	readonly error: readonly [error: unknown]
}

/**
 * A transport-agnostic MCP message carrier — pumps JSON-RPC messages to a peer and
 * surfaces received messages on its `emitter`'s `message` event, with no knowledge
 * of the protocol role on either side.
 *
 * @remarks
 * A client hands the transport one {@link JSONRPCMessage} through `send`, and the
 * transport delivers each decoded reply through the `message` event. Server bridges
 * use the same carrier for bidirectional WebSocket and stdio channels. The minimal surface is a
 * `start` (open the connection / arm any reader), `send` (write one message),
 * and `close` (tear down). `session` exposes a server-assigned session id once a
 * stateful transport has one (`undefined` for the stateless v1) — reserved for the
 * later sessions tier. Concrete transports live in the browser and server environments;
 * the in-process loopback transport in the tests implements the same contract.
 */
export interface MCPClientTransportInterface {
	readonly emitter: EmitterInterface<MCPClientTransportEventMap>
	/** A server-assigned session id once a stateful transport has one; `undefined` otherwise. */
	readonly session: string | undefined
	/**
	 * Whether this carrier accepts a CLIENT-INITIATED notification — one written with no
	 * `id`, which no response will ever answer.
	 *
	 * @remarks
	 * The transport states it because only the transport knows it, and getting it wrong is
	 * invisible: `send` accepts any {@link JSONRPCMessage}, so a carrier with no
	 * client→server notification channel will happily write one and drop it silently.
	 *
	 * `true` for a genuinely bidirectional channel — a WebSocket, a stdio pipe pair, an
	 * in-process duplex port — where a frame the client writes at any moment reaches the
	 * peer. `false` for a request/response carrier such as Streamable HTTP: the dated
	 * revision defines NO client-to-server notification over it, and the cancellation
	 * signal there is closing the response stream rather than a frame. A `false` carrier
	 * is not a degraded one — it has its own signal — so the client withholds the frame
	 * rather than writing one nothing will read.
	 */
	readonly duplex: boolean
	/**
	 * Opens the transport — establishes the connection and arms any reply reader.
	 *
	 * @remarks
	 * A `start` that REJECTS must first release whatever it had already acquired. The
	 * {@link MCPClientInterface} claims a connection only once `start` resolves, so a rejection
	 * leaves it holding an error and no claim: a socket, session, or reader the transport opened
	 * before failing is reachable by nothing the client can call, and no client-side mechanism can
	 * be added that would reach it.
	 *
	 * @returns Resolves once the transport is ready to `send`
	 */
	start(): Promise<void>
	/**
	 * Sends one JSON-RPC message to the remote server.
	 *
	 * @remarks
	 * Each decoded reply is surfaced on the `emitter`'s `message` event — `send`
	 * itself resolves once the message has been written (and, for a request/response
	 * transport, its synchronous reply emitted), not when a logical response arrives;
	 * the {@link MCPClientInterface} awaits the response through its `id` correlation.
	 *
	 * A `send` that FAILS must fail by REJECTING, never by throwing synchronously. The
	 * {@link MCPClientInterface} registers the write inside the same promise executor that
	 * records the request's pending entry, so a synchronous throw leaves no promise for that
	 * registration to attach to: the entry set one statement earlier is never settled, and a
	 * later abort writes `notifications/cancelled` naming a request the write never delivered.
	 * An `async send` satisfies this by construction, which is why every transport this package
	 * ships declares one; a non-`async` implementation returns a rejected promise instead of
	 * throwing. The client cannot enforce this from its side — the throw and the write are
	 * indistinguishable to it — so it is stated here, on the contract that owns it.
	 *
	 * A transport whose channel confirms the write rejects on its failure. A transport whose
	 * exchange reports through the emitter resolves. A transport whose channel cannot confirm a
	 * write answers a closed channel from its own state, and each states which in its own
	 * remarks.
	 *
	 * @param message - The message to write to the wire
	 * @returns Resolves once the message has been sent, and rejects — never throws — when the
	 * write fails
	 */
	send(message: JSONRPCMessage): Promise<void>
	/**
	 * Closes the transport — ends the connection and releases resources.
	 *
	 * @remarks
	 * A `close` must SETTLE, and its settlements mean different things to its caller: resolving
	 * says the connection ended, rejecting says it did not. The
	 * {@link MCPClientInterface}'s only other bound is a deadline, which reports that the shutdown
	 * did not ANSWER and never that it did not happen — so a `close` that resolves or rejects hours
	 * late still decides the outcome, and one that never settles leaves the connection owed for the
	 * client's life. `close` is never called twice concurrently for one connection: a caller that
	 * gave up waiting JOINS the `close` still running rather than issuing another. It IS called
	 * again after an earlier `close` REJECTED, because a rejected close ended nothing.
	 *
	 * `close` is IDEMPOTENT: a call on a transport an earlier `close` already ended resolves
	 * without emitting `close` again and without releasing anything a second time. Idempotence
	 * bounds ONE closed lifetime rather than the object — a transport that reopens on `start`
	 * arms itself there, and its next `close` ends that connection and emits once for it.
	 *
	 * @returns Resolves once the transport is closed
	 */
	close(): Promise<void>
}

/**
 * Options for the explicit legacy client transport adapter.
 *
 * @remarks
 * - `identity` — the client identity sent through the legacy `clientInfo` field. Defaults to the
 *   package client identity.
 * - `capabilities` — the legacy handshake capability record. Defaults to an empty record.
 * - `version` — an optional exact legacy handshake revision. Absence offers the newest supported
 *   legacy revision and accepts the supported revision the peer selects.
 * - `timeout` — the legacy handshake, handshake-write, and forwarded-request deadline in
 *   milliseconds. Default:
 *   {@link import('./constants.js').DEFAULT_MCP_REQUEST_TIMEOUT}.
 *
 * The adapter reserves JSON-RPC wire id `0` for its handshake while `start()` is waiting for
 * the peer. Do not send unrelated id-`0` traffic through the wrapped transport in that window.
 */
export interface MCPLegacyClientTransportOptions {
	/** The client identity sent during the legacy handshake. */
	readonly identity?: MCPIdentity
	/** The client capabilities sent during the legacy handshake. */
	readonly capabilities?: MCPClientCapabilities
	/** The exact legacy revision to request and require. */
	readonly version?: MCPLegacyVersion
	/** The legacy handshake and forwarded-request deadline in milliseconds. */
	readonly timeout?: number
}

/**
 * The push observation surface of an {@link MCPClientInterface} — the moments a
 * fire-and-forget observer (logging, tracing) subscribes to through `client.emitter.on`.
 *
 * @remarks
 * - `connect` — modern revision negotiation completed through `server/discover`, and the client
 *   is connected. A legacy transport adapter presents this same modern boundary after completing
 *   its own handshake.
 * - `disconnect` — the connection this client had announced ended (every pending request
 *   rejected, and the connection it owned on the transport closed — or that close faulted or
 *   timed out, which rejects the `disconnect` caller rather than withholding this event).
 * - `notification` — a server-initiated JSON-RPC NOTIFICATION arrived — forwarded for the
 *   consumer to react to (for example, a `notifications/tools/list_changed`). A
 *   `notifications/progress` frame claimed by an in-flight request's progress handler is
 *   delivered there instead, and a RESPONSE correlating to nothing pending is discarded
 *   rather than forwarded here, because it answers a request that has already settled.
 * - `error` — a client-level fault surfaced for observation (typed `unknown`). This is
 *   a DOMAIN event, distinct from the emitter's own listener-error channel: a listener throw
 *   is routed to the emitter's `error` handler (the `error` option), never onto this map.
 *   Declared as a `type` alias so the literal satisfies `EventMap`.
 */
export type MCPClientEventMap = {
	/** Era negotiation completed — the client is connected. */
	readonly connect: readonly []
	/** The client disconnected — pending requests rejected, the connection it owned closed or its close failed. */
	readonly disconnect: readonly []
	/** A server-initiated notification arrived (not a response to a pending request). */
	readonly notification: readonly [message: JSONRPCMessage]
	/** A client-level fault surfaced for observation (typed `unknown`). */
	readonly error: readonly [error: unknown]
}

/**
 * Options for `createMCPClient` — the {@link MCPClientTransportInterface} to drive, the
 * optional client {@link MCPIdentity}, the per-request `timeout`, and the reserved
 * `on` hooks.
 *
 * @remarks
 * - `transport` — the carrier the client drives a remote MCP server over (REQUIRED;
 *   a concrete one from `src/server/mcp`, or an in-process loopback). The bare client negotiates
 *   the modern revision through `server/discover`; wrap the carrier with
 *   {@link import('./factories.js').createMCPLegacyClientTransport} for a legacy peer.
 * - `identity` — identifies the client in modern request metadata; defaults to
 *   {@link import('./constants.js').DEFAULT_MCP_CLIENT_NAME} /
 *   {@link import('./constants.js').DEFAULT_MCP_CLIENT_VERSION}.
 * - `capabilities` — the open client-capability record carried by every modern
 *   request; defaults to an empty record.
 * - `version` — an optional modern protocol pin; absence lets `server/discover` negotiate.
 * - `timeout` — the per-request deadline in milliseconds: a `server/discover` / `tools/list` /
 *   `tools/call` that the server does not answer within it REJECTS (the pending
 *   request is settled by an `AbortSignal.timeout(timeout)` deadline — never a raw
 *   `setTimeout`). The same deadline bounds the client's WAIT on the transport's `close`, so a
 *   shutdown the transport accepts and never answers rejects its caller instead of wedging the
 *   client — which makes a short `timeout` a short shutdown grace as well as a short request
 *   deadline. Defaults to {@link import('./constants.js').DEFAULT_MCP_REQUEST_TIMEOUT}.
 * - `on` — the reserved `on` key: initial listeners for the client's
 *   {@link MCPClientEventMap}, wired at construction.
 */
export interface MCPClientOptions {
	readonly on?: EmitterHooks<MCPClientEventMap>
	/** The emitter's listener-error handler — a listener throw routes here, not to a domain event. */
	readonly error?: EmitterErrorHandler
	readonly transport: MCPClientTransportInterface
	readonly identity?: MCPIdentity
	/** The open client-capability record carried by modern requests. */
	readonly capabilities?: MCPClientCapabilities
	/**
	 * An optional exact modern protocol revision pin; absence permits modern negotiation. A defined
	 * pin must match the peer's discovery advertisement. An unsupported runtime value throws an
	 * {@link MCPError} synchronously during construction.
	 */
	readonly version?: MCPModernVersion
	/** The per-request deadline in milliseconds (default {@link import('./constants.js').DEFAULT_MCP_REQUEST_TIMEOUT}). */
	readonly timeout?: number
}

/**
 * Configures per-call policy and continuation data for one remote `tools/call`.
 *
 * @remarks
 * Each option lives for exactly one request:
 *
 * - `signal` cancels THAT request and nothing else. It never closes the connection, never
 *   reaches a durable task the call may have become, and never asks the peer to undo work
 *   already done — cancellation is advisory in MCP, so the peer may finish anyway and the
 *   caller simply stops waiting. A signal that is ALREADY aborted refuses the call before
 *   anything is written, so no request the peer would have to be told about is ever issued.
 * - `progress` receives each `notifications/progress` frame the peer publishes for this
 *   request. Supplying it is what stamps the request's progress token, so a peer only
 *   reports where a caller is listening.
 * - `input` carries one input-required retry. Its `state` and `responses` leaves are
 *   required together. The retry must repeat the original `name` and byte-identical
 *   `arguments`; the client maps the leaves to the top-level `requestState` and
 *   `inputResponses` parameters.
 *
 * No option survives the call: the continuation data is placed only on that request, and when
 * the request settles — answered, refused, timed out, aborted, or drained by a `disconnect` —
 * the signal listener is removed and the progress handler is dropped in the same step.
 */
export interface MCPCallOptions {
	/** Cancels this one in-flight request; an already-aborted signal refuses it unsent. */
	readonly signal?: AbortSignal
	/** Receives this request's progress frames; supplying it stamps the progress token. */
	readonly progress?: MCPProgressHandler
	/** Carries the protected state and responses for one input-required retry. */
	readonly input?: {
		readonly state: string
		readonly responses: Readonly<Record<string, unknown>>
	}
}

/**
 * What one remote `tools/call` answered — the arms the dated protocol permits.
 *
 * @remarks
 * The peer chooses the arm, so the caller narrows on `resultType`:
 *
 * - `'complete'` — the call finished. `value` is the tool's own value: the peer's
 *   `structuredContent` when it sent one (the tool's value in its original structure),
 *   and otherwise the concatenated `text` blocks parsed as JSON, falling back to the raw
 *   text. A tool FAILURE never reaches this arm — `isError: true` throws, so an agent's
 *   {@link ToolManagerInterface} isolates a remote failure exactly as it does a local one.
 * - {@link MCPTaskResult} — the server DEFERRED the call into a durable task. The request
 *   is over and the work is not; the outcome arrives later through the task's own methods.
 * - {@link MCPInputResult} — the call needs another round trip before it can finish.
 *
 * An unknown `resultType` is refused rather than surfaced: this union is what the client
 * can carry, and an arm it cannot name is one it cannot hand a caller safely.
 */
export type MCPCallOutcome =
	| {
			readonly resultType: 'complete'
			/** The remote tool's value — its `structuredContent`, or its parsed text. */
			readonly value: unknown
	  }
	| MCPTaskResult
	| MCPInputResult

/**
 * Issues one correlated JSON-RPC request and awaits the peer's result.
 *
 * @remarks
 * The door an {@link MCPTaskClientInterface} reaches the wire through, and the whole of what
 * it is given: a method name, that method's parameters, and the deadline the request carries
 * (`undefined` waits on the peer indefinitely). An {@link MCPClientInterface} supplies its own
 * correlated-request path here, so a task read travels the exact channel `call` and `tools`
 * travel — one id space, one pending table, one drain on `disconnect`.
 *
 * It resolves the peer's `result` UNVALIDATED, because validating it is the caller's job and
 * every caller wants a different shape. It REJECTS with an
 * {@link import('./errors.js').MCPError} for an error response, and with an ordinary `Error`
 * for a deadline, an abort, or a transport write that failed.
 *
 * @param method - The JSON-RPC method to issue
 * @param params - That method's parameters, or `undefined` to send none
 * @param deadline - Milliseconds to wait for the answer, or `undefined` for no bound
 * @returns The peer's `result` payload, unvalidated
 */
export type MCPRequestFunction = (
	method: string,
	params: Readonly<Record<string, unknown>> | undefined,
	deadline: number | undefined,
) => Promise<unknown>

/**
 * Construction options for an {@link MCPTaskClientInterface}.
 *
 * @remarks
 * `request` is the correlated-request door (see {@link MCPRequestFunction}); an
 * {@link MCPClientInterface} hands over its own. `timeout` is the deadline every task request
 * carries, and omitting it leaves them unbounded — the same policy the issuing client applies
 * to its own calls, stated here because this client does not read the other one's options.
 */
export interface MCPTaskClientOptions {
	/** The correlated-request door every task request is issued through. */
	readonly request: MCPRequestFunction
	/** The deadline each task request carries; omitted waits on the peer indefinitely. */
	readonly timeout?: number
}

/**
 * The CLIENT half of the stable Tasks extension — reading, answering, and stopping a durable
 * task the peer created.
 *
 * @remarks
 * The mirror of {@link MCPTaskManagerInterface} minus `start`, because creating a task is
 * never the client's decision: the extension gives a client no flag and no parameter to ask
 * for one, and a task exists only because the SERVER deferred a `tools/call` it received. The
 * methods that remain are the `tasks/*` methods on the wire.
 *
 * There is deliberately NO plural accessor, for the same reason the server-side port has none:
 * the extension defines no `tasks/list`, and an accessor that could enumerate tasks would
 * invite one. The absence is how this contract states that.
 *
 * **This package ships no polling loop, and that is a design position rather than an
 * omission.** A task snapshot carries `pollIntervalMs` — a manager's hint about how often to
 * ask again — and this package carries that datum untouched and supplies the one-shot read
 * beside it. It supplies no timer, no scheduler, no terminal-await helper, and no cache,
 * because it has no durable place to keep a task, no way to know when the application still
 * cares, and no lifetime to hang a timer on that outlives the request. Schedule the reads
 * yourself, or wait for the peer to push. A task notification the server stamped for a
 * subscription is claimed by the `listen` stream that asked for it and does not re-emit
 * through the `MCPClientEventMap` `notification` event, so a subscribed consumer reads its
 * transitions from the stream it opened; an unstamped notification arrives on that event at
 * no added mechanism.
 *
 * Every method authorizes on the peer's side, so a task belonging to another principal is
 * indistinguishable from one that never existed and one whose TTL purged it — each is
 * the same `-32602`, deliberately.
 */
export interface MCPTaskClientInterface {
	/**
	 * Reads one durable task's current snapshot.
	 *
	 * @remarks
	 * REJECTS rather than answering `undefined` for a task it cannot read. The peer's refusal
	 * is byte-identical across a task that never existed, one whose TTL purged it, and one this
	 * caller is not entitled to see — that indistinguishability is the extension's whole
	 * anti-enumeration property — so manufacturing a lookup-miss here would mean matching on
	 * the peer's message text and publishing a difference the peer refused to publish.
	 *
	 * The peer's payload is carried VERBATIM once it proves well-formed. A modern result's own
	 * `resultType: 'complete'` and `_meta` stamps therefore ride along on the snapshot, because
	 * rebuilding the object to drop them would also drop the unrecognized members this
	 * package deliberately preserves.
	 *
	 * @param id - The `taskId` to read
	 * @returns That task's detail, narrowed by its `status`
	 * @throws MCPError when the peer refuses the read or answers something that is not a task
	 *
	 * @example
	 * ```ts
	 * const detail = await client.tasks.task(taskId)
	 * if (detail.status === 'completed') use(detail.result)
	 * ```
	 */
	task(id: string): Promise<MCPTaskDetail>
	/**
	 * Answers the input requests an `input_required` task is waiting on.
	 *
	 * @remarks
	 * The responses are keyed by the request keys the task itself published, and they travel
	 * VERBATIM: a key the task does not recognize, or has already answered, is the manager's to
	 * ignore rather than this client's to refuse. A partial set of answers is legal.
	 *
	 * @param id - The `taskId` the responses belong to
	 * @param responses - The answers, keyed by the task's own request keys
	 * @returns Nothing — the peer acknowledges, and the task's next snapshot reports the effect
	 * @throws MCPError when the peer refuses the update
	 *
	 * @example
	 * ```ts
	 * await client.tasks.update(taskId, { approval: { action: 'accept' } })
	 * ```
	 */
	update(id: string, responses: Readonly<Record<string, unknown>>): Promise<void>
	/**
	 * Asks one durable task to stop.
	 *
	 * @remarks
	 * ADVISORY, exactly like the server-side port it mirrors: the acknowledgement reports that
	 * the request was accepted, never that the task stopped, and a task whose work cannot be
	 * interrupted may legally reach `completed` afterwards. Read the task again to learn what
	 * happened.
	 *
	 * This is a different mechanism from `call`'s `options.signal`, which withdraws one caller
	 * from one in-flight request and never reaches a task. A call that already answered
	 * `resultType: 'task'` is a request that is OVER; only this method reaches the work it left
	 * behind.
	 *
	 * @param id - The `taskId` to stop
	 * @returns Nothing — the peer acknowledges the ask
	 * @throws MCPError when the peer refuses the cancellation
	 *
	 * @example
	 * ```ts
	 * await client.tasks.abort(taskId)
	 * ```
	 */
	abort(id: string): Promise<void>
}

/**
 * A transport-agnostic Model Context Protocol CLIENT — connects to a REMOTE MCP
 * server over an injected {@link MCPClientTransportInterface}, negotiates the
 * modern wire revision, and exposes the server's tools as local
 * {@link ToolInterface}s an agent can run.
 *
 * @remarks
 * - **The mirror of {@link MCPServerInterface}.** Where the server DISPATCHES requests
 *   over a tool registry, the client ISSUES them over a transport: `connect` negotiates through
 *   `server/discover`. A legacy peer requires an explicit
 *   {@link MCPLegacyClientTransportOptions legacy transport adapter}; the bare client refuses a
 *   peer that does not speak the modern era and names that adapter.
 *   The negotiated revision is exposed through `version`; `tools()` lists
 *   the remote tools and wraps each as a local {@link ToolInterface} whose `execute`
 *   calls back through `call`; `call(name, args)` runs a remote `tools/call` and reports
 *   the arm the peer answered with — a value, a durable task, or a request for more input
 *   (a remote tool FAILURE — `isError: true` — throws locally, so the agent's
 *   {@link ToolManagerInterface} isolates it into a `success: false` result just like a
 *   local throw). A wrapped tool has no way to hand an agent a deferred answer, so a
 *   non-`'complete'` arm throws there instead.
 * - **Per-request cancellation.** `call`'s `options.signal` cancels ONE in-flight request:
 *   it rejects locally on every carrier, and additionally writes `notifications/cancelled`
 *   where the transport declares itself {@link MCPClientTransportInterface.duplex}. It
 *   never cancels the connection, and never a durable task — a call that already answered
 *   `resultType: 'task'` is a request that is over. Cancellation is advisory, so a
 *   response arriving after the abort is discarded rather than raised.
 * - **Durable tasks, no schedule.** `tasks` ({@link MCPTaskClientInterface}) reads, answers,
 *   and stops a task the peer deferred a call into. It carries the peer's `pollIntervalMs`
 *   datum and supplies the one-shot read; it starts no timer and keeps no cache, so a client
 *   left alone after a `resultType: 'task'` answer writes NOTHING until its consumer asks.
 * - **Request↔response correlation.** Every request is tagged with a monotonic numeric
 *   `id`; the client subscribes to the transport's `message` event and resolves /
 *   rejects the matching pending request by that `id`. A server-initiated message is
 *   surfaced on `notification` — except a `notifications/progress` frame naming a request
 *   whose caller supplied a progress handler, which goes to that handler instead. A
 *   RESPONSE whose id matches nothing pending is DISCARDED: the request it answers has
 *   already settled, by its deadline, by an abort, or by a disconnect, and the protocol
 *   says to ignore it rather than surface it as something a caller might act on.
 * - **Per-request deadline.** A request carrying a deadline races an
 *   `AbortSignal.timeout(timeout)`: a server that never replies REJECTS that pending
 *   request once the deadline fires. The initial discovery probe and every public request use a
 *   deadline. An omitted `timeout` selects {@link DEFAULT_MCP_REQUEST_TIMEOUT}; an explicit
 *   timeout applies that deadline to the probe. The client's
 *   wait on the transport's `close` carries that same deadline, because it is the one wait neither
 *   the pending-request drain nor the supersession signal can reach; the deadline ends the wait,
 *   not the close, so a retry joins that close rather than issuing a second one.
 * - **Transport-agnostic.** Imports only core siblings — JSON-RPC + the tool vocabulary
 *   + the timeout primitive — with no HTTP and no model; the concrete transport is
 *   injected. Wire fields are narrowed with the contract guards (no `as`).
 * - **Observable.** The owned `emitter` fires `connect` / `disconnect` /
 *   `notification` / `error`; the emitter isolates a listener throw and routes it to its
 *   `error` handler (the `error` option), never the client.
 */
export interface MCPClientInterface {
	readonly emitter: EmitterInterface<MCPClientEventMap>
	/** Whether modern revision negotiation has completed and the client is connected. */
	readonly connected: boolean
	/** The negotiated protocol revision, or `undefined` while disconnected. */
	readonly version: MCPModernVersion | undefined
	/** The injected transport the client drives the remote server over. */
	readonly transport: MCPClientTransportInterface
	/**
	 * The stable Tasks extension's client half — reading, answering, and stopping a durable task.
	 *
	 * @remarks
	 * Always present, because the `tasks/*` methods are ordinary requests a client may
	 * issue at any time; whether they SUCCEED is the peer's decision, and a server that did not
	 * configure the extension answers each of them `-32601`. Nothing here is advertised, cached, or
	 * polled — see {@link MCPTaskClientInterface} for why the schedule stays the consumer's.
	 */
	readonly tasks: MCPTaskClientInterface
	/**
	 * Connects to the remote server — opens a connection on the transport and negotiates the
	 * modern wire revision.
	 *
	 * @remarks
	 * Idempotent — a second `connect` while already connected is a no-op, and one issued
	 * while the CURRENT attempt is in flight joins that attempt and returns its outcome
	 * instead of opening a second connection. One issued while a {@link disconnect} is closing
	 * waits for that close first; one issued while an attempt that a {@link disconnect}
	 * superseded is still unwinding OUTWAITS it, because that attempt may still owe the close
	 * of a connection it opened, and then opens the next connection or joins whichever caller
	 * reached it first. One issued while a close is still OWED — an earlier `close` having failed,
	 * or having outrun its deadline without ever confirming that the connection ended — closes that
	 * connection FIRST, joining a close still running rather than issuing a second one, and rejects
	 * with the fault if that close fails or goes unanswered again; so the transport is never opened
	 * beside a connection no path has closed. The client probes `server/discover`; an explicit legacy
	 * transport adapter owns any `initialize` handshake and presents a modern discovery result.
	 * On success {@link version} contains a supported revision and the `connect` event
	 * fires. Whichever side owns the open connection closes it when the attempt rejects — the
	 * attempt itself, or the {@link disconnect} that superseded it — and a `close` that fails, or
	 * that the client stops waiting for, returns that connection to the client's ownership, so a
	 * later `connect` or {@link disconnect} can still reach it. Only the transport settles that
	 * ownership: a retained `close` that resolves later discharges it, and one that rejects later
	 * leaves it owed and closable again.
	 *
	 * @returns Resolves once this attempt's handshake completes — the attempt's outcome, not
	 * the client's state when the caller resumes, which a racing {@link disconnect} can
	 * already have cleared
	 */
	connect(): Promise<void>
	/**
	 * Discovers a modern server's supported revisions and capabilities.
	 *
	 * @remarks
	 * The request carries the modern per-request metadata stamp. Unknown revisions in
	 * the peer's advertisement are ignored because {@link MCPDiscoverResult} exposes
	 * only revisions this client can negotiate. It carries the configured request deadline;
	 * omitting `timeout` selects {@link DEFAULT_MCP_REQUEST_TIMEOUT}.
	 *
	 * @returns The validated modern discovery result
	 */
	discover(): Promise<MCPDiscoverResult>
	/**
	 * Disconnects from the remote server — rejects every pending request and closes the
	 * connection this client opened on its transport.
	 *
	 * @remarks
	 * Idempotent — one issued while another is closing joins it and returns that outcome, and
	 * one issued with nothing connected, no attempt in flight, and no connection left open by a
	 * failed close does nothing. A `disconnect`
	 * awaited during an in-flight {@link connect} supersedes that attempt instead of waiting
	 * for it: the superseded `connect` rejects rather than resolving, and every wait it can be
	 * parked in once the transport has opened is bounded — a pending request by the drain, a raw
	 * wire write by the supersession signal, its own close by the request deadline — so it
	 * settles. An attempt still suspended inside the transport's `start` settles only when that
	 * `start` does, because nothing here bounds the opening step. It closes the connection the
	 * client owns when it runs, and closes nothing for an attempt still inside the transport's
	 * `start` — that attempt owns nothing yet and closes what it opens itself. The transport's
	 * `close` carries the per-request deadline on the WAIT, so a shutdown the transport accepts and
	 * never answers rejects instead of holding this caller and every later {@link connect} — while
	 * that close itself keeps running, because the deadline only ends this client's waiting. A `close`
	 * that faults or goes unanswered rejects this call and leaves the connection owned, so the next
	 * `disconnect` — or the next {@link connect}, which refuses to open while a close is owed —
	 * settles it again: joining the close still running when there is one, issuing a fresh `close`
	 * when the last one rejected, rather than stranding a connection no path can reach or shutting
	 * one connection down twice. {@link connected} is
	 * cleared before the teardown suspends, so it is never true once `disconnect` resolves,
	 * and {@link version} becomes `undefined` with it. The `disconnect` event fires only where
	 * this client had announced `connect`, so an attempt torn down before that announcement
	 * ends silently, and a failed `close` does not withhold it.
	 *
	 * @returns Resolves once the teardown has finished and any connection it owned is closed;
	 * rejects with the fault when that close failed or never returned
	 */
	disconnect(): Promise<void>
	/**
	 * Lists the remote server's tools, each wrapped as a local {@link ToolInterface}
	 * whose `execute` runs the remote `tools/call` through {@link call}.
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
	 * Listens for the remote server's matching subscription notifications.
	 *
	 * @param notifications - The requested filter, or `undefined` for an empty filter
	 * @param options - Required cancellation and optional queue-capacity policy
	 * @returns The acknowledgement and matching notifications, with the graceful result on closure
	 */
	listen(
		notifications: MCPSubscriptionFilter | undefined,
		options: MCPListenOptions,
	): MCPSubscriptionStream
	/**
	 * Calls a remote tool by name — runs `tools/call` and reports which permitted arm
	 * the peer answered with.
	 *
	 * @remarks
	 * The answer is an {@link MCPCallOutcome} because the peer, not the caller, decides
	 * whether the call finished: a modern server may DEFER it into a durable task or ask
	 * for another round trip, and both are legal answers to an ordinary call. Narrow on
	 * `resultType`; the `'complete'` arm carries the tool's `value` — the peer's
	 * `structuredContent` when it sent one, otherwise its concatenated `text` parsed as
	 * JSON (falling back to the raw string). A remote tool FAILURE (`isError: true`)
	 * THROWS an `Error` carrying the error text instead, so an agent's
	 * {@link ToolManagerInterface} isolates it into a `success: false` result exactly as
	 * it would a local tool throw. A `resultType` this client cannot name is refused.
	 *
	 * `options.signal` cancels THIS request only — the caller stops waiting, the pending
	 * request rejects, and the peer is TOLD on a carrier that can carry a client
	 * notification (see {@link MCPClientTransportInterface.duplex}). MCP cancellation is
	 * advisory: the peer may answer anyway, and that late answer is discarded rather than
	 * raised. `options.progress` receives this request's progress frames.
	 *
	 * @param name - The remote tool's name
	 * @param args - The arguments record forwarded as the call's `arguments`
	 * @param options - Optional per-call cancellation and progress policy
	 * @returns The arm the peer answered with — a value, a task, or an input request
	 */
	call(
		name: string,
		args: Readonly<Record<string, unknown>>,
		options?: MCPCallOptions,
	): Promise<MCPCallOutcome>
}
