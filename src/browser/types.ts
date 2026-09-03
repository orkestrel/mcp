import type { MCPTransportInterface } from '@src/core'
import type { ToolManagerInterface } from '@orkestrel/tool'

// The MCP browser-transport surface — the source of truth. The CLIENT
// transports for the Model Context Protocol drive a REMOTE server from a page
// / Web Worker / Service Worker: the native `WebSocket` transport
// (`transports/WebSocketClientTransport.ts`) and the host-independent `fetch` +
// `@orkestrel/sse` streamable-HTTP transport `@src/core` publishes, which this face's
// `createHTTPClientTransport` returns. Every one speaks the SAME `@src/core`
// `MCPMessageTransportInterface`, so `createMCPClient` consumes them identically. The host
// performs the WebSocket handshake, so this face carries none of the Node client's
// `node:crypto` / `node:http(s)` machinery.
//
// `MessagePortTransport` (below) is the genuinely new capability: unlike the
// CLIENT-only carriers above, a `MessagePort` is SYMMETRIC — the same class is handed
// to EITHER `bindServer` or `bindClient` (`@src/core`), the role coming from which
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
 *   WebSocket endpoint. REQUIRED.
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
 * platform DOES carry: a cookie the browser attaches to the upgrade, a subprotocol token, or
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
 * the port a `message` event's `ports[0]` carried). REQUIRED. The SAME transport
 * works as either a server or a client carrier — the role comes from whether it is
 * handed to `bindServer` or `bindClient`/`createDuplexClientTransport` (`@orkestrel/mcp`).
 */
export interface MessagePortTransportOptions {
	readonly port: MessagePort
}

/**
 * Adapts a message-event-bearing SCOPE (`self` in a dedicated Web Worker, or any object
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
 * port-bearing, arrives through the SAME listener — see {@link ScopeServerOptions}'s
 * doc and the factory). A real `self` / `globalThis` inside a worker satisfies this
 * structurally (it exposes far more, which this narrower shape ignores).
 */
export interface ScopeInterface {
	postMessage(message: unknown): void
	addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
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
 * OPTIONAL (defaulting to {@link import('./constants.js').DEFAULT_MCP_SERVER_NAME} /
 * {@link import('./constants.js').DEFAULT_MCP_SERVER_VERSION}).
 *
 * @remarks
 * - `accept` — optional identity gate consulted **before** a port-bearing `message`
 *   event is accepted; return `false` to drop the event (no binding, no reply).
 *   **`accept` gates ONLY port-bearing events** — portless messages bypass it and
 *   deliver directly to the implicit scope channel (the tool executes, blind; in a
 *   Service Worker the reply is silently dropped — see `createScopeServer`'s portless note).
 *   Prefer a handshake token in `event.data` as the primary pattern
 *   (for example, `(event) => event.data === token`) — for same-origin worker/MessagePort
 *   messages `event.origin` is frequently the empty string, making origin
 *   allow-listing unreliable; origin checks are meaningful for cross-origin
 *   `postMessage` only. When omitted, ALL port-bearing events are accepted — every
 *   same-origin context that can reach the scope gets full tool-call access.
 *   See `createScopeServer`'s trust-boundary and portless-events notes.
 */
export interface ScopeServerOptions {
	readonly tools: ToolManagerInterface
	readonly name?: string
	readonly version?: string
	readonly accept?: (event: MessageEvent) => boolean
}
