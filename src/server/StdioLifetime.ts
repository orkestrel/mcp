import type { Interface } from 'node:readline'
import type { MCPMessageTransportEventMap } from '@src/core'
import type { EmitterInterface } from '@orkestrel/emitter'
import type { ProcessExit } from '@orkestrel/process'
import type { StdioClientTransportOptions } from './types.js'
import { createInterface } from 'node:readline'
import { Supervisor } from '@orkestrel/process/server'
import { PROCESS_GRACE } from '@orkestrel/process'
import { DEFAULT_MCP_DELIVERY, MCP_STDIO_GRACE } from './constants.js'
import { dispatchLines } from './helpers.js'

/** Owns one stdio child, its reader, and the ordering of its terminal report. */
export class StdioLifetime {
	readonly #emitter: EmitterInterface<MCPMessageTransportEventMap>
	readonly #options: StdioClientTransportOptions
	readonly #ended = Promise.withResolvers<void>()
	readonly #opened = Promise.withResolvers<void>()
	#predecessor: StdioLifetime | undefined
	#child: Supervisor | undefined
	#reader: Interface | undefined
	#closing: Promise<void> | undefined
	#reported = false

	constructor(
		emitter: EmitterInterface<MCPMessageTransportEventMap>,
		options: StdioClientTransportOptions,
		predecessor: StdioLifetime | undefined,
	) {
		this.#emitter = emitter
		this.#options = options
		this.#predecessor = predecessor
	}

	get evidence(): string | undefined {
		return this.#child?.evidence ?? this.#predecessor?.evidence
	}

	get child(): Supervisor | undefined {
		return this.#closing === undefined ? this.#child : undefined
	}

	get closed(): boolean {
		return this.#closing !== undefined
	}

	get reported(): boolean {
		return this.#reported
	}

	get ended(): Promise<void> {
		return this.#ended.promise
	}

	get opened(): Promise<void> {
		return this.#opened.promise
	}

	open(): void {
		const child = new Supervisor(
			{
				command: {
					file: this.#options.command,
					arguments: [...(this.#options.args ?? [])],
					...(this.#options.env === undefined ? {} : { environment: this.#options.env }),
				},
				workspace: process.cwd(),
				grace: PROCESS_GRACE,
				delivery: this.#options.delivery ?? DEFAULT_MCP_DELIVERY,
				writable: true,
			},
			{
				chunk: () => undefined,
				fault: (cause) => this.#emitter.emit('error', cause),
				close: () => this.#reader?.close(),
				terminal: () => undefined,
				teardown: () => this.#reader?.close(),
			},
		)
		const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
		this.#child = child
		this.#reader = reader
		reader.on('line', (line: string) => {
			if (this.#closing !== undefined) return
			dispatchLines(this.#emitter, [line])
		})
		void child.exit.then((exit) => this.#onExit(exit))
		this.#opened.resolve()
		this.#predecessor = undefined
	}

	close(): Promise<void> {
		if (this.#child === undefined) {
			if (this.#predecessor !== undefined) return this.#predecessor.ended
			if (this.#closing !== undefined) return this.#closing
			this.#closing = this.#ended.promise
			this.#emitter.emit('close')
			this.#reported = true
			this.#ended.resolve()
			return this.#closing
		}
		return (this.#closing ??= this.#teardown())
	}

	async #teardown(): Promise<void> {
		const child = this.#child
		if (child === undefined) return
		const expired = Promise.withResolvers<void>()
		const timer = setTimeout(expired.resolve, MCP_STDIO_GRACE)
		try {
			void child.end()
			await Promise.race([child.ended, expired.promise])
		} finally {
			clearTimeout(timer)
		}
		await child.destroy()
		this.#report(await child.exit)
		this.#emitter.emit('close')
		this.#reported = true
		this.#ended.resolve()
	}

	#onExit(exit: ProcessExit): void {
		if (this.#closing !== undefined) return
		this.#closing = this.#ended.promise
		this.#report(exit)
		this.#reported = true
		this.#ended.resolve()
		this.#emitter.emit('close')
	}

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
