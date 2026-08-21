import type { MCPClientTransportEventMap, JSONRPCMessage } from '@src/core'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { StdioClientTransportInterface, StdioClientTransportOptions } from '../types.js'
import { Process } from '@orkestrel/process/server'
import { PROCESS_GRACE } from '@orkestrel/process'
import { Emitter } from '@orkestrel/emitter'
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
 *   rejects — it answers `false` for a channel that was closed, destroyed, or ended, and for a write
 *   that failed — so a `false` answer REJECTS here with the same not-connected error a transport
 *   that was never started raises. A dead peer surfaces at the caller instead of vanishing.
 * - **`close()`** releases this transport's line pump without waiting for the child's stdout
 *   iterator, then runs the supervisor's bounded termination and teardown, captures this
 *   lifetime's stderr tail, and fires `close` once (idempotent). A line the supervisor had already
 *   framed behind the one being delivered is dropped rather than emitted onto a transport whose
 *   teardown has begun. A `close()` issued while that teardown runs joins it rather than opening a
 *   second one, so it resolves only after the tail is captured and `close` has fired, and a
 *   `start()` issued while it runs waits behind the same barrier, so lifetimes never overlap. A
 *   descendant can retain an inherited stdout pipe after the child exits; the
 *   pump's release barrier keeps that substrate limit from keeping this transport's `close()`
 *   pending. The termination itself belongs to the host: a POSIX host signals the child's own
 *   process group `SIGTERM`, waits the grace window, then `SIGKILL`s through the same route, so
 *   the kill reaches grandchildren rather than orphaning them, while Windows ends the tree with
 *   `taskkill /F /T`, which nothing in the child can intercept.
 * - **Evidence.** `evidence` reports that retained stderr tail — the live one while a child is
 *   held, and the value captured at the child's end afterwards, cleared by the next `start()`.
 *   The capture is what keeps a post-`close()` read stable, because a detached descendant
 *   holding the child's inherited stderr can still grow the supervisor's tail after
 *   `destroy()` resolves. See {@link StdioClientTransportInterface.evidence} for the readings
 *   and the byte bound.
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
export class StdioClientTransport implements StdioClientTransportInterface {
	readonly #emitter: Emitter<MCPClientTransportEventMap>
	readonly #command: string
	readonly #args: readonly string[]
	readonly #env: Readonly<Record<string, string>> | undefined
	#process: Process | undefined = undefined
	#evidence: string | undefined = undefined
	#closing: Promise<void> | undefined = undefined
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

	get evidence(): string | undefined {
		// A held child answers its own live tail (`''` while it has written nothing). Once that
		// child has ended, the value captured at its end answers instead, and the supervisor is
		// never re-read: a detached descendant holding the inherited stderr can still grow the
		// supervisor's tail after `destroy()` resolves, which would make a late read report bytes
		// the closed lifetime never had.
		return this.#process?.evidence ?? this.#evidence
	}

	async start(): Promise<void> {
		// A teardown still running owns the ending lifetime until its tail is captured, so a
		// replacement WAITS on that barrier rather than racing it. This is what makes the capture
		// rule total rather than usually right: `#closing` is assigned in the same synchronous turn
		// `close()` is called in, and only this method clears it, only after it has resolved. No
		// child is therefore ever installed while an older child's capture is outstanding, so no
		// interleaving can land an older lifetime's tail after a newer lifetime's.
		const closing = this.#closing
		if (closing !== undefined) await closing
		// Clear only the barrier this call waited on. A `close()` issued while an EARLIER `start()`
		// was resuming installs a NEWER barrier, and clearing that one would strand the teardown it
		// belongs to: a later `close()` would find no barrier, find this transport already closed,
		// and resolve through a no-op before the running teardown had captured its tail.
		if (this.#closing === closing) this.#closing = undefined
		// Already spawned — a second `start()` (such as through `connect()`) short-circuits (idempotent).
		if (this.#process !== undefined) return
		// A new lifetime opens with no evidence of its own: the ended child's tail belongs to the
		// `close` listener that fired before this respawn, never to the child about to run.
		this.#evidence = undefined
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
		// Concurrent calls share ONE teardown. A second `close()` that returned early would resolve
		// before this lifetime's tail was captured, and a consumer reading `evidence` off that
		// resolution would find the absent value for a child that ran.
		this.#closing ??= this.#teardown()
		await this.#closing
	}

	// Release the line pump, run the supervisor's bounded teardown, capture this lifetime's tail,
	// and report `close` once. The child's own exit ends the lifetime the same way, so a teardown
	// that finds it already ended leaves that capture alone.
	async #teardown(): Promise<void> {
		if (this.#closed) return
		this.#closed = true
		const child = this.#process
		const pumping = this.#pumping
		this.#release.resolve()
		if (child !== undefined) {
			await child.destroy()
			// Capture at the teardown barrier, before this transport reports `close`: what the
			// supervisor holds here is this lifetime's tail, and bytes a descendant writes later
			// must not join it.
			this.#evidence = child.evidence
		}
		// The held child answers the getter until its capture lands, so a read taken during the
		// teardown reports this lifetime's own live tail rather than falling absent inside it.
		this.#process = undefined
		await pumping
		this.#emitter.emit('close')
	}

	// Drain the supervisor's newline-framed stdout lines, decoding + delivering every complete line
	// onto this transport's emitter. A teardown that has begun and a replacement that superseded
	// this child each stop the dispatch.
	async #pump(child: Process, release: Promise<void>): Promise<void> {
		const iterator = child.lines[Symbol.asyncIterator]()
		while (true) {
			const next = await Promise.race([iterator.next(), release])
			if (next === undefined || next.done) return
			// The release does NOT win this race against a line the supervisor already framed: that
			// read answers from its queue with a resolved promise, and it is the earlier entry. The
			// closed state is therefore what stops the pump, and peer identity is what keeps a stale
			// iteration from emitting onto a live child.
			if (this.#closed || this.#process !== child) return
			dispatchLines(this.#emitter, [next.value])
		}
	}

	// The current child process exited — fire this transport's `close` once. A child an explicit
	// close superseded reports its own exit after `start()` has installed a replacement; peer
	// identity keeps that old exit from clearing the live child or emitting a second close.
	#onExit(child: Process): void {
		if (this.#closed || this.#process !== child) return
		this.#closed = true
		// Capture while this child is still the held one — the identity guard above is what keeps a
		// superseded child's late exit from writing its tail over the live lifetime's.
		this.#evidence = child.evidence
		this.#process = undefined
		this.#emitter.emit('close')
	}
}
