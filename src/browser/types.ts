import type { MCPTransportInterface } from '@src/core'
import type { ToolManagerInterface } from '@orkestrel/agent'

// The MCP browser-transport surface — the source of truth (AGENTS §2). Two CLIENT
// transports for the Model Context Protocol, both driving a REMOTE server from a page
// / Web Worker / Service Worker: the native `WebSocket` transport
// (`transports/WebSocketClientTransport.ts`) and the `fetch` + `@orkestrel/sse`
// streamable-HTTP transport (`transports/HTTPClientTransport.ts`) — the browser
// siblings of the Node face's `WebSocketClientTransport` / `HTTPClientTransport`
// (`src/server`), speaking the SAME `@src/core` `ClientTransportInterface` so
// `createMCPClient` consumes either identically. The host performs the WebSocket
// handshake and the HTTP request/response plumbing, so this face carries none of the
// Node client's `node:crypto` / `node:http(s)` machinery.
//
// `MessagePortTransport` (below) is the genuinely new capability: unlike the two
// CLIENT-only carriers above, a `MessagePort` is SYMMETRIC — the same class is handed
// to EITHER `bindServer` or `bindClient` (`@src/core`), the role coming from which
// binder it is given to. `ServeMCPOptions` / `ServeMCPScopeInterface` back the
// `serve.ts` bootstrap that wires a Web Worker's / Service Worker's own message
// events (and any `MessagePort` they carry) to an `MCPServer`.

/**
 * Options for `createWebSocketClientTransport` (browser face) — the remote MCP
 * WebSocket endpoint and any negotiated subprotocols.
 *
 * @remarks
 * - `url` — the absolute `ws://` / `wss://` (or `http://` / `https://`, accepted by
 *   the native `WebSocket` constructor the same way) URL of the remote server's
 *   WebSocket endpoint. REQUIRED.
 * - `protocols` — the WebSocket subprotocol(s) to request, forwarded verbatim as the
 *   native `WebSocket` constructor's second argument (e.g. `'mcp'` to match the Node
 *   face's `MCP_WEBSOCKET_SUBPROTOCOL`). Omit for no subprotocol negotiation.
 */
export interface WebSocketClientTransportOptions {
	readonly url: string
	readonly protocols?: string | readonly string[]
}

/**
 * Options for `createHTTPClientTransport` (browser face) — the remote MCP server's
 * URL and any extra request headers.
 *
 * @remarks
 * - `url` — the absolute URL of the remote server's Streamable-HTTP endpoint (the
 *   `POST` target every JSON-RPC message is written to). REQUIRED.
 * - `headers` — extra request headers merged onto every `POST` (e.g. an
 *   `Authorization` bearer for a guarded server). The transport always sets
 *   `content-type: application/json` and an `Accept` of both `application/json` and
 *   `text/event-stream`; a key supplied here is merged on top.
 * - `fetch` — the `fetch` implementation to issue each `POST` with; defaults to
 *   `globalThis.fetch`. Injectable for a test double or a non-global `fetch`.
 * - `timeout` — an optional per-request timeout in milliseconds; when set, each
 *   `fetch` call is issued with `signal: AbortSignal.timeout(timeout)`. Omit for no
 *   transport-level deadline.
 */
export interface HTTPClientTransportOptions {
	readonly url: string
	readonly headers?: Readonly<Record<string, string>>
	readonly fetch?: typeof fetch
	readonly timeout?: number
}

/**
 * Options for `createMessagePortTransport` — the native `MessagePort` a
 * {@link MessagePortTransport} sends and listens on.
 *
 * @remarks
 * `port` — the channel half to drive (e.g. one side of a `new MessageChannel()`, or
 * the port a `message` event's `ports[0]` carried). REQUIRED. The SAME transport
 * works as either a server or a client carrier — the role comes from whether it is
 * handed to `bindServer` or `bindClient`/`createDuplexClientTransport` (`@src/core`).
 */
export interface MessagePortTransportOptions {
	readonly port: MessagePort
}

/**
 * A duplex {@link MCPTransportInterface} adapting a message-event-bearing SCOPE
 * (`self` in a dedicated Web Worker, or any object shaped the same way) — the
 * internal carrier `serveMCPScope` binds to route the implicit (portless) message
 * channel, plus the `deliver` entry point the scope's own `message` listener pushes
 * an inbound string through (the scope itself never registers `listen`'s handler
 * for the caller — `serveMCPScope`'s dispatcher does, via this `deliver`).
 */
export interface ScopeTransportInterface extends MCPTransportInterface {
	/** Push one inbound message string into the currently registered `listen` handler. */
	deliver(message: string): void
}

/**
 * The structural shape `serveMCPScope` needs from a hostable scope — `self` in a
 * dedicated Web Worker or a Service Worker (or any double matching this shape).
 *
 * @remarks
 * Only the three members `serveMCPScope` actually touches: `postMessage` (the
 * dedicated-worker implicit reply channel), and `addEventListener` /
 * `removeEventListener` for `'message'` (every inbound event, portless or
 * port-bearing, arrives through the SAME listener — see {@link ServeMCPOptions}'s
 * doc and `serve.ts`). A real `self` / `globalThis` inside a worker satisfies this
 * structurally (it exposes far more, which this narrower shape ignores).
 */
export interface ServeMCPScopeInterface {
	postMessage(message: unknown): void
	addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
	removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

/**
 * Options for `serveMCP` / `serveMCPScope` — the live {@link ToolManagerInterface} to
 * expose plus the optional server identity, mirroring `createMCPServer`'s
 * `MCPServerOptions` (`@src/core`) but with `name`/`version` OPTIONAL (defaulting to
 * {@link import('./constants.js').DEFAULT_MCP_SERVER_NAME} /
 * {@link import('./constants.js').DEFAULT_MCP_SERVER_VERSION}).
 */
export interface ServeMCPOptions {
	readonly tools: ToolManagerInterface
	readonly name?: string
	readonly version?: string
}
