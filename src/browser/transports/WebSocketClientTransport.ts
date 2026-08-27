import type {
	MCPClientTransportEventMap,
	MCPClientTransportInterface,
	JSONRPCMessage,
} from '@src/core'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { WebSocketClientTransportOptions } from '../types.js'
import { parseJSONRPCMessage } from '@src/core'
import { isString } from '@orkestrel/contract'
import { Emitter } from '@orkestrel/emitter'
import { MCP_WEBSOCKET_SUBPROTOCOL } from '../constants.js'

/**
 * The browser-face WebSocket CLIENT transport for the Model Context Protocol — a
 * {@link MCPClientTransportInterface} that drives a REMOTE MCP server over the native
 * `WebSocket` global, the browser sibling of the Node face's
 * {@link import('@orkestrel/mcp/server').WebSocketClientTransport}.
 *
 * @remarks
 * - **Host-performed handshake.** `start()` opens `new WebSocket(url, protocols)` and
 *   waits for the native `'open'` event — the RFC 6455 handshake itself is entirely
 *   the host's concern, so this transport carries none of the Node client's
 *   `node:crypto` / `node:http(s)` machinery. A connection failure (the native
 *   `'error'` event while not yet `OPEN`) REJECTS `start()`.
 * - **Queued sends.** `send` writes each message as one text frame immediately once
 *   the socket is `OPEN`; a `send` issued before `'open'` fires (or before `start()`
 *   is even called) is QUEUED and flushed, IN ORDER, the moment the socket opens —
 *   so a caller need not await `start()` before calling `send`.
 * - **A closed channel REJECTS.** The native socket confirms nothing about a write, so this
 *   transport answers from its own state: a `send` after `close()`, or on a socket already
 *   reporting `CLOSING` / `CLOSED`, REJECTS with `WebSocket transport is not connected` rather
 *   than resolving on a frame nobody wrote. Only the closed state rejects — a pre-open `send`
 *   still queues.
 * - **Inbound (`message`).** Each decoded text frame is `JSON.parse`d (guarded) and
 *   narrowed with `parseJSONRPCMessage` — a well-formed {@link JSONRPCMessage}
 *   re-emits on this transport's `message` event; a non-text (binary) frame or a
 *   non-JSON / non-message text frame surfaces on `error` and is DROPPED (never
 *   throws on adversarial wire input).
 * - **`close()`** unsubscribes from the underlying socket, closes it, and fires `close`
 *   (idempotent); the socket's native `close` event (a server-initiated close) fires the
 *   SAME `close` exactly once total — `close()` first flips the guard, so the native event
 *   never double-emits, and the released socket reports its own close to nobody. Closing before
 *   the socket opens resolves the pending `start()` rather than leaving it pending, matching the
 *   Node face. A `send` issued after `close()` REJECTS (it is never queued), so a closed
 *   transport delivers nothing until a `start()` opens a new connection.
 * - **Observable.** Owns the `emitter` ({@link MCPClientTransportEventMap}); every
 *   emit the emitter isolates a listener throw; `error` is a DOMAIN event (a
 *   transport-level fault).
 *
 * @example
 * ```ts
 * const transport = new WebSocketClientTransport({ url: 'ws://localhost:3000/mcp' })
 * const client = new MCPClient({ transport })
 * await client.connect() // the browser handshakes, then the MCP initialize runs over WS frames
 * ```
 */
export class WebSocketClientTransport implements MCPClientTransportInterface {
	readonly #emitter: Emitter<MCPClientTransportEventMap>
	readonly #url: string
	readonly #protocols: string | string[] | undefined
	// Bound once, as fields, so `close` can remove exactly the listeners `#bind` installed: an
	// inline arrow is a new function on every call and can never be removed by reference.
	readonly #frame = (event: MessageEvent<unknown>): void => this.#receive(event.data)
	readonly #ending = (): void => this.#onClose()
	readonly #failure = (event: Event): void => this.#emitter.emit('error', event)
	readonly #opening = (): void => this.#onOpen()
	readonly #rejection = (): void => this.#onHandshakeError()
	#socket: WebSocket | undefined = undefined
	#handshake: WebSocket | undefined = undefined
	#resolve: (() => void) | undefined = undefined
	#reject: ((error: Error) => void) | undefined = undefined
	#queue: string[] = []
	#closed = false

	constructor(options: WebSocketClientTransportOptions) {
		this.#emitter = new Emitter<MCPClientTransportEventMap>()
		this.#url = options.url
		const protocols = options.protocols
		// Default to MCP_WEBSOCKET_SUBPROTOCOL when `protocols` is omitted; the server selects it
		// from this offer. An empty array means "no subprotocol",
		// overriding the default explicitly for foreign servers.
		this.#protocols =
			typeof protocols === 'string'
				? protocols
				: protocols === undefined
					? MCP_WEBSOCKET_SUBPROTOCOL
					: protocols.length === 0
						? undefined
						: [...protocols]
	}

	get emitter(): EmitterInterface<MCPClientTransportEventMap> {
		return this.#emitter
	}

	get session(): string | undefined {
		return undefined
	}

	get duplex(): boolean {
		// A socket is bidirectional for its whole life: either side writes a frame whenever it
		// has one, with no request to attach it to.
		return true
	}

	async start(): Promise<void> {
		// Already connected — a second `connect()` short-circuits in the client, but guard here
		// too (idempotent open).
		if (this.#socket !== undefined) return
		this.#closed = false
		const socket = new WebSocket(this.#url, this.#protocols)
		this.#socket = socket
		this.#bind(socket)
		await new Promise<void>((resolve, reject) => {
			this.#handshake = socket
			this.#resolve = resolve
			this.#reject = reject
			socket.addEventListener('open', this.#opening)
			socket.addEventListener('error', this.#rejection)
		})
	}

	async send(message: JSONRPCMessage): Promise<void> {
		const socket = this.#socket
		// A closed transport, and a socket the host has already moved past OPEN, each name a
		// channel that will never carry this frame. Resolving would tell the client the message
		// was written and leave its correlated request pending to its own deadline. The socket's
		// own state is a SECOND source rather than a copy of the first: the native `close` event
		// lags the readyState transition, so a server-initiated close leaves this transport's flag
		// clear while the socket already reports `CLOSING`.
		if (
			this.#closed ||
			socket?.readyState === WebSocket.CLOSING ||
			socket?.readyState === WebSocket.CLOSED
		) {
			throw new Error('WebSocket transport is not connected')
		}
		const text = JSON.stringify(message)
		// No socket yet (`start()` has not run) or still `CONNECTING`: queue it, and `#flush`
		// writes the whole queue in order the moment the socket opens.
		if (socket !== undefined && socket.readyState === WebSocket.OPEN) socket.send(text)
		else this.#queue.push(text)
	}

	async close(): Promise<void> {
		if (this.#closed) return
		this.#closed = true
		const socket = this.#socket
		const resolve = this.#resolve
		this.#releaseHandshake()
		this.#release()
		this.#socket = undefined
		if (socket !== undefined) socket.close()
		this.#emitter.emit('close')
		resolve?.()
	}

	// Bridge the native socket's events onto the transport: a text frame → `message`
	// (decoded + narrowed), the socket close → `close`, a socket fault → `error`.
	#bind(socket: WebSocket): void {
		socket.addEventListener('message', this.#frame)
		socket.addEventListener('close', this.#ending)
		socket.addEventListener('error', this.#failure)
	}

	// Unsubscribe from the socket this transport holds. A closing socket goes on
	// firing its own events, so a bridge left installed on one this transport has released
	// would report a connection it no longer owns.
	#release(): void {
		const socket = this.#socket
		if (socket === undefined) return
		socket.removeEventListener('message', this.#frame)
		socket.removeEventListener('close', this.#ending)
		socket.removeEventListener('error', this.#failure)
	}

	#releaseHandshake(): void {
		const socket = this.#handshake
		if (socket === undefined) return
		socket.removeEventListener('open', this.#opening)
		socket.removeEventListener('error', this.#rejection)
		this.#handshake = undefined
		this.#resolve = undefined
		this.#reject = undefined
	}

	// Write every queued (pre-open) message, in order, as the socket opens.
	#flush(socket: WebSocket): void {
		for (const text of this.#queue.splice(0)) socket.send(text)
	}

	#onOpen(): void {
		const socket = this.#handshake
		const resolve = this.#resolve
		if (socket === undefined || resolve === undefined) return
		this.#releaseHandshake()
		this.#flush(socket)
		resolve()
	}

	#onHandshakeError(): void {
		const socket = this.#handshake
		const reject = this.#reject
		if (socket === undefined || reject === undefined || socket.readyState === WebSocket.OPEN) return
		this.#releaseHandshake()
		this.#release()
		this.#socket = undefined
		reject(new Error('WebSocket connection failed'))
	}

	// Decode one inbound frame: a non-text (binary) frame is rejected without a throw; a
	// text frame is `JSON.parse`d → `parseJSONRPCMessage`. A well-formed message re-emits on
	// `message`; a malformed / non-message frame surfaces on `error` and is dropped
	// (never throws on adversarial wire input).
	#receive(data: unknown): void {
		if (!isString(data)) {
			this.#emitter.emit('error', new Error('non-text WebSocket frame'))
			return
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(data)
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

	// The socket closed underneath us — fire `close` once. Only the socket this transport still
	// holds can reach here: a superseded one was unsubscribed when it was released, so its own
	// later close cannot end the connection that replaced it.
	#onClose(): void {
		if (this.#closed) return
		this.#closed = true
		this.#release()
		this.#socket = undefined
		this.#emitter.emit('close')
	}
}
