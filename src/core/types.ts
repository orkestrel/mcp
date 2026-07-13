import type { EmitterErrorHandler, EmitterHooks, EmitterInterface } from '../emitters/types.js'
import type { ToolInterface, ToolManagerInterface } from '../agents/types.js'

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

/** One content item of an MCP {@link MCPToolResult} — a `text` block carrying the tool's output. */
export interface MCPContent {
	readonly type: 'text'
	readonly text: string
}

/**
 * The MCP `tools/call` result — the executed tool's output as `content` blocks,
 * with `isError` flagging a tool failure.
 *
 * @remarks
 * A success carries the tool's value serialized into one `text` content block; a
 * tool FAILURE (the `ToolResult.error` the registry isolated) carries the error
 * text in `content` AND sets `isError: true`, so the model sees the failure as a
 * tool result it can react to rather than a protocol error.
 */
export interface MCPToolResult {
	readonly content: readonly MCPContent[]
	/** `true` when the tool failed — its error text is in `content`. */
	readonly isError?: boolean
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

/** The server identity echoed in the MCP `initialize` result's `serverInfo`. */
export interface MCPServerInfo {
	readonly name: string
	readonly version: string
}

/**
 * The push observation surface (§13) of an {@link MCPServerInterface} — the
 * dispatch moments a fire-and-forget observer (logging, tracing) subscribes to
 * via `server.emitter.on`.
 *
 * @remarks
 * `request` fires at the TOP of every `dispatch` with the method and the
 * correlating id (`null` for a notification), BEFORE the method runs — so an
 * observer sees every inbound call. Listener isolation is the emitter's (§13): a
 * listener throw is routed to the emitter's `error` handler (the `error` option),
 * never onto this map, so a buggy observer can never corrupt a dispatch. Declared as
 * a `type` alias (§4.5) so the type-literal satisfies `EventMap` structurally.
 */
export type MCPServerEventMap = {
	/** A request is being dispatched — its `method` and correlating `id` (`null` for a notification). */
	readonly request: readonly [method: string, id: string | number | null]
}

/**
 * Options for `createMCPServer` — the server identity (`name` / `version`), the
 * live {@link ToolManagerInterface} it exposes, an optional `description`, and the
 * reserved `on` hooks (§8).
 *
 * @remarks
 * `name` / `version` identify the server in the `initialize` handshake
 * (`serverInfo`). `tools` is the live registry the server dispatches `tools/list`
 * / `tools/call` over — its `definitions()` advertise the tools and its
 * `execute()` runs a call (the manager already isolates a tool throw into a
 * result `error`, so the server adds none). `description` is a human label for
 * the server (reserved for a future `instructions` capability — unused by the
 * current dispatch). `on` is the §8 reserved key: initial listeners for the
 * server's {@link MCPServerEventMap}, wired at construction.
 */
export interface MCPServerOptions {
	readonly on?: EmitterHooks<MCPServerEventMap>
	/** The emitter's listener-error handler (AGENTS §13) — a listener throw routes here, not to a domain event. */
	readonly error?: EmitterErrorHandler
	readonly name: string
	readonly version: string
	/** The live tool registry the server exposes over `tools/list` / `tools/call`. */
	readonly tools: ToolManagerInterface
	/** A human label for the server (reserved for a future capability; unused by dispatch). */
	readonly description?: string
}

/**
 * A transport-agnostic Model Context Protocol server — dispatches JSON-RPC 2.0
 * requests (`initialize` / `ping` / `tools/list` / `tools/call`) over a live
 * {@link ToolManagerInterface}, with NO transport coupling (a transport layer
 * pumps strings through `handle`).
 *
 * @remarks
 * - **Two entry points.** `dispatch(request)` is the TYPED core: it takes an
 *   already-parsed {@link JSONRPCRequest}, runs the method, and resolves a
 *   {@link JSONRPCResponse} — or `undefined` for a NOTIFICATION (a request with no
 *   `id`). `handle(message)` is the STRING boundary: it `JSON.parse`s the raw
 *   message, narrows it to a request, dispatches, and serializes the response back
 *   to a string — turning a parse failure into a `-32700` response and a non-request
 *   into a `-32600` response, and returning `undefined` for a notification.
 * - **Provider-agnostic.** Imports only core siblings; it speaks JSON-RPC + the
 *   tool registry, with no HTTP, no model, and no backend coupling.
 * - **Observable (§13).** The owned `emitter` ({@link MCPServerEventMap}) fires
 *   `request` per dispatch; the emitter isolates a listener throw and routes it to its
 *   `error` handler (the `error` option, §13), never the dispatch.
 */
export interface MCPServerInterface {
	readonly emitter: EmitterInterface<MCPServerEventMap>
	readonly name: string
	readonly version: string
	/**
	 * Dispatch an already-parsed request — run its method and resolve the response,
	 * or `undefined` for a notification (a request with no `id`).
	 *
	 * @param request - The parsed JSON-RPC request to dispatch
	 * @returns The response, or `undefined` when the request was a notification
	 */
	dispatch(request: JSONRPCRequest): Promise<JSONRPCResponse | undefined>
	/**
	 * Handle a raw message string — parse it, dispatch, and serialize the response.
	 *
	 * @remarks
	 * A `JSON.parse` failure resolves a serialized `-32700` (Parse error) response;
	 * a parsed value that is not a valid request resolves a serialized `-32600`
	 * (Invalid Request) response; a notification resolves `undefined` (no response).
	 *
	 * @param message - The raw JSON-RPC message string
	 * @returns The serialized response string, or `undefined` for a notification
	 */
	handle(message: string): Promise<string | undefined>
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
 * {@link MCPClientInterface} hands the transport a {@link JSONRPCMessage} (or a batch)
 * via `send`, and the transport delivers each decoded reply back through the
 * `message` event the client subscribed to. The minimal carrier surface (§21): a
 * `start` (open the connection / arm any reader), `send` (write a message or batch),
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
	 * Send one JSON-RPC message (or a batch) to the remote server.
	 *
	 * @remarks
	 * Each decoded reply is surfaced on the `emitter`'s `message` event — `send`
	 * itself resolves once the message has been written (and, for a request/response
	 * transport, its synchronous reply emitted), not when a logical response arrives;
	 * the {@link MCPClientInterface} awaits the response through its `id` correlation.
	 *
	 * @param message - One message, or a batch of them, to write to the wire
	 * @returns Resolves once the message(s) have been sent
	 */
	send(message: JSONRPCMessage | readonly JSONRPCMessage[]): Promise<void>
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
 * client identity (`name` / `version`), the per-request `timeout`, and the reserved
 * `on` hooks (§8).
 *
 * @remarks
 * - `transport` — the carrier the client drives a remote MCP server over (REQUIRED;
 *   a concrete one from `src/server/mcp`, or an in-process loopback).
 * - `name` / `version` — identify the client in the `initialize` handshake
 *   (`clientInfo`); default to {@link import('./constants.js').DEFAULT_MCP_CLIENT_NAME}
 *   / {@link import('./constants.js').DEFAULT_MCP_CLIENT_VERSION}.
 * - `timeout` — the per-request deadline in milliseconds: a `tools/list` / `tools/call`
 *   / `initialize` that the server does not answer within it REJECTS (the pending
 *   request is settled by an {@link import('../timeouts/types.js').TimeoutInterface}
 *   deadline, the taverna idiom — never a raw `setTimeout`). Defaults to {@link
 *   import('./constants.js').DEFAULT_MCP_REQUEST_TIMEOUT}.
 * - `on` — the §8 reserved key: initial listeners for the client's
 *   {@link MCPClientEventMap}, wired at construction.
 */
export interface MCPClientOptions {
	readonly on?: EmitterHooks<MCPClientEventMap>
	/** The emitter's listener-error handler (AGENTS §13) — a listener throw routes here, not to a domain event. */
	readonly error?: EmitterErrorHandler
	readonly transport: ClientTransportInterface
	readonly name?: string
	readonly version?: string
	/** The per-request deadline in milliseconds (default {@link import('./constants.js').DEFAULT_MCP_REQUEST_TIMEOUT}). */
	readonly timeout?: number
}

/**
 * A transport-agnostic Model Context Protocol CLIENT — connects to a REMOTE MCP
 * server over an injected {@link ClientTransportInterface}, performs the
 * `initialize` handshake, and exposes the server's tools as local
 * {@link ToolInterface}s an agent can run.
 *
 * @remarks
 * - **The mirror of {@link MCPServerInterface}.** Where the server DISPATCHES requests
 *   over a tool registry, the client ISSUES them over a transport: `connect` runs the
 *   `initialize` handshake (then sends `notifications/initialized`); `tools()` lists
 *   the remote tools and wraps each as a local {@link ToolInterface} whose `execute`
 *   calls back through `call`; `call(name, args)` runs a remote `tools/call` and
 *   returns the tool's value (a remote tool FAILURE — `isError: true` — throws locally,
 *   so the agent's {@link ToolManagerInterface} isolates it into a result `error` just
 *   like a local throw).
 * - **Request↔response correlation.** Every request is tagged with a monotonic numeric
 *   `id`; the client subscribes to the transport's `message` event and resolves /
 *   rejects the matching pending request by that `id`. A message that is NOT a response
 *   to a pending request is a server NOTIFICATION — surfaced on `notification`.
 * - **Per-request deadline.** Each request races an {@link
 *   import('../timeouts/types.js').TimeoutInterface} (the taverna idiom): a server that
 *   never replies REJECTS the pending request once the deadline fires, never hanging.
 * - **Transport-agnostic.** Imports only core siblings — JSON-RPC + the tool vocabulary
 *   + the timeout primitive — with no HTTP and no model; the concrete transport is
 *   injected. Wire fields are narrowed via the contracts guards (no `as`).
 * - **Observable (§13).** The owned `emitter` fires `connect` / `disconnect` /
 *   `notification` / `error`; the emitter isolates a listener throw and routes it to its
 *   `error` handler (the `error` option, §13), never the client.
 */
export interface MCPClientInterface {
	readonly emitter: EmitterInterface<MCPClientEventMap>
	/** Whether the `initialize` handshake has completed and the client is connected. */
	readonly connected: boolean
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
	 * Connect to the remote server — open the transport and run the `initialize`
	 * handshake (then send `notifications/initialized`).
	 *
	 * @remarks
	 * Idempotent — a second `connect` while already connected is a no-op. On success
	 * the `connect` event fires.
	 *
	 * @returns Resolves once the handshake completes and the client is connected
	 */
	connect(): Promise<void>
	/**
	 * Disconnect from the remote server — reject every pending request and close the
	 * transport.
	 *
	 * @remarks
	 * Idempotent — a second `disconnect` while already disconnected is a no-op. The
	 * `disconnect` event fires.
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
	 * The inverse of the server's `buildToolResult`: a SUCCESS parses the concatenated
	 * `text` as JSON (falling back to the raw string when it is not JSON); a remote tool
	 * FAILURE (`isError: true`) THROWS an `Error` carrying the error text — so an agent's
	 * {@link ToolManagerInterface} isolates the remote failure into a result `error`
	 * exactly as it would a local tool throw.
	 *
	 * @param name - The remote tool's name
	 * @param args - The arguments record forwarded as the call's `arguments`
	 * @returns The remote tool's value (parsed JSON, or the raw text)
	 */
	call(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown>
}
