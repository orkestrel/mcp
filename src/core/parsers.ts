import type { JSONRPCMessage } from './types.js'
import { isJSONRPCMessage } from './validators.js'

/**
 * Narrow an already-parsed value to a {@link JSONRPCMessage}, or `undefined` when
 * it is not one.
 *
 * @remarks
 * Total (§14) — a non-message returns `undefined`, never throws. The input must
 * ALREADY be `JSON.parse`d: the raw-string parse (which can throw on malformed
 * JSON) happens in `MCPServer.handle` inside a try/catch that maps a parse failure
 * to a `-32700` response. Sound with {@link isJSONRPCMessage}: a guard-valid input
 * is returned unchanged, and every non-`undefined` output satisfies the guard.
 *
 * @param value - The already-parsed value to narrow
 * @returns The value as a {@link JSONRPCMessage}, or `undefined`
 *
 * @example
 * ```ts
 * parseJSONRPCMessage({ jsonrpc: '2.0', method: 'ping', id: 1 }) // the request
 * parseJSONRPCMessage({ method: 'ping' }) // undefined — missing jsonrpc
 * ```
 */
export function parseJSONRPCMessage(value: unknown): JSONRPCMessage | undefined {
	return isJSONRPCMessage(value) ? value : undefined
}
