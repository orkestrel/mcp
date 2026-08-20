import type {
	MCPClientTransportEventMap,
	MCPClientTransportInterface,
	JSONRPCMessage,
} from '@src/core'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { StdioClientTransportOptions } from '../types.js'
import { Process } from '@orkestrel/process/server'
import { PROCESS_GRACE } from '@orkestrel/process'
import { Emitter } from '@orkestrel/emitter'
import { dispatchLines } from '../helpers.js'

/**
 * The stdio CLIENT transport for the Model Context Protocol — a
 * {@link MCPClientTransportInterface} that drives a CHILD PROCESS MCP server over
 * newline-delimited JSON-RPC on `stdin`/`stdout`, the stdio sibling of {@link
 * import('./HTTPClientTransport.js').HTTPClientTransport} and {@link
 * import('./WebSocketClientTransport.js').WebSocketClientTransport}.
 *
 * @remarks
 * - **Composes `@orkestrel/process`.** `start()` builds one supervised
 *   {@link import('@orkestrel/process/server').Process} with `writable: true`, so the child's
 *   `stdin`/`stdout` are the JSON-RPC channel and its `stderr` is retained as bounded evidence
 *   rather than parsed as protocol. The supervisor owns spawn, framing, and termination.
 * - **Inbound (`message`).** Standard output is drained eagerly through the supervisor's
 *   `readline`-framed `lines` iterable, so a multi-byte UTF-8 sequence split across two reads is
 *   decoded whole and a final line written without a trailing newline still arrives. Each framed
 *   line is decoded and delivered via the shared {@link dispatchLines} helper — a well-formed
 *   {@link JSONRPCMessage} emits `message`, a malformed line emits `error` (never throws).
 * - **Outbound (`send`).** `send(message)` writes one newline-terminated `JSON.stringify`d line
 *   through the supervisor's `send` and AWAITS its answer, so this promise settles only after the
 *   host reports the line handled rather than the moment the write is queued. The supervisor never
 *   rejects — it answers `false` for a channel that was closed, destroyed, or ended, and for a write
 *   that failed — so a `false` answer REJECTS here with the same not-connected error a transport
 *   that was never started raises. A dead peer surfaces at the caller instead of vanishing.
 * - **`close()`** releases this transport's line pump without waiting for the child's stdout
 *   iterator, then runs the supervisor's bounded `SIGTERM` → grace → `SIGKILL` group-kill and
 *   teardown before firing `close` once (idempotent). A descendant can retain an inherited stdout
 *   pipe after the child exits; the pump's release barrier keeps that substrate limit from keeping
 *   this transport's `close()` pending. On a POSIX host the child leads its own process group, so
 *   the group-kill reaches its grandchildren rather than orphaning them.
 * - **Observable.** Owns the `emitter` ({@link MCPClientTransportEventMap}); the
 *   emitter isolates a listener throw; `error` is a DOMAIN event (a transport-level
 *   fault, including the child spawn cause the supervisor surfaces), distinct from the emitter's
 *   own listener-error channel.
 *
 * @example
 * ```ts
 * const transport = new StdioClientTransport({ command: 'node', args: ['./server.js'] })
 * const client = new MCPClient({ transport })
 * await client.connect() // start() spawns the child, then the MCP initialize runs over stdio
 * ```
 */
export class StdioClientTransport implements MCPClientTransportInterface {
	readonly #emitter: Emitter<MCPClientTransportEventMap>
	readonly #command: string
	readonly #args: readonly string[]
	readonly #env: Readonly<Record<string, string>> | undefined
	#process: Process | undefined = undefined
	#release = Promise.withResolvers<void>()
	#pumping: Promise<void> = Promise.resolve()
	#closed = false

	constructor(options: StdioClientTransportOptions) {
		this.#emitter = new Emitter<MCPClientTransportEventMap>()
		this.#command = options.command
		this.#args = options.args ?? []
		this.#env = options.env
	}

	get emitter(): EmitterInterface<MCPClientTransportEventMap> {
		return this.#emitter
	}

	get session(): string | undefined {
		return undefined
	}

	get duplex(): boolean {
		// A spawned child's stdin stays writable for the process's life, so a client frame
		// reaches the peer at any moment — stdio is the transport MCP defines cancellation on.
		return true
	}

	async start(): Promise<void> {
		// Already spawned — a second `start()` (e.g. via `connect()`) short-circuits (idempotent).
		if (this.#process !== undefined) return
		this.#closed = false
		this.#release = Promise.withResolvers<void>()
		const child = new Process({
			command: {
				file: this.#command,
				arguments: [...this.#args],
				...(this.#env === undefined ? {} : { environment: this.#env }),
			},
			workspace: process.cwd(),
			grace: PROCESS_GRACE,
			writable: true,
		})
		this.#process = child
		child.emitter.on('error', (cause) => this.#emitter.emit('error', cause))
		void child.exit.then(() => this.#onExit(child))
		this.#pumping = this.#pump(child, this.#release.promise)
	}

	async send(message: JSONRPCMessage): Promise<void> {
		const child = this.#process
		// The supervisor's `send` never rejects: it ANSWERS `false` when the channel was closed,
		// destroyed, ended, or the write failed. Awaiting that answer is what keeps a dead peer from
		// vanishing — an unawaited call resolves this `send` before the line reaches the host.
		const delivered = child === undefined ? false : await child.send(JSON.stringify(message))
		if (!delivered) throw new Error('stdio transport is not connected')
	}

	async close(): Promise<void> {
		if (this.#closed) return
		this.#closed = true
		const child = this.#process
		const pumping = this.#pumping
		this.#release.resolve()
		this.#process = undefined
		if (child !== undefined) await child.destroy()
		await pumping
		this.#emitter.emit('close')
	}

	// Drain the supervisor's newline-framed stdout lines, decoding + delivering every complete line
	// onto this transport's emitter. A child an explicit close or a replacement superseded stops
	// dispatching: peer identity keeps a stale iteration from emitting onto the live child.
	async #pump(child: Process, release: Promise<void>): Promise<void> {
		const iterator = child.lines[Symbol.asyncIterator]()
		while (true) {
			const next = await Promise.race([iterator.next(), release])
			if (next === undefined || next.done) return
			if (this.#process !== child) return
			dispatchLines(this.#emitter, [next.value])
		}
	}

	// The current child process exited — fire this transport's `close` once. A child an explicit
	// close superseded reports its own exit after `start()` has installed a replacement; peer
	// identity keeps that old exit from clearing the live child or emitting a second close.
	#onExit(child: Process): void {
		if (this.#closed || this.#process !== child) return
		this.#closed = true
		this.#process = undefined
		this.#emitter.emit('close')
	}
}
