import type { ToolCall, ToolManagerInterface } from '@orkestrel/tool'
import type {
	JSONRPCErrorResponse,
	JSONRPCId,
	JSONRPCInvocation,
	JSONRPCMessage,
	JSONRPCNotification,
	JSONRPCRequest,
	JSONRPCResultResponse,
	MCPCallOutcome,
	MCPClientInterface,
	MCPDiscoverResult,
	MCPDispatchOptions,
	MCPIdentity,
	MCPJSONLimitOptions,
	MCPLegacyResult,
	MCPMethodOptions,
	MCPProgress,
	MCPResult,
	MCPResultMetaObject,
	MCPDispatcherInterface,
	MCPServerOptions,
	MCPSubscriptionFilter,
	MCPTextStreamControllerInterface,
	MCPToolDescriptor,
	MCPTransportInterface,
	MCPSubscriptionResult,
	MCPSubscriptionResultMetaObject,
} from './types.js'
import {
	attempt,
	cloneJSONRecord,
	isArray,
	isBoolean,
	isJSONValue,
	isNumber,
	isRecord,
	isString,
} from '@orkestrel/contract'
import {
	DEFAULT_MCP_CACHE_TTL,
	JSONRPC_INVALID_PARAMS,
	MCP_EXTENSION_TASKS,
	MCP_META_CAPABILITIES,
	MCP_META_CLIENT,
	MCP_META_SERVER,
	MCP_META_SUBSCRIPTION,
	MCP_META_VERSION,
	MCP_MODERN_VERSION,
	MCP_PROTOCOL_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
} from './constants.js'
import { MCPError } from './errors.js'
import { parseJSONRPCMessage } from './parsers.js'
import {
	isBoundedString,
	isJSONRPCId,
	isJSONRPCNotification,
	isMCPInputResult,
	isMCPLegacyVersion,
	isMCPMetaObject,
	isMCPTaskResult,
} from './validators.js'

/**
 * Determines whether a client capability record declares form-mode elicitation.
 *
 * @remarks
 * The protocol's empty `elicitation` object is the implicit form-only declaration.
 * A non-empty declaration must carry a record-valued `form` member; URL-only support
 * does not authorize a form request. Total over hostile input.
 *
 * @param value - The client capability record to inspect
 * @returns `true` when form-mode elicitation is declared
 *
 * @example
 * ```ts
 * isFormElicitationSupported({ elicitation: {} }) // true — implicit form mode
 * isFormElicitationSupported({ elicitation: { url: {} } }) // false
 * ```
 */
export function isFormElicitationSupported(value: unknown): boolean {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const elicitation = owned.value['elicitation']
		if (!isRecord(elicitation)) return false
		if (isRecord(elicitation['form'])) return true
		return Object.keys(elicitation).length === 0
	} catch {
		return false
	}
}

/**
 * Determines whether a client capability record declares the draft Tasks extension.
 *
 * @remarks
 * The declaration lives at `extensions['io.modelcontextprotocol/tasks']` and its value is
 * an empty object, so this is a PRESENCE check: the extension defines no options, and a
 * server that read one would be reading a field no client can meaningfully set. The value
 * must still be a record, because that is the shape the capability record declares — a
 * `true` or a string there is a client speaking a different protocol, not a shorthand.
 *
 * A client declares this PER REQUEST. Nothing here consults a session, because the modern
 * revision is stateless and a capability declared once at connect time says nothing about
 * the request in hand. Total over hostile input.
 *
 * @param value - The client capability record to inspect
 * @returns `true` when the tasks extension is declared
 *
 * @example
 * ```ts
 * isTaskSupported({ extensions: { 'io.modelcontextprotocol/tasks': {} } }) // true
 * isTaskSupported({ extensions: {} }) // false — the key is the declaration
 * ```
 */
export function isTaskSupported(value: unknown): boolean {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const extensions = owned.value['extensions']
		return isRecord(extensions) && isRecord(extensions[MCP_EXTENSION_TASKS])
	} catch {
		return false
	}
}

/**
 * Serializes one exact JSON value deterministically within explicit bounds.
 *
 * @param value - The unknown value to validate and serialize
 * @param limits - Serialized byte, key, and depth limits
 * @returns Canonical JSON, or `undefined` when invalid or out of bounds
 */
export function serializeJSON(value: unknown, limits: MCPJSONLimitOptions): string | undefined {
	const serialized = attempt(() => {
		const limit = limits.bytes
		const depth = limits.depth
		const breadth = limits.keys
		if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit < 0) return undefined
		if (!Number.isFinite(depth) || !Number.isInteger(depth) || depth < 0) return undefined
		if (
			breadth !== undefined &&
			(!Number.isFinite(breadth) || !Number.isInteger(breadth) || breadth < 0)
		)
			return undefined

		let bytes = 0
		let keys = 0
		const chunks: string[] = []
		const ancestors = new WeakSet<object>()
		const pending: Array<
			| { readonly operation: 'value'; readonly value: unknown; readonly depth: number }
			| { readonly operation: 'string'; readonly value: string; readonly output: string[] }
			| { readonly operation: 'text'; readonly text: string }
			| { readonly operation: 'close'; readonly value: object; readonly text: string }
			| {
					readonly operation: 'record'
					readonly value: object
					readonly names: readonly string[]
					readonly encoded: string[]
					readonly index: number
					readonly depth: number
			  }
		> = [{ operation: 'value', value, depth: 0 }]

		while (pending.length > 0) {
			const frame = pending.pop()
			if (frame === undefined) return undefined
			if (frame.operation === 'text') {
				chunks.push(frame.text)
				continue
			}
			if (frame.operation === 'close') {
				ancestors.delete(frame.value)
				chunks.push(frame.text)
				continue
			}
			if (frame.operation === 'string') {
				let encodedBytes = 2
				for (let index = 0; index < frame.value.length; index += 1) {
					const code = frame.value.charCodeAt(index)
					if (code === 0x22 || code === 0x5c) encodedBytes += 2
					else if (
						code === 0x08 ||
						code === 0x09 ||
						code === 0x0a ||
						code === 0x0c ||
						code === 0x0d
					)
						encodedBytes += 2
					else if (code < 0x20) encodedBytes += 6
					else if (code < 0x80) encodedBytes += 1
					else if (code < 0x800) encodedBytes += 2
					else if (code >= 0xd800 && code <= 0xdbff) {
						const next = index + 1 < frame.value.length ? frame.value.charCodeAt(index + 1) : 0
						if (next >= 0xdc00 && next <= 0xdfff) {
							encodedBytes += 4
							index += 1
						} else encodedBytes += 6
					} else if (code >= 0xdc00 && code <= 0xdfff) encodedBytes += 6
					else encodedBytes += 3
					if (bytes + encodedBytes > limit) return undefined
				}
				bytes += encodedBytes
				if (bytes > limit) return undefined
				const text = JSON.stringify(frame.value)
				if (!isString(text)) return undefined
				frame.output.push(text)
				continue
			}
			if (frame.operation === 'record') {
				const name = frame.names[frame.index]
				if (name !== undefined) {
					pending.push({ ...frame, index: frame.index + 1 })
					pending.push({ operation: 'string', value: name, output: frame.encoded })
					continue
				}
				const entries: Array<{ readonly text: string; readonly value: unknown }> = []
				for (let index = 0; index < frame.names.length; index += 1) {
					const key = frame.names[index]
					const text = frame.encoded[index]
					if (key === undefined || text === undefined) return undefined
					const descriptor = Reflect.getOwnPropertyDescriptor(frame.value, key)
					if (
						descriptor === undefined ||
						descriptor.enumerable !== true ||
						!Object.hasOwn(descriptor, 'value')
					)
						return undefined
					entries.push({ text, value: descriptor.value })
				}
				ancestors.add(frame.value)
				chunks.push('{')
				pending.push({ operation: 'close', value: frame.value, text: '}' })
				for (let index = entries.length - 1; index >= 0; index -= 1) {
					const property = entries[index]
					if (property === undefined) return undefined
					pending.push({ operation: 'value', value: property.value, depth: frame.depth + 1 })
					pending.push({ operation: 'text', text: ':' })
					pending.push({ operation: 'text', text: property.text })
					if (index > 0) pending.push({ operation: 'text', text: ',' })
				}
				continue
			}

			if (frame.depth > depth) return undefined
			const entry = frame.value
			if (entry === null || isBoolean(entry)) {
				const text = entry === null ? 'null' : entry ? 'true' : 'false'
				bytes += text.length
				if (bytes > limit) return undefined
				chunks.push(text)
				continue
			}
			if (isNumber(entry)) {
				if (!Number.isFinite(entry)) return undefined
				const text = JSON.stringify(entry)
				if (!isString(text)) return undefined
				bytes += text.length
				if (bytes > limit) return undefined
				chunks.push(text)
				continue
			}
			if (isString(entry)) {
				pending.push({ operation: 'string', value: entry, output: chunks })
				continue
			}
			if (typeof entry !== 'object' || ancestors.has(entry)) return undefined
			if (Array.isArray(entry)) {
				const lengthDescriptor = Reflect.getOwnPropertyDescriptor(entry, 'length')
				if (
					lengthDescriptor === undefined ||
					!Object.hasOwn(lengthDescriptor, 'value') ||
					!isNumber(lengthDescriptor.value) ||
					!Number.isInteger(lengthDescriptor.value) ||
					lengthDescriptor.value < 0 ||
					lengthDescriptor.value > 0xffff_ffff ||
					lengthDescriptor.enumerable === true ||
					lengthDescriptor.configurable === true
				)
					return undefined
				const length = lengthDescriptor.value
				keys += length
				bytes += 2 + (length === 0 ? 0 : length - 1)
				if (bytes > limit || (breadth !== undefined && keys > breadth)) return undefined
				if (length > 0 && frame.depth >= depth) return undefined
				const names = Reflect.ownKeys(entry)
				if (names.length !== length + 1) return undefined
				let foundLength = false
				for (const name of names) {
					if (!isString(name)) return undefined
					if (name === 'length') {
						if (foundLength) return undefined
						foundLength = true
						continue
					}
					const index = Number(name)
					if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== name)
						return undefined
				}
				if (!foundLength) return undefined
				const values: unknown[] = []
				for (let index = 0; index < length; index += 1) {
					const descriptor = Reflect.getOwnPropertyDescriptor(entry, String(index))
					if (
						descriptor === undefined ||
						descriptor.enumerable !== true ||
						!Object.hasOwn(descriptor, 'value')
					)
						return undefined
					values.push(descriptor.value)
				}
				ancestors.add(entry)
				chunks.push('[')
				pending.push({ operation: 'close', value: entry, text: ']' })
				for (let index = values.length - 1; index >= 0; index -= 1) {
					const item = values[index]
					pending.push({ operation: 'value', value: item, depth: frame.depth + 1 })
					if (index > 0) pending.push({ operation: 'text', text: ',' })
				}
				continue
			}
			if (!isRecord(entry)) return undefined
			const ownKeys = Reflect.ownKeys(entry)
			keys += ownKeys.length
			bytes += 2 + (ownKeys.length === 0 ? 0 : ownKeys.length - 1) + ownKeys.length
			if (bytes > limit || (breadth !== undefined && keys > breadth)) return undefined
			if (ownKeys.length > 0 && frame.depth >= depth) return undefined
			const names: string[] = []
			for (const key of ownKeys) {
				if (!isString(key)) return undefined
				names.push(key)
			}
			names.sort()
			pending.push({
				operation: 'record',
				value: entry,
				names,
				encoded: [],
				index: 0,
				depth: frame.depth,
			})
		}
		return chunks.join('')
	})
	return serialized.success ? serialized.value : undefined
}

/**
 * Computes a lowercase host-neutral SHA-256 digest of one bounded canonical JSON value.
 *
 * @param value - The unknown value to validate and digest
 * @param limits - Serialized byte, key, and depth limits
 * @returns The lowercase hexadecimal digest, or `undefined` when invalid
 */
export async function digestJSON(
	value: unknown,
	limits: MCPJSONLimitOptions,
): Promise<string | undefined> {
	const serialized = serializeJSON(value, limits)
	if (serialized === undefined) return undefined
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Builds one official progress notification for the original request stream.
 *
 * @param token - The request's original opaque progress token
 * @param progress - The finite progress payload
 * @returns The official `notifications/progress` request
 */
export function buildProgressNotification(
	token: string | number,
	progress: MCPProgress,
): JSONRPCNotification {
	return {
		jsonrpc: '2.0',
		method: 'notifications/progress',
		params: {
			progressToken: token,
			progress: progress.progress,
			...(progress.total === undefined ? {} : { total: progress.total }),
			...(progress.message === undefined ? {} : { message: progress.message }),
		},
	}
}

/**
 * Builds one official cancellation notification for a request already sent.
 *
 * @remarks
 * `requestId` and `reason` are WIRE SPELLINGS carried verbatim from the dated schema's
 * `CancelledNotificationParams`, and so is the `cancelled` in the method name — this
 * package's own vocabulary says `abort`, but the method is the protocol's and does not
 * change. The notification is FIRE-AND-FORGET in the strongest sense: it carries no id,
 * so nothing answers it, and every receiver obligation the spec states is `SHOULD` or
 * `MAY`. A peer may ignore it for a request it never saw, has already answered, or cannot
 * interrupt, and the sender must treat a late answer to the cancelled request as ordinary
 * rather than as a violation.
 *
 * Only write one on a carrier that accepts a client-initiated notification — see
 * {@link import('./types.js').MCPClientTransportInterface.duplex}. On Streamable HTTP the
 * dated revision defines no such frame, and closing the response stream is the
 * cancellation signal instead.
 *
 * @param id - The JSON-RPC id of the request being cancelled
 * @param reason - An optional human-readable reason for the cancellation
 * @returns The official `notifications/cancelled` notification
 *
 * @example
 * ```ts
 * buildCancelledNotification(7, 'caller aborted')
 * // → { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7, reason: 'caller aborted' } }
 * ```
 */
export function buildCancelledNotification(id: JSONRPCId, reason?: string): JSONRPCNotification {
	return {
		jsonrpc: '2.0',
		method: 'notifications/cancelled',
		params: {
			requestId: id,
			...(reason === undefined ? {} : { reason }),
		},
	}
}

/**
 * Determines whether one method may answer with a given modern `resultType`.
 *
 * @remarks
 * The dated protocol lets a `tools/call` answer in more than one way — it COMPLETED, it became a
 * durable task, or it needs another round trip — while every other method this client
 * issues has exactly one legal answer. So the arm a peer chose is only meaningful beside
 * the method it answers, and this is the one place that pairing is decided.
 *
 * The rule is deliberately closed: an unrecognized `resultType` is refused for every
 * method, including `tools/call`. A client that carried an arm it cannot name would hand
 * its caller a value whose meaning it invented.
 *
 * @param method - The method the pending request was issued for
 * @param resultType - The unknown `resultType` the peer answered with
 * @returns Whether that method may legally answer with that `resultType`
 *
 * @example
 * ```ts
 * matchesResultType('tools/call', 'task') // true
 * matchesResultType('tools/list', 'task') // false
 * matchesResultType('tools/call', 'future') // false
 * ```
 */
export function matchesResultType(method: string, resultType: unknown): boolean {
	if (resultType === 'complete') return true
	if (method !== 'tools/call') return false
	return resultType === 'task' || resultType === 'input_required'
}

/**
 * Concatenates an MCP tool-call result's text content blocks into one string.
 *
 * @remarks
 * The inverse of a server splitting a value into text block(s), and TOTAL: a non-record
 * result, a non-array `content`, or a non-string `text` contributes nothing rather than
 * throwing. What it returns is a RENDERING — the prose a model reads — and not the tool's
 * value, which travels as `structuredContent` whenever the peer sent one.
 *
 * @param result - The unknown result payload to read content blocks from
 * @returns Every text block joined by newlines, or an empty string when there are none
 *
 * @example
 * ```ts
 * extractContentText({ content: [{ type: 'text', text: 'hi' }] }) // 'hi'
 * extractContentText('not a result') // ''
 * ```
 */
export function extractContentText(result: unknown): string {
	if (!isRecord(result) || !isArray(result['content'])) return ''
	const parts: string[] = []
	for (const block of result['content']) {
		if (isRecord(block) && isString(block['text'])) parts.push(block['text'])
	}
	return parts.join('\n')
}

/**
 * Narrows one `tools/call` answer to the arm the peer chose.
 *
 * @remarks
 * The arms {@link matchesResultType} admits are the whole space this sees, because a
 * `resultType` the client cannot name is refused at correlation. What is left is validating
 * the arms the protocol gives a shape to, and deriving the tool's value from the one it
 * does not:
 *
 * - A peer's `structuredContent` is PREFERRED over the content blocks, because it is the
 *   tool's value in its original structure while the blocks are a rendering beside it. Its
 *   mere presence decides — an explicit `null` is a value the tool returned, not an absence.
 * - With no structured value the legacy shape applies: the value was JSON-serialized into
 *   the text block(s), so parse them and fall back to the raw string when they are not JSON.
 * - A remote tool FAILURE (`isError: true`) THROWS the error text, so an agent's tool
 *   registry isolates it into a failure result exactly as it would a local throw.
 *
 * @param name - The tool's name, used only to describe a failure that carried no text
 * @param result - The already-owned result payload the peer answered with
 * @returns The arm the peer answered with, frozen
 * @throws MCPError when a task or input arm's payload does not match its schema
 * @throws Error when the remote tool failed
 *
 * @example
 * ```ts
 * buildCallOutcome('search', { resultType: 'complete', structuredContent: { count: 3 } })
 * // → { resultType: 'complete', value: { count: 3 } }
 * ```
 */
export function buildCallOutcome(name: string, result: unknown): MCPCallOutcome {
	const resultType = isRecord(result) ? result['resultType'] : undefined
	if (resultType === 'task') {
		if (!isMCPTaskResult(result)) {
			throw new MCPError(
				'MCP server returned a malformed task result',
				JSONRPC_INVALID_PARAMS,
				result,
			)
		}
		return Object.freeze(result)
	}
	if (resultType === 'input_required') {
		if (!isMCPInputResult(result)) {
			throw new MCPError(
				'MCP server returned a malformed input request',
				JSONRPC_INVALID_PARAMS,
				result,
			)
		}
		return Object.freeze(result)
	}
	const text = extractContentText(result)
	if (isRecord(result) && result['isError'] === true) {
		throw new Error(text.length > 0 ? text : `MCP tool '${name}' failed`)
	}
	let value: unknown
	if (isRecord(result) && Object.hasOwn(result, 'structuredContent')) {
		value = result['structuredContent']
	} else if (text.length > 0) {
		try {
			value = JSON.parse(text)
		} catch {
			value = text
		}
	}
	const outcome: MCPCallOutcome = { resultType: 'complete', value }
	return Object.freeze(outcome)
}

/**
 * Builds the canonical Tool call for one validated MCP `tools/call` request.
 *
 * @param request - The original MCP request
 * @param caller - Optional consumer-asserted caller context
 * @param args - Optional once-validated modern arguments; omission retains legacy normalization
 * @returns The canonical call, or `undefined` when the name is invalid
 */
export function buildToolCall(
	request: JSONRPCRequest,
	caller?: unknown,
	args?: Readonly<Record<string, unknown>>,
): ToolCall | undefined {
	const name = request.params?.['name']
	if (typeof name !== 'string') return undefined
	const rawArguments = request.params?.['arguments']
	return {
		id: String(request.id),
		name,
		arguments: args ?? (isRecord(rawArguments) ? rawArguments : {}),
		...(caller === undefined ? {} : { caller }),
	}
}

// Pure dispatch builders (the dispatch branches stay exported helpers,
// not hidden privates). Each turns a piece of MCP state into the JSON-RPC `result`
// payload (or a response envelope) the server returns — independently testable.

/**
 * Builds a JSON-RPC success {@link JSONRPCResultResponse} — the `id` echoed, the
 * method's value as `result`.
 *
 * @remarks
 * A result answers a request, and a request always carries a readable id, so `id` is
 * required here. The failure arm is the only one that can lack one.
 *
 * @param id - The request's id
 * @param result - The method's return value
 * @returns The success response envelope
 */
export function buildJSONRPCResult(
	id: JSONRPCId,
	result: MCPResult | MCPLegacyResult,
): JSONRPCResultResponse {
	return { jsonrpc: '2.0', id, result }
}

/**
 * Builds a JSON-RPC error {@link JSONRPCErrorResponse} — the `id` echoed, the failure
 * as an `error` object.
 *
 * @remarks
 * An `undefined` `id` is OMITTED from the envelope rather than serialized as `null`:
 * MCP overrides the base specification here, so a peer that could not have its id
 * read receives a response with no `id` member at all.
 *
 * @param id - The failed request's id, or `undefined` when none could be read
 * @param code - One of the reserved JSON-RPC codes (see `./constants.js`)
 * @param message - A short human description of the failure
 * @param data - An OPTIONAL machine-readable payload (omitted from the envelope when absent)
 * @returns The error response envelope
 */
export function buildJSONRPCError(
	id: JSONRPCId | undefined,
	code: number,
	message: string,
	data?: unknown,
): JSONRPCErrorResponse {
	return {
		jsonrpc: '2.0',
		...(id === undefined ? {} : { id }),
		error: data === undefined ? { code, message } : { code, message, data },
	}
}

/**
 * Resolves the caller-facing dispatch options into the options a dispatched method
 * receives.
 *
 * @remarks
 * The ONE place a cancellation signal is resolved. A caller may have no signal to
 * offer; a dispatched method always has one to observe, so a missing signal becomes
 * a real signal rather than an absence every downstream handler would have to case on.
 *
 * The resolved signal is the request's LIFETIME, which is strictly wider than the
 * caller's: it composes the caller's signal, when there is one, with the `lifetime`
 * dispatch owns and aborts once the answer this request produced is finished. That is
 * what wakes a stream producer parked on an event that will never arrive after its
 * consumer walked away — a caller-only signal would leave it parked forever.
 *
 * `caller` is carried by identity and omitted when absent — this package never
 * inspects, validates, clones, or serializes it.
 *
 * @param options - The caller-facing per-request options
 * @param lifetime - The request-scoped signal dispatch aborts when the answer is finished
 * @returns The resolved per-request method options
 *
 * @example
 * ```ts
 * const lifetime = new AbortController()
 * buildMethodOptions({}, lifetime.signal).signal.aborted // false — until the answer ends
 * ```
 */
export function buildMethodOptions(
	options: MCPDispatchOptions,
	lifetime: AbortSignal,
): MCPMethodOptions {
	return {
		signal: options.signal === undefined ? lifetime : AbortSignal.any([options.signal, lifetime]),
		...(options.caller === undefined ? {} : { caller: options.caller }),
	}
}

/**
 * Maps a {@link ToolManagerInterface}'s definitions to MCP `tools/list` descriptors
 * — renaming `parameters` to the wire's `inputSchema`.
 *
 * @remarks
 * Each {@link import('@orkestrel/tool').ToolDefinition} carries through its
 * `name` and (when present) `description`; its open JSON-Schema `parameters`
 * becomes `inputSchema`, defaulting to an empty object schema (`{ type: 'object' }`)
 * when a tool declares none (MCP requires an `inputSchema`).
 *
 * @param manager - The tool registry to describe
 * @returns One {@link MCPToolDescriptor} per registered tool, in registry order
 */
export function buildToolDescriptors(manager: ToolManagerInterface): readonly MCPToolDescriptor[] {
	return manager.definitions().map((definition) => {
		const descriptor: {
			name: string
			description?: string
			inputSchema: Readonly<Record<string, unknown>>
		} = {
			name: definition.name,
			inputSchema: definition.parameters ?? { type: 'object' },
		}
		if (definition.description !== undefined) descriptor.description = definition.description
		return descriptor
	})
}

/**
 * Stamps a result with the modern complete-result discriminator and server
 * metadata, plus cache fields when the result is cacheable.
 *
 * @remarks
 * This is the single stamping site shared by modern result builders. Supplying
 * `ttl` adds both schema-coupled fields (`ttlMs` and `cacheScope`); omitting it
 * adds neither, which keeps `tools/call` distinct from cacheable results.
 *
 * @param result - The unstamped result payload
 * @param identity - The server identity carried under the reserved `_meta` key
 * @param ttl - Required freshness lifetime for a cacheable result; omit for a non-cacheable result
 * @param scope - The cache visibility, defaulting to `'private'` when `ttl` is supplied
 * @returns A copy of the payload with its modern stamps
 */
export function buildModernResult<T extends object>(
	result: T,
	identity: MCPIdentity,
	ttl: number,
	scope?: 'public' | 'private',
): T & {
	readonly resultType: 'complete'
	readonly _meta: MCPResultMetaObject
	readonly ttlMs: number
	readonly cacheScope: 'public' | 'private'
}
export function buildModernResult<T extends object>(
	result: T,
	identity: MCPIdentity,
): T & {
	readonly resultType: 'complete'
	readonly _meta: MCPResultMetaObject
}
export function buildModernResult<T extends object>(
	result: T,
	identity: MCPIdentity,
	ttl?: number,
	scope?: 'public' | 'private',
): T & {
	readonly resultType: 'complete'
	readonly _meta: MCPResultMetaObject
	readonly ttlMs?: number
	readonly cacheScope?: 'public' | 'private'
} {
	const currentMetadata = isRecord(result) ? result['_meta'] : undefined
	if (!isJSONValue(identity)) throw new TypeError('MCP identity must be exact JSON')
	const metadata = {
		...(isMCPMetaObject(currentMetadata) ? currentMetadata : {}),
		[MCP_META_SERVER]: identity,
	}
	if (ttl === undefined) return { ...result, resultType: 'complete', _meta: metadata }
	return {
		...result,
		resultType: 'complete',
		ttlMs: ttl,
		cacheScope: scope ?? 'private',
		_meta: metadata,
	}
}

/**
 * Projects one complete modern result onto the legacy wire shape.
 *
 * @remarks
 * The projection removes the modern discriminator, cache fields, and reserved server identity.
 * A non-complete result has no legacy representation and returns `undefined`.
 *
 * @param result - The modern result to project
 * @returns The legacy result, or `undefined` when the modern arm cannot be represented
 */
export function modernResultToLegacy(
	result: MCPResult | MCPLegacyResult,
): MCPLegacyResult | undefined {
	if (result.resultType !== 'complete') return undefined
	const projected: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(result)) {
		if (key === 'resultType' || key === 'ttlMs' || key === 'cacheScope') continue
		if (key === 'content' && Array.isArray(value)) {
			projected[key] = value.map((entry) =>
				isRecord(entry) && entry['type'] === 'text' && isString(entry['text'])
					? { type: 'text', text: entry['text'] }
					: entry,
			)
			continue
		}
		if (key !== '_meta' || !isRecord(value)) {
			projected[key] = value
			continue
		}
		const metadata: Record<string, unknown> = {}
		for (const [name, entry] of Object.entries(value)) {
			if (name !== MCP_META_SERVER) metadata[name] = entry
		}
		if (Object.keys(metadata).length > 0) projected['_meta'] = metadata
	}
	return projected
}

/**
 * Restores one legacy result to the modern complete-result shape.
 *
 * @remarks
 * Legacy `tools/list` results receive the required modern cache fields. Other legacy results are
 * non-cacheable. Every restored result receives the server identity learned during `initialize`.
 *
 * @param result - The unstamped legacy result
 * @param method - The request method whose result is being restored
 * @param identity - The server identity learned during the legacy handshake
 * @returns The modern complete result
 */
export function legacyResultToModern(
	result: MCPLegacyResult,
	method: string,
	identity: MCPIdentity,
): MCPResult {
	return method === 'tools/list'
		? buildModernResult(result, identity, DEFAULT_MCP_CACHE_TTL)
		: buildModernResult(result, identity)
}

/**
 * Stamps one legacy request for the modern dispatcher.
 *
 * @param request - The legacy request to translate
 * @returns A modern request carrying the package revision and an empty capability set
 */
export function legacyInvocationToModern(request: JSONRPCRequest): JSONRPCRequest {
	const params = request.params ?? {}
	const metadata = isRecord(params['_meta']) ? params['_meta'] : {}
	return {
		...request,
		params: {
			...params,
			_meta: {
				...metadata,
				[MCP_META_VERSION]: MCP_MODERN_VERSION,
				[MCP_META_CAPABILITIES]: {},
			},
		},
	}
}

/**
 * Removes modern request metadata before an invocation reaches a legacy peer.
 *
 * @remarks
 * Non-reserved metadata such as `progressToken` remains on the legacy wire. When no metadata
 * remains, the translated parameters omit `_meta`.
 *
 * @param invocation - The modern invocation to translate
 * @returns The legacy invocation with reserved modern metadata removed
 */
export function modernInvocationToLegacy(invocation: JSONRPCInvocation): JSONRPCInvocation {
	const params = invocation.params
	if (params === undefined || !isRecord(params['_meta'])) return invocation
	const translated: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(params)) {
		if (key !== '_meta') translated[key] = value
	}
	const metadata: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(params['_meta'])) {
		if (key !== MCP_META_VERSION && key !== MCP_META_CAPABILITIES && key !== MCP_META_CLIENT) {
			metadata[key] = value
		}
	}
	if (Object.keys(metadata).length > 0) translated['_meta'] = metadata
	return {
		...invocation,
		params: translated,
	}
}

/**
 * Intersects a requested subscription filter with the notification families a server supports.
 *
 * @param requested - The notification families requested by the client
 * @param supported - The notification families the server can actually produce
 * @returns The exact subset the server will honour
 */
export function buildSubscriptionFilter(
	requested: MCPSubscriptionFilter,
	supported: MCPSubscriptionFilter,
): MCPSubscriptionFilter {
	const toolsListChanged =
		requested.toolsListChanged === true && supported.toolsListChanged === true
	const promptsListChanged =
		requested.promptsListChanged === true && supported.promptsListChanged === true
	const resourcesListChanged =
		requested.resourcesListChanged === true && supported.resourcesListChanged === true
	const supportedResources = new Set(supported.resourceSubscriptions ?? [])
	const resourceSubscriptions = requested.resourceSubscriptions?.filter((uri) =>
		supportedResources.has(uri),
	)
	return {
		...(toolsListChanged ? { toolsListChanged: true } : {}),
		...(promptsListChanged ? { promptsListChanged: true } : {}),
		...(resourcesListChanged ? { resourcesListChanged: true } : {}),
		...(resourceSubscriptions !== undefined && resourceSubscriptions.length > 0
			? { resourceSubscriptions }
			: {}),
	}
}

/**
 * Determines whether a produced notification belongs to an honoured subscription filter.
 *
 * @param notification - The server notification offered by the configured producer
 * @param filter - The filter acknowledged to the client
 * @returns `true` when the notification belongs on this subscription stream
 */
export function matchesSubscriptionNotification(
	notification: JSONRPCNotification,
	filter: MCPSubscriptionFilter,
): boolean {
	if (notification.method === 'notifications/tools/list_changed') {
		return filter.toolsListChanged === true
	}
	if (notification.method === 'notifications/prompts/list_changed') {
		return filter.promptsListChanged === true
	}
	if (notification.method === 'notifications/resources/list_changed') {
		return filter.resourcesListChanged === true
	}
	if (notification.method !== 'notifications/resources/updated') return false
	const uri = notification.params?.['uri']
	return typeof uri === 'string' && filter.resourceSubscriptions?.includes(uri) === true
}

/**
 * Stamps a subscription notification with the request id reserved for its held-open stream.
 *
 * @param notification - The notification to copy and stamp
 * @param id - The `subscriptions/listen` request id
 * @returns The stamped notification, preserving its other params and metadata
 */
export function stampSubscriptionNotification(
	notification: JSONRPCNotification,
	id: JSONRPCId,
): JSONRPCNotification {
	const metadata = notification.params?.['_meta']
	return {
		jsonrpc: notification.jsonrpc,
		method: notification.method,
		params: {
			...notification.params,
			_meta: {
				...(isRecord(metadata) ? metadata : {}),
				[MCP_META_SUBSCRIPTION]: id,
			},
		},
	}
}

/**
 * Builds the first notification carrying a subscription id for a listen request.
 *
 * @param notifications - The exact notification filter the server will honour
 * @param id - The `subscriptions/listen` request id
 * @returns The stamped subscription acknowledgement notification
 */
export function buildSubscriptionAcknowledgement(
	notifications: MCPSubscriptionFilter,
	id: JSONRPCId,
): JSONRPCNotification {
	return stampSubscriptionNotification(
		{
			jsonrpc: '2.0',
			method: 'notifications/subscriptions/acknowledged',
			params: { notifications },
		},
		id,
	)
}

/**
 * Builds the terminating response for a subscription source that closes gracefully.
 *
 * @param id - The `subscriptions/listen` request id
 * @param identity - The server identity included by the modern result stamping site
 * @returns The complete modern result carrying the required subscription id metadata
 */
export function buildSubscriptionResult(
	id: JSONRPCId,
	identity: MCPIdentity,
): JSONRPCResultResponse {
	const metadata: MCPSubscriptionResultMetaObject = { [MCP_META_SUBSCRIPTION]: id }
	const result: MCPSubscriptionResult = buildModernResult({ _meta: metadata }, identity)
	return buildJSONRPCResult(id, result)
}

/**
 * Builds the mandatory modern `server/discover` result.
 *
 * @remarks
 * `capabilities.resources` and `capabilities.prompts` appear only for servers with their
 * respective managers and derive notification flags from the configured subscription filter.
 * `capabilities.completions` is independent and appears only with a completion provider.
 * `capabilities.extensions` appears only for a server that CONFIGURED the extension it
 * would name. An advertisement is a promise a client is entitled to act on, so a server
 * with no `task` policy omits the member entirely rather than advertising an empty
 * record — and its discovery answer stays byte-for-byte what it was before the extension
 * existed.
 *
 * @param options - The server identity, instructions, cache, and extension configuration
 * @returns The supported revisions, capabilities, and required modern cache stamps
 */
export function buildDiscoverResult(options: MCPServerOptions): MCPDiscoverResult {
	return buildModernResult(
		{
			supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
			capabilities: {
				tools: {},
				...(options.resources === undefined
					? {}
					: {
							resources: {
								...(options.subscription?.notifications.resourceSubscriptions === undefined
									? {}
									: { subscribe: true }),
								...(options.subscription?.notifications.resourcesListChanged === true
									? { listChanged: true }
									: {}),
							},
						}),
				...(options.prompts === undefined
					? {}
					: {
							prompts: {
								...(options.subscription?.notifications.promptsListChanged === true
									? { listChanged: true }
									: {}),
							},
						}),
				...(options.completion === undefined ? {} : { completions: {} }),
				...(options.task === undefined ? {} : { extensions: { [MCP_EXTENSION_TASKS]: {} } }),
			},
			...(options.instructions === undefined ? {} : { instructions: options.instructions }),
		},
		options.identity,
		options.cache?.ttl ?? DEFAULT_MCP_CACHE_TTL,
		options.cache?.scope,
	)
}

/**
 * Builds the MCP `initialize` result — the negotiated protocol version, the
 * advertised capabilities, and the server identity.
 *
 * @remarks
 * Version negotiation echoes the client's `requested` version when it is one of the
 * supported legacy revisions. A modern or unsupported request receives the newest
 * supported legacy revision; the client decides whether to continue.
 * `capabilities.tools` is an empty object — this server advertises the tools
 * capability with no sub-options (no list-changed notification yet).
 *
 * @param name - The server name (echoed in `serverInfo`)
 * @param version - The server version (echoed in `serverInfo`)
 * @param requested - The client's requested protocol version (negotiated when supported)
 * @returns The `initialize` result payload
 */
export function buildInitializeResult(
	name: string,
	version: string,
	requested?: string,
): MCPLegacyResult {
	const protocolVersion = isMCPLegacyVersion(requested) ? requested : MCP_PROTOCOL_VERSION
	return {
		protocolVersion,
		capabilities: { tools: {} },
		serverInfo: { name, version },
	}
}

/**
 * Decodes one raw inbound message within an explicit bound — the decode a binder performs
 * before it hands the string on.
 *
 * @remarks
 * The bound is checked FIRST, against the raw string, so an oversized message is never
 * `JSON.parse`d at all: a decoder that parses before it measures has already spent the work
 * the bound exists to refuse. A message over the bound, malformed JSON, and a well-formed
 * value that is not a JSON-RPC message are one answer — `undefined` — because a binder does
 * exactly the same thing with each of them: nothing, and let
 * {@link import('./types.js').MCPServerInterface.handle} produce the wire refusal from the
 * same bound.
 *
 * Total — never throws, whatever the input.
 *
 * @param message - The raw inbound JSON-RPC message string
 * @param limits - The byte and depth bounds to decode within (the server's own, from `limit`)
 * @returns The decoded message, or `undefined` when it is over the bound or is not one
 *
 * @example
 * ```ts
 * decodeBoundedMessage(raw, { bytes: server.limit.message, depth: server.limit.depth })
 * ```
 */
export function decodeBoundedMessage(
	message: string,
	limits: MCPJSONLimitOptions,
): JSONRPCMessage | undefined {
	if (!isBoundedString(message, limits.bytes)) return undefined
	const parsed = attempt<unknown>(() => JSON.parse(message))
	return parsed.success ? parseJSONRPCMessage(parsed.value, limits) : undefined
}

/**
 * Reads the request id an inbound `notifications/cancelled` names — the inverse of
 * {@link buildCancelledNotification}.
 *
 * @remarks
 * `requestId` is the WIRE SPELLING carried verbatim from the dated schema, and it must be a
 * real {@link JSONRPCId}: `null` is not one, and neither is an absent member, so a
 * malformed frame reads as "cancels nothing" rather than as an error. Anything that is not a
 * `notifications/cancelled` notification — a response, a request that happens to use the
 * method name, another notification — reads the same way. Total.
 *
 * @param message - The decoded inbound message to read
 * @returns The id of the request being cancelled, or `undefined` when the message cancels nothing
 *
 * @example
 * ```ts
 * readCancelledId(buildCancelledNotification(7)) // → 7
 * ```
 */
export function readCancelledId(message: JSONRPCMessage): JSONRPCId | undefined {
	if (!isJSONRPCNotification(message) || message.method !== 'notifications/cancelled') {
		return undefined
	}
	const requested = message.params?.['requestId']
	return isJSONRPCId(requested) ? requested : undefined
}

// The held-open stream leaf: the pump that writes a serialized exchange onto a transport. It
// consumes the stream MANUALLY rather than with `for await`, because `for await` discards the
// `return` value and the terminating response IS that value.

/**
 * Pumps a controlled serialized exchange onto a transport — every notification in order, then
 * the terminating response — and END the exchange however the pump leaves.
 *
 * @remarks
 * The generator's `return` value is a message like any other on the wire: it is sent
 * LAST and closes the exchange. Sends are awaited one at a time so the transport
 * receives the sequence in the order the method produced it.
 *
 * The first parameter is the CONTROLLED arm rather than a bare
 * {@link import('./types.js').MCPTextStream}, and that is the whole point of it: this pump is
 * an owner, and an owner needs a lifecycle member to discharge its obligation with. A bare
 * generator has none, so an exit where nothing was cancelled — a `send` that threw two
 * messages in, a transport that closed underneath the loop — would leave the producer, the
 * request lifetime, and any live server slot behind it held with no signal to release them.
 * The `finally` here is that release, it runs on every exit including the normal one, and it
 * is a no-op for an exchange that already ended on its terminal.
 *
 * The `finally` is spelled explicitly rather than with `await using` because this package's
 * declared Node floor cannot PARSE `await using` — `target: ESNext` emits the declaration
 * verbatim, and a floor engine rejects the whole module at load. The obligation discharged is
 * identical either way.
 *
 * @param stream - The controlled serialized held-open result to write out and then end
 * @param transport - The duplex channel to write each message to
 * @returns Resolves once the terminating response has been sent and the exchange has ended
 *
 * @example
 * ```ts
 * const answer = await server.handle(message)
 * if (typeof answer !== 'string' && answer !== undefined) await sendStream(answer, transport)
 * ```
 */
export async function sendStream(
	stream: MCPTextStreamControllerInterface,
	transport: MCPTransportInterface,
): Promise<void> {
	try {
		let next = await stream.next()
		while (!next.done) {
			await transport.send(next.value)
			next = await stream.next()
		}
		await transport.send(next.value)
	} finally {
		await stream[Symbol.asyncDispose]()
	}
}

// The environment-agnostic PORT binders — the keystone that lets an
// {@link MCPDispatcherInterface} / {@link MCPClientInterface} run over ANY
// {@link MCPTransportInterface} (a Node stdio pair, a browser MessagePort, a Web
// Worker `self`) with no per-environment dispatch/correlation wiring duplicated at
// each face. Both are TOTAL: a `send` throw or rejection is caught and never
// escapes as an unhandled rejection.

/**
 * Pipes an {@link MCPTransportInterface} into an {@link MCPDispatcherInterface} — every
 * inbound message runs through `server.handle`, and a defined reply is written back
 * through `transport.send`.
 *
 * @remarks
 * `server.handle` already turns a malformed message into a serialized `-32700` /
 * `-32600` reply and a notification into `undefined` (no reply), so this binder parses
 * nothing the server would parse differently: it decodes each inbound message through
 * {@link decodeBoundedMessage} under `server.limit`, the SERVER'S OWN bound, so a message
 * the server would refuse is never parsed here either and still receives its `-32700` from
 * the one place that words it. A HELD-OPEN reply arrives as an
 * {@link import('./types.js').MCPTextStreamControllerInterface} instead of a string: this is
 * the one place that pumps it, writing each notification in order and then the generator's
 * returned terminating response ({@link sendStream}). A `transport.send` throw or rejection —
 * mid-stream included — is caught and routed
 * to `server.emitter`'s `error` event (never rethrown, never an unhandled rejection);
 * a listener on that event that itself throws is swallowed (the end of the line —
 * the caller's own bug, never this binder's). A fault raised AFTER its own request was
 * cancelled reports nothing, because a cancellation is not a fault.
 *
 * **This binder OWNS every exchange it starts, and ends each one on every exit.** It holds one
 * `AbortController` per live request, keyed by the request's id and deleted whenever that
 * request leaves — normally, by a throw, or by cancellation — and it supplies that signal to
 * `handle` as {@link import('./types.js').MCPDispatchOptions}. These consequences follow.
 * An inbound `notifications/cancelled` ABORTS the request it names, which is how the message-
 * based cancellation path reaches a tool on the carriers that have one (stdio, WebSocket,
 * `MessagePort`); a cancelled request writes NO response, because a peer that asked for a call
 * to stop is not answered by it; and the transport's `closed` signal aborts every request
 * still in flight, so an exchange being pumped when the carrier dies ends with it instead of
 * writing into a socket nobody is holding.
 *
 * `listen`/`closed` are REPLACE semantics (§ port contract): the returned unbind
 * DETACHES by replacing this binder's own handlers with no-ops, so a subsequent
 * `bindServer` call on the SAME transport is never double-dispatched by a stale
 * subscription left behind — an unbind→rebind cycle yields exactly one reply per
 * request. Unbinding is itself an owner exit: it aborts and retires every request still in
 * flight before detaching, so `unbind()` then `close()` and `close()` then `unbind()` end the
 * same exchanges. It does NOT close the transport; that remains the caller's decision.
 *
 * @param server - The transport-agnostic server to dispatch inbound messages over
 * @param transport - The duplex channel to pipe the server over
 * @returns Detach this binder from the transport (does not close it)
 *
 * @example
 * ```ts
 * const unbind = bindServer(server, transport)
 * // ... later, detach without closing:
 * unbind()
 * ```
 */
export function bindServer(
	server: MCPDispatcherInterface,
	transport: MCPTransportInterface,
): () => void {
	let active = true
	// The per-live-request registry. It lives HERE rather than on the method registry because
	// the controller a cancellation must reach is created per dispatch and published to no
	// member — the binder is the one place that both mints the request's lifetime and sees the
	// next inbound frame, so it is the only place the two can meet.
	const live = new Map<JSONRPCId, AbortController>()
	transport.listen(async (message) => {
		if (!active) return
		const decoded = decodeBoundedMessage(message, {
			bytes: server.limit.message,
			depth: server.limit.depth,
		})
		const cancelled = decoded === undefined ? undefined : readCancelledId(decoded)
		if (cancelled !== undefined) {
			live.get(cancelled)?.abort()
			return
		}
		const id = decoded === undefined || !('method' in decoded) ? undefined : decoded.id
		const request = new AbortController()
		if (id !== undefined) live.set(id, request)
		try {
			const answer = await server.handle(message, { signal: request.signal })
			if (answer === undefined) return
			// A cancelled request writes nothing — and a held-open answer is RELEASED rather
			// than dropped, because dropping one is exactly the abandonment this binder owns.
			if (typeof answer === 'string') {
				if (!request.signal.aborted) await transport.send(answer)
			} else if (request.signal.aborted) await answer[Symbol.asyncDispose]()
			else await sendStream(answer, transport)
		} catch (error) {
			// A cancellation is not a fault. Once this request has been aborted, whatever the
			// pump raises IS the abort arriving, and reporting it as a contained fault would
			// put an operator's `error` feed one entry behind every peer that cancels.
			if (!request.signal.aborted) {
				try {
					server.emitter.emit('error', error)
				} catch {
					// A throwing `error` listener is the caller's own bug — the end of the line.
				}
			}
		} finally {
			// Only ever retire OUR OWN entry: a peer reusing a live id would otherwise have the
			// first request's exit delete the second request's controller and silence its cancel.
			if (id !== undefined && live.get(id) === request) live.delete(id)
		}
	})
	transport.closed(() => {
		active = false
		for (const pending of live.values()) pending.abort()
		live.clear()
	})
	return () => {
		active = false
		for (const pending of live.values()) pending.abort()
		live.clear()
		transport.listen(() => {})
		transport.closed(() => {})
	}
}

/**
 * Pipes an {@link MCPTransportInterface} into an {@link MCPClientInterface} — every
 * inbound message is decoded and delivered onto the client's OWN transport
 * (`client.transport.emitter`'s `message` / `close` events), resolving/rejecting the
 * client's correlated pending requests exactly as a direct reply would.
 *
 * @remarks
 * The client's outbound writes flow through `client.transport.send` — its existing,
 * unmodified request/response correlation — so `client` must have been constructed
 * with a {@link import('./types.js').MCPClientTransportInterface} that itself carries
 * the SAME `transport` (see {@link import('./factories.js').createDuplexClientTransport},
 * the additive factory that adapts an {@link MCPTransportInterface} into that shape);
 * this binder then completes the inbound half by decoding each message and pushing it
 * onto `client.transport.emitter` (an {@link import('@orkestrel/emitter').EmitterInterface}
 * exposes `emit`, so no client modification is needed). A malformed / non-JSON-RPC
 * inbound message is DROPPED (total — never throws); a delivery fault is routed to
 * `client.transport.emitter`'s `error` event (never rethrown). The returned unbind
 * DETACHES this binder (further inbound messages and the transport's `closed` signal are
 * ignored) WITHOUT closing the transport.
 *
 * `listen`/`closed` are REPLACE semantics (§ port contract): the returned unbind
 * DETACHES by replacing this binder's own handlers with no-ops, so a subsequent
 * `bindClient` call on the SAME transport is never double-dispatched by a stale
 * subscription left behind — an unbind→rebind cycle delivers exactly one `message`
 * emit per inbound reply.
 *
 * **This binder needs no live-request registry, and the asymmetry with {@link bindServer} is
 * real rather than an omission.** A server binder holds the lifetime of work it STARTED, so an
 * inbound `notifications/cancelled` has something to reach; a client binder starts no work —
 * `MCPClient` already owns its pending entries and already writes the cancellation frame
 * itself when a caller's `signal` aborts, on a carrier declaring `duplex`. Adding a registry
 * here would be a second correlation table for ids the client is already correlating, and two
 * tables for one fact drift. The one obligation this binder does carry is delivery: a
 * malformed / non-JSON-RPC inbound message is DROPPED (total — never throws).
 *
 * @param client - The transport-agnostic client whose transport to deliver messages onto
 * @param transport - The duplex channel to pipe the client over
 * @returns Detach this binder from the transport (does not close it)
 *
 * @example
 * ```ts
 * const client = createMCPClient({ transport: createDuplexClientTransport(transport) })
 * const unbind = bindClient(client, transport)
 * await client.connect()
 * // ... later, detach without closing:
 * unbind()
 * ```
 */
export function bindClient(
	client: MCPClientInterface,
	transport: MCPTransportInterface,
): () => void {
	let active = true
	transport.listen((message) => {
		if (!active) return
		let parsed: unknown
		try {
			parsed = JSON.parse(message)
		} catch {
			return
		}
		const decoded = parseJSONRPCMessage(parsed)
		if (decoded === undefined) return
		try {
			client.transport.emitter.emit('message', decoded)
		} catch (error) {
			try {
				client.transport.emitter.emit('error', error)
			} catch {
				// A throwing `error` listener is the caller's own bug — the end of the line.
			}
		}
	})
	transport.closed(() => {
		if (!active) return
		active = false
		try {
			client.transport.emitter.emit('close')
		} catch {
			// A throwing `close` listener is the caller's own bug — the end of the line.
		}
	})
	return () => {
		active = false
		transport.listen(() => {})
		transport.closed(() => {})
	}
}
