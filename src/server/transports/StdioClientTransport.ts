import type { ClientTransportEventMap, ClientTransportInterface, JSONRPCMessage } from '@src/core'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { StdioClientTransportOptions } from '../types.js'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { spawn } from 'node:child_process'
import { Emitter } from '@orkestrel/emitter'
import { dispatchLines, extractLines } from '../helpers.js'

/**
 * The stdio CLIENT transport for the Model Context Protocol — a
 * {@link ClientTransportInterface} that drives a CHILD PROCESS MCP server over
 * newline-delimited JSON-RPC on `stdin`/`stdout`, the stdio sibling of {@link
 * import('./HTTPClientTransport.js').HTTPClientTransport} and {@link
 * import('./WebSocketClientTransport.js').WebSocketClientTransport}.
 *
 * @remarks
 * - **Spawns the server.** `start()` runs `node:child_process`'s `spawn(options.command,
 *   options.args, { env: options.env, stdio: ['pipe', 'pipe', 'inherit'] })` — the
 *   child's `stdin`/`stdout` are piped for the JSON-RPC channel, its `stderr` inherits
 *   the parent's (diagnostics pass through, never parsed as protocol).
 * - **Inbound (`message`).** Each `stdout` chunk is folded through the shared
 *   {@link extractLines} line-framing helper (buffering a partial trailing line
 *   across reads); every complete line is decoded and delivered via the shared
 *   {@link dispatchLines} helper — a well-formed {@link JSONRPCMessage} emits
 *   `message`, a malformed line emits `error` (§14, never throws). The child's
 *   `close` bridges to this transport's `close`.
 * - **Outbound (`send`).** `send(message | messages)` writes ONE newline-terminated
 *   `JSON.stringify`d line per message to the child's `stdin`.
 * - **`close()`** kills the child process and fires `close` (idempotent).
 * - **Observable (§13).** Owns the `emitter` ({@link ClientTransportEventMap}); the
 *   emitter isolates a listener throw; `error` is a DOMAIN event (a transport-level
 *   fault), distinct from the emitter's own listener-error channel.
 *
 * @example
 * ```ts
 * const transport = new StdioClientTransport({ command: 'node', args: ['./server.js'] })
 * const client = new MCPClient({ transport })
 * await client.connect() // start() spawns the child, then the MCP initialize runs over stdio
 * ```
 */
export class StdioClientTransport implements ClientTransportInterface {
	readonly #emitter: Emitter<ClientTransportEventMap>
	readonly #command: string
	readonly #args: readonly string[]
	readonly #env: Readonly<Record<string, string>> | undefined
	#child: ChildProcessByStdio<Writable, Readable, null> | undefined = undefined
	#buffer = ''
	#closed = false

	constructor(options: StdioClientTransportOptions) {
		this.#emitter = new Emitter<ClientTransportEventMap>()
		this.#command = options.command
		this.#args = options.args ?? []
		this.#env = options.env
	}

	get emitter(): EmitterInterface<ClientTransportEventMap> {
		return this.#emitter
	}

	get session(): string | undefined {
		return undefined
	}

	async start(): Promise<void> {
		// Already spawned — a second `start()` (e.g. via `connect()`) short-circuits (idempotent).
		if (this.#child !== undefined) return
		this.#closed = false
		this.#buffer = ''
		const child = spawn(this.#command, [...this.#args], {
			env: this.#env,
			stdio: ['pipe', 'pipe', 'inherit'],
		})
		this.#child = child
		child.stdout.on('data', (chunk: Buffer | string) => this.#receive(chunk.toString()))
		child.on('close', () => this.#onClose())
		child.on('error', (error) => this.#emitter.emit('error', error))
	}

	async send(message: JSONRPCMessage | readonly JSONRPCMessage[]): Promise<void> {
		const child = this.#child
		if (child === undefined) throw new Error('stdio transport is not connected')
		const messages = Array.isArray(message) ? message : [message]
		for (const one of messages) child.stdin.write(`${JSON.stringify(one)}\n`)
	}

	async close(): Promise<void> {
		if (this.#closed) return
		this.#closed = true
		const child = this.#child
		this.#child = undefined
		if (child !== undefined) child.kill()
		this.#emitter.emit('close')
	}

	// Buffer a raw stdout chunk through the shared line-framing helper, then decode + deliver
	// every complete line onto this transport's emitter (a partial trailing line carries
	// forward to the next chunk).
	#receive(chunk: string): void {
		const { lines, remainder } = extractLines(this.#buffer, chunk)
		this.#buffer = remainder
		dispatchLines(this.#emitter, lines)
	}

	// The child process closed — fire this transport's `close` once. A `close()` call already
	// flipped `#closed`, so a child-driven close after an explicit one does not double-emit.
	#onClose(): void {
		if (this.#closed) return
		this.#closed = true
		this.#child = undefined
		this.#emitter.emit('close')
	}
}
