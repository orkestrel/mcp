import type { MCPMessageTransportEventMap, JSONRPCMessage } from '@src/core'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { StdioClientTransportInterface, StdioClientTransportOptions } from '../types.js'
import { Emitter } from '@orkestrel/emitter'
import { DEFAULT_MCP_DELIVERY } from '../constants.js'
import { StdioLifetime } from '../StdioLifetime.js'

/**
 * Drives a child process MCP server over newline-delimited JSON-RPC on `stdin`/`stdout` —
 * a {@link StdioClientTransportInterface}, the stdio sibling of {@link
 * import('@orkestrel/mcp').HTTPClientTransport} and {@link
 * import('./WebSocketClientTransport.js').WebSocketClientTransport}.
 *
 * @remarks
 * - **Composes `@orkestrel/process`.** `start()` builds one supervised
 *   {@link import('@orkestrel/process/server').Supervisor} with `writable: true`, so the child's
 *   `stdin`/`stdout` are the JSON-RPC channel and its `stderr` is retained as bounded evidence
 *   rather than parsed as protocol. The supervisor owns spawn and termination.
 * - **Inbound (`message`).** Standard output is drained eagerly through Node's `readline`,
 *   so a multi-byte UTF-8 sequence split across two reads is
 *   decoded whole and a final line written without a trailing newline still arrives. Each framed
 *   line is decoded and delivered through the shared {@link dispatchLines} helper — a well-formed
 *   {@link JSONRPCMessage} emits `message`, a malformed line emits `error` (never throws).
 * - **Outbound (`send`).** `send(message)` writes one newline-terminated `JSON.stringify`d line
 *   through the supervisor's `deliver` and awaits its answer, so this promise settles only after the
 *   host reports the line handled rather than the moment the write is queued. The supervisor never
 *   rejects — it answers `false` for a channel that was closed, destroyed, or ended, for a write
 *   that failed, or for one that remained unconfirmed through `delivery`. A call made without a
 *   live child rejects as not connected; a `false` answer from a live child rejects as unable to
 *   deliver. The supervisor does not disclose which cause produced that answer.
 * - **`close()`** ends the child's input and waits up to
 *   {@link import('../constants.js').MCP_STDIO_GRACE} for native exit,
 *   including any pending input flush. Only after that wait does the supervisor terminate a child
 *   that remains alive. Teardown freezes `evidence`, closes the reader, and settles `exit`, then
 *   fires `close` once (idempotent).
 *   A child that exits on input end within the grace receives no termination signal, so it must
 *   end its own child processes on input end; only escalation reaches its process tree.
 *   If an `MCPClient` request `timeout` is shorter than the grace and the close outlasts that
 *   timeout, `disconnect()` rejects with `MCP transport close timed out after <timeout>ms`.
 *   The close keeps running, and a later caller joins it while it remains pending.
 *   A line already framed behind the one being delivered is dropped rather than
 *   emitted onto a transport whose teardown has begun. A `close()` issued while that teardown runs
 *   joins it rather than opening a second one, so it resolves only after `close` has fired, and a
 *   `start()` waits while the previous lifetime has not yet reported `close`, so lifetimes never overlap. A
 *   descendant can retain an inherited stdout pipe after the child exits; the supervisor's `drain`
 *   bound cuts that wait off independently of the input grace. Escalation belongs to the host:
 *   a POSIX host signals the
 *   child's own process group `SIGTERM`, waits the grace window, then `SIGKILL`s through the same
 *   route, so the kill reaches grandchildren rather than orphaning them, while Windows ends the
 *   tree with `taskkill /F /T`, which nothing in the child can intercept.
 * - **Evidence.** `evidence` reports that retained stderr tail off the held child — its live tail
 *   while the child runs, and the value the supervisor froze at that child's terminal moment
 *   afterwards. The reference is held past that moment and replaced only by the next `start()`,
 *   which is what keeps a post-`close()` read stable without a private copy: the frozen value
 *   never moves again, so a detached descendant writing to the inherited stderr after the cutoff
 *   cannot grow it. See {@link StdioClientTransportInterface.evidence} for the readings and the
 *   byte bound.
 * - **Observable.** Owns the `emitter` ({@link MCPMessageTransportEventMap}); the
 *   emitter isolates a listener throw; `error` is a domain event (a transport-level
 *   fault, including the child spawn cause the supervisor surfaces and the notice that this
 *   lifetime's `evidence` was cut off at the `drain` bound), distinct from the emitter's own
 *   listener-error channel.
 *
 * @example
 * ```ts
 * const transport = new StdioClientTransport({ command: 'node', args: ['./server.js'] })
 * const client = new MCPClient({ transport })
 * await client.connect() // start() spawns the child, then modern discovery runs over stdio
 * ```
 */
export class StdioClientTransport implements StdioClientTransportInterface {
	readonly #emitter: Emitter<MCPMessageTransportEventMap>
	readonly #options: StdioClientTransportOptions
	#lifetime: StdioLifetime | undefined

	constructor(options: StdioClientTransportOptions) {
		this.#emitter = new Emitter<MCPMessageTransportEventMap>()
		const { command, args = [], env, delivery = DEFAULT_MCP_DELIVERY } = options
		this.#options = Object.freeze({
			command,
			args,
			...(env === undefined ? {} : { env }),
			delivery,
		})
	}

	get emitter(): EmitterInterface<MCPMessageTransportEventMap> {
		return this.#emitter
	}

	get session(): string | undefined {
		return undefined
	}

	get duplex(): boolean {
		return true
	}

	get evidence(): string | undefined {
		return this.#lifetime?.evidence
	}

	async start(): Promise<void> {
		const previous = this.#lifetime
		if (previous !== undefined && !previous.closed) return previous.opened
		const lifetime = new StdioLifetime(this.#emitter, this.#options, previous)
		this.#lifetime = lifetime
		if (previous !== undefined && !previous.reported) await previous.ended
		lifetime.open()
	}

	/**
	 * Sends one newline-delimited JSON-RPC message to the live child.
	 *
	 * @param message - The message to write to the child's `stdin`
	 * @returns Resolves when the supervisor confirms the write
	 * @throws Thrown with `stdio transport is not connected` when no live child is available before
	 *   the write
	 * @throws Thrown with `stdio transport could not deliver the message` when a live child's write
	 *   resolves `false`
	 */
	async send(message: JSONRPCMessage): Promise<void> {
		const child = this.#lifetime?.child
		if (child === undefined) throw new Error('stdio transport is not connected')
		const delivered = await child.deliver(Buffer.from(`${JSON.stringify(message)}\n`, 'utf8'))
		if (!delivered) throw new Error('stdio transport could not deliver the message')
	}

	async close(): Promise<void> {
		this.#lifetime ??= new StdioLifetime(this.#emitter, this.#options, undefined)
		await this.#lifetime.close()
	}
}
