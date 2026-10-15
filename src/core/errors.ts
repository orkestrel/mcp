import { isInstance } from '@orkestrel/contract'

/**
 * Preserves a Model Context Protocol error's machine-readable numeric code and
 * optional structured context.
 *
 * @remarks
 * {@link MCPClient} throws this error for a remote JSON-RPC `error` response, for a locally
 * detected protocol incompatibility, and for a session-bound request refused because the
 * client holds no connection — that one carries `-32600`, so a caller separates "reconnect"
 * from "retry" without reading a message. Local lifecycle and transport conditions that
 * settle a request already in flight, such as a disconnect and a request timeout, remain
 * plain `Error`s. For a remote response, `context`
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
 * @returns True if the value is an `MCPError`; false otherwise
 *
 * @example
 * ```ts
 * isMCPError(new MCPError('Method not found', -32601)) // true
 * isMCPError(new Error('Method not found')) // false
 * ```
 */
export function isMCPError(value: unknown): value is MCPError {
	return isInstance(value, MCPError)
}

/**
 * Distinguishes a completed remote tool call that the peer itself reported as failed.
 *
 * @remarks
 * {@link MCPClient} throws this error when a `tools/call` answer arrives with
 * `isError: true`. Its message is the result's text, or a fallback naming the tool when the
 * result carried none, so an agent's tool registry still isolates it as an ordinary failure.
 * It is not an {@link MCPError}: the peer answered, so no JSON-RPC `error` response and no
 * numeric code exist, and a transport failure or request timeout stays a plain `Error`.
 * It carries no copy of the result; `code` is the one discriminant.
 *
 * @example
 * ```ts
 * const error = new MCPToolError('tool exploded')
 * error.code // 'TOOL'
 * error.message // 'tool exploded'
 * ```
 */
export class MCPToolError extends Error {
	override readonly name = 'MCPToolError'
	readonly code: 'TOOL'

	/**
	 * Creates a remote tool refusal error.
	 *
	 * @param message - The remote tool's error text, or the fallback naming the tool
	 */
	constructor(message: string) {
		super(message)
		this.code = 'TOOL'
	}
}

/**
 * Determines whether an unknown value is an {@link MCPToolError}.
 *
 * @param value - The unknown value to inspect
 * @returns True if the value is an `MCPToolError`; false otherwise
 *
 * @example
 * ```ts
 * isMCPToolError(new MCPToolError('tool exploded')) // true
 * isMCPToolError(new MCPError('Method not found', -32601)) // false
 * isMCPToolError(new Error('tool exploded')) // false
 * ```
 */
export function isMCPToolError(value: unknown): value is MCPToolError {
	return isInstance(value, MCPToolError)
}
