/**
 * A remote Model Context Protocol JSON-RPC error, preserving its machine-readable
 * numeric code and optional structured context.
 *
 * @remarks
 * {@link MCPClient} throws this error only for a remote JSON-RPC `error` response.
 * Local lifecycle and transport conditions such as disconnects and request timeouts
 * remain plain `Error`s. `context` carries the response's optional `error.data`
 * unchanged and is `undefined` when the peer omitted it.
 *
 * @example
 * ```ts
 * const error = new MCPError('Method not found', -32601, { method: 'missing' })
 * error.code // -32601
 * error.context // { method: 'missing' }
 * ```
 */
export class MCPError extends Error {
	override readonly name = 'MCPError'
	readonly code: number
	readonly context: unknown

	/**
	 * Create a remote MCP protocol error.
	 *
	 * @param message - The human-readable JSON-RPC error message
	 * @param code - The machine-readable numeric JSON-RPC error code
	 * @param context - The optional JSON-RPC `error.data` payload
	 */
	constructor(message: string, code: number, context?: unknown) {
		super(message)
		this.code = code
		this.context = context
	}
}

/**
 * Determine whether an unknown value is an {@link MCPError}.
 *
 * @param value - The unknown value to inspect
 * @returns `true` only when the value is an `MCPError`
 *
 * @example
 * ```ts
 * isMCPError(new MCPError('Method not found', -32601)) // true
 * isMCPError(new Error('Method not found')) // false
 * ```
 */
export function isMCPError(value: unknown): value is MCPError {
	try {
		// A revoked Proxy or a hostile prototype can make `instanceof` throw — this guard
		// must stay total, so the check is wrapped rather than left to escape.
		return value instanceof MCPError
	} catch {
		return false
	}
}
