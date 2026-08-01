import type { MCPMethodHandler, MCPMethodManagerInterface } from './types.js'

/**
 * The modern method registry an {@link import('./types.js').MCPServerInterface}
 * dispatches through — a name-keyed store of {@link MCPMethodHandler}s that owns its
 * map rather than exposing one.
 *
 * @remarks
 * - **One seam.** The server registers its built-in modern methods here at construction
 *   and resolves EVERY modern method from here, so a consumer's method and a built-in
 *   are the same kind of thing on the same path.
 * - **Registration is a write, not a merge.** `add` under a name already present
 *   REPLACES it, which is how a consumer overrides a built-in; there is no precedence
 *   rule to remember.
 * - **A narrower contract than a `Map`.** Callers register and resolve; they cannot
 *   iterate, clear, or otherwise reach the server's internal state through it.
 *
 * @example
 * ```ts
 * const methods = new MCPMethodManager()
 * methods.add('tools/list', async (request) => buildJSONRPCResult(request.id ?? null, { tools: [] }))
 * methods.method('tools/list') // the handler
 * methods.method('tools/nope') // undefined → the dispatch branch answers -32601
 * ```
 */
export class MCPMethodManager implements MCPMethodManagerInterface {
	readonly #handlers = new Map<string, MCPMethodHandler>()

	add(name: string, handler: MCPMethodHandler): void {
		this.#handlers.set(name, handler)
	}

	method(name: string): MCPMethodHandler | undefined {
		return this.#handlers.get(name)
	}
}
