import type { MCPSessionEntry, MCPSessionStoreInterface } from '../types.js'

/** Owns an in-memory table of negotiated legacy MCP sessions. */
export class MCPSessionStore implements MCPSessionStoreInterface {
	readonly #entries = new Map<string, MCPSessionEntry>()

	/** Reads the session associated with an opaque protocol identifier. */
	get(id: string): MCPSessionEntry | undefined {
		return this.#entries.get(id)
	}

	/** Publishes an entry under the identifier its session owns. */
	set(entry: MCPSessionEntry): void {
		this.#entries.set(entry.session.id, entry)
	}

	/** Removes a session and reports whether its identifier was present. */
	delete(id: string): boolean {
		return this.#entries.delete(id)
	}

	/** Removes every entry last touched at or before the idle cutoff. */
	sweep(cutoff: number): void {
		for (const [id, entry] of this.#entries) {
			if (entry.touched <= cutoff) this.#entries.delete(id)
		}
	}
}
