import type {
	HTTPClientTransportOptions,
	MCPMessageTransportInterface,
	MCPServerInterface,
	MCPTransportInterface,
} from '@src/core'
import type {
	MessagePortTransportOptions,
	ScopeInterface,
	ScopeServerInterface,
	ScopeServerOptions,
	ScopeTransportInterface,
	WebSocketClientTransportOptions,
} from './types.js'
import { bindServer, createMCPServer, HTTPClientTransport } from '@src/core'
import { isString } from '@orkestrel/contract'
import { DEFAULT_MCP_SERVER_NAME, DEFAULT_MCP_SERVER_VERSION } from './constants.js'
import { MessagePortTransport } from './transports/MessagePortTransport.js'
import { WebSocketClientTransport } from './transports/WebSocketClientTransport.js'

/**
 * Creates the browser-face WebSocket CLIENT transport for an
 * {@link import('@orkestrel/mcp').MCPClientInterface} — a {@link MCPMessageTransportInterface}
 * that drives a REMOTE MCP server over the native `WebSocket` global, the browser
 * sibling of the Node face's `createWebSocketClientTransport` (`@orkestrel/mcp/server`).
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
 * @returns A working {@link MCPMessageTransportInterface} over the native `WebSocket`
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
): MCPMessageTransportInterface {
	return new WebSocketClientTransport(options)
}

/**
 * Creates the HTTP CLIENT transport for an
 * {@link import('@orkestrel/mcp').MCPClientInterface} — a {@link MCPMessageTransportInterface}
 * that drives a REMOTE Streamable-HTTP MCP server over the native `fetch`.
 *
 * @remarks
 * It returns the core {@link import('@orkestrel/mcp').HTTPClientTransport}, the same class the
 * Node face's `createHTTPClientTransport` returns, because the class touches `fetch`,
 * `Response`, `AbortController`, `AbortSignal`, and `WeakMap` alone. This factory exists so a
 * page imports its transport from the face it already imports everything else from.
 *
 * @remarks
 * Hand it to `createMCPClient({ transport })`: each JSON-RPC message the client
 * sends is `POST`ed to `options.url` with `content-type: application/json` and an
 * `Accept` of both `application/json` and `text/event-stream` (the server answers
 * with EITHER — a plain JSON envelope or a Streamable-HTTP SSE `data:` event,
 * decoded with `@orkestrel/sse`), and the reply is surfaced on the transport's
 * `message` event for the client's id correlation. Add `options.headers` (for example, an
 * `Authorization` bearer) to reach a guarded server. `start` / `close` hold no
 * connection; against a STATEFUL server it captures the `mcp-session-id` from
 * `initialize` and echoes it on later requests. It also captures the initialize
 * result's `protocolVersion` and sends `mcp-protocol-version` alone on subsequent
 * legacy requests. Modern requests instead derive `mcp-protocol-version` and
 * `mcp-method` from the message, plus `mcp-name` only for `tools/call`, so the
 * same `MCPClient` passes either era's protocol gates without caller wiring.
 *
 * @param options - `url` (the remote endpoint; REQUIRED), optional `headers` merged
 *   onto every request, optional `fetch` (default `globalThis.fetch`), and optional
 *   `timeout` (ms, applied with `AbortSignal.timeout`); see
 *   {@link HTTPClientTransportOptions}
 * @returns A working {@link MCPMessageTransportInterface} over the native `fetch`
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
): MCPMessageTransportInterface {
	return new HTTPClientTransport(options)
}

/**
 * Creates the browser-face `MessagePort` transport — a
 * {@link import('@orkestrel/mcp').MCPTransportInterface} over a native `MessagePort`, the
 * SYMMETRIC carrier that works as either a server or a client transport depending on
 * which binder ({@link import('@orkestrel/mcp').bindServer} or
 * {@link import('@orkestrel/mcp').bindClient}) it is handed to.
 *
 * @remarks
 * `port.start()` runs at construction (see {@link MessagePortTransport}'s doc for
 * why); inbound payloads are string-only (a non-string `postMessage` payload is
 * dropped, never thrown); `messageerror` is ignored (one bad frame does not close the
 * channel); `close()` closes the port and fires `closed` exactly once.
 *
 * @param options - `port` (the `MessagePort` half to drive; REQUIRED); see
 *   {@link MessagePortTransportOptions}
 * @returns A working {@link import('@orkestrel/mcp').MCPTransportInterface} over the port
 *
 * @example
 * ```ts
 * import { bindServer, createMCPLegacy, createMCPServer } from '@orkestrel/mcp'
 * import { createMessagePortTransport } from '@orkestrel/mcp/browser'
 *
 * const { port1, port2 } = new MessageChannel()
 * const mcp = createMCPServer({ identity: { name: 's', version: '1.0.0' }, tools })
 * bindServer(createMCPLegacy(mcp), createMessagePortTransport({ port: port1 })) // answers `initialize` too; pass `mcp` alone for modern-only
 * ```
 */
export function createMessagePortTransport(
	options: MessagePortTransportOptions,
): MCPTransportInterface {
	return new MessagePortTransport(options)
}

/**
 * Creates an `MCPServer` hosted inside a worker scope and wires that scope's message events
 * to it — the browser face's bootstrap, and the twin of the Node face's `createStdioServer`.
 *
 * @remarks
 * `scope` defaults to `globalThis`, which is `self` inside a dedicated Web Worker or a
 * Service Worker, so a worker boots with `createScopeServer({ tools })` alone; pass a scope
 * explicitly to host a server on a double or on another message-event-bearing object.
 *
 * Port-bearing events are gated by `options.accept`, deduplicated by port, and receive
 * their own `MessagePortTransport` binding. Portless string events use the scope's
 * implicit channel. The returned handle's `stop` removes the listener, unbinds the implicit
 * channel, closes every accepted port binding, and drops the ports themselves — the
 * bindings are held in one map keyed by port, so nothing survives the clear. The served
 * endpoint is modern-only: it answers a legacy `initialize` with `-32601`. A dual-era
 * worker composes `bindServer(createMCPLegacy(mcp), …)` instead of this factory.
 *
 * @param options - The tools, optional identity, and optional port-event gate; see
 *   {@link ScopeServerOptions}
 * @param scope - The hostable scope to wire; defaults to `globalThis`
 * @returns A {@link ScopeServerInterface} whose `stop` ends every binding this call owns
 *
 * @example
 * ```ts
 * import { createScopeServer } from '@orkestrel/mcp/browser'
 * import { createToolManager } from '@orkestrel/tool'
 *
 * // Inside a Web Worker: the scope defaults to `globalThis`.
 * const worker = createScopeServer({ tools: createToolManager() })
 * // ... later, release every binding this call owns:
 * worker.stop()
 * ```
 */
export function createScopeServer(
	options: ScopeServerOptions,
	scope: ScopeInterface = globalThis,
): ScopeServerInterface {
	const server = createMCPServer({
		tools: options.tools,
		identity: {
			name: options.name ?? DEFAULT_MCP_SERVER_NAME,
			version: options.version ?? DEFAULT_MCP_SERVER_VERSION,
		},
	})
	const scopeTransport = createScopeTransport(scope)
	const unbindScope = bindServer(server, scopeTransport)
	const teardowns = new Map<MessagePort, () => void>()
	const onMessage = createScopeMessageListener(server, scopeTransport, teardowns, options)
	scope.addEventListener('message', onMessage)
	let stopped = false
	return {
		stop(): void {
			if (stopped) return
			stopped = true
			scope.removeEventListener('message', onMessage)
			unbindScope()
			for (const teardown of teardowns.values()) teardown()
			// One clear releases the bindings AND the ports they were keyed by, so a scope that
			// outlives its handle — a Service Worker — retains neither.
			teardowns.clear()
		},
	}
}

/**
 * Builds {@link createScopeServer}'s `message`-event listener — the unified dispatcher that
 * routes EVERY inbound event on a hostable scope, portless or port-bearing, to the right
 * binding.
 *
 * @remarks
 * Port-bearing events (`event.ports.length > 0`) are gated by `options.accept` FIRST
 * — when the gate returns `false` the event is dropped entirely (no binding, no reply).
 * Accepted events spawn a fresh `MessagePortTransport` over `event.ports[0]`,
 * `bindServer` `server` onto it, and record a teardown (`unbind` then `transport.close()`)
 * into `teardowns` KEYED BY THAT PORT. A port already present is IGNORED — repeated delivery
 * of the same `MessagePort` would create duplicate bindings over one port (→ duplicated
 * replies), so a repeat is silently dropped.
 *
 * The key is what makes `teardowns` the ONLY place an accepted port is remembered. A separate
 * seen-port set would be a second collection over the same lifetime, and the scope server's
 * `stop` would have to remember to empty both — so a long-lived scope such as a Service Worker
 * would retain every port it ever accepted, closed and unbound ones included. Membership
 * answers "already bound?" and `clear()` drops the binding and the dedup together.
 *
 * This branch fires on EITHER a Service-Worker-shaped scope (its normal per-client
 * channel) or a dedicated-worker-shaped one that happens to receive a port-bearing event
 * (the unified design's deliberate cross-case, needing no upfront shape flag). An event
 * with NO ports and a STRING `data` is pushed onto `scopeTransport.deliver` (the
 * implicit, already-bound scope channel); any other event (no ports, non-string data)
 * is silently dropped — total, never throws.
 *
 * @param server - The `MCPServerInterface` every spawned/implicit binding dispatches over
 * @param scopeTransport - The implicit scope channel (already `bindServer`-bound) portless events deliver onto
 * @param teardowns - The shared teardown map the scope server's `stop` drains and clears, keyed by the accepted port; each port-bearing event adds one entry
 * @param options - The `ScopeServerOptions` (for `options.accept`)
 * @returns The `message`-event listener to register (and later remove) on the scope
 *
 * @example
 * ```ts
 * const teardowns = new Map<MessagePort, () => void>()
 * const scopeTransport = createScopeTransport(scope)
 * bindServer(server, scopeTransport)
 * const onMessage = createScopeMessageListener(server, scopeTransport, teardowns, options)
 * scope.addEventListener('message', onMessage)
 * ```
 */
export function createScopeMessageListener(
	server: MCPServerInterface,
	scopeTransport: ScopeTransportInterface,
	teardowns: Map<MessagePort, () => void>,
	options: ScopeServerOptions,
): (event: MessageEvent) => void {
	return (event: MessageEvent): void => {
		const ports = event.ports
		if (ports.length > 0) {
			// Gate: consult accept (origin/identity check) before binding.
			if (options.accept !== undefined && !options.accept(event)) return
			const port = ports[0]
			if (port === undefined) return
			// Deduplicate off the teardown map itself: repeated delivery of the same port would
			// create duplicate bindings, and a second collection recording the same fact is one
			// the handle's `stop` can forget to empty.
			if (teardowns.has(port)) return
			const transport = new MessagePortTransport({ port })
			const unbind = bindServer(server, transport)
			teardowns.set(port, () => {
				unbind()
				transport.close()
			})
			return
		}
		if (isString(event.data)) scopeTransport.deliver(event.data)
	}
}

/**
 * Adapts a hostable {@link ScopeInterface} (`self` in a dedicated Web Worker, or any
 * structurally matching double) into a {@link ScopeTransportInterface} — the implicit,
 * portless message channel {@link createScopeServer} binds for the dedicated-worker shape.
 *
 * @remarks
 * `send` writes each outbound string through `scope.postMessage`. `listen`/`closed`
 * register the SINGLE handler `deliver` / the underlying close path route through —
 * the scope server's own `scope` `message`-event listener calls `deliver(event.data)`
 * for every portless, string-payload event (there is no native registration point on
 * the scope itself for the scope server to hand a `listen` handler to, so `deliver` is
 * the bridge). `close()` fires the registered `closed` handler — a scope has nothing
 * physically closable, so this is the only teardown signal available.
 *
 * @param scope - The hostable scope to adapt (structurally, `self` / `globalThis`
 *   inside a dedicated Web Worker)
 * @returns A {@link ScopeTransportInterface} the scope server binds and drives through `deliver`
 *
 * @example
 * ```ts
 * const scopeTransport = createScopeTransport(self)
 * const unbind = bindServer(server, scopeTransport)
 * ```
 */
export function createScopeTransport(scope: ScopeInterface): ScopeTransportInterface {
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
