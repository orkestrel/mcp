import type {
	ClientTransportEventMap,
	ClientTransportInterface,
	EmitterInterface,
	JSONRPCMessage,
} from '@src/core'
import type { NodeWebSocketInterface } from '../../websocket/types.js'
import type { WebSocketClientTransportOptions } from '../types.js'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Emitter, isString, parseJSONRPCMessage } from '@src/core'
import { computeWebSocketAccept, createNodeWebSocket } from '../../websocket/index.js'
import { WEBSOCKET_VERSION } from '../../websocket/constants.js'
import { MCP_WEBSOCKET_SUBPROTOCOL } from '../constants.js'

/**
 * The WebSocket CLIENT transport for the Model Context Protocol — a
 * {@link ClientTransportInterface} that drives a REMOTE MCP server over a WebSocket, the
 * egress mirror of {@link import('./factories.js').createWebSocketServer} and the WebSocket
 * sibling of {@link import('./HTTPClientTransport.js').HTTPClientTransport}.
 *
 * @remarks
 * - **Persistent bidirectional channel (unlike the HTTP transport).** `start()` performs the
 *   RFC 6455 client handshake: it opens a `node:http`(`s`) `GET` carrying `Connection: Upgrade`
 *   / `Upgrade: websocket` / a random `Sec-WebSocket-Key` / `Sec-WebSocket-Version: 13` /
 *   `Sec-WebSocket-Protocol: mcp` (plus any `options.headers`), awaits the client `'upgrade'`
 *   event, and VALIDATES `Sec-WebSocket-Accept === computeWebSocketAccept(key)` (the D2 helper)
 *   — a mismatch (or a non-`101` response, or a request error) REJECTS `start()` and the socket
 *   is destroyed. On success it wraps the raw upgraded socket in `createNodeWebSocket({ socket,
 *   head })` (CLIENT mode — no key → frames are MASKED per §5.3) and bridges its `message`.
 * - **Inbound (`message`).** Each decoded text frame is `JSON.parse`d (guarded) and narrowed
 *   with `parseJSONRPCMessage` — a {@link JSONRPCMessage} re-emits on this transport's `message`
 *   event (the reply the {@link import('@src/core').MCPClientInterface} correlates by `id`); a
 *   non-JSON / non-message frame surfaces on `error` and is dropped (§14). The socket's `close`
 *   / `error` bridge to this transport's events.
 * - **Outbound (`send`).** `send(message | messages)` writes ONE masked text frame per message.
 * - **`close()`** closes the underlying socket and fires `close` (idempotent).
 * - **URL scheme.** `options.url` accepts a `ws://` / `wss://` URL or an `http://` / `https://`
 *   one; a `ws(s)` scheme is converted to `http(s)` for the underlying upgrade request (`wss`
 *   → TLS via `node:https`). Either reaches the same endpoint.
 * - **Observable (§13).** Owns the `emitter` ({@link ClientTransportEventMap}); every emit
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
export class WebSocketClientTransport implements ClientTransportInterface {
	readonly #emitter: Emitter<ClientTransportEventMap>
	readonly #url: string
	readonly #headers: Readonly<Record<string, string>>
	#socket: NodeWebSocketInterface | undefined = undefined
	#closed = false

	constructor(options: WebSocketClientTransportOptions) {
		this.#emitter = new Emitter<ClientTransportEventMap>()
		this.#url = options.url
		this.#headers = options.headers ?? {}
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
		const url = this.#httpURL()
		const key = randomBytes(16).toString('base64')
		const secure = url.protocol === 'https:'
		const send = secure ? httpsRequest : httpRequest

		await new Promise<void>((resolve, reject) => {
			let settled = false
			const fail = (error: Error): void => {
				if (settled) return
				settled = true
				reject(error)
			}
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

			// The server accepted the upgrade: validate the handshake accept, then wrap the
			// raw socket in a CLIENT-mode NodeWebSocket (masks its frames).
			request.on('upgrade', (response: IncomingMessage, socket: Duplex, head: Buffer) => {
				const accept = response.headers['sec-websocket-accept']
				if (!isString(accept) || accept !== computeWebSocketAccept(key)) {
					socket.destroy()
					fail(new Error('WebSocket handshake failed: Sec-WebSocket-Accept mismatch'))
					return
				}
				const ws = createNodeWebSocket({ socket, head })
				this.#socket = ws
				this.#bind(ws)
				if (!settled) {
					settled = true
					resolve()
				}
			})

			// A plain (non-101) response means the server declined the upgrade.
			request.on('response', (response) => {
				response.resume()
				fail(new Error(`WebSocket upgrade declined with status ${response.statusCode ?? 0}`))
			})
			// A connection-level failure (refused, DNS, reset).
			request.on('error', (error) =>
				fail(error instanceof Error ? error : new Error(String(error))),
			)
			request.end()
		})
	}

	async send(message: JSONRPCMessage | readonly JSONRPCMessage[]): Promise<void> {
		const socket = this.#socket
		if (socket === undefined) throw new Error('WebSocket transport is not connected')
		const messages = Array.isArray(message) ? message : [message]
		for (const one of messages) socket.send(JSON.stringify(one))
	}

	async close(): Promise<void> {
		if (this.#closed) return
		this.#closed = true
		const socket = this.#socket
		this.#socket = undefined
		if (socket !== undefined) socket.close()
		this.#emitter.emit('close')
	}

	// Bridge the upgraded socket's events onto the transport: a text frame → `message`
	// (decoded + narrowed), the socket close → `close`, a socket fault → `error`.
	#bind(ws: NodeWebSocketInterface): void {
		ws.emitter.on('message', (text) => this.#receive(text))
		ws.emitter.on('close', () => this.#onClose())
		ws.emitter.on('error', (error) => this.#emitter.emit('error', error))
	}

	// Decode one inbound text frame: `JSON.parse` → `parseJSONRPCMessage`. A well-formed
	// message re-emits on `message`; a malformed / non-message frame surfaces on `error` and
	// is dropped (§14 — never throws on adversarial wire input).
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

	// The socket closed underneath us — fire `close` once (a `close()` call already flipped
	// `#closed`, so it does not double-emit).
	#onClose(): void {
		if (this.#closed) return
		this.#closed = true
		this.#socket = undefined
		this.#emitter.emit('close')
	}

	// Normalize `options.url` to the `http(s)` URL the underlying upgrade request uses: a
	// `ws://` → `http://`, a `wss://` → `https://`; an `http(s)://` URL passes through. Any
	// other scheme throws (a clear boundary error, not a silent mis-dial).
	#httpURL(): URL {
		const url = new URL(this.#url)
		if (url.protocol === 'ws:') url.protocol = 'http:'
		else if (url.protocol === 'wss:') url.protocol = 'https:'
		else if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new Error(`unsupported WebSocket URL scheme '${url.protocol}'`)
		}
		return url
	}
}
