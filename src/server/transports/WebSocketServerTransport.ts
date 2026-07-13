import type {
	ClientTransportEventMap,
	ClientTransportInterface,
	EmitterInterface,
	JSONRPCMessage,
} from '@src/core'
import type { NodeWebSocketInterface } from '../../websocket/types.js'
import { Emitter, parseJSONRPCMessage } from '@src/core'

/**
 * The per-connection JSON-RPC-over-WebSocket SERVER bridge — wraps a
 * {@link NodeWebSocketInterface} (the RFC 6455 wire wrapper) as a
 * {@link ClientTransportInterface}, the bidirectional JSON-RPC message channel
 * `createWebSocketServer` pumps `mcp.dispatch` over and the egress mirror's
 * {@link import('./WebSocketClientTransport.js').WebSocketClientTransport} reuses.
 *
 * @remarks
 * - **Reuses `ClientTransportInterface` (§21).** It IS the same generic carrier the HTTP
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
 * - **Outbound (`send`).** `send(message | messages)` writes ONE text frame per message
 *   (`nodeWs.send(JSON.stringify(...))`); the underlying wrapper no-ops a write on a
 *   non-open socket, so a closed connection drops silently rather than throwing.
 * - **`close()`** closes the underlying socket (the RFC 6455 close handshake) and fires the
 *   transport's `close` event (idempotent — a second `close`, or a socket-driven close, emits
 *   once).
 * - **Observable (§13).** Owns the `emitter` ({@link ClientTransportEventMap}); the emitter
 *   isolates a listener throw (a buggy observer never corrupts the bridge). `error` is a
 *   DOMAIN event (a transport-level fault), distinct from the emitter's listener-error channel.
 */
export class WebSocketServerTransport implements ClientTransportInterface {
	readonly #emitter: Emitter<ClientTransportEventMap>
	readonly #socket: NodeWebSocketInterface
	#started = false
	#closed = false

	constructor(socket: NodeWebSocketInterface) {
		this.#emitter = new Emitter<ClientTransportEventMap>()
		this.#socket = socket
	}

	get emitter(): EmitterInterface<ClientTransportEventMap> {
		return this.#emitter
	}

	get session(): string | undefined {
		// The stateless v1 holds no session — a server-assigned id is the deferred tier.
		return undefined
	}

	async start(): Promise<void> {
		// Arm the socket subscriptions once: a text frame becomes a `message`, the socket's
		// close / error bridge to this transport's events. Idempotent — a second `start` is a
		// no-op (the single MCPServer pump subscribes once).
		if (this.#started || this.#closed) return
		this.#started = true
		this.#socket.emitter.on('message', (text) => this.#receive(text))
		this.#socket.emitter.on('close', () => this.#onClose())
		this.#socket.emitter.on('error', (error) => this.#emitter.emit('error', error))
	}

	async send(message: JSONRPCMessage | readonly JSONRPCMessage[]): Promise<void> {
		// One text frame per message (a batch is unrolled). The wrapper drops a write on a
		// non-open socket, so a closed connection is a silent no-op rather than a throw.
		const messages = Array.isArray(message) ? message : [message]
		for (const one of messages) this.#socket.send(JSON.stringify(one))
	}

	async close(): Promise<void> {
		if (this.#closed) return
		this.#closed = true
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

	// The socket closed (peer close frame, transport teardown) — fire this transport's
	// `close` once. A `close()` call already flipped `#closed`, so a socket-driven close
	// after an explicit one does not double-emit.
	#onClose(): void {
		if (this.#closed) return
		this.#closed = true
		this.#emitter.emit('close')
	}
}
