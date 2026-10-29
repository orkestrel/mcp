import type { MCPMessageTransportInterface, MCPModernVersion } from './types.js'

/** Owns one negotiation and the close still owed for the transport it opened. */
export class MCPConnection {
	readonly #transport: MCPMessageTransportInterface
	readonly #negotiation: Promise<void>
	readonly #closings = new Set<Promise<void>>()
	#version: MCPModernVersion | undefined
	#settled = false
	#superseded = false
	#claimed = false
	#closed = false

	constructor(
		transport: MCPMessageTransportInterface,
		negotiate: (connection: MCPConnection) => Promise<void>,
	) {
		this.#transport = transport
		this.#negotiation = Promise.resolve().then(() => negotiate(this))
		void this.#negotiation.then(
			() => this.#settle(),
			() => this.#settle(),
		)
	}

	get negotiation(): Promise<void> {
		return this.#negotiation
	}

	get version(): MCPModernVersion | undefined {
		return this.#version
	}

	get connected(): boolean {
		return this.#version !== undefined
	}

	get settled(): boolean {
		return this.#settled
	}

	get superseded(): boolean {
		return this.#superseded
	}

	get owed(): boolean {
		return this.#claimed && !this.#closed
	}

	claim(): void {
		this.#claimed = true
	}

	accept(version: MCPModernVersion): void {
		this.#version = version
	}

	supersede(): void {
		this.#superseded = true
		this.#version = undefined
	}

	release(): void {
		this.supersede()
		this.#closed = true
	}

	async close(): Promise<void> {
		const [running] = this.#closings
		if (running !== undefined) return await running
		const closing = this.#transport.close()
		this.#closings.add(closing)
		try {
			await closing
			this.#closed = true
		} finally {
			this.#closings.delete(closing)
		}
	}

	#settle(): void {
		this.#settled = true
	}
}
