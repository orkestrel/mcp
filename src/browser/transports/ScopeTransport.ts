import type { ScopeInterface, ScopeTransportInterface } from '../types.js'

/** Adapts a scope's implicit channel to replaceable MCP transport callbacks. */
export class ScopeTransport implements ScopeTransportInterface {
	readonly #scope: ScopeInterface
	#message: ((message: string) => void) | undefined
	#closure: (() => void) | undefined

	constructor(scope: ScopeInterface) {
		this.#scope = scope
	}

	readonly send = (message: string): void => {
		this.#scope.postMessage(message)
	}

	readonly listen = (handler: (message: string) => void): void => {
		this.#message = handler
	}

	readonly closed = (handler: () => void): void => {
		this.#closure = handler
	}

	readonly close = (): void => {
		const handler = this.#closure
		handler?.()
	}

	deliver(message: string): void {
		const handler = this.#message
		handler?.(message)
	}
}
