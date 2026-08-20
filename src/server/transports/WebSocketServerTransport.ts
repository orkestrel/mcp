import type {
	MCPClientTransportEventMap,
	MCPClientTransportInterface,
	JSONRPCMessage,
} from '@src/core'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { NodeWebSocketInterface } from '@orkestrel/websocket'
import { parseJSONRPCMessage } from '@src/core'
import { Emitter } from '@orkestrel/emitter'

/**
 * The per-connection JSON-RPC-over-WebSocket SERVER bridge — wraps a
 * {@link NodeWebSocketInterface} (the RFC 6455 wire wrapper) as a
 * {@link MCPClientTransportInterface}, the bidirectional JSON-RPC message channel
 * `createWebSocketServer` pumps `mcp.dispatch` over and the egress mirror's
 * {@link import('./WebSocketClientTransport.js').WebSocketClientTransport} reuses.
 *
 * @remarks
 * - **Reuses `MCPClientTransportInterface` (§21).** It IS the same generic carrier the HTTP
 *   client transport implements — `emitter` (`message` / `close` / `error`), `start`,
 *   `send`, `close` — so the WebSocket server and client both speak ONE transport contract,
 *   no near-duplicate sibling interface. `session` is `undefined` (the stateless v1; a
 *   session id is the deferred sessions tier). The name keeps the role explicit even though
 *   the shape is shared.
 * - **Inbound (`message`).** `start()` subscribes to the socket's `message` event; each text
 *   frame is `JSON.parse`d inside a try/catch and narrowed with `parseJSONRPCMessage` — a
 *   well-formed {@link JSONRPCMessage} is re-emitted on this transport's `message` event (the
 *   parsed envelope the {@link import('@src/core').MCPServerInterface} pump dispatches), while
 *   a non-JSON or non-message frame is surfaced on `error` and DROPPED, never thrown (§14). It
 *   also bridges the socket's `close` → this transport's `close`, and the socket's `error`.
 * - **Outbound (`send`).** `send(message)` writes one text frame
 *   (`nodeWs.send(JSON.stringify(message))`); the underlying wrapper no-ops a write on a
 *   non-open socket, so a closed connection drops silently rather than throwing.
 * - **`close()`** removes the three subscriptions `start()` installed on the socket, closes the
 *   underlying socket (the RFC 6455 close handshake), and fires the transport's `close` event
 *   (idempotent — a second `close`, or a socket-driven close, emits once). A frame that arrives
 *   between that release and the peer's close echo reaches nothing: the socket-driven close path
 *   releases the same way, so a closed transport is never subscribed to a live socket.
 * - **Observable (§13).** Owns the `emitter` ({@link MCPClientTransportEventMap}); the emitter
 *   isolates a listener throw (a buggy observer never corrupts the bridge). `error` is a
 *   DOMAIN event (a transport-level fault), distinct from the emitter's listener-error channel.
 */
export class WebSocketServerTransport implements MCPClientTransportInterface {
	readonly #emitter: Emitter<MCPClientTransportEventMap>
	readonly #socket: NodeWebSocketInterface
	// Bound once, as fields, so `close` can remove exactly the subscriptions `start` installed:
	// an inline arrow is a new function on every call and can never be removed by reference.
	readonly #frame = (text: string): void => this.#receive(text)
	readonly #ending = (): void => this.#onClose()
	readonly #failure = (error: unknown): void => this.#emitter.emit('error', error)
	#started = false
	#closed = false

	constructor(socket: NodeWebSocketInterface) {
		this.#emitter = new Emitter<MCPClientTransportEventMap>()
		this.#socket = socket
	}

	get emitter(): EmitterInterface<MCPClientTransportEventMap> {
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
		// The wrapper drops a write on a non-open socket, so a closed connection is a
		// silent no-op rather than a throw.
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

	// Decode one inbound text frame: `JSON.parse` → `parseJSONRPCMessage`. A well-formed
	// message re-emits on `message`; a malformed / non-message frame surfaces on `error` and
	// is dropped (§14 — the bridge never throws on adversarial wire input).
	#receive(text: string): void {
		let parsed: unknown
		try {
			parsed = JSON.parse(text)
		} catch (error) {
			this.#emitter.emit('error', error)
			return
		}
		const message = parseJSONRPCMessage(parsed)
		if (message === undefined) {
			this.#emitter.emit('error', new Error('non-JSON-RPC WebSocket frame'))
			return
		}
		this.#emitter.emit('message', message)
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
	// claimed the upgrade, so this transport removes its own three subscriptions and touches
	// nothing else on it.
	#release(): void {
		this.#socket.emitter.off('message', this.#frame)
		this.#socket.emitter.off('close', this.#ending)
		this.#socket.emitter.off('error', this.#failure)
	}
}
