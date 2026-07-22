import type { JSONRPCMessage, MCPServerInterface } from '@src/core'
import type { SSEParserInterface } from '@orkestrel/sse'
import type { ServeMCPOptions, ScopeTransportInterface } from './types.js'
import { bindServer, parseJSONRPCMessage } from '@src/core'
import { isString } from '@orkestrel/contract'
import { createSSEParser } from '@orkestrel/sse'
import { MessagePortTransport } from './transports/MessagePortTransport.js'

// The MCP browser-transport helpers (AGENTS §4.3 module-scope names — no entity
// context). `decodeEvent` and `readEventStream` are the browser face's copies of the
// Node face's SAME-NAMED helpers (`src/server/helpers.ts`) — peer environment faces
// (AGENTS §2) share no import, so the CLIENT-side SSE decode step (reused by
// `transports/HTTPClientTransport.ts`) is declared once here too. Both are total and
// narrow at the boundary, never `as` (AGENTS §14): a malformed / non-message SSE
// `data:` event is dropped, never thrown.
//
// `createScopeMessageListener` is `serve.ts`'s per-event dispatcher, extracted here
// (AGENTS §5 — no function is declared inside another function body) so
// `serveMCPScope` merely CALLS it and stores the RETURNED closure (an ordinary
// value assignment, not an inline function literal) for `addEventListener` /
// `removeEventListener` to share the same reference.

/**
 * Decode one SSE event's `data` string into a {@link JSONRPCMessage}, or `undefined`
 * when it is not one — the per-event step {@link readEventStream} folds over.
 *
 * @remarks
 * `JSON.parse`s the `data` (the server serializes the JSON-RPC envelope as the
 * event's `data`) inside a try/catch and narrows the parsed value with
 * `parseJSONRPCMessage`. Total (§14): malformed JSON or a non-message value yields
 * `undefined`, never throws.
 *
 * @param data - One SSE event's `data` payload
 * @returns The decoded {@link JSONRPCMessage}, or `undefined`
 */
export function decodeEvent(data: string): JSONRPCMessage | undefined {
	try {
		return parseJSONRPCMessage(JSON.parse(data))
	} catch {
		return undefined
	}
}

/**
 * Decode a `fetch` Response's Server-Sent-Events body into the JSON-RPC messages it
 * carried — the CLIENT-side inverse of the server's Streamable-HTTP SSE response.
 *
 * @remarks
 * Reads the whole `response.body` stream chunk-by-chunk through a `TextDecoder({
 * stream: true })` (handling a multi-byte char split across reads) and
 * `@orkestrel/sse`'s {@link SSEParserInterface} (handling a partial line / in-progress
 * event split across reads), then narrows each dispatched event's `data` to a
 * {@link JSONRPCMessage} via {@link decodeEvent} (so a non-message / non-JSON `data:`
 * event is DROPPED, never thrown — total, §14). A `null` body (no stream) yields no
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
 * Build `serveMCPScope`'s (`serve.ts`) `message`-event listener — the unified
 * dispatcher that routes EVERY inbound event on a hostable scope, portless or
 * port-bearing, to the right binding.
 *
 * @remarks
 * Port-bearing events (`event.ports.length > 0`) are gated by `options.accept` FIRST
 * — when the gate returns `false` the event is dropped entirely (no binding, no reply).
 * Accepted events spawn a fresh `MessagePortTransport` over `event.ports[0]`,
 * `bindServer` `server` onto it, and record a teardown (`unbind` then `transport.close()`)
 * into `teardowns`. A port that was already seen is IGNORED — repeated delivery of the
 * same `MessagePort` would create duplicate bindings over one port (→ duplicated replies),
 * so the listener tracks seen ports and silently drops repeats.
 *
 * This branch fires on EITHER a Service-Worker-shaped scope (its normal per-client
 * channel) or a dedicated-worker-shaped one that happens to receive a port-bearing event
 * (the unified design's deliberate cross-case, needing no upfront shape flag). An event
 * with NO ports and a STRING `data` is pushed onto `scopeTransport.deliver` (the
 * implicit, already-bound scope channel); any other event (no ports, non-string data)
 * is silently dropped — total (§14), never throws.
 *
 * @param server - The `MCPServerInterface` every spawned/implicit binding dispatches over
 * @param scopeTransport - The implicit scope channel (already `bindServer`-bound) portless events deliver onto
 * @param teardowns - The shared teardown set `serveMCPScope`'s dispose drains; each port-bearing event adds one entry
 * @param options - The `ServeMCPOptions` (for `options.accept`)
 * @returns The `message`-event listener to register (and later remove) on the scope
 *
 * @example
 * ```ts
 * const teardowns = new Set<() => void>()
 * const scopeTransport = createScopeTransport(scope)
 * bindServer(server, scopeTransport)
 * const onMessage = createScopeMessageListener(server, scopeTransport, teardowns, options)
 * scope.addEventListener('message', onMessage)
 * ```
 */
export function createScopeMessageListener(
	server: MCPServerInterface,
	scopeTransport: ScopeTransportInterface,
	teardowns: Set<() => void>,
	options: ServeMCPOptions,
): (event: MessageEvent) => void {
	const seen = new Set<MessagePort>()
	return (event: MessageEvent): void => {
		const ports = event.ports
		if (ports.length > 0) {
			// Gate: consult accept (origin/identity check) before binding.
			if (options.accept !== undefined && !options.accept(event)) return
			const port = ports[0]
			// Deduplicate: repeated delivery of the same port would create duplicate bindings.
			if (seen.has(port)) return
			seen.add(port)
			const transport = new MessagePortTransport({ port })
			const unbind = bindServer(server, transport)
			teardowns.add(() => {
				unbind()
				transport.close()
			})
			return
		}
		if (isString(event.data)) scopeTransport.deliver(event.data)
	}
}
