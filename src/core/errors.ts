/**
 * A Model Context Protocol error preserving its machine-readable numeric code and
 * optional structured context.
 *
 * @remarks
 * {@link MCPClient} throws this error for a remote JSON-RPC `error` response and for a
 * locally detected protocol incompatibility. Local lifecycle and transport conditions such
 * as disconnects and request timeouts remain plain `Error`s. For a remote response, `context`
 * carries the optional `error.data` unchanged and is `undefined` when the peer omitted it.
 * This includes the modern reserved paths: `-32020` carries no context, `-32021` may carry
 * `requiredCapabilities`, and `-32022` carries the peer's `supported` revisions and
 * `requested` revision for negotiation recovery.
 *
 * @example
 * ```ts
 * const error = new MCPError('Unsupported protocol version', -32022, {
 * 	supported: ['2026-07-28'],
 * 	requested: '2024-11-05',
 * })
 * error.code // -32022
 * error.context // { supported: ['2026-07-28'], requested: '2024-11-05' }
 * ```
 */
export class MCPError extends Error {
	override readonly name = 'MCPError'
	readonly code: number
	readonly context: unknown

	/**
	 * Creates an MCP protocol error.
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
 * Determines whether an unknown value is an {@link MCPError}.
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
