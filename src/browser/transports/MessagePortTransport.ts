import type { MCPTransportInterface } from '@src/core'
import type { MessagePortTransportOptions } from '../types.js'
import { isString } from '@orkestrel/contract'

/**
 * The browser-face `MessagePort` transport for the Model Context Protocol — a
 * {@link MCPTransportInterface} over a native `MessagePort`, the genuinely new
 * capability this face adds: MCP over `postMessage`.
 *
 * @remarks
 * - **Symmetric.** Unlike {@link import('./WebSocketClientTransport.js').WebSocketClientTransport}
 *   / {@link import('./HTTPClientTransport.js').HTTPClientTransport} (CLIENT-only
 *   carriers of `@src/core`'s `ClientTransportInterface`), a `MessagePort` is a
 *   plain duplex channel — the SAME class implements `@src/core`'s
 *   `MCPTransportInterface` and is handed to EITHER `bindServer` or
 *   `bindClient`/`createDuplexClientTransport`; which role it plays comes entirely
 *   from the binder it is given to, not from anything this class decides.
 * - **`start()` at construction — bind synchronously.** `MessagePort.start()` is only
 *   REQUIRED when listening via `addEventListener` (as opposed to the `onmessage`
 *   setter, which implies it) — this transport uses `addEventListener`, and
 *   `MCPTransportInterface` has no separate open/connect step for the caller to hook
 *   a start into, so the constructor calls `port.start()` immediately: the port
 *   begins dispatching QUEUED messages the moment the transport exists. This is safe
 *   inside `serveMCP`'s flow (the transport is synchronously handed to `bindServer`
 *   before control returns to the event loop), but is a **footgun for direct use**:
 *   if you construct `new MessagePortTransport({ port })` and then `await` anything
 *   before calling `listen`, messages that arrived in the gap are DROPPED. **Bind
 *   synchronously after construction** — do not interleave an `await` between
 *   `new MessagePortTransport(…)` and `bindServer` / `listen`.
 * - **String payloads only.** `send` posts the message string as-is (`postMessage`
 *   structured-clones it — a string clones to an identical string, so the wire stays
 *   plain JSON-RPC text like every other transport in this package). Inbound: a
 *   non-string `event.data` (a host or a misbehaving peer posting a structured
 *   object) is IGNORED — dropped silently, never forwarded, never thrown (§14) —
 *   because `MCPTransportInterface` carries no `error` channel for this port to
 *   surface a non-string frame on (unlike `ClientTransportInterface`'s `emitter`);
 *   silently ignoring is the total, contract-shaped choice.
 * - **`messageerror` is IGNORED, not routed to `closed`.** A `messageerror` event
 *   (the structured-clone deserialization of an inbound message threw) reports one
 *   BAD FRAME, not a dead channel — the port itself keeps working and later, well-
 *   formed messages still arrive. Routing it to `closed` would tear down the
 *   `bindServer`/`bindClient` wiring (and, transitively, every session it carries)
 *   over a single malformed frame, which is far more destructive than dropping that
 *   one frame — so this transport registers a `messageerror` listener that does
 *   nothing, deliberately.
 * - **`close()`** is idempotent: it closes the underlying `port` (`MessagePort.close()`
 *   disconnects it — further `postMessage` calls on EITHER end are silently
 *   undelivered, per the platform contract) and fires the registered `closed`
 *   handler exactly once, whether the caller closes it once or twice. There is no
 *   native "peer closed" signal for a `MessagePort` (unlike a WebSocket's `close`
 *   event) — `closed` fires ONLY from this transport's own `close()`.
 * - **Single-handler-replace (the port contract, `@src/core`'s `MCPTransportInterface`
 *   doc).** `listen`/`closed` each hold the ONE currently registered handler; a
 *   second call REPLACES the first rather than adding a second subscriber.
 *
 * @example
 * ```ts
 * const { port1, port2 } = new MessageChannel()
 * const serverTransport = new MessagePortTransport({ port: port1 })
 * bindServer(server, serverTransport) // port1 side dispatches inbound requests
 *
 * const clientTransport = new MessagePortTransport({ port: port2 })
 * const client = createMCPClient({ transport: createDuplexClientTransport(clientTransport) })
 * bindClient(client, clientTransport) // port2 side is the client's carrier
 * ```
 */
export class MessagePortTransport implements MCPTransportInterface {
	readonly #port: MessagePort
	#onMessage: ((message: string) => void) | undefined = undefined
	#onClosed: (() => void) | undefined = undefined
	#closed = false

	constructor(options: MessagePortTransportOptions) {
		this.#port = options.port
		this.#port.addEventListener('message', (event: MessageEvent) => this.#receive(event.data))
		this.#port.addEventListener('messageerror', () => {
			// Intentionally ignored — one bad frame, not a dead channel; see class doc.
		})
		this.#port.start()
	}

	send(message: string): void {
		if (this.#closed) return
		this.#port.postMessage(message)
	}

	listen(handler: (message: string) => void): void {
		this.#onMessage = handler
	}

	closed(handler: () => void): void {
		this.#onClosed = handler
	}

	close(): void {
		if (this.#closed) return
		this.#closed = true
		this.#port.close()
		this.#onClosed?.()
	}

	// Decode one inbound `postMessage` payload: a non-string `data` is dropped, never
	// forwarded (§14 — this port carries only plain JSON-RPC text). A string reaches the
	// registered `listen` handler unchanged (the string IS the JSON-RPC message; parsing is
	// entirely the core's concern, per the port contract).
	#receive(data: unknown): void {
		if (!isString(data)) return
		this.#onMessage?.(data)
	}
}
