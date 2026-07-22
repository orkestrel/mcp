import type { ClientTransportEventMap, ClientTransportInterface, JSONRPCMessage } from '@src/core'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { WebSocketClientTransportOptions } from '../types.js'
import { parseJSONRPCMessage } from '@src/core'
import { isString } from '@orkestrel/contract'
import { Emitter } from '@orkestrel/emitter'
import { MCP_WEBSOCKET_SUBPROTOCOL } from '../constants.js'

/**
 * The browser-face WebSocket CLIENT transport for the Model Context Protocol — a
 * {@link ClientTransportInterface} that drives a REMOTE MCP server over the native
 * `WebSocket` global, the browser sibling of the Node face's
 * {@link import('@src/server').WebSocketClientTransport}.
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
 * - **Inbound (`message`).** Each decoded text frame is `JSON.parse`d (guarded) and
 *   narrowed with `parseJSONRPCMessage` — a well-formed {@link JSONRPCMessage}
 *   re-emits on this transport's `message` event; a non-text (binary) frame or a
 *   non-JSON / non-message text frame surfaces on `error` and is DROPPED (§14 — never
 *   throws on adversarial wire input).
 * - **`close()`** closes the underlying socket and fires `close` (idempotent); the
 *   socket's native `close` event (a server-initiated close) fires the SAME `close`
 *   exactly once total — `close()` first flips the guard, so the native event never
 *   double-emits. **This transport is not reusable after `close()`** — a `send` issued
 *   after `close()` is silently dropped (not queued, not delivered even on a later
 *   `start()`).
 * - **Observable (§13).** Owns the `emitter` ({@link ClientTransportEventMap}); every
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
export class WebSocketClientTransport implements ClientTransportInterface {
	readonly #emitter: Emitter<ClientTransportEventMap>
	readonly #url: string
	readonly #protocols: string | string[] | undefined
	#socket: WebSocket | undefined = undefined
	#queue: string[] = []
	#closed = false

	constructor(options: WebSocketClientTransportOptions) {
		this.#emitter = new Emitter<ClientTransportEventMap>()
		this.#url = options.url
		const protocols = options.protocols
		// Default to MCP_WEBSOCKET_SUBPROTOCOL when `protocols` is omitted — matching
		// createWebSocketServer's unconditional echo. An empty array means "no subprotocol",
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

	get emitter(): EmitterInterface<ClientTransportEventMap> {
		return this.#emitter
	}

	get session(): string | undefined {
		return undefined
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
			socket.addEventListener(
				'open',
				() => {
					this.#flush(socket)
					resolve()
				},
				{ once: true },
			)
			socket.addEventListener(
				'error',
				() => {
					if (socket.readyState !== WebSocket.OPEN) {
						this.#socket = undefined
						reject(new Error('WebSocket connection failed'))
					}
				},
				{ once: true },
			)
		})
	}

	async send(message: JSONRPCMessage | readonly JSONRPCMessage[]): Promise<void> {
		// After close(), silently drop — never queue (a closed transport is not reusable;
		// queued messages would resurrect on a later start() which is not a supported pattern).
		if (this.#closed) return
		const messages = Array.isArray(message) ? message : [message]
		for (const one of messages) {
			const text = JSON.stringify(one)
			const socket = this.#socket
			if (socket !== undefined && socket.readyState === WebSocket.OPEN) socket.send(text)
			else this.#queue.push(text)
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return
		this.#closed = true
		const socket = this.#socket
		this.#socket = undefined
		if (socket !== undefined) socket.close()
		this.#emitter.emit('close')
	}

	// Bridge the native socket's events onto the transport: a text frame → `message`
	// (decoded + narrowed), the socket close → `close`, a socket fault → `error`.
	#bind(socket: WebSocket): void {
		socket.addEventListener('message', (event: MessageEvent) => this.#receive(event.data))
		socket.addEventListener('close', () => this.#onClose())
		socket.addEventListener('error', (event) => this.#emitter.emit('error', event))
	}

	// Write every queued (pre-open) message, in order, as the socket opens.
	#flush(socket: WebSocket): void {
		for (const text of this.#queue.splice(0)) socket.send(text)
	}

	// Decode one inbound frame: a non-text (binary) frame is rejected without a throw; a
	// text frame is `JSON.parse`d → `parseJSONRPCMessage`. A well-formed message re-emits on
	// `message`; a malformed / non-message frame surfaces on `error` and is dropped (§14 —
	// never throws on adversarial wire input).
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

	// The socket closed underneath us — fire `close` once (a `close()` call already flipped
	// `#closed`, so it does not double-emit).
	#onClose(): void {
		if (this.#closed) return
		this.#closed = true
		this.#socket = undefined
		this.#emitter.emit('close')
	}
}
