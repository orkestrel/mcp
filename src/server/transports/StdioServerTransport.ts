import type { ClientTransportEventMap, ClientTransportInterface, JSONRPCMessage } from '@src/core'
import type { EmitterInterface } from '@orkestrel/emitter'
import { Emitter } from '@orkestrel/emitter'
import { dispatchLines, extractLines } from '../helpers.js'

/**
 * The stdio SERVER transport for the Model Context Protocol — wraps an injectable
 * readable/writable stream pair (`process.stdin`/`process.stdout` in production, a
 * test double in tests) as a {@link ClientTransportInterface}, the newline-delimited
 * JSON-RPC channel {@link import('../factories.js').createStdioServer} pumps
 * `mcp.dispatch` over, the stdio mirror of {@link
 * import('./WebSocketServerTransport.js').WebSocketServerTransport}.
 *
 * @remarks
 * - **Reuses `ClientTransportInterface` (§21).** The same generic carrier the HTTP
 *   and WebSocket server transports implement — `emitter` (`message` / `close` /
 *   `error`), `start`, `send`, `close`. `session` is `undefined` (the stateless v1).
 * - **Inbound (`message`).** `start()` subscribes to `input`'s `data` event; each
 *   chunk is folded through the shared {@link extractLines} line-framing helper
 *   (buffering a partial trailing line across reads), and every complete line is
 *   decoded and delivered via the shared {@link dispatchLines} helper — a
 *   well-formed {@link JSONRPCMessage} re-emits on `message`, a malformed line
 *   emits `error` (§14, never throws). `input`'s `close` bridges to this
 *   transport's `close`.
 * - **Outbound (`send`).** `send(message | messages)` writes ONE newline-terminated
 *   `JSON.stringify`d line per message to `output`.
 * - **`close()`** fires this transport's `close` (idempotent) — the injected streams
 *   are owned by the caller (typically `process.stdin`/`process.stdout`, which must
 *   never be closed out from under the process) and are not torn down here.
 * - **Observable (§13).** Owns the `emitter` ({@link ClientTransportEventMap}); the
 *   emitter isolates a listener throw; `error` is a DOMAIN event (a transport-level
 *   fault), distinct from the emitter's own listener-error channel.
 */
export class StdioServerTransport implements ClientTransportInterface {
	readonly #emitter: Emitter<ClientTransportEventMap>
	readonly #input: NodeJS.ReadableStream
	readonly #output: NodeJS.WritableStream
	#buffer = ''
	#started = false
	#closed = false

	constructor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream) {
		this.#emitter = new Emitter<ClientTransportEventMap>()
		this.#input = input
		this.#output = output
	}

	get emitter(): EmitterInterface<ClientTransportEventMap> {
		return this.#emitter
	}

	get session(): string | undefined {
		// The stateless v1 holds no session — a server-assigned id is the deferred tier.
		return undefined
	}

	async start(): Promise<void> {
		// Arm the stream subscriptions once: an input chunk decodes to `message`, the input's
		// close bridges to this transport's `close`. Idempotent — a second `start` is a no-op
		// (the single MCPServer pump subscribes once).
		if (this.#started || this.#closed) return
		this.#started = true
		this.#input.on('data', (chunk: Buffer | string) => this.#receive(chunk.toString()))
		this.#input.on('close', () => this.#onClose())
		this.#input.on('error', (error) => this.#emitter.emit('error', error))
	}

	async send(message: JSONRPCMessage | readonly JSONRPCMessage[]): Promise<void> {
		const messages = Array.isArray(message) ? message : [message]
		for (const one of messages) this.#output.write(`${JSON.stringify(one)}\n`)
	}

	async close(): Promise<void> {
		if (this.#closed) return
		this.#closed = true
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

	// The input stream closed (EOF, peer teardown) — fire this transport's `close` once. A
	// `close()` call already flipped `#closed`, so a stream-driven close after an explicit one
	// does not double-emit.
	#onClose(): void {
		if (this.#closed) return
		this.#closed = true
		this.#emitter.emit('close')
	}
}
