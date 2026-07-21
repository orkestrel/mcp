import type { ClientTransportInterface, MCPTransportInterface } from '@src/core'
import type {
	HTTPClientTransportOptions,
	MessagePortTransportOptions,
	ScopeTransportInterface,
	ServeMCPScopeInterface,
	WebSocketClientTransportOptions,
} from './types.js'
import { HTTPClientTransport } from './transports/HTTPClientTransport.js'
import { MessagePortTransport } from './transports/MessagePortTransport.js'
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

/**
 * Create the browser-face `MessagePort` transport — a
 * {@link import('@src/core').MCPTransportInterface} over a native `MessagePort`, the
 * SYMMETRIC carrier that works as either a server or a client transport depending on
 * which binder ({@link import('@src/core').bindServer} or
 * {@link import('@src/core').bindClient}) it is handed to.
 *
 * @remarks
 * `port.start()` runs at construction (see {@link MessagePortTransport}'s doc for
 * why); inbound payloads are string-only (a non-string `postMessage` payload is
 * dropped, never thrown); `messageerror` is ignored (one bad frame does not close the
 * channel); `close()` closes the port and fires `closed` exactly once.
 *
 * @param options - `port` (the `MessagePort` half to drive; REQUIRED); see
 *   {@link MessagePortTransportOptions}
 * @returns A working {@link import('@src/core').MCPTransportInterface} over the port
 *
 * @example
 * ```ts
 * import { bindServer, createMCPServer } from '@orkestrel/mcp'
 * import { createMessagePortTransport } from '@orkestrel/mcp/browser'
 *
 * const { port1, port2 } = new MessageChannel()
 * bindServer(createMCPServer({ name: 's', version: '1.0.0', tools }), createMessagePortTransport({ port: port1 }))
 * ```
 */
export function createMessagePortTransport(
	options: MessagePortTransportOptions,
): MCPTransportInterface {
	return new MessagePortTransport(options)
}

/**
 * Adapt a hostable {@link ServeMCPScopeInterface} (`self` in a dedicated Web Worker,
 * or any structurally matching double) into a {@link ScopeTransportInterface} — the
 * implicit, portless message channel `serveMCPScope` (`serve.ts`) binds for the
 * dedicated-worker shape.
 *
 * @remarks
 * `send` writes each outbound string via `scope.postMessage`. `listen`/`closed`
 * register the SINGLE handler `deliver` / the underlying close path route through —
 * `serveMCPScope`'s own `scope` `message`-event listener calls `deliver(event.data)`
 * for every portless, string-payload event (there is no native registration point on
 * the scope itself for `serveMCPScope` to hand a `listen` handler to, so `deliver` is
 * the bridge). `close()` fires the registered `closed` handler — a scope has nothing
 * physically closable, so this is the only teardown signal available.
 *
 * @param scope - The hostable scope to adapt (structurally, `self` / `globalThis`
 *   inside a dedicated Web Worker)
 * @returns A {@link ScopeTransportInterface} `serveMCPScope` binds and drives via `deliver`
 *
 * @example
 * ```ts
 * const scopeTransport = createScopeTransport(self)
 * const unbind = bindServer(server, scopeTransport)
 * ```
 */
export function createScopeTransport(scope: ServeMCPScopeInterface): ScopeTransportInterface {
	let onMessage: ((message: string) => void) | undefined
	let onClosed: (() => void) | undefined
	return {
		send(message: string): void {
			scope.postMessage(message)
		},
		listen(handler: (message: string) => void): void {
			onMessage = handler
		},
		closed(handler: () => void): void {
			onClosed = handler
		},
		close(): void {
			onClosed?.()
		},
		deliver(message: string): void {
			onMessage?.(message)
		},
	}
}
