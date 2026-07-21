import type { ClientTransportInterface } from '@src/core'
import type { HTTPClientTransportOptions, WebSocketClientTransportOptions } from './types.js'
import { HTTPClientTransport } from './transports/HTTPClientTransport.js'
import { WebSocketClientTransport } from './transports/WebSocketClientTransport.js'

/**
 * Create the browser-face WebSocket CLIENT transport for an
 * {@link import('@src/core').MCPClientInterface} — a {@link ClientTransportInterface}
 * that drives a REMOTE MCP server over the native `WebSocket` global, the browser
 * sibling of the Node face's `createWebSocketClientTransport` (`@src/server`).
 *
 * @remarks
 * Hand it to `createMCPClient({ transport })`: `start()` (run by `client.connect()`)
 * opens `new WebSocket(options.url, options.protocols)` and awaits the native
 * `'open'` event — the RFC 6455 handshake itself is the browser's concern. Each
 * JSON-RPC message the client `send`s before the socket opens is QUEUED and flushed,
 * in order, once it does; each decoded reply is surfaced on the transport's
 * `message` event for the client's id correlation.
 *
 * @param options - `url` (the remote WebSocket endpoint; REQUIRED) and optional
 *   `protocols` (the WebSocket subprotocol(s) to request); see
 *   {@link WebSocketClientTransportOptions}
 * @returns A working {@link ClientTransportInterface} over the native `WebSocket`
 *
 * @example
 * ```ts
 * import { createMCPClient } from '@orkestrel/mcp'
 * import { createWebSocketClientTransport } from '@orkestrel/mcp/browser'
 *
 * const client = createMCPClient({
 * 	transport: createWebSocketClientTransport({ url: 'ws://localhost:3000/mcp' }),
 * })
 * await client.connect()
 * const tools = await client.tools()
 * ```
 */
export function createWebSocketClientTransport(
	options: WebSocketClientTransportOptions,
): ClientTransportInterface {
	return new WebSocketClientTransport(options)
}

/**
 * Create the browser-face HTTP CLIENT transport for an
 * {@link import('@src/core').MCPClientInterface} — a {@link ClientTransportInterface}
 * that drives a REMOTE Streamable-HTTP MCP server over the native `fetch`, the
 * browser sibling of the Node face's `createHTTPClientTransport` (`@src/server`).
 *
 * @remarks
 * Hand it to `createMCPClient({ transport })`: each JSON-RPC message the client
 * sends is `POST`ed to `options.url` with `content-type: application/json` and an
 * `Accept` of both `application/json` and `text/event-stream` (the server answers
 * with EITHER — a plain JSON envelope or a Streamable-HTTP SSE `data:` event,
 * decoded via `@orkestrel/sse`), and the reply is surfaced on the transport's
 * `message` event for the client's id correlation. Add `options.headers` (e.g. an
 * `Authorization` bearer) to reach a guarded server. `start` / `close` hold no
 * connection; against a STATEFUL server it captures the `mcp-session-id` from
 * `initialize` and echoes it on later requests, so the same `MCPClient` passes
 * session validation (a stateless server sends none).
 *
 * @param options - `url` (the remote endpoint; REQUIRED), optional `headers` merged
 *   onto every request, optional `fetch` (default `globalThis.fetch`), and optional
 *   `timeout` (ms, applied via `AbortSignal.timeout`); see
 *   {@link HTTPClientTransportOptions}
 * @returns A working {@link ClientTransportInterface} over the native `fetch`
 *
 * @example
 * ```ts
 * import { createMCPClient } from '@orkestrel/mcp'
 * import { createHTTPClientTransport } from '@orkestrel/mcp/browser'
 *
 * const client = createMCPClient({
 * 	transport: createHTTPClientTransport({ url: 'http://localhost:3000/mcp' }),
 * })
 * await client.connect()
 * const tools = await client.tools()
 * ```
 */
export function createHTTPClientTransport(
	options: HTTPClientTransportOptions,
): ClientTransportInterface {
	return new HTTPClientTransport(options)
}
