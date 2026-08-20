import type { JSONValue } from '@orkestrel/contract'
import type { ToolResult } from '@orkestrel/tool'
import type { MCPJSONLimitOptions } from './types.js'
import { attempt, cloneJSONValue, isRecord, isString } from '@orkestrel/contract'
import { serializeJSON } from './helpers.js'

/**
 * Snapshots one bounded exact JSON value together with its canonical wire serialization.
 *
 * The returned value is an owned, deeply frozen graph reconstructed from the canonical text;
 * the frozen tuple shares no mutable structure with the input. Invalid exact-JSON shapes,
 * hostile reflection, serialization failures, and values outside the byte, key, or depth limits
 * return `undefined`.
 *
 * @param value - The unknown value to snapshot
 * @param limits - The canonical serialization byte, key, and depth bounds
 * @returns A frozen owned value/text tuple, or `undefined` when the value cannot be bounded
 *
 * @example
 * ```ts
 * import { snapshotJSON } from '@orkestrel/mcp'
 *
 * snapshotJSON({ beta: 2, alpha: 1 }, { bytes: 64, keys: 2, depth: 1 })
 * // [{ alpha: 1, beta: 2 }, '{"alpha":1,"beta":2}']
 * ```
 */
export function snapshotJSON(
	value: unknown,
	limits: MCPJSONLimitOptions,
): readonly [value: JSONValue, text: string] | undefined {
	const text = serializeJSON(value, limits)
	if (text === undefined) return undefined
	const parsed = attempt((): unknown => JSON.parse(text))
	if (!parsed.success) return undefined
	const owned = attempt(() => cloneJSONValue(parsed.value))
	if (!owned.success) return undefined
	const snapshot: [value: JSONValue, text: string] = [owned.value, text]
	return Object.freeze(snapshot)
}

/**
 * Snapshots one exact Tool result and the canonical wire text of a defined success value.
 *
 * A success must have exactly the own enumerable data properties `id`, `name`,
 * `success: true`, and `value`. A failure must instead have exactly `id`, `name`, `success: false`, and a string
 * `error`. The returned result and tuple are frozen. Only a defined success value crosses the
 * bounded JSON ownership seam; it becomes an owned deeply frozen value and receives canonical
 * text. Value-less successes and failures pair with `undefined` text. Non-records, symbol keys,
 * accessors, hidden or extra properties, malformed discriminants or fields, hostile reflection,
 * and unbounded defined success values return `undefined`.
 *
 * @param value - The unknown Tool result candidate to snapshot
 * @param limits - The byte, key, and depth bounds for a defined successful value
 * @returns A frozen owned result/text tuple, or `undefined` when the result is malformed
 *
 * @example
 * ```ts
 * import { snapshotToolResult } from '@orkestrel/mcp'
 *
 * snapshotToolResult(
 * 	{ id: '1', name: 'search', success: true, value: { count: 1 } },
 * 	{ bytes: 64, keys: 1, depth: 1 },
 * )
 * // [{ id: '1', name: 'search', success: true, value: { count: 1 } }, '{"count":1}']
 * ```
 */
export function snapshotToolResult(
	value: unknown,
	limits: MCPJSONLimitOptions,
): readonly [result: ToolResult, text: string | undefined] | undefined {
	const captured = attempt(() => {
		if (!isRecord(value)) return undefined
		const names = Reflect.ownKeys(value)
		const descriptors = new Map<string, PropertyDescriptor>()
		for (const name of names) {
			if (!isString(name)) return undefined
			const descriptor = Reflect.getOwnPropertyDescriptor(value, name)
			if (
				descriptor === undefined ||
				descriptor.enumerable !== true ||
				!Object.hasOwn(descriptor, 'value')
			)
				return undefined
			descriptors.set(name, descriptor)
		}
		const id = descriptors.get('id')?.value
		const name = descriptors.get('name')?.value
		const success = descriptors.get('success')?.value
		if (!isString(id) || !isString(name) || (success !== true && success !== false)) {
			return undefined
		}
		if (success) {
			if (
				descriptors.size !== 4 ||
				!descriptors.has('id') ||
				!descriptors.has('name') ||
				!descriptors.has('success') ||
				!descriptors.has('value')
			)
				return undefined
			const resultValue = descriptors.get('value')?.value
			if (resultValue === undefined) {
				const result: ToolResult = Object.freeze({ id, name, success: true, value: undefined })
				const snapshot: [result: ToolResult, text: undefined] = [result, undefined]
				return Object.freeze(snapshot)
			}
			const owned = snapshotJSON(resultValue, limits)
			if (owned === undefined) return undefined
			const result: ToolResult = Object.freeze({ id, name, success: true, value: owned[0] })
			const snapshot: [result: ToolResult, text: string] = [result, owned[1]]
			return Object.freeze(snapshot)
		}
		if (
			descriptors.size !== 4 ||
			!descriptors.has('id') ||
			!descriptors.has('name') ||
			!descriptors.has('success') ||
			!descriptors.has('error')
		)
			return undefined
		const error = descriptors.get('error')?.value
		if (!isString(error)) return undefined
		const result: ToolResult = Object.freeze({ id, name, success: false, error })
		const snapshot: [result: ToolResult, text: undefined] = [result, undefined]
		return Object.freeze(snapshot)
	})
	return captured.success ? captured.value : undefined
}
