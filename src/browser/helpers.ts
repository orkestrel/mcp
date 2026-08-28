import type { JSONRPCMessage, MCPServerInterface } from '@src/core'
import type { SSEParserInterface } from '@orkestrel/sse'
import type { ServeMCPOptions, ScopeTransportInterface, ServeMCPScopeInterface } from './types.js'
import { bindServer, createMCPServer, parseJSONRPCMessage } from '@src/core'
import { isString, parseJSON } from '@orkestrel/contract'
import { createSSEParser } from '@orkestrel/sse'
import { DEFAULT_MCP_SERVER_NAME, DEFAULT_MCP_SERVER_VERSION } from './constants.js'
import { createScopeTransport } from './factories.js'
import { MessagePortTransport } from './transports/MessagePortTransport.js'

// The MCP browser-transport helpers — module-scope names, so they carry no entity
// context. `decodeEvent` and `readEventStream` are the browser face's copies of the
// Node face's SAME-NAMED helpers (`src/server/helpers.ts`) — peer environment faces share
// no import, so the CLIENT-side SSE decode step (reused by
// `transports/HTTPClientTransport.ts`) is declared once here too. Both are total and
// narrow at the boundary, never `as`: a malformed / non-message SSE
// `data:` event is dropped, never thrown.
//
// `serveMCPScope` / `serveMCP` are the worker bootstrap. They are reusable exported
// infrastructure that BOOTS and BINDS — the browser sibling of `src/core`'s
// `bindServer` / `bindClient` — and each returns an idempotent disposer rather than an
// entity, so they belong here rather than in `factories.ts` (`.claude/rules/architecture.md`
// kind purity: placement follows what a function is, and every exported `factories.ts`
// function is named `create*`). The value factory they compose, `createScopeTransport`,
// stays in `factories.ts`.
//
// `createScopeMessageListener` is the bootstrap's per-event dispatcher, extracted
// (no function is declared inside another function body) so
// `serveMCPScope` merely CALLS it and stores the RETURNED closure (an ordinary
// value assignment, not an inline function literal) for `addEventListener` /
// `removeEventListener` to share the same reference.

/**
 * Decodes one SSE event's `data` string into a {@link JSONRPCMessage}, or `undefined`
 * when it is not one — the per-event step {@link readEventStream} folds over.
 *
 * @remarks
 * Parses the `data` (the server serializes the JSON-RPC envelope as the event's `data`)
 * with `@orkestrel/contract`'s `parseJSON` — the declared JSON boundary, which answers
 * `undefined` instead of throwing — and narrows the parsed value with
 * `parseJSONRPCMessage`. Total: malformed JSON or a non-message value yields `undefined`,
 * never throws.
 *
 * @param data - One SSE event's `data` payload
 * @returns The decoded {@link JSONRPCMessage}, or `undefined`
 */
export function decodeEvent(data: string): JSONRPCMessage | undefined {
	return parseJSONRPCMessage(parseJSON(data))
}

/**
 * Decodes a `fetch` Response's Server-Sent-Events body into the JSON-RPC messages it
 * carried — the CLIENT-side inverse of the server's Streamable-HTTP SSE response.
 *
 * @remarks
 * Reads the whole `response.body` stream chunk-by-chunk through a `TextDecoder({
 * stream: true })` (handling a multi-byte char split across reads) and
 * `@orkestrel/sse`'s {@link SSEParserInterface} (handling a partial line / in-progress
 * event split across reads), then narrows each dispatched event's `data` to a
 * {@link JSONRPCMessage} through {@link decodeEvent} (so a non-message / non-JSON `data:`
 * event is DROPPED, never thrown — total). A `null` body (no stream) yields no
 * messages; {@link import('./transports/HTTPClientTransport.js').HTTPClientTransport}
 * reads a request/response SSE reply (the server sends one `data:` event then ends),
 * so this drains to completion.
 *
 * @param response - The SSE `fetch` Response to decode (its `body` is read to completion)
 * @returns Every {@link JSONRPCMessage} the stream carried, in order
 */
export async function readEventStream(response: Response): Promise<readonly JSONRPCMessage[]> {
	const body = response.body
	if (body === null) return []
	const reader = body.getReader()
	const decoder = new TextDecoder()
	const parser: SSEParserInterface = createSSEParser()
	const messages: JSONRPCMessage[] = []
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			for (const event of parser.parse(decoder.decode(value, { stream: true }))) {
				const message = decodeEvent(event.data)
				if (message !== undefined) messages.push(message)
			}
		}
	} finally {
		reader.releaseLock()
	}
	return messages
}

/**
 * Builds `serveMCPScope`'s `message`-event listener — the unified
 * dispatcher that routes EVERY inbound event on a hostable scope, portless or
 * port-bearing, to the right binding.
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
 * seen-port set would be a second collection over the same lifetime, and the caller's disposer
 * would have to remember to empty both — so a long-lived scope such as a Service Worker would
 * retain every port it ever accepted, closed and unbound ones included. Membership answers
 * "already bound?" and `clear()` drops the binding and the dedup together.
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
 * @param teardowns - The shared teardown map `serveMCPScope`'s dispose drains and clears, keyed by the accepted port; each port-bearing event adds one entry
 * @param options - The `ServeMCPOptions` (for `options.accept`)
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
	options: ServeMCPOptions,
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
			// the disposer can forget to empty.
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
 * Boots an `MCPServer` inside a hostable worker scope and wires its message events to it.
 *
 * @remarks
 * Port-bearing events are gated by `options.accept`, deduplicated by port, and receive
 * their own `MessagePortTransport` binding. Portless string events use the scope's
 * implicit channel. The returned disposer removes the listener, unbinds the implicit
 * channel, closes every accepted port binding, and drops the ports themselves — the
 * bindings are held in one map keyed by port, so nothing survives the clear. The served
 * endpoint is modern-only: it answers a legacy `initialize` with `-32601`. A dual-era
 * worker composes `bindServer(createMCPLegacy(mcp), …)` instead of this function.
 *
 * @param scope - The hostable worker scope to wire
 * @param options - The tools, optional identity, and optional port-event gate
 * @returns An idempotent disposer for every binding owned by this call
 */
export function serveMCPScope(scope: ServeMCPScopeInterface, options: ServeMCPOptions): () => void {
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
	let disposed = false
	return () => {
		if (disposed) return
		disposed = true
		scope.removeEventListener('message', onMessage)
		unbindScope()
		for (const teardown of teardowns.values()) teardown()
		// One clear releases the bindings AND the ports they were keyed by, so a scope that
		// outlives its disposer — a Service Worker — retains neither.
		teardowns.clear()
	}
}

/**
 * Boots an `MCPServer` inside the current hostable worker scope.
 *
 * @remarks
 * The served endpoint is modern-only: it answers a legacy `initialize` with `-32601`. A
 * dual-era worker composes `bindServer(createMCPLegacy(mcp), …)` instead of this function.
 *
 * @param options - The tools, optional identity, and optional port-event gate
 * @returns The disposer returned by {@link serveMCPScope}
 */
export function serveMCP(options: ServeMCPOptions): () => void {
	return serveMCPScope(globalThis, options)
}
