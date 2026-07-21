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
