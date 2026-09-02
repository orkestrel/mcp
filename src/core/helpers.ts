import type { EmitterInterface } from '@orkestrel/emitter'
import type { SSEParserInterface } from '@orkestrel/sse'
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
	MCPClientCapabilities,
	MCPClientInterface,
	MCPMessageTransportEventMap,
	MCPDiscoverResult,
	MCPDispatchOptions,
	MCPHeaderParameter,
	MCPHeaderPrimitive,
	MCPIdentity,
	MCPInputRequestMap,
	MCPJSONLimitOptions,
	MCPLegacyResult,
	MCPMetaObject,
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
import { decodeBase64, decodeUTF8, encodeBase64, encodeHex } from '@orkestrel/codec'
import { createSSEParser } from '@orkestrel/sse'
import {
	attempt,
	cloneJSONRecord,
	isArray,
	isBoolean,
	isJSONValue,
	isNumber,
	isRecord,
	isString,
	parseJSON,
} from '@orkestrel/contract'
import {
	DEFAULT_MCP_CACHE_TTL,
	DEFAULT_MCP_LIMITS,
	JSONRPC_INVALID_PARAMS,
	MCP_EXTENSION_TASKS,
	MCP_HEADER_ANNOTATION,
	MCP_PARAM_PREFIX,
	MCP_SENTINEL_PREFIX,
	MCP_SENTINEL_SUFFIX,
	MCP_META_CAPABILITIES,
	MCP_META_CLIENT,
	MCP_META_SERVER,
	MCP_META_SUBSCRIPTION,
	MCP_META_VERSION,
	MCP_MODERN_VERSION,
	MCP_HANDSHAKE_VERSION,
	SUPPORTED_MODERN_PROTOCOL_VERSIONS,
} from './constants.js'
import { MCPError } from './errors.js'
import { parseJSONRPCMessage } from './parsers.js'
import {
	isBoundedString,
	isFieldToken,
	isJSONRPCId,
	isJSONRPCNotification,
	isMCPHeaderPrimitive,
	isMCPInputResult,
	isMCPLegacyVersion,
	isMCPMetaObject,
	isMCPTaskNotification,
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
 * Computes the capabilities one round of input requests needs and the client did not declare.
 *
 * @remarks
 * The protocol's rule is about SENDING: a server never issues a request kind the client's
 * declared capabilities exclude. So this reads the round rather than the method, and it
 * answers with the refusal's own payload — the `requiredCapabilities` record a
 * `MissingRequiredClientCapability` error carries, keyed by each missing capability, in the
 * `ClientCapabilities` shape the schema defines rather than as a list of names.
 *
 * Each kind maps to one declaration: `sampling/createMessage` to `sampling`, `roots/list` to
 * `roots`, a form elicitation to what {@link isFormElicitationSupported} accepts, and a
 * URL-mode elicitation to a record-valued `elicitation.url`. A request this package cannot
 * recognize needs nothing, because {@link import('./validators.js').isMCPInputRequestMap}
 * has already refused the round it would have travelled in. Total over hostile input.
 *
 * The `elicitation` value names the ARM the round needs, so a client can act on the refusal
 * by declaring exactly what the payload asks for. A missing URL arm answers `{ url: {} }`, a
 * missing form arm answers the empty record this package reads as form-only, and a round
 * needing both answers `{ form: {}, url: {} }`. An empty record for a URL round would name
 * the declaration a URL-capable client already sent, and refuse the identical round again.
 *
 * @param requests - The round the server is about to issue
 * @param capabilities - The client capability record the request declared
 * @returns The missing capabilities, or `undefined` when the client declared every one
 *
 * @example
 * ```ts
 * computeMissingCapabilities({ answer: { method: 'roots/list' } }, {}) // { roots: {} }
 * computeMissingCapabilities({ answer: { method: 'roots/list' } }, { roots: {} }) // undefined
 * ```
 */
export function computeMissingCapabilities(
	requests: MCPInputRequestMap,
	capabilities: unknown,
): MCPClientCapabilities | undefined {
	const owned = attempt(() => cloneJSONRecord(capabilities))
	const declared: Readonly<Record<string, unknown>> = owned.success ? owned.value : {}
	const missing: Record<string, MCPMetaObject> = {}
	let formUndeclared = false
	let urlUndeclared = false
	for (const request of Object.values(requests)) {
		if (request.method === 'sampling/createMessage') {
			if (!isRecord(declared['sampling'])) missing['sampling'] = {}
			continue
		}
		if (request.method === 'roots/list') {
			if (!isRecord(declared['roots'])) missing['roots'] = {}
			continue
		}
		const elicitation = declared['elicitation']
		if (request.params.mode === 'url') {
			if (!isRecord(elicitation) || !isRecord(elicitation['url'])) urlUndeclared = true
			continue
		}
		if (!isFormElicitationSupported(declared)) formUndeclared = true
	}
	if (formUndeclared && !urlUndeclared) missing['elicitation'] = {}
	if (urlUndeclared && !formUndeclared) missing['elicitation'] = { url: {} }
	if (formUndeclared && urlUndeclared) missing['elicitation'] = { form: {}, url: {} }
	return Object.keys(missing).length === 0 ? undefined : Object.freeze(missing)
}

/**
 * Determines whether a client capability record declares the stable Tasks extension.
 *
 * @remarks
 * The declaration lives at `extensions['io.modelcontextprotocol/tasks']` and the schema
 * types its value EXACTLY EMPTY — `Record<string, never>`, an object with no additional
 * properties. So the key's presence is the whole declaration, and the value carries the
 * whole of the check: a `true` or a string there is a client speaking a different protocol
 * rather than a shorthand, and a member inside the object is a client declaring an option
 * this extension does not define. Both are refused, because a server that accepted either
 * would be reading a shape no peer can produce from the snapshot's own schema.
 *
 * A client declares this PER REQUEST. Nothing here consults a session, because the modern
 * revision is stateless and a capability declared once at connect time says nothing about
 * the request in hand. Total over hostile input.
 *
 * @param value - The client capability record to inspect
 * @returns `true` when the tasks extension is declared as the schema's empty object
 *
 * @example
 * ```ts
 * isTaskSupported({ extensions: { 'io.modelcontextprotocol/tasks': {} } }) // true
 * isTaskSupported({ extensions: {} }) // false — the key is the declaration
 * isTaskSupported({ extensions: { 'io.modelcontextprotocol/tasks': { on: true } } }) // false
 * ```
 */
export function isTaskSupported(value: unknown): boolean {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const extensions = owned.value['extensions']
		if (!isRecord(extensions)) return false
		const declaration = extensions[MCP_EXTENSION_TASKS]
		return isRecord(declaration) && Object.keys(declaration).length === 0
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
	return encodeHex(new Uint8Array(digest))
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
 * {@link import('./types.js').MCPMessageTransportInterface.duplex}. On Streamable HTTP the
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
 * @param enabled - If `true`, carries the requested task identifiers into the filter; if `false`,
 *   omits them. Default: `false`
 * @returns The exact subset the server will honour
 */
export function buildSubscriptionFilter(
	requested: MCPSubscriptionFilter,
	supported: MCPSubscriptionFilter,
	enabled = false,
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
	const taskIds = enabled ? requested.taskIds : undefined
	return {
		...(toolsListChanged ? { toolsListChanged: true } : {}),
		...(promptsListChanged ? { promptsListChanged: true } : {}),
		...(resourcesListChanged ? { resourcesListChanged: true } : {}),
		...(resourceSubscriptions !== undefined && resourceSubscriptions.length > 0
			? { resourceSubscriptions }
			: {}),
		...(taskIds !== undefined && taskIds.length > 0 ? { taskIds } : {}),
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
	if (notification.method === 'notifications/resources/updated') {
		const uri = notification.params?.['uri']
		return typeof uri === 'string' && filter.resourceSubscriptions?.includes(uri) === true
	}
	if (notification.method === 'notifications/tasks') {
		return (
			isMCPTaskNotification(notification) &&
			filter.taskIds?.includes(notification.params.taskId) === true
		)
	}
	return false
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
			supportedVersions: SUPPORTED_MODERN_PROTOCOL_VERSIONS,
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
	const protocolVersion = isMCPLegacyVersion(requested) ? requested : MCP_HANDSHAKE_VERSION
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
 * parsed at all: a decoder that parses before it measures has already spent the work
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
	return parseJSONRPCMessage(parseJSON(message), limits)
}

/**
 * Decodes one inbound frame and delivers it onto a transport emitter as `message` or `error`.
 *
 * @remarks
 * The ONE inbound fold every message-carrying transport in this package runs: parse the frame,
 * narrow it with `parseJSONRPCMessage`, emit `message` for a well-formed
 * {@link JSONRPCMessage}, and emit `error` for anything else. Total — an adversarial frame
 * produces an `error` emission and never a throw.
 *
 * The two failures report differently on purpose. Unparsable text emits the CAUGHT parse
 * error, which names the offending position; well-formed JSON that is not a JSON-RPC message
 * has no caught value to report, so it emits `fault` — the carrier's own wording, passed in
 * rather than forked into a second copy of this body.
 *
 * @param emitter - The transport's emitter to deliver onto
 * @param text - One inbound frame's raw text
 * @param fault - The message for the error emitted when the frame parses but is not JSON-RPC
 *
 * @example
 * ```ts
 * deliverMessage(transport.emitter, frame, 'non-JSON-RPC WebSocket frame')
 * ```
 */
export function deliverMessage(
	emitter: EmitterInterface<MCPMessageTransportEventMap>,
	text: string,
	fault: string,
): void {
	// The one boundary in this package that keeps its own `try`: the caught value IS the
	// report here, so `parseJSON`'s `undefined` would discard what this emit exists to carry.
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch (error) {
		emitter.emit('error', error)
		return
	}
	const message = parseJSONRPCMessage(parsed)
	if (message === undefined) {
		emitter.emit('error', new Error(fault))
		return
	}
	emitter.emit('message', message)
}

/**
 * Decodes one SSE event's `data` string into a {@link JSONRPCMessage}, or `undefined`
 * when it is not one — the per-event step {@link readEventStream} folds over.
 *
 * @remarks
 * Parses the `data` (a peer serializes the JSON-RPC envelope as the event's `data`) with
 * `@orkestrel/contract`'s `parseJSON` — the declared JSON boundary, which answers `undefined`
 * instead of throwing — and narrows the parsed value with `parseJSONRPCMessage`. Total:
 * malformed JSON or a non-message value yields `undefined`, never throws.
 *
 * @param data - One SSE event's `data` payload
 * @returns The decoded {@link JSONRPCMessage}, or `undefined`
 *
 * @example
 * ```ts
 * decodeEvent('{"jsonrpc":"2.0","id":1,"result":{}}') // the decoded response
 * ```
 */
export function decodeEvent(data: string): JSONRPCMessage | undefined {
	return parseJSONRPCMessage(parseJSON(data))
}

/**
 * Decodes a `fetch` Response's Server-Sent-Events body into the JSON-RPC messages it
 * carried — the CLIENT-side inverse of a server's Streamable-HTTP SSE response.
 *
 * @remarks
 * Reads the whole `response.body` stream chunk-by-chunk through a `TextDecoder({ stream: true
 * })` (handling a multi-byte character split across reads) and `@orkestrel/sse`'s
 * {@link SSEParserInterface} (handling a partial line or in-progress event split across
 * reads), then narrows each dispatched event's `data` to a {@link JSONRPCMessage} through
 * {@link decodeEvent} (so a non-message or non-JSON `data:` event is DROPPED, never thrown —
 * total). It reuses the SAME `SSEParser` a server's `createStream` seam serializes against, so
 * the wire round-trips. A `null` body (no stream) yields no messages;
 * {@link import('./transports/HTTPClientTransport.js').HTTPClientTransport} reads a
 * request/response SSE reply (the server sends one `data:` event then ends), so this drains to
 * completion.
 *
 * @param response - The SSE `fetch` Response to decode (its `body` is read to completion)
 * @returns Every {@link JSONRPCMessage} the stream carried, in order
 *
 * @example
 * ```ts
 * const messages = await readEventStream(await fetch(url, { method: 'POST', body }))
 * ```
 */
export async function readEventStream(response: Response): Promise<readonly JSONRPCMessage[]> {
	const body = response.body
	if (body === null) return []
	const reader = body.getReader()
	const decoder = new TextDecoder()
	const parser: SSEParserInterface = createSSEParser()
	const messages: JSONRPCMessage[] = []
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			for (const event of parser.parse(decoder.decode(value, { stream: true }))) {
				// JSON-parse the event's `data` (the JSON-RPC envelope the peer wrote), then narrow
				// it — a malformed or non-message payload is dropped, never thrown.
				const message = decodeEvent(event.data)
				if (message !== undefined) messages.push(message)
			}
		}
	} finally {
		reader.releaseLock()
	}
	return messages
}

/**
 * Builds the error for a non-success HTTP response that carried no JSON-RPC message.
 *
 * @param response - The response whose status is reported
 * @param type - The response's content type, or an empty string when absent
 * @returns An error naming the HTTP status and unsupported response shape
 *
 * @example
 * ```ts
 * const error = buildResponseError(new Response('', { status: 500 }), '')
 * ```
 */
export function buildResponseError(response: Response, type: string): Error {
	if (type.includes('application/json')) {
		return new Error(
			`HTTP ${response.status} response contained an application/json body that was not a JSON-RPC message`,
		)
	}
	if (type.includes('text/event-stream')) {
		return new Error(
			`HTTP ${response.status} response contained a text/event-stream body without a JSON-RPC message`,
		)
	}
	const shape = type === '' ? 'a body without a content type' : `an unsupported '${type}' body`
	return new Error(`HTTP ${response.status} response contained ${shape}`)
}

/**
 * Reads the value one standard MCP request header carries, decoding the Base64 sentinel.
 *
 * @remarks
 * The sentinel format is `=?base64?{Base64OfUTF8}?=`, spelled once as
 * {@link MCP_SENTINEL_PREFIX} and {@link MCP_SENTINEL_SUFFIX} and read from there by both
 * directions of the codec.
 * The markers alone decide whether a value is a sentinel: a value carrying the prefix and the
 * suffix is one, and its payload is then held to `decodeBase64` from `@orkestrel/codec` — the
 * canonical RFC 4648 § 4 grammar, which admits exactly one spelling per byte sequence — and to
 * well-formed UTF-8. A payload leaving a non-zero bit in the sextet its padding discards is a
 * second spelling of a byte, so it is refused: `=?base64?QR==?=` reaches for the byte
 * `=?base64?QQ==?=` spells canonically, and only the canonical spelling decodes. A malformed
 * payload answers `undefined` rather than falling back to the literal, because the protocol
 * requires a server to REJECT invalid characters, and a fallback would admit the very value
 * the rule exists to refuse. A value missing either marker is a literal and comes back
 * unchanged.
 *
 * `decodeUTF8` from `@orkestrel/codec` reads the bytes back as text: strict RFC 3629, where an
 * overlong, an encoded surrogate, a code point past U+10FFFF, and a truncated sequence each
 * answer `undefined` rather than a replacement character, and total, so the refusal arrives as
 * that value instead of as a throw. It also keeps a leading U+FEFF as a character of the
 * value, where the platform decoder consumes it as a byte order mark — which is what lets a
 * value leading with U+FEFF survive {@link encodeSentinel} and come back whole.
 *
 * {@link import('./validators.js').isStandardBase64} is a wider and separate rule: it names
 * JSON Schema `byte` membership for the blob, image, and audio content a peer sends, where
 * this package receives liberally. It does not govern this payload.
 *
 * Optional whitespace is excluded first, per RFC 9110 § 5.5: a recipient parses a field value
 * with its surrounding spaces and horizontal tabs removed, so a peer that padded a plain value
 * still matches the body. A value whose own leading or trailing whitespace is significant
 * cannot survive that, which is what {@link encodeSentinel} encodes it for.
 *
 * Total — never throws, whatever the input.
 *
 * @param value - The raw header field value the peer sent
 * @returns The carried value, or `undefined` when the sentinel's payload is invalid
 *
 * @example
 * ```ts
 * decodeSentinel('=?base64?Y2Fmw6k=?=') // 'café'
 * decodeSentinel('  search  ') // 'search' — optional whitespace excluded
 * decodeSentinel('=?base64?SGVsbG8?=') // undefined — invalid padding
 * decodeSentinel('=?base64?QR==?=') // undefined — a non-canonical spelling
 * ```
 */
export function decodeSentinel(value: string): string | undefined {
	const field = value.replace(/^[ \t]+|[ \t]+$/g, '')
	const marked =
		field.length >= MCP_SENTINEL_PREFIX.length + MCP_SENTINEL_SUFFIX.length &&
		field.startsWith(MCP_SENTINEL_PREFIX) &&
		field.endsWith(MCP_SENTINEL_SUFFIX)
	if (!marked) return field
	const payload = field.slice(MCP_SENTINEL_PREFIX.length, field.length - MCP_SENTINEL_SUFFIX.length)
	const bytes = decodeBase64(payload)
	if (bytes === undefined) return undefined
	return decodeUTF8(bytes)
}

/**
 * Builds the wire form one standard MCP request header value must travel as.
 *
 * @remarks
 * The exact inverse of {@link decodeSentinel}, and its membership rule is stated as that
 * inverse rather than as a second list that could drift: a value travels LITERALLY when it is
 * plain printable ASCII — every code point in `U+0020`–`U+007E`, the RFC 9110 field-value
 * range this package admits — and {@link decodeSentinel} gives it back unchanged. Every other
 * value travels wrapped in {@link MCP_SENTINEL_PREFIX} and {@link MCP_SENTINEL_SUFFIX}, the
 * same markers the decode recognizes a sentinel by. `encodeBase64` from `@orkestrel/codec`
 * spells the payload, so the wire form carries the canonical spelling {@link decodeSentinel}
 * accepts.
 *
 * That one rule covers each row of the protocol's encoding table. A non-ASCII value and a
 * value carrying a control character fail the ASCII test. A value with leading or trailing
 * whitespace comes back trimmed, so it fails the round trip. A value already wearing the
 * sentinel markers decodes to something else, or to nothing, so it fails the round trip too
 * and is encoded rather than read back as a sentinel it never was.
 *
 * The bytes come from the platform `TextEncoder`, not from codec's `encodeUTF8`, and that is a
 * ruling rather than an oversight. `TextEncoder` is total: it spells ill-formed text — a lone
 * surrogate, which has no UTF-8 spelling — with the replacement character, so this function
 * answers a `string` for every input. `encodeUTF8` refuses that text with `undefined`, which
 * would widen this return to `string | undefined` and oblige every header projection to handle
 * a value it cannot send. The decode side carries no such tension, so it reads back through
 * codec's strict `decodeUTF8`.
 *
 * @param value - The value the header must carry
 * @returns The literal value, or its Base64 sentinel form
 *
 * @example
 * ```ts
 * encodeSentinel('search') // 'search'
 * encodeSentinel('café') // '=?base64?Y2Fmw6k=?='
 * ```
 */
export function encodeSentinel(value: string): string {
	if (/^[ -~]*$/.test(value) && decodeSentinel(value) === value) return value
	const payload = encodeBase64(new TextEncoder().encode(value))
	return `${MCP_SENTINEL_PREFIX}${payload}${MCP_SENTINEL_SUFFIX}`
}

/**
 * Counts every {@link MCP_HEADER_ANNOTATION} key one JSON value carries, at any position.
 *
 * @remarks
 * The companion of {@link extractHeaderAnnotations}, which reads only the annotations a
 * `properties` chain reaches. Comparing the two answers is how
 * {@link buildHeaderParameters} decides reachability without a second walk that would have
 * to re-state which JSON Schema keywords are traversable: an annotation the reachable walk
 * did not read is one sitting under `items`, a composition or conditional keyword, a `$ref`
 * target, or any other position, and the protocol makes the whole tool definition invalid for
 * it.
 *
 * Iterative and ancestor-tracked, so a deeply nested or self-referential value terminates
 * rather than exhausting the stack. Total — never throws, whatever the input.
 *
 * @param value - The value to scan, normally a tool's `inputSchema`
 * @returns How many annotation keys the value carries
 *
 * @example
 * ```ts
 * countHeaderAnnotations({ properties: { region: { 'x-mcp-header': 'Region' } } }) // 1
 * ```
 */
export function countHeaderAnnotations(value: unknown): number {
	let total = 0
	const seen = new Set<object>()
	const pending: unknown[] = [value]
	while (pending.length > 0) {
		const node = pending.pop()
		if (isArray(node)) {
			if (seen.has(node)) continue
			seen.add(node)
			for (const item of node) pending.push(item)
			continue
		}
		if (!isRecord(node) || seen.has(node)) continue
		seen.add(node)
		for (const [key, member] of Object.entries(node)) {
			if (key === MCP_HEADER_ANNOTATION) total += 1
			else pending.push(member)
		}
	}
	return total
}

/**
 * Reads every `x-mcp-header` annotation reachable from a schema node through `properties`.
 *
 * @remarks
 * Reachability is the protocol's own rule: an annotation counts only where a chain of
 * `properties` keys leads to it from the `inputSchema` root, so `path` is both the schema
 * position and the position the call's `arguments` carry the value at. A property named
 * `items` is reachable like any other, because the chain is read by key POSITION rather than
 * by key name.
 *
 * `undefined` means the definition is invalid rather than empty: a reachable annotation whose
 * value is not an {@link import('./validators.js').isFieldToken} token, one sitting on the
 * schema ROOT (which is no property), one on a leaf whose declared type is not an
 * {@link import('./validators.js').isMCPHeaderPrimitive} primitive, or a chain deeper than
 * `DEFAULT_MCP_LIMITS.depth` — which is also what makes a self-referential schema terminate.
 * A node that is not a record carries nothing and answers an empty list, because a leaf the
 * walk cannot read is not a violation.
 *
 * @param schema - The schema node to read
 * @param path - The `properties` keys already traversed; the root is called with `[]`
 * @returns The annotations reachable from this node, or `undefined` when one is invalid
 *
 * @example
 * ```ts
 * extractHeaderAnnotations({ properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } }, [])
 * // → [{ name: 'Region', path: ['region'], primitive: 'string' }]
 * ```
 */
export function extractHeaderAnnotations(
	schema: unknown,
	path: readonly string[],
): readonly MCPHeaderParameter[] | undefined {
	if (path.length > DEFAULT_MCP_LIMITS.depth) return undefined
	if (!isRecord(schema)) return []
	const found: MCPHeaderParameter[] = []
	const annotation = schema[MCP_HEADER_ANNOTATION]
	if (annotation !== undefined) {
		if (path.length === 0 || !isFieldToken(annotation)) return undefined
		const primitive = schema['type']
		if (!isMCPHeaderPrimitive(primitive)) return undefined
		found.push({ name: annotation, path, primitive })
	}
	const properties = schema['properties']
	if (isRecord(properties)) {
		for (const [key, leaf] of Object.entries(properties)) {
			const nested = extractHeaderAnnotations(leaf, [...path, key])
			if (nested === undefined) return undefined
			found.push(...nested)
		}
	}
	return found
}

/**
 * Builds the `x-mcp-header` projections one tool's `inputSchema` declares.
 *
 * @remarks
 * The single decision both sides of the protocol make about an annotated tool: an HTTP
 * CLIENT excludes a definition this refuses from the `tools/list` result it delivers, and a
 * SERVER recognizes exactly the `Mcp-Param-*` names this returns for its own definitions.
 *
 * `undefined` means the definition is invalid, and every rule the protocol states produces
 * it: a value that is not an RFC 9110 token, a non-primitive or untyped annotated leaf, a
 * name repeated case-insensitively within the schema, an annotation the `properties` chain
 * does not reach, and a schema that is not a record at all. An empty list is the valid answer
 * for a schema carrying no annotation.
 *
 * Total — never throws, and a cyclic or stack-hostile schema is refused rather than followed.
 *
 * @param schema - The tool's advertised `inputSchema`
 * @returns The declared projections, or `undefined` when the definition is invalid
 *
 * @example
 * ```ts
 * buildHeaderParameters({
 * 	type: 'object',
 * 	properties: { region: { type: 'string', 'x-mcp-header': 'Region' } },
 * }) // → [{ name: 'Region', path: ['region'], primitive: 'string' }]
 * ```
 */
export function buildHeaderParameters(schema: unknown): readonly MCPHeaderParameter[] | undefined {
	if (!isRecord(schema)) return undefined
	const found = extractHeaderAnnotations(schema, [])
	if (found === undefined || found.length !== countHeaderAnnotations(schema)) return undefined
	const taken = new Set<string>()
	for (const parameter of found) {
		const key = parameter.name.toLowerCase()
		if (taken.has(key)) return undefined
		taken.add(key)
	}
	return found
}

/**
 * Renders one projected argument as the text its `Mcp-Param-*` header carries.
 *
 * @remarks
 * The protocol's conversion table, and the ONE place it is stated: a string travels as
 * itself, an integer in decimal, and a boolean as lowercase `true` or `false`. The value's
 * runtime shape must match the leaf's declared type, so a schema that declares `integer` and
 * an argument that supplies a string, a fraction, or a magnitude outside the IEEE 754 safe
 * range carries NOTHING — a header that cannot round-trip the body value is worse than an
 * absent one, and the tool's own argument validation owns the disagreement.
 *
 * @param value - The argument value read at the parameter's path
 * @param primitive - The leaf's declared type
 * @returns The header text, or `undefined` when the value cannot travel as that type
 *
 * @example
 * ```ts
 * renderHeaderValue(42, 'integer') // '42'
 * renderHeaderValue(false, 'boolean') // 'false'
 * ```
 */
export function renderHeaderValue(
	value: unknown,
	primitive: MCPHeaderPrimitive,
): string | undefined {
	if (primitive === 'string') return isString(value) ? value : undefined
	if (primitive === 'boolean') return isBoolean(value) ? (value ? 'true' : 'false') : undefined
	return isNumber(value) && Number.isSafeInteger(value) ? String(value) : undefined
}

/**
 * Builds the `Mcp-Param-*` request headers one `tools/call` carries.
 *
 * @remarks
 * The projection SEP-2243 requires of an HTTP client, and the same derivation a server runs
 * to know what the request should have carried. Each parameter's value is read at its exact
 * property path in the call's own `arguments`; an absent or `null` value omits its header
 * entirely, which is the protocol's distinction between "not supplied" and "supplied empty".
 * The rendered text then travels through {@link encodeSentinel}, so a value carrying
 * non-ASCII, control, or edge whitespace characters reaches the peer intact.
 *
 * @param parameters - The projections the tool's `inputSchema` declares
 * @param values - The call's `arguments` record
 * @returns The header field names and values, empty when nothing projects
 *
 * @example
 * ```ts
 * buildHeaderProjection(
 * 	[{ name: 'Region', path: ['region'], primitive: 'string' }],
 * 	{ region: 'us-west1' },
 * ) // → { 'Mcp-Param-Region': 'us-west1' }
 * ```
 */
export function buildHeaderProjection(
	parameters: readonly MCPHeaderParameter[],
	values: unknown,
): Readonly<Record<string, string>> {
	const headers: Record<string, string> = {}
	for (const parameter of parameters) {
		let carried: unknown = values
		for (const key of parameter.path) carried = isRecord(carried) ? carried[key] : undefined
		if (carried === undefined || carried === null) continue
		const text = renderHeaderValue(carried, parameter.primitive)
		if (text !== undefined) headers[`${MCP_PARAM_PREFIX}${parameter.name}`] = encodeSentinel(text)
	}
	return headers
}

/**
 * Reads one named tool's advertised `inputSchema` out of a `tools/list` answer.
 *
 * @remarks
 * The answer is read as foreign data end to end — a dispatched response, an error envelope,
 * and a result whose `tools` member is absent or is not an array all read as "no schema"
 * rather than as a fault. That is what lets the HTTP POST handler ask its own dispatcher
 * which `Mcp-Param-*` names a `tools/call` may carry without narrowing anything first.
 *
 * @param response - The `tools/list` answer, normally a {@link JSONRPCResponse}
 * @param name - The tool whose schema to read
 * @returns The advertised `inputSchema`, or `undefined` when the answer carries none
 *
 * @example
 * ```ts
 * extractToolSchema(answer, 'search')?.['properties']
 * ```
 */
export function extractToolSchema(
	response: unknown,
	name: string,
): Readonly<Record<string, unknown>> | undefined {
	const result = isRecord(response) ? response['result'] : undefined
	const tools = isRecord(result) ? result['tools'] : undefined
	if (!isArray(tools)) return undefined
	for (const tool of tools) {
		if (!isRecord(tool) || tool['name'] !== name) continue
		const schema = tool['inputSchema']
		return isRecord(schema) ? schema : undefined
	}
	return undefined
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
 * with a {@link import('./types.js').MCPMessageTransportInterface} that itself carries
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
