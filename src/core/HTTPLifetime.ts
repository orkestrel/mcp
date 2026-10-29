/** Owns HTTP request cancellation and the protocol accepted during one lifetime. */
export class HTTPLifetime {
	readonly #controller = new AbortController()
	#protocol: string | undefined

	get signal(): AbortSignal {
		return this.#controller.signal
	}

	get protocol(): string | undefined {
		return this.#protocol
	}

	accept(protocol: string): void {
		this.#protocol = protocol
	}

	abort(): void {
		this.#controller.abort()
	}
}
