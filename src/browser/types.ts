import type { MCPClientInterface, MCPClientOptions, MCPTransportInterface } from '@src/core'
import type { ToolInterface, ToolManagerInterface } from '@orkestrel/tool'
import type { EmitterErrorHandler, EmitterHooks, EmitterInterface } from '@orkestrel/emitter'

// The MCP browser-transport surface — the source of truth. The client
// transports for the Model Context Protocol drive a remote server from a page
// / Web Worker / Service Worker: the native `WebSocket` transport
// (`transports/WebSocketClientTransport.ts`) and the host-independent `fetch` +
// `@orkestrel/sse` streamable-HTTP transport `@src/core` publishes, which this face's
// `createHTTPClientTransport` returns. Every one speaks the same `@src/core`
// `MCPMessageTransportInterface`, so `createMCPClient` consumes them identically. The host
// performs the WebSocket handshake, so this face carries none of the Node client's
// `node:crypto` / `node:http(s)` machinery.
//
// `MessagePortTransport` is the genuinely new capability: unlike the
// client-only carriers, a `MessagePort` is symmetric — the same class is handed
// to either `bindServer` or `bindClient` (`@src/core`), the role coming from which
// binder it is given to. `ScopeServerOptions`, `ScopeInterface`, and
// `ScopeServerInterface` back `createScopeServer`, the factory that wires a Web Worker's /
// Service Worker's own message events (and any `MessagePort` they carry) to an `MCPServer`.

/**
 * Options for `createWebSocketClientTransport` (browser face) — the remote MCP
 * WebSocket endpoint and any negotiated subprotocols.
 *
 * @remarks
 * - `url` — the absolute `ws://` / `wss://` (or `http://` / `https://`, accepted by
 *   the native `WebSocket` constructor the same way) URL of the remote server's
 *   WebSocket endpoint. Required.
 * - `protocols` — the WebSocket subprotocol(s) to request. **Defaults to
 *   {@link import('@orkestrel/mcp').MCP_WEBSOCKET_SUBPROTOCOL} (`'mcp'`)**, which
 *   `createWebSocketServer` selects when the offer contains it. Per
 *   RFC 6455 §4.1 a client must fail the connection if the server returns a subprotocol
 *   it did not request; Node ≥ 22 (undici) enforces this strictly, so the default saves
 *   you from that trap when connecting to this repo's own server. Override only when
 *   targeting a foreign server that speaks a different (or no) subprotocol — pass `[]`
 *   to request no subprotocol at all.
 *
 * **No `headers` here, and that divergence from the Node face's `{ url, headers }` is
 * deliberate rather than unfinished: the host performs the WebSocket handshake.** The
 * native constructor takes a URL and subprotocols and nothing else, so a page cannot set an
 * upgrade request header at all — there is no seam for an `Authorization` bearer to reach.
 * The Node face owns its own `node:http(s)` upgrade request and therefore can, which is why
 * only that side offers `headers`. Reach a guarded server from a page with a credential the
 * platform does carry: a cookie the browser attaches to the upgrade, a subprotocol token, or
 * a signed value in the URL. Adding a `headers` key here would be an option that silently
 * did nothing.
 */
export interface WebSocketClientTransportOptions {
	readonly url: string
	readonly protocols?: string | readonly string[]
}

/**
 * Options for `createMessagePortTransport` — the native `MessagePort` a
 * {@link MessagePortTransport} sends and listens on.
 *
 * @remarks
 * `port` — the channel half to drive (for example, one side of a `new MessageChannel()`, or
 * the port a `message` event's `ports[0]` carried). Required. The same transport
 * works as either a server or a client carrier — the role comes from whether it is
 * handed to `bindServer` or `bindClient`/`createDuplexClientTransport` (`@orkestrel/mcp`).
 */
export interface MessagePortTransportOptions {
	readonly port: MessagePort
}

/**
 * Adapts a message-event-bearing scope (`self` in a dedicated Web Worker, or any object
 * shaped the same way) as a duplex {@link MCPTransportInterface} — the
 * internal carrier `createScopeServer` binds to route the implicit (portless) message
 * channel, plus the `deliver` entry point the scope's own `message` listener pushes
 * an inbound string through (the scope itself never registers `listen`'s handler
 * for the caller — the scope server's dispatcher does, through this `deliver`).
 */
export interface ScopeTransportInterface extends MCPTransportInterface {
	/** Pushes one inbound message string into the active `listen` handler. */
	deliver(message: string): void
}

/**
 * Describes the structural shape {@link import('./factories.js').createScopeServer} needs
 * from a
 * hostable scope — `self` in a dedicated Web Worker or a Service Worker (or any double
 * matching this shape).
 *
 * @remarks
 * Only the members the scope server actually touches: `postMessage` (the
 * dedicated-worker implicit reply channel), and `addEventListener` /
 * `removeEventListener` for `'message'` (every inbound event, portless or
 * port-bearing, arrives through the same listener — see {@link ScopeServerOptions}'s
 * doc and the factory). A real `self` / `globalThis` inside a worker satisfies this
 * structurally (it exposes far more, which this narrower shape ignores).
 */
export interface ScopeInterface {
	/** Posts one reply onto the scope's implicit channel. */
	postMessage(message: unknown): void
	/** Subscribes to the scope's `message` events, portless and port-bearing alike. */
	addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
	/** Drops a `message` subscription. */
	removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

/**
 * Represents one MCP server hosted inside a worker scope — what
 * {@link import('./factories.js').createScopeServer} returns.
 *
 * @remarks
 * The browser twin of the Node face's `StdioServerInterface`, and it publishes only the
 * terminal: the factory arms the scope's `message` listener before it returns, because an
 * event delivered between construction and an explicit `start` would reach nothing. `stop`
 * removes that listener, unbinds the implicit scope channel, and tears down every accepted
 * port binding; it is idempotent, and it ends this handle's lifetime permanently.
 */
export interface ScopeServerInterface {
	/** Ends every binding this scope server owns — idempotent, and permanent for this handle. */
	stop(): void
}

/**
 * Options for {@link import('./factories.js').createScopeServer} — the live
 * {@link ToolManagerInterface} to expose plus the optional server identity, mirroring
 * `createMCPServer`'s `MCPServerOptions` (`@orkestrel/mcp`) but with `name`/`version`
 * optional (defaulting to {@link import('./constants.js').DEFAULT_MCP_SERVER_NAME} /
 * {@link import('./constants.js').DEFAULT_MCP_SERVER_VERSION}).
 *
 * @remarks
 * - `accept` — optional identity gate consulted **before** a port-bearing `message`
 *   event is accepted; return `false` to drop the event (no binding, no reply).
 *   **`accept` gates only port-bearing events** — portless messages bypass it and
 *   deliver directly to the implicit scope channel (the tool executes, blind; in a
 *   Service Worker the reply is silently dropped — see `createScopeServer`'s portless note).
 *   Prefer a handshake token in `event.data` as the primary pattern
 *   (for example, `(event) => event.data === token`) — for same-origin worker/MessagePort
 *   messages `event.origin` is frequently the empty string, making origin
 *   allow-listing unreliable; origin checks are meaningful for cross-origin
 *   `postMessage` only. When omitted, all port-bearing events are accepted — every
 *   same-origin context that can reach the scope gets full tool-call access.
 *   See `createScopeServer`'s trust-boundary and portless-events notes.
 */
export interface ScopeServerOptions {
	readonly tools: ToolManagerInterface
	readonly name?: string
	readonly version?: string
	readonly accept?: (event: MessageEvent) => boolean
}

// ── The in-page pair ─────────────────────────────────────────────────────────
//
// `createPageServer` is `createScopeServer`'s page twin: it hosts an `MCPServer` in the
// calling context over a native `MessageChannel` and hands back the client already bound to
// it. `PageServerOptions` mirrors `ScopeServerOptions`'s identity defaults and adds the
// `client` group for the client half the pair owns.

/**
 * Options for {@link import('./factories.js').createPageServer} — the live
 * {@link ToolManagerInterface} to expose, the optional server identity, and the optional
 * settings for the client half the pair owns.
 *
 * @remarks
 * - `tools` — the registry the hosted `MCPServer` dispatches `tools/call` against. Required.
 * - `name` / `version` — the hosted server's identity, defaulting to
 *   {@link import('./constants.js').DEFAULT_MCP_SERVER_NAME} /
 *   {@link import('./constants.js').DEFAULT_MCP_SERVER_VERSION} exactly as
 *   {@link ScopeServerOptions} does.
 * - `client` — the client half's own settings, grouped because there is more than one, and
 *   declared as `MCPClientOptions` (`@orkestrel/mcp`) minus its one omission rather than as a
 *   restatement of its members: every member the client accepts reaches this factory, and a
 *   member added to that interface later reaches it without an edit here. `transport` is the
 *   omission, and the only one: the pair mints the `MessageChannel` and owns both ends of it,
 *   which is the whole point of the factory, so a caller-supplied carrier would be a second
 *   transport with nothing on the other side of it.
 */
export interface PageServerOptions {
	readonly tools: ToolManagerInterface
	readonly name?: string
	readonly version?: string
	readonly client?: Omit<MCPClientOptions, 'transport'>
}

/**
 * Represents one MCP server hosted inside the calling page — what
 * {@link import('./factories.js').createPageServer} returns.
 *
 * @remarks
 * The page twin of {@link ScopeServerInterface}, and it publishes the client beside the
 * terminal because the pair's whole value is holding both ends. The returned `client` is
 * bound but NOT connected: connection is a protocol round trip over the channel, so it stays
 * the consumer's `await client.connect()` rather than a promise the factory hides.
 *
 * `stop` closes the client's port first, so the client observes the close and reports
 * `connected` as `false`, then unbinds both sides and closes the server's port. It is
 * idempotent, and it ends this handle's lifetime permanently — the same verb, with the same
 * meaning, that {@link ScopeServerInterface} publishes for the same action.
 *
 * The published `client` stays reachable after `stop` and is inert: `call` and `tools` reject
 * at once with an `MCPError` carrying `-32600`, because the pair's channel is closed and no
 * `connect` can reopen it.
 */
export interface PageServerInterface {
	/** Holds the client bound to the server this page hosts, awaiting its own `connect`. */
	readonly client: MCPClientInterface
	/** Closes both ports, unbinds both sides, and disconnects the client — idempotent. */
	stop(): void
}

// ── The WebMCP bridge ────────────────────────────────────────────────────────
//
// The `WebMCP*` types transliterate the WebMCP WebIDL (`document.modelContext`) member for
// member, because TypeScript's DOM library declares none of it: the specification is
// incubating in a Community Group and no browser ships the global (the chromestatus record,
// read 2026-09-15 and last updated 2026-08-12, reports `Proposed` with `"flag": false` and
// `"origintrial": false`). They are this package's own declaration of a FOREIGN surface, so
// each keeps the IDL's exact spelling —
// `registerTool`, `exposedTo`, `fromOrigins`, `readOnlyHint` — while every package-owned
// member beside them stays one word. `ModelContext*` is the bridge's own vocabulary.

/**
 * Describes a tool's observable effects as the WebMCP registry declares them.
 *
 * @remarks
 * Transliterates the WebMCP `ToolAnnotations` dictionary. The IDL defaults each member to
 * `false`; this declaration keeps every member optional instead, because the bridge projects
 * from `@orkestrel/tool`'s `ToolAnnotations` and never invents a hint the author omitted. The
 * mapping is `pure` to `readOnlyHint`, `untrusted` to `untrustedContentHint`, and
 * `consequential` to `consequentialHint` — a fuller correspondence than the MCP wire's, which
 * has no counterpart for `untrusted` and spells the consequence `destructiveHint`.
 */
export interface WebMCPAnnotations {
	readonly readOnlyHint?: boolean
	readonly untrustedContentHint?: boolean
	readonly consequentialHint?: boolean
}

/**
 * Describes the members a WebMCP tool carries into the registry and back out of it.
 *
 * @remarks
 * The WebMCP `ModelContextTool` and `RegisteredTool` dictionaries declare the same members —
 * `name`, `title`, `description`, `inputSchema`, `annotations` — and differ only in what each
 * adds, so this is the shared body {@link WebMCPTool} and {@link WebMCPRegisteredTool} extend.
 * `description` is required in the IDL and stays required here, which is why `publish` refuses
 * a tool that authors neither a description nor a summary rather than registering an empty one.
 */
export interface WebMCPDescriptor {
	readonly name: string
	readonly title?: string
	readonly description: string
	readonly inputSchema?: Readonly<Record<string, unknown>>
	readonly annotations?: WebMCPAnnotations
}

/**
 * Carries the execution signal the WebMCP registry hands a registered tool's callback.
 *
 * @remarks
 * Transliterates the WebMCP `ToolExecuteCallbackOptions` dictionary, whose `signal` is
 * required: the registry always mints one, and an `executeTool` caller's own signal is
 * forwarded onto it.
 */
export interface WebMCPHandlerOptions {
	readonly signal: AbortSignal
}

/**
 * Runs one registered WebMCP tool with the caller's input and the registry's signal.
 *
 * @remarks
 * Transliterates the WebMCP `ToolExecuteCallback` callback. The IDL types its return
 * `Promise<any>` and this declaration narrows that to `Promise<unknown>`, because a caller
 * must narrow what a foreign tool returned before reading it.
 */
export type WebMCPExecuteHandler = (
	input: Readonly<Record<string, unknown>>,
	options: WebMCPHandlerOptions,
) => Promise<unknown>

/**
 * Describes one tool as handed to the WebMCP registry for registration.
 *
 * @remarks
 * Transliterates the WebMCP `ModelContextTool` dictionary: {@link WebMCPDescriptor}'s members
 * plus the required `execute` callback the registry invokes.
 */
export interface WebMCPTool extends WebMCPDescriptor {
	readonly execute: WebMCPExecuteHandler
}

/**
 * Describes one tool as the WebMCP registry reports it back.
 *
 * @remarks
 * Transliterates the WebMCP `RegisteredTool` dictionary: {@link WebMCPDescriptor}'s members
 * plus the `window` that registered the tool and the `origin` it was registered from. The
 * bridge carries both unread — `executeTool` takes the whole record back — and reads the
 * descriptor members alone.
 */
export interface WebMCPRegisteredTool extends WebMCPDescriptor {
	readonly window: Window
	readonly origin: string
}

/**
 * Options for the WebMCP registry's `registerTool` — the exposure list and the
 * unregistration signal.
 *
 * @remarks
 * Transliterates the WebMCP `ModelContextRegisterToolOptions` dictionary. `exposedTo` lists
 * the origins the registration is visible to; `signal` is WebMCP's unregistration path —
 * aborting it removes the tool, which is why the bridge retains one controller per
 * registration.
 */
export interface WebMCPRegisterOptions {
	readonly exposedTo?: readonly string[]
	readonly signal?: AbortSignal
}

/**
 * Options for the WebMCP registry's `getTools` — the origins whose tools are read.
 *
 * @remarks
 * Transliterates the WebMCP `ModelContextGetToolOptions` dictionary. Omitting `fromOrigins`
 * reads this document's own registrations.
 */
export interface WebMCPToolsOptions {
	readonly fromOrigins?: readonly string[]
}

/**
 * Options for the WebMCP registry's `executeTool` — the caller's cancellation signal.
 *
 * @remarks
 * Transliterates the WebMCP `ModelContextExecuteToolOptions` dictionary. The registry
 * forwards this signal onto the {@link WebMCPHandlerOptions} it hands the tool's callback.
 */
export interface WebMCPExecuteOptions {
	readonly signal?: AbortSignal
}

/**
 * Represents the WebMCP tool registry a document exposes as `document.modelContext`.
 *
 * @remarks
 * Transliterates the WebMCP `ModelContext` interface, which extends `EventTarget`: the
 * operations plus the `toolchange` subscription the bridge republishes as
 * {@link ModelContextEventMap}'s `change`. Only the members the bridge touches are declared,
 * exactly as {@link ScopeInterface} declares only what `createScopeServer` touches, so a real
 * `ModelContext` satisfies this structurally and an IDL-faithful double satisfies it without
 * implementing the whole of `EventTarget`.
 *
 * `executeTool` resolves `unknown` because the primary source disagrees with itself: the IDL
 * types it `Promise<DOMString>` while the specification's own README sample returns the MCP
 * content shape `{ content: [...] }` from a tool's callback. The bridge records that
 * disagreement rather than resolving it, so it neither parses the answer as text nor projects
 * it into content blocks.
 */
export interface WebMCPRegistryInterface {
	/** Registers one tool, resolving when the registry has accepted it. */
	registerTool(tool: WebMCPTool, options?: WebMCPRegisterOptions): Promise<void>
	/** Reads the registered tools this document may see. */
	getTools(options?: WebMCPToolsOptions): Promise<readonly WebMCPRegisteredTool[]>
	/** Runs one registered tool and resolves whatever its callback returned. */
	executeTool(
		tool: WebMCPRegisteredTool,
		input?: Readonly<Record<string, unknown>>,
		options?: WebMCPExecuteOptions,
	): Promise<unknown>
	/** Subscribes to the registry's `toolchange` event. */
	addEventListener(type: 'toolchange', listener: () => void): void
	/** Drops a `toolchange` subscription. */
	removeEventListener(type: 'toolchange', listener: () => void): void
}

/**
 * Describes a document that exposes the WebMCP tool registry.
 *
 * @remarks
 * The narrowed shape {@link import('./validators.js').isWebMCPDocument} produces, and the one
 * value {@link import('./ModelContext.js').ModelContext} needs. It declares the `modelContext`
 * member alone rather than extending `Document`, because that member is the whole of what the
 * bridge dereferences — a real `Document` carrying the registry satisfies it structurally, and
 * so does any other host object that exposes one.
 */
export interface WebMCPDocument {
	readonly modelContext: WebMCPRegistryInterface
}

/**
 * Pairs one tool with the WebMCP descriptor a registry advertises for it.
 *
 * @remarks
 * The bridge's own pairing rather than a WebMCP dictionary. A registration has to answer later
 * whether the manager still holds the tool it was made for, and a descriptor alone cannot
 * answer that: two tools can advertise identical descriptors, and a descriptor JSON cannot
 * encode — a cyclic `inputSchema` — compares equal to none, its own included.
 */
export interface WebMCPProjection {
	readonly tool: ToolInterface
	readonly descriptor: WebMCPDescriptor
}

/**
 * Reports the moments a WebMCP registry's contents changed.
 *
 * @remarks
 * Declared as a `type` alias rather than an interface, so the type-literal satisfies
 * `EventMap` structurally. One event, because the registry publishes one: WebMCP's
 * `toolchange` names no tool and carries no payload, so the bridge republishes it as a bare
 * signal and a listener re-reads {@link ModelContextInterface.adopt} to learn what changed.
 */
export type ModelContextEventMap = {
	/** Reports that the document's registry changed — re-read it to learn how. */
	readonly change: readonly []
}

/**
 * Options for {@link import('./factories.js').createModelContext} — the document to bridge
 * and the emitter's initial wiring.
 *
 * @remarks
 * - `document` — the document whose registry to bridge, defaulting to `globalThis.document`.
 *   A document exposing no `modelContext` makes the factory return `undefined`.
 * - `on` — the reserved initial {@link import('@orkestrel/emitter').EmitterHooks} for
 *   {@link ModelContextEventMap}.
 * - `error` — the emitter's listener-error handler; a listener throw routes here rather than
 *   to a domain event.
 */
export interface ModelContextOptions {
	readonly document?: Document
	readonly on?: EmitterHooks<ModelContextEventMap>
	readonly error?: EmitterErrorHandler
}

/**
 * Options for {@link ModelContextInterface.publish} — the origins each registration is
 * exposed to.
 *
 * @remarks
 * `origins` is this package's one-word name for WebMCP's `exposedTo`, forwarded unchanged.
 * Omitting it registers with no exposure list, which is the registry's own default.
 */
export interface ModelContextPublishOptions {
	readonly origins?: readonly string[]
}

/**
 * Options for {@link ModelContextInterface.adopt} — the origins whose tools are read.
 *
 * @remarks
 * `origins` is this package's one-word name for WebMCP's `fromOrigins`, forwarded unchanged.
 * Omitting it reads this document's own registrations.
 */
export interface ModelContextAdoptOptions {
	readonly origins?: readonly string[]
}

/**
 * Represents the bridge between a {@link ToolManagerInterface} and a document's WebMCP
 * registry — what {@link import('./factories.js').createModelContext} returns.
 *
 * @remarks
 * Bidirectional and symmetric: `publish` sends this page's tools out to the registry, `adopt`
 * brings the registry's tools back in as `@orkestrel/tool` `Tool` instances. Both directions
 * run the same annotation projection in opposite directions.
 *
 * The handle aborts exactly the registrations it made. WebMCP registration identity is the
 * tool name, per document, so a later registration of a name replaces the earlier one whichever
 * handle made it, and this handle's release takes whatever now stands under the names it
 * registered — including a same-name registration another handle made later. Names this handle
 * never registered are untouched.
 */
export interface ModelContextInterface {
	/** Holds the emitter republishing the registry's `toolchange` as `change`. */
	readonly emitter: EmitterInterface<ModelContextEventMap>
	/**
	 * Registers every tool the manager holds at this moment, then follows it.
	 *
	 * @remarks
	 * The snapshot is taken when the call is made, before the work queues behind an earlier
	 * `publish`, so a registry mutated while this call waits registers what it held at the call
	 * rather than what it holds when the queue reaches it.
	 *
	 * The same call subscribes to the manager's own `emitter`. Each `add`, `remove`, and
	 * `clear` it publishes queues one synchronisation of this handle's registrations against
	 * what the manager holds when that queued work runs, so the document registry converges on
	 * the tool registry after every change it follows, without a second call. Changes that
	 * arrive before that queued work runs are covered by it; a change that arrives after a
	 * later `publish` call takes a synchronisation of its own, which runs after that
	 * publication rather than before it. The event is the trigger and the manager is the fact:
	 * `remove` and `clear` carry tools the manager no longer holds, a listener that ran earlier
	 * in the same dispatch may already have put another tool under one of those names, and the
	 * manager's own `destroy` empties its map after publishing the `clear` that reports it. One
	 * manager is followed at a time: a `publish` naming another manager releases the
	 * subscription and takes up the new one, and `destroy` releases it outright. An event from
	 * a manager this handle no longer follows is ignored, which is what a listener republishing
	 * another manager from inside a dispatch produces. A followed change reaches no caller, so
	 * a tool advertising neither a `description` nor a `summary` is left unregistered rather
	 * than refusing anything, and a registration the document registry refuses is dropped, so
	 * the next call or the next synchronisation registers that name again. That batch still
	 * releases the names it dropped, because the prune runs whether or not every registration
	 * it asked for was made. A synchronisation registers only what it can carry, so such a tool
	 * standing under a name this handle already registered releases that registration instead
	 * of leaving it advertising a descriptor the manager no longer stands behind. Under a name
	 * this handle never registered the skip emits no `change`, because nothing reached the
	 * document registry; releasing a name this handle did register emits the registry's
	 * `change` like any other release. Compare the manager's own `definitions()` with what
	 * `adopt()` returns to read the mismatch, and
	 * {@link import('./helpers.js').describeWebMCPTool} answers `undefined` for a name
	 * `definitions()` still lists, which is that mismatch read from the manager's own side.
	 *
	 * Every name reconciles against what this handle registered for it, whether it arrives in a
	 * snapshot or through a synchronisation. The same manager still holding the same tool
	 * leaves the registration untouched, so a repeat publishes nothing and fires no
	 * `toolchange`. Another tool of that manager advertising an equal descriptor leaves the
	 * registration standing too, because execution routes through the manager by name and the
	 * replacement's handler is already what a foreign agent reaches. A changed projection, or
	 * the same name arriving from a different manager, releases the registration this handle
	 * holds and registers the new descriptor bound to the new manager. A name the snapshot
	 * dropped, and a name the followed manager no longer holds, is released after everything
	 * the batch carries has reconciled, so no name is withdrawn while the tools replacing it
	 * are still being registered.
	 *
	 * Every tool is projected before anything is registered, so a manager holding a tool with
	 * neither `description` nor `summary` is refused whole rather than half-registered.
	 *
	 * @param tools - The registry whose current tools are registered and whose later changes
	 *   are followed
	 * @param options - The optional exposure list; see {@link ModelContextPublishOptions}
	 * @returns Resolves after the registry has accepted each added registration
	 * @throws Thrown when a tool carries neither a `description` nor a `summary`, because
	 * WebMCP requires the member and an empty string would be an invented one
	 */
	publish(tools: ToolManagerInterface, options?: ModelContextPublishOptions): Promise<void>
	/**
	 * Reads the document's registered tools as locally executable tools.
	 *
	 * @remarks
	 * Each returned tool's `execute` runs the registry's `executeTool` and forwards its
	 * `ToolContext.signal` as WebMCP's `signal`, so an agent-side abort reaches the foreign
	 * tool. The value resolves unchanged: WebMCP's own sources disagree about whether a tool
	 * answers with a string or an MCP content record, so the bridge normalizes neither.
	 *
	 * An adopted tool advertises the foreign `inputSchema` as its `parameters` and validates
	 * nothing against it. Compiling that schema into a contract would let one page's
	 * unreadable or hostile schema refuse the whole `adopt` call, and the arguments reach a
	 * handler in another document that has to validate them anyway.
	 *
	 * @param options - The optional origin filter; see {@link ModelContextAdoptOptions}
	 * @returns The registry's tools, in registry order
	 */
	adopt(options?: ModelContextAdoptOptions): Promise<readonly ToolInterface[]>
	/**
	 * Aborts every registration this handle made, stops following the tool registry, and
	 * releases the emitter — idempotent.
	 *
	 * @remarks
	 * The subscription is released before anything is aborted, and a synchronisation already
	 * queued reads the destroyed handle and stops, so no registration is made after this call
	 * and none is left behind for a later change to release.
	 *
	 * @returns Nothing
	 */
	destroy(): void
}
