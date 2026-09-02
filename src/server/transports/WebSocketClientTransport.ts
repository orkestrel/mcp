import type {
	MCPMessageTransportEventMap,
	MCPMessageTransportInterface,
	JSONRPCMessage,
} from '@src/core'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { NodeWebSocketInterface } from '@orkestrel/websocket'
import type { WebSocketClientTransportOptions } from '../types.js'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { deliverMessage } from '@src/core'
import { isString } from '@orkestrel/contract'
import { Emitter } from '@orkestrel/emitter'
import {
	computeWebSocketAccept,
	createNodeWebSocket,
	WEBSOCKET_READY_OPEN,
	WEBSOCKET_VERSION,
} from '@orkestrel/websocket'
import { MCP_WEBSOCKET_SUBPROTOCOL } from '../constants.js'

/**
 * The WebSocket CLIENT transport for the Model Context Protocol — a
 * {@link MCPMessageTransportInterface} that drives a REMOTE MCP server over a WebSocket, the
 * egress mirror of {@link import('./factories.js').createWebSocketServer} and the WebSocket
 * sibling of {@link import('@orkestrel/mcp').HTTPClientTransport}.
 *
 * @remarks
 * - **Persistent bidirectional channel (unlike the HTTP transport).** `start()` performs the
 *   RFC 6455 client handshake: it opens a `node:http`(`s`) `GET` carrying `Connection: Upgrade`
 *   / `Upgrade: websocket` / a random `Sec-WebSocket-Key` / `Sec-WebSocket-Version: 13` /
 *   `Sec-WebSocket-Protocol: mcp` (plus any `options.headers`), awaits the client `'upgrade'`
 *   event, and VALIDATES `Sec-WebSocket-Accept === computeWebSocketAccept(key)` (the D2 helper)
 *   — a mismatch (or a non-`101` response, or a request error) REJECTS `start()` and the socket
 *   is destroyed. On success it wraps the raw upgraded socket in `createNodeWebSocket({ socket,
 *   head })` (CLIENT mode — no key → frames are MASKED per RFC 6455 §5.3) and bridges its
 *   `message`.
 * - **The arriving socket is RE-ASKED for, never assumed.** `start()` suspends across that
 *   connect and upgrade, so it re-checks the transport's state before installing anything: a
 *   concurrent `start()` that already installed a socket, or a {@link close} that ended the
 *   transport while the handshake was on the wire, both WIN — the socket that arrives late is
 *   DESTROYED and never bound, so no orphan is left re-emitting frames at nobody. Both
 *   `start()` calls still resolve; exactly one socket is ever bound.
 * - **Inbound (`message`).** Each decoded text frame runs through the shared `deliverMessage`
 *   fold (parse, then narrow) — a {@link JSONRPCMessage} re-emits on this transport's `message`
 *   event (the reply the {@link import('@orkestrel/mcp').MCPClientInterface} correlates by `id`); a
 *   non-JSON / non-message frame surfaces on `error` and is dropped. The socket's `close`
 *   / `error` bridge to this transport's events.
 * - **Outbound (`send`).** `send(message)` writes one masked text frame. A socket write is not
 *   confirmed, so this transport answers a closed channel from its own state AND the socket's
 *   `readyState`: a `send` with no bound socket — before `start()`, after `close()`, or after the
 *   peer ended the socket — and a `send` on a bound socket that is not `OPEN` both REJECT with
 *   `WebSocket transport is not connected`. It neither drops the message nor queues it for a
 *   connection this transport is not holding — the browser face queues a pre-open send, and this
 *   one, holding no connection to flush it onto, rejects that too.
 * - **`close()`** unsubscribes from the socket, closes it, and fires `close` (idempotent). An
 *   upgrade still on the wire is DESTROYED, so a `close()` during the handshake ends the
 *   transport at once instead of waiting for a peer that may never answer — the suspended
 *   `start()` resolves, because the close is the outcome its caller asked for.
 * - **URL scheme.** `options.url` accepts a `ws://` / `wss://` URL or an `http://` / `https://`
 *   one; a `ws(s)` scheme is converted to `http(s)` for the underlying upgrade request (`wss`
 *   → TLS through `node:https`). Either reaches the same endpoint.
 * - **Observable.** Owns the `emitter` ({@link MCPMessageTransportEventMap}); every emit
 *   the emitter isolates a listener throw (a buggy observer never corrupts the transport);
 *   `error` is a DOMAIN event (a transport-level fault).
 *
 * @example
 * ```ts
 * const transport = new WebSocketClientTransport({ url: 'ws://localhost:3000/mcp' })
 * const client = new MCPClient({ transport })
 * await client.connect() // start() handshakes, then the MCP initialize runs over WS frames
 * ```
 */
export class WebSocketClientTransport implements MCPMessageTransportInterface {
	readonly #emitter: Emitter<MCPMessageTransportEventMap>
	readonly #url: string
	readonly #headers: Readonly<Record<string, string>>
	// Bound once, as fields, so `close` can remove exactly the subscriptions `#bind` installed:
	// an inline arrow is a new function on every call and can never be removed by reference.
	readonly #frame = (text: string): void => this.#receive(text)
	readonly #ending = (): void => this.#onClose()
	readonly #failure = (error: unknown): void => this.#emitter.emit('error', error)
	#socket: NodeWebSocketInterface | undefined = undefined
	// The upgrade on the wire. Nothing else holds it, so a `close` during the
	// handshake can only cancel through this.
	#request: ClientRequest | undefined = undefined
	#closed = false

	constructor(options: WebSocketClientTransportOptions) {
		this.#emitter = new Emitter<MCPMessageTransportEventMap>()
		this.#url = options.url
		this.#headers = options.headers ?? {}
	}

	get emitter(): EmitterInterface<MCPMessageTransportEventMap> {
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
		try {
			await this.#connect(this.#toHTTPURL(), randomBytes(16).toString('base64'))
		} finally {
			// Whatever the handshake did, it is no longer on the wire, so nothing is left for a
			// later `close` to cancel.
			this.#request = undefined
		}
	}

	async send(message: JSONRPCMessage): Promise<void> {
		// The wrapper DROPS a write on a non-open socket and reports nothing, so this transport
		// answers the closed channel from its own state and the socket's. Resolving would tell the
		// client a frame reached a peer that had already gone, and leave its correlated request
		// pending to its own deadline. The socket's `readyState` is a SECOND source rather than a
		// copy of the first: a peer close decoded inside `createNodeWebSocket` — from the bytes
		// that rode in with the handshake — fires before this transport binds a single listener,
		// so the socket is installed already past OPEN while this transport's own state says
		// nothing happened.
		const socket = this.#socket
		if (socket === undefined || socket.readyState !== WEBSOCKET_READY_OPEN) {
			throw new Error('WebSocket transport is not connected')
		}
		socket.send(JSON.stringify(message))
	}

	async close(): Promise<void> {
		if (this.#closed) return
		this.#closed = true
		// The upgrade still on the wire is this transport's to cancel. Without it a close during
		// the handshake waits out the peer, and the socket that finally arrives is destroyed long
		// after the caller was told the transport had ended.
		this.#request?.destroy()
		const socket = this.#socket
		this.#release()
		this.#socket = undefined
		if (socket !== undefined) socket.close()
		this.#emitter.emit('close')
	}

	// Run the RFC 6455 client handshake and bind the socket it produces. Split from `start` so
	// the retained request is cleared on every settlement path, including a rejection.
	async #connect(url: URL, key: string): Promise<void> {
		const secure = url.protocol === 'https:'
		const send = secure ? httpsRequest : httpRequest
		await new Promise<void>((resolve, reject) => {
			const request = send({
				hostname: url.hostname,
				port: url.port.length > 0 ? Number(url.port) : secure ? 443 : 80,
				path: `${url.pathname}${url.search}`,
				headers: {
					Connection: 'Upgrade',
					Upgrade: 'websocket',
					'Sec-WebSocket-Key': key,
					'Sec-WebSocket-Version': WEBSOCKET_VERSION,
					'Sec-WebSocket-Protocol': MCP_WEBSOCKET_SUBPROTOCOL,
					...this.#headers,
				},
			})
			this.#request = request

			// The server accepted the upgrade: validate the handshake accept, then wrap the
			// raw socket in a CLIENT-mode NodeWebSocket (masks its frames).
			request.on('upgrade', (response: IncomingMessage, socket: Duplex, head: Buffer) => {
				const accept = response.headers['sec-websocket-accept']
				if (!isString(accept) || accept !== computeWebSocketAccept(key)) {
					socket.destroy()
					reject(new Error('WebSocket handshake failed: Sec-WebSocket-Accept mismatch'))
					return
				}
				// RE-ASK. Every state the guard at the top of `start()` read is stale by now: this
				// handshake suspended across a real TCP connect and HTTP upgrade, during which a
				// second `start()` may have installed its own socket or `close()` may have ended the
				// transport. Nobody wants this one, so DESTROY it rather than binding a second,
				// never-closed peer that keeps re-emitting frames at a transport that has moved on.
				// `start()` still resolves: the winner (or the close) is the outcome the caller asked
				// for, not a failure.
				if (this.#closed || this.#socket !== undefined) {
					socket.destroy()
					resolve()
					return
				}
				const ws = createNodeWebSocket({ socket, head })
				this.#socket = ws
				this.#bind(ws)
				resolve()
			})

			// A plain (non-101) response means the server declined the upgrade.
			request.on('response', (response) => {
				response.resume()
				reject(new Error(`WebSocket upgrade declined with status ${response.statusCode ?? 0}`))
			})
			// A connection-level failure (refused, DNS, reset) — or the reset that follows the
			// `close()` above destroying this request, which IS that close arriving rather than a
			// fault: the caller asked for the transport to end, and it has.
			request.on('error', (error) => {
				if (this.#closed) {
					resolve()
					return
				}
				reject(error instanceof Error ? error : new Error(String(error)))
			})
			request.end()
		})
	}

	// Bridge the upgraded socket's events onto the transport: a text frame → `message`
	// (decoded + narrowed), the socket close → `close`, a socket fault → `error`.
	#bind(ws: NodeWebSocketInterface): void {
		ws.emitter.on('message', this.#frame)
		ws.emitter.on('close', this.#ending)
		ws.emitter.on('error', this.#failure)
	}

	// Unsubscribe from the socket this transport holds. The socket itself belongs to
	// the peer connection, so nothing else on it is touched.
	#release(): void {
		const socket = this.#socket
		if (socket === undefined) return
		socket.emitter.off('message', this.#frame)
		socket.emitter.off('close', this.#ending)
		socket.emitter.off('error', this.#failure)
	}

	// One frame through the shared `deliverMessage` fold: a well-formed message re-emits on
	// `message`; an unparsable or non-message frame surfaces on `error` and is dropped (never
	// throws on adversarial wire input).
	#receive(text: string): void {
		deliverMessage(this.#emitter, text, 'non-JSON-RPC WebSocket frame')
	}

	// The current socket closed underneath us — fire `close` once. Only the socket this
	// transport still holds can reach here: a superseded one was unsubscribed when it was
	// released, so its own later close reports to nobody and cannot clear the live socket.
	#onClose(): void {
		if (this.#closed) return
		this.#closed = true
		this.#release()
		this.#socket = undefined
		this.#emitter.emit('close')
	}

	// Normalize `options.url` to the `http(s)` URL the underlying upgrade request uses: a
	// `ws://` → `http://`, a `wss://` → `https://`; an `http(s)://` URL passes through. Any
	// other scheme throws (a clear boundary error, not a silent mis-dial).
	#toHTTPURL(): URL {
		const url = new URL(this.#url)
		if (url.protocol === 'ws:') url.protocol = 'http:'
		else if (url.protocol === 'wss:') url.protocol = 'https:'
		else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new Error(`unsupported WebSocket URL scheme '${url.protocol}'`)
		}
		return url
	}
}
