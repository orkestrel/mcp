import type { JSONRPCMessage, JSONRPCRequest, JSONRPCResponse } from './types.js'
import { isNumber, isRecord, isString, isUndefined } from '@orkestrel/contract'

// AGENTS §14: every guard here is a TOTAL function over the already-`JSON.parse`d
// value — adversarial input returns `false`, never throws. The raw-string
// `JSON.parse` (which CAN throw) happens in `MCPServer.handle` inside a try/catch;
// these guards only ever see a parsed `unknown`. Each is a flat structural test on
// `isRecord` + field checks (no user callbacks), so totality is immediate.

/**
 * Determine whether a value is a valid JSON-RPC REQUEST `id` — a string, a number,
 * or absent.
 *
 * @remarks
 * A request id is a string, a number, or `undefined` (its ABSENCE marks a
 * NOTIFICATION). `null` is NOT a valid request id — it is valid only on a RESPONSE.
 * Total (§14): any other input returns `false`.
 *
 * @param value - The already-parsed value to test
 * @returns `true` when `value` is a string, a number, or `undefined`
 *
 * @example
 * ```ts
 * isRequestId(1)         // true
 * isRequestId('abc')     // true
 * isRequestId(undefined) // true — a notification
 * isRequestId(null)      // false — valid only on a response
 * ```
 */
export function isRequestId(value: unknown): value is string | number | undefined {
	return isUndefined(value) || isString(value) || isNumber(value)
}

/**
 * Determine whether a parsed value is a {@link JSONRPCRequest}.
 *
 * @remarks
 * A request is a record with `jsonrpc === '2.0'` and a string `method`. `id`, when
 * present, must be a string or number; its ABSENCE is valid — that marks a
 * NOTIFICATION (a fire-and-forget request that yields no response). `params`, when
 * present, must be a record. Total (§14): any other input returns `false`.
 *
 * @param value - The already-parsed value to test
 * @returns `true` when `value` is a valid JSON-RPC request
 *
 * @example
 * ```ts
 * isJSONRPCRequest({ jsonrpc: '2.0', method: 'ping', id: 1 }) // true
 * isJSONRPCRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }) // true — a notification
 * isJSONRPCRequest({ jsonrpc: '1.0', method: 'ping' }) // false
 * ```
 */
export function isJSONRPCRequest(value: unknown): value is JSONRPCRequest {
	if (!isRecord(value)) {
		return false
	}
	if (value['jsonrpc'] !== '2.0' || !isString(value['method'])) {
		return false
	}
	if (!isRequestId(value['id'])) {
		return false
	}
	const params = value['params']
	return isUndefined(params) || isRecord(params)
}

/**
 * Determine whether a parsed value is a {@link JSONRPCResponse}.
 *
 * @remarks
 * A response is a record with `jsonrpc === '2.0'`, an `id` that is a string,
 * number, or `null`, and EXACTLY ONE of a `result` (any value, including
 * `undefined`'s absence) or an `error` (a record with a numeric `code` and string
 * `message`). Total (§14).
 *
 * @param value - The already-parsed value to test
 * @returns `true` when `value` is a valid JSON-RPC response
 */
export function isJSONRPCResponse(value: unknown): value is JSONRPCResponse {
	if (!isRecord(value)) {
		return false
	}
	if (value['jsonrpc'] !== '2.0') {
		return false
	}
	const id = value['id']
	if (id !== null && !isString(id) && !isNumber(id)) {
		return false
	}
	const hasResult = Object.hasOwn(value, 'result')
	const error = value['error']
	const hasError = !isUndefined(error)
	// Exactly one of result / error — never both, never neither.
	if (hasResult === hasError) {
		return false
	}
	if (hasError) {
		return isRecord(error) && isNumber(error['code']) && isString(error['message'])
	}
	return true
}

/**
 * Determine whether a parsed value is a {@link JSONRPCMessage} — a request or a
 * response.
 *
 * @remarks
 * The union of {@link isJSONRPCRequest} and {@link isJSONRPCResponse}. Total (§14).
 *
 * @param value - The already-parsed value to test
 * @returns `true` when `value` is a valid JSON-RPC request or response
 */
export function isJSONRPCMessage(value: unknown): value is JSONRPCMessage {
	return isJSONRPCRequest(value) || isJSONRPCResponse(value)
}

/**
 * Determine whether a parsed value is an MCP `initialize` request — a
 * {@link JSONRPCRequest} whose `method` is `'initialize'`.
 *
 * @param value - The already-parsed value to test
 * @returns `true` when `value` is a valid `initialize` request
 *
 * @example
 * ```ts
 * isInitializeRequest({ jsonrpc: '2.0', method: 'initialize', id: 1 }) // true
 * isInitializeRequest({ jsonrpc: '2.0', method: 'ping', id: 1 }) // false
 * ```
 */
export function isInitializeRequest(value: unknown): value is JSONRPCRequest {
	return isJSONRPCRequest(value) && value.method === 'initialize'
}
