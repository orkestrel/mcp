import type {
	MCPMessageTransportEventMap,
	MCPMessageTransportInterface,
	JSONRPCMessage,
} from '@src/core'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { NodeWebSocketInterface } from '@orkestrel/websocket'
import { deliverMessage } from '@src/core'
import { Emitter } from '@orkestrel/emitter'
import { WEBSOCKET_READY_OPEN } from '@orkestrel/websocket'

/**
 * Wraps a {@link NodeWebSocketInterface} (the RFC 6455 wire wrapper) as a
 * {@link MCPMessageTransportInterface} — the per-connection JSON-RPC-over-WebSocket SERVER
 * bridge, the bidirectional JSON-RPC message channel
 * `createWebSocketServer` pumps `mcp.dispatch` over and the egress mirror's
 * {@link import('./WebSocketClientTransport.js').WebSocketClientTransport} reuses.
 *
 * @remarks
 * - **Reuses `MCPMessageTransportInterface`.** It IS the same generic carrier the HTTP
 *   client transport implements — `emitter` (`message` / `close` / `error`), `start`,
 *   `send`, `close` — so the WebSocket server and client both speak ONE transport contract,
 *   no near-duplicate sibling interface. `session` is `undefined` (the stateless v1; a
 *   session id is the deferred sessions tier). The name keeps the role explicit even though
 *   the shape is shared.
 * - **Inbound (`message`).** `start()` subscribes to the socket's `message` event; each text
 *   frame runs through the shared `deliverMessage` fold (parse, then narrow) — a
 *   well-formed {@link JSONRPCMessage} is re-emitted on this transport's `message` event (the
 *   parsed envelope the {@link import('@orkestrel/mcp').MCPServerInterface} pump dispatches), while
 *   a non-JSON or non-message frame is surfaced on `error` and DROPPED, never thrown. It
 *   also bridges the socket's `close` → this transport's `close`, and the socket's `error`.
 * - **Outbound (`send`).** `send(message)` writes one text frame
 *   (`nodeWs.send(JSON.stringify(message))`). The underlying wrapper no-ops a write on a
 *   non-open socket and confirms nothing, so this bridge answers a closed channel from its own
 *   state and the socket's `readyState`: a `send` after `close()`, after the peer's close, or on
 *   a socket that is not `OPEN` REJECTS with `WebSocket transport is not connected` rather than
 *   resolving on a frame nobody wrote. `bindServer` catches that rejection and routes it to the
 *   dispatcher's `error` event, and it aborts every in-flight request the moment this transport's
 *   `close` fires — so a peer that disconnects mid-request is answered by no write at all.
 * - **`close()`** removes the subscriptions `start()` installed on the socket, closes the
 *   underlying socket (the RFC 6455 close handshake), and fires the transport's `close` event
 *   (idempotent — a second `close`, or a socket-driven close, emits once). A frame that arrives
 *   between that release and the peer's close echo reaches nothing: the socket-driven close path
 *   releases the same way, so a closed transport is never subscribed to a live socket.
 * - **Observable.** Owns the `emitter` ({@link MCPMessageTransportEventMap}); the emitter
 *   isolates a listener throw (a buggy observer never corrupts the bridge). `error` is a
 *   DOMAIN event (a transport-level fault), distinct from the emitter's listener-error channel.
 */
export class WebSocketServerTransport implements MCPMessageTransportInterface {
	readonly #emitter: Emitter<MCPMessageTransportEventMap>
	readonly #socket: NodeWebSocketInterface
	// Bound once, as fields, so `close` can remove exactly the subscriptions `start` installed:
	// an inline arrow is a new function on every call and can never be removed by reference.
	readonly #frame = (text: string): void => this.#receive(text)
	readonly #ending = (): void => this.#onClose()
	readonly #failure = (error: unknown): void => this.#emitter.emit('error', error)
	#started = false
	#closed = false

	constructor(socket: NodeWebSocketInterface) {
		this.#emitter = new Emitter<MCPMessageTransportEventMap>()
		this.#socket = socket
	}

	get emitter(): EmitterInterface<MCPMessageTransportEventMap> {
		return this.#emitter
	}

	get session(): string | undefined {
		// The stateless v1 holds no session — a server-assigned id is the deferred tier.
		return undefined
	}

	get duplex(): boolean {
		// A socket is bidirectional for its whole life: either side writes a frame whenever it
		// has one, with no request to attach it to.
		return true
	}

	async start(): Promise<void> {
		// Arm the socket subscriptions once: a text frame becomes a `message`, the socket's
		// close / error bridge to this transport's events. Idempotent — a second `start` is a
		// no-op (the single MCPServer pump subscribes once).
		if (this.#started || this.#closed) return
		this.#started = true
		this.#socket.emitter.on('message', this.#frame)
		this.#socket.emitter.on('close', this.#ending)
		this.#socket.emitter.on('error', this.#failure)
	}

	async send(message: JSONRPCMessage): Promise<void> {
		// The wrapper DROPS a write on a non-open socket and reports nothing, so this bridge
		// answers the closed channel from its own state and the socket's. Resolving would tell
		// the pump a frame reached a peer that had already gone. The socket's `readyState` is a
		// SECOND source rather than a copy of the first: a socket that ended before `start()`
		// armed the close subscription leaves this transport's own flag clear.
		if (this.#closed || this.#socket.readyState !== WEBSOCKET_READY_OPEN) {
			throw new Error('WebSocket transport is not connected')
		}
		this.#socket.send(JSON.stringify(message))
	}

	async close(): Promise<void> {
		if (this.#closed) return
		this.#closed = true
		// Release BEFORE the close handshake: the peer has not answered yet, so a frame already
		// on the wire still decodes, and a subscription left behind would re-emit it on a
		// transport whose `close` has already fired.
		this.#release()
		this.#socket.close()
		this.#emitter.emit('close')
	}

	// One frame through the shared `deliverMessage` fold: a well-formed message re-emits on
	// `message`; an unparsable or non-message frame surfaces on `error` and is dropped (the
	// bridge never throws on adversarial wire input).
	#receive(text: string): void {
		deliverMessage(this.#emitter, text, 'non-JSON-RPC WebSocket frame')
	}

	// The socket closed (peer close frame, transport teardown) — fire this transport's `close`
	// once. No peer identity check is needed: the socket is constructor-fixed and `start()` is
	// idempotent, so no superseded socket can report a close against a replacement.
	#onClose(): void {
		if (this.#closed) return
		this.#closed = true
		this.#release()
		this.#emitter.emit('close')
	}

	// Hand the socket back exactly as it was found: the wrapper is owned by the ingress that
	// claimed the upgrade, so this transport removes its own subscriptions and touches
	// nothing else on it.
	#release(): void {
		this.#socket.emitter.off('message', this.#frame)
		this.#socket.emitter.off('close', this.#ending)
		this.#socket.emitter.off('error', this.#failure)
	}
}
