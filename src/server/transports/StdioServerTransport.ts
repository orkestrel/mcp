import type {
	MCPClientTransportEventMap,
	MCPClientTransportInterface,
	JSONRPCMessage,
} from '@src/core'
import type { EmitterInterface } from '@orkestrel/emitter'
import { Emitter } from '@orkestrel/emitter'
import { dispatchLines, extractLines } from '../helpers.js'

/**
 * The stdio SERVER transport for the Model Context Protocol — wraps an injectable
 * readable/writable stream pair (`process.stdin`/`process.stdout` in production, a
 * test double in tests) as a {@link MCPClientTransportInterface}, the newline-delimited
 * JSON-RPC channel {@link import('../factories.js').createStdioServer} pumps
 * `mcp.dispatch` over, the stdio mirror of {@link
 * import('./WebSocketServerTransport.js').WebSocketServerTransport}.
 *
 * @remarks
 * - **Reuses `MCPClientTransportInterface` (§21).** The same generic carrier the HTTP
 *   and WebSocket server transports implement — `emitter` (`message` / `close` /
 *   `error`), `start`, `send`, `close`. `session` is `undefined` (the stateless v1).
 * - **Inbound (`message`).** `start()` subscribes to `input`'s `data` event; each
 *   chunk is folded through the shared {@link extractLines} line-framing helper
 *   (buffering a partial trailing line across reads), and every complete line is
 *   decoded and delivered via the shared {@link dispatchLines} helper — a
 *   well-formed {@link JSONRPCMessage} re-emits on `message`, a malformed line
 *   emits `error` (§14, never throws). `input`'s `close` bridges to this
 *   transport's `close`.
 * - **Outbound (`send`).** `send(message)` writes one newline-terminated
 *   `JSON.stringify`d line to `output`.
 * - **`close()`** removes this transport's input subscriptions and fires its `close`
 *   event (idempotent). The injected streams are owned by the caller (typically
 *   `process.stdin`/`process.stdout`), so the transport never closes, pauses, ends, or
 *   blanket-clears them.
 * - **Observable (§13).** Owns the `emitter` ({@link MCPClientTransportEventMap}); the
 *   emitter isolates a listener throw; `error` is a DOMAIN event (a transport-level
 *   fault), distinct from the emitter's own listener-error channel.
 */
export class StdioServerTransport implements MCPClientTransportInterface {
	readonly #emitter: Emitter<MCPClientTransportEventMap>
	readonly #input: NodeJS.ReadableStream
	readonly #output: NodeJS.WritableStream
	readonly #data = (chunk: Buffer | string): void => this.#receive(chunk.toString())
	readonly #ending = (): void => this.#onClose()
	readonly #failure = (error: Error): void => this.#emitter.emit('error', error)
	#buffer = ''
	#started = false
	#closed = false

	constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
		this.#emitter = new Emitter<MCPClientTransportEventMap>()
		this.#input = input
		this.#output = output
	}

	get emitter(): EmitterInterface<MCPClientTransportEventMap> {
		return this.#emitter
	}

	get session(): string | undefined {
		// The stateless v1 holds no session — a server-assigned id is the deferred tier.
		return undefined
	}

	get duplex(): boolean {
		// The output stream stays writable for the process's life, so a frame written at any
		// moment reaches the peer — stdio is the transport MCP defines cancellation on.
		return true
	}

	async start(): Promise<void> {
		// Arm the stream subscriptions once: an input chunk decodes to `message`, the input's
		// close bridges to this transport's `close`. Idempotent — a second `start` is a no-op
		// (the single MCPServer pump subscribes once).
		if (this.#started || this.#closed) return
		this.#started = true
		this.#input.on('data', this.#data)
		this.#input.on('close', this.#ending)
		this.#input.on('error', this.#failure)
	}

	async send(message: JSONRPCMessage): Promise<void> {
		this.#output.write(`${JSON.stringify(message)}\n`)
	}

	async close(): Promise<void> {
		if (this.#closed) return
		this.#closed = true
		this.#release()
		this.#emitter.emit('close')
	}

	// Buffer a raw input chunk through the shared line-framing helper, then decode + deliver
	// every complete line onto this transport's emitter (a partial trailing line carries
	// forward to the next chunk).
	#receive(chunk: string): void {
		const { lines, remainder } = extractLines(this.#buffer, chunk)
		this.#buffer = remainder
		dispatchLines(this.#emitter, lines)
	}

	// The input stream closed (EOF, peer teardown) — fire this transport's `close` once. No peer
	// identity check is needed: the input is constructor-fixed and `start()` is idempotent, so no
	// superseded stream can report a close against a replacement.
	#onClose(): void {
		if (this.#closed) return
		this.#closed = true
		this.#release()
		this.#emitter.emit('close')
	}

	#release(): void {
		this.#input.removeListener('data', this.#data)
		this.#input.removeListener('close', this.#ending)
		this.#input.removeListener('error', this.#failure)
	}
}
