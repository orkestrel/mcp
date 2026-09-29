import type { WebMCPDocument, WebMCPRegistryInterface, WebMCPToolEvent } from './types.js'
import { isFunction, isString, objectOf } from '@orkestrel/contract'

// The browser face's guards. Both narrow a FOREIGN surface no TypeScript library declares, so
// each enforces the published WebMCP contract and no more: the operations the bridge calls and
// the subscription it registers, each read as the IDL declares it and nothing read beyond
// that. Both are built from `@orkestrel/contract`'s `objectOf`, which is the combinator this
// case needs and the reason neither guard hand-rolls a read loop: it admits unknown members,
// reads each declared member through `Reflect.get` so a prototype-carried operation satisfies
// the shape, refuses arrays and primitives, and answers `false` on a hostile read instead of
// throwing. Neither uses an exact-record guard. A `Document` and a `ModelContext` are platform
// class instances whose members arrive through a prototype chain, and an exact-record guard
// refuses exactly those — it would fail closed on every valid implementation.

/**
 * Determines whether an unknown value is a WebMCP tool registry.
 *
 * @remarks
 * Reads the members the bridge dereferences — the IDL's `registerTool`, `getTools`, and
 * `executeTool` operations, plus the `EventTarget` pair the `toolchange` subscription needs —
 * and nothing else. A registry carrying extra members is still a registry, and a user agent's
 * own implementation reaches every one of these through its prototype.
 *
 * @param value - The unknown value to inspect
 * @returns True if the value exposes every WebMCP registry operation; false otherwise
 *
 * @example
 * ```ts
 * isWebMCPRegistry({}) // false
 * ```
 */
export function isWebMCPRegistry(value: unknown): value is WebMCPRegistryInterface {
	return objectOf({
		registerTool: isFunction,
		getTools: isFunction,
		executeTool: isFunction,
		addEventListener: isFunction,
		removeEventListener: isFunction,
	})(value)
}

/**
 * Determines whether an unknown value is a document exposing the WebMCP tool registry.
 *
 * @remarks
 * This is the feature detection {@link import('./factories.js').createModelContext} performs,
 * published so a consumer can run it before deciding to build a bridge at all. It reads
 * `modelContext` and checks it with {@link isWebMCPRegistry}; it asserts nothing about the rest
 * of a `Document`, because that member is the whole of what the bridge needs.
 *
 * @param value - The unknown value to inspect
 * @returns True if the value carries a WebMCP registry; false otherwise
 *
 * @example
 * ```ts
 * isWebMCPDocument(globalThis.document) // false in a browser that ships no WebMCP
 * ```
 */
export function isWebMCPDocument(value: unknown): value is WebMCPDocument {
	return objectOf({ modelContext: isWebMCPRegistry })(value)
}

/**
 * Determines whether an unknown value is a WebMCP execution event.
 *
 * @remarks
 * Reads the IDL's `toolName` attribute and nothing else, so it admits a `ToolActivatedEvent`
 * and a `ToolCancelEvent` and refuses a plain `Event`.
 *
 * @param value - The unknown value to inspect
 * @returns True if the value carries a string `toolName`; false otherwise
 *
 * @example
 * ```ts
 * isWebMCPToolEvent(new Event('toolactivated')) // false
 * ```
 */
export function isWebMCPToolEvent(value: unknown): value is WebMCPToolEvent {
	return objectOf({ toolName: isString })(value)
}
