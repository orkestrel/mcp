import type { JSONRPCId, JSONRPCResponse, MCPIdentity, MCPServerCapabilities } from './types.js'

/** Owns one legacy handshake and its outstanding request correlations. */
export class MCPLegacySession {
	readonly #handshake = Promise.withResolvers<JSONRPCResponse>()
	readonly #correlations = new Map<JSONRPCId, { readonly method: string }>()
	#claimed = false
	#identity: MCPIdentity | undefined
	#capabilities: MCPServerCapabilities | undefined
	#instructions: string | undefined

	get response(): Promise<JSONRPCResponse> {
		return this.#handshake.promise
	}

	get identity(): MCPIdentity | undefined {
		return this.#identity
	}

	get capabilities(): MCPServerCapabilities | undefined {
		return this.#capabilities
	}

	get instructions(): string | undefined {
		return this.#instructions
	}

	claim(response: JSONRPCResponse): boolean {
		if (this.#claimed) return false
		this.#claimed = true
		this.#handshake.resolve(response)
		return true
	}

	expire(error: unknown): void {
		if (this.#claimed) return
		this.#claimed = true
		this.#handshake.reject(error)
	}

	accept(
		identity: MCPIdentity,
		capabilities: MCPServerCapabilities,
		instructions: string | undefined,
	): void {
		this.#identity = identity
		this.#capabilities = capabilities
		this.#instructions = instructions
	}

	correlate(id: JSONRPCId, method: string): void {
		this.#correlations.set(id, { method })
	}

	correlation(id: JSONRPCId): { readonly method: string } | undefined {
		return this.#correlations.get(id)
	}

	forget(id: JSONRPCId): void {
		this.#correlations.delete(id)
	}
}
