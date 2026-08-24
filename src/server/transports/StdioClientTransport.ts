import type { MCPClientTransportEventMap, JSONRPCMessage } from '@src/core'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { ProcessExit } from '@orkestrel/process'
import type { StdioClientTransportInterface, StdioClientTransportOptions } from '../types.js'
import { Process } from '@orkestrel/process/server'
import { PROCESS_GRACE } from '@orkestrel/process'
import { Emitter } from '@orkestrel/emitter'
import { DEFAULT_MCP_DELIVERY } from '../constants.js'
import { dispatchLines } from '../helpers.js'

/**
 * The stdio CLIENT transport for the Model Context Protocol — a
 * {@link StdioClientTransportInterface} that drives a CHILD PROCESS MCP server over
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
 *   line is decoded and delivered through the shared {@link dispatchLines} helper — a well-formed
 *   {@link JSONRPCMessage} emits `message`, a malformed line emits `error` (never throws).
 * - **Outbound (`send`).** `send(message)` writes one newline-terminated `JSON.stringify`d line
 *   through the supervisor's `send` and AWAITS its answer, so this promise settles only after the
 *   host reports the line handled rather than the moment the write is queued. The supervisor never
 *   rejects — it answers `false` for a channel that was closed, destroyed, or ended, for a write
 *   that failed, or for one that remained unconfirmed through `delivery`. A call made without a
 *   live child rejects as not connected; a `false` answer from a live child rejects as unable to
 *   deliver. The supervisor does not disclose which cause produced that answer.
 * - **`close()`** runs the supervisor's bounded termination and teardown, then fires `close` once
 *   (idempotent). That teardown reaches the child's TERMINAL MOMENT, where the supervisor freezes
 *   `evidence`, ends `lines`, and settles `exit` together, so this transport needs no release of
 *   its own to get its line pump back: the stream ends under the pump rather than throwing at it.
 *   A line the supervisor had already framed behind the one being delivered is dropped rather than
 *   emitted onto a transport whose teardown has begun. A `close()` issued while that teardown runs
 *   joins it rather than opening a second one, so it resolves only after `close` has fired, and a
 *   `start()` issued while it runs waits behind the same barrier, so lifetimes never overlap. A
 *   descendant can retain an inherited stdout pipe after the child exits; the supervisor's `drain`
 *   bound cuts that wait off, so this transport's `close()` settles within that bound rather than
 *   on the descendant. The termination itself belongs to the host: a POSIX host signals the
 *   child's own process group `SIGTERM`, waits the grace window, then `SIGKILL`s through the same
 *   route, so the kill reaches grandchildren rather than orphaning them, while Windows ends the
 *   tree with `taskkill /F /T`, which nothing in the child can intercept.
 * - **Evidence.** `evidence` reports that retained stderr tail off the HELD child — its live tail
 *   while the child runs, and the value the supervisor froze at that child's terminal moment
 *   afterwards. The reference is held past that moment and replaced only by the next `start()`,
 *   which is what keeps a post-`close()` read stable without a private copy: the frozen value
 *   never moves again, so a detached descendant writing to the inherited stderr after the cutoff
 *   cannot grow it. See {@link StdioClientTransportInterface.evidence} for the readings and the
 *   byte bound.
 * - **Observable.** Owns the `emitter` ({@link MCPClientTransportEventMap}); the
 *   emitter isolates a listener throw; `error` is a DOMAIN event (a transport-level
 *   fault, including the child spawn cause the supervisor surfaces and the notice that this
 *   lifetime's `evidence` was cut off at the `drain` bound), distinct from the emitter's own
 *   listener-error channel.
 *
 * @example
 * ```ts
 * const transport = new StdioClientTransport({ command: 'node', args: ['./server.js'] })
 * const client = new MCPClient({ transport })
 * await client.connect() // start() spawns the child, then the MCP initialize runs over stdio
 * ```
 */
export class StdioClientTransport implements StdioClientTransportInterface {
	readonly #emitter: Emitter<MCPClientTransportEventMap>
	readonly #command: string
	readonly #args: readonly string[]
	readonly #env: Readonly<Record<string, string>> | undefined
	readonly #delivery: number
	#process: Process | undefined = undefined
	#closing: Promise<void> | undefined = undefined
	#closed = false

	constructor(options: StdioClientTransportOptions) {
		this.#emitter = new Emitter<MCPClientTransportEventMap>()
		this.#command = options.command
		this.#args = options.args ?? []
		this.#env = options.env
		this.#delivery = options.delivery ?? DEFAULT_MCP_DELIVERY
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

	get evidence(): string | undefined {
		// The held child answers every reading: its live tail while it runs (`''` while it has
		// written nothing), and the value the supervisor FROZE at its terminal moment afterwards.
		// The frozen value never moves again, so the ended lifetime's tail stays readable off the
		// child itself and a detached descendant writing to the inherited stderr after the cutoff
		// cannot grow it. The reference is therefore held past the end of the lifetime and released
		// only when `start()` installs a replacement.
		return this.#process?.evidence
	}

	async start(): Promise<void> {
		// A teardown still running owns the ending lifetime until it has reported `close`, so a
		// replacement WAITS on that barrier rather than racing it. This is what makes the ordering
		// rule total rather than usually right: `#closing` is assigned in the same synchronous turn
		// the `close()` or the exit that installed it runs in, and the call that installed it is the
		// only one that clears it, only after it has resolved. No child is therefore ever installed
		// while an older child's teardown is outstanding, so no interleaving can strand a `close`
		// listener on a tail the replacement already replaced.
		// The wait covers EVERY barrier this call meets, not only the first. A `close()` issued
		// while this one was resuming installs a NEWER barrier, and clearing that one would strand
		// the teardown it belongs to: a later `close()` would find no barrier, find this transport
		// already closed, and resolve through a no-op before the running teardown had reported
		// `close`. Waiting that newer barrier out keeps the same guard and leaves nothing behind —
		// a barrier still assigned when this call installs its child is one a later `close()`
		// resolves through as a no-op while that child is live.
		let closing = this.#closing
		while (closing !== undefined) {
			await closing
			if (this.#closing === closing) {
				this.#closing = undefined
				break
			}
			closing = this.#closing
		}
		// Already spawned and still open — a second `start()` (such as through `connect()`)
		// short-circuits (idempotent). An ENDED child stays held for its frozen tail, so the held
		// reference no longer answers whether a lifetime is open; this transport's own closed state
		// does, and a held ended child is exactly what a replacement replaces.
		if (this.#process !== undefined && !this.#closed) return
		this.#closed = false
		const child = new Process({
			command: {
				file: this.#command,
				arguments: [...this.#args],
				...(this.#env === undefined ? {} : { environment: this.#env }),
			},
			workspace: process.cwd(),
			grace: PROCESS_GRACE,
			delivery: this.#delivery,
			writable: true,
		})
		this.#process = child
		child.emitter.on('error', (cause) => this.#emitter.emit('error', cause))
		void child.exit.then((exit) => this.#onExit(child, exit))
		void this.#pump(child)
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
		// A closed lifetime's child is still HELD for its tail, and a tail is not a channel: this
		// transport's own closed state is what says the channel is gone, so a write issued after a
		// `close()` or after the child's own exit reports not-connected here rather than depending
		// on the supervisor to answer for a channel it has already torn down.
		const child = this.#closed ? undefined : this.#process
		if (child === undefined) throw new Error('stdio transport is not connected')
		// The supervisor's `send` never rejects: it ANSWERS `false` when the channel was closed,
		// destroyed, ended, the write failed, or the delivery bound elapsed. Awaiting that answer is
		// what keeps a dead peer from vanishing — an unawaited call resolves this `send` before the
		// line reaches the host. The answer does not disclose which cause produced it.
		const delivered = await child.send(JSON.stringify(message))
		if (!delivered) throw new Error('stdio transport could not deliver the message')
	}

	async close(): Promise<void> {
		// A CLOSED lifetime with no barrier assigned has already reached its terminal moment and
		// reported it, so there is nothing to tear down and nothing to join: return directly. Going
		// through `??=` here would assign the resolved promise an early-returning teardown produces
		// and leave that NO-OP barrier behind, which is not inert — a `start()` a later `close`
		// listener calls waits on every barrier it meets, so it would park on the microtask queue
		// and open its replacement after the emit rather than inside it, and the natural-exit
		// restart this transport documents would stop reaching the listeners after it.
		if (this.#closed && this.#closing === undefined) return
		// Concurrent calls share ONE teardown. A second `close()` that returned early would resolve
		// before this lifetime had reached its terminal moment, and a consumer reading `evidence`
		// off that resolution would find a tail still moving under it. A barrier assigned over a
		// closed lifetime is exactly that case — an explicit teardown still running, or the report
		// barrier a natural exit holds across its `error` — so those still join it here.
		this.#closing ??= this.#teardown()
		await this.#closing
	}

	// Run the supervisor's bounded teardown and report `close` once. That teardown resolves at the
	// child's terminal moment, so `evidence` is frozen and `lines` has ended by the time this
	// resumes. The child's own exit ends the lifetime the same way.
	async #teardown(): Promise<void> {
		if (this.#closed) return
		this.#closed = true
		const child = this.#process
		if (child !== undefined) {
			// The child stays HELD past this point. Its frozen tail is what `evidence` answers for
			// the ended lifetime, and only the next `start()` replaces the reference.
			await child.destroy()
			this.#report(await child.exit)
		}
		this.#emitter.emit('close')
	}

	// Drain the supervisor's newline-framed stdout lines, decoding + delivering every complete line
	// onto this transport's emitter. The stream ENDS at the child's terminal moment rather than
	// throwing there, so this loop needs no release of its own — the supervisor's own teardown is
	// what releases it. A teardown that has begun and a replacement that superseded this child each
	// stop the dispatch before that end: the closed state is what drops a line the supervisor had
	// already framed behind the one being delivered, and peer identity is what keeps a stale
	// iteration from emitting onto a live child.
	async #pump(child: Process): Promise<void> {
		for await (const line of child.lines) {
			if (this.#closed || this.#process !== child) return
			dispatchLines(this.#emitter, [line])
		}
	}

	// The current child process reached its terminal moment — report a cut-off tail, then fire this
	// transport's `close` once. A child an explicit close superseded reports its own exit after
	// `start()` has installed a replacement; peer identity keeps that old exit from reporting on a
	// tail no reader can reach any more or emitting a second close. A teardown already reported
	// this lifetime, so the closed state stops the second report rather than the first.
	#onExit(child: Process, exit: ProcessExit): void {
		if (this.#process !== child) return
		if (this.#closed) return
		this.#closed = true
		// The report below emits SYNCHRONOUSLY, so a listener on that fault channel runs before this
		// lifetime has said it ended, and a `start()` it calls there would install its replacement
		// first: the `close` that followed would then reach every listener over a child the reader
		// can no longer see. A barrier held across the report is what orders those two — the
		// `start()` parks on it and resumes on the microtask queue, after `close` has been delivered
		// — and it is the same barrier `close()` holds across an explicit teardown's own report. A
		// `close()` called from that same listener finds this barrier through `??=` instead of
		// opening a second teardown, and resolves against it as the no-op an ended lifetime makes
		// it, after `close` has fired.
		const barrier = Promise.withResolvers<void>()
		this.#closing ??= barrier.promise
		this.#report(exit)
		// Release and clear before the emit, so a `start()` called from a `close` listener finds no
		// barrier and opens the next lifetime inside that emit — the restart this transport
		// documents on a natural exit. Clear only this lifetime's own barrier: a barrier that is not
		// this one belongs to a teardown still running, and discarding it would let a later
		// `close()` resolve through a no-op before that teardown had reported its own `close`.
		barrier.resolve()
		if (this.#closing === barrier.promise) this.#closing = undefined
		this.#emitter.emit('close')
	}

	// A terminal moment the `drain` bound cut off rather than the child's own stream close leaves
	// `evidence` holding the tail as of that cutoff, and later diagnostics may have existed. Say so
	// on the fault channel, or a consumer reads a cut-off tail as the child's whole output.
	#report(exit: ProcessExit): void {
		if (exit.drained) return
		this.#emitter.emit(
			'error',
			new Error(
				'stdio transport evidence may be incomplete: the child streams stayed open past the supervisor drain bound',
			),
		)
	}
}
