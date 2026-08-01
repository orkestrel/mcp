import type {
	ElicitRequest,
	ElicitRequestFormParams,
	ElicitRequestURLParams,
	ElicitPrimitiveSchema,
	ElicitResult,
	InputRequest,
	InputRequiredResult,
	InputRequests,
	JSONRPCMessage,
	JSONRPCRequest,
	JSONRPCResponse,
	MCPVersion,
	SubscriptionFilter,
} from './types.js'
import { arrayOf, isBoolean, isNumber, isRecord, isString, isUndefined } from '@orkestrel/contract'
import { MCP_META_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from './constants.js'

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
 * Determine whether a value is a supported {@link MCPVersion}.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when the value is one of {@link SUPPORTED_PROTOCOL_VERSIONS}
 */
export function isMCPVersion(value: unknown): value is MCPVersion {
	return isString(value) && SUPPORTED_PROTOCOL_VERSIONS.some((version) => version === value)
}

/**
 * Determine whether a value is an MCP {@link SubscriptionFilter}.
 *
 * @remarks
 * Every filter field is optional. Boolean notification families accept only booleans, and
 * `resourceSubscriptions` accepts only an array of string URIs. Unknown fields remain open
 * for protocol extensions and are ignored by the built-in subscription matcher. Total over
 * hostile input.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when every recognized filter field has its protocol shape
 */
export function isSubscriptionFilter(value: unknown): value is SubscriptionFilter {
	if (!isRecord(value)) return false
	const tools = value['toolsListChanged']
	if (!isUndefined(tools) && !isBoolean(tools)) return false
	const prompts = value['promptsListChanged']
	if (!isUndefined(prompts) && !isBoolean(prompts)) return false
	const resources = value['resourcesListChanged']
	if (!isUndefined(resources) && !isBoolean(resources)) return false
	const subscriptions = value['resourceSubscriptions']
	return isUndefined(subscriptions) || arrayOf(isString)(subscriptions)
}

/**
 * Determine whether a client capability record declares form-mode elicitation.
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
	try {
		if (!isRecord(value)) return false
		const elicitation = value['elicitation']
		if (!isRecord(elicitation)) return false
		if (isRecord(elicitation['form'])) return true
		return Object.keys(elicitation).length === 0
	} catch {
		return false
	}
}

/**
 * Determine whether a value is one restricted primitive form-elicitation schema.
 *
 * @param value - The unknown value to inspect
 * @returns `true` for a supported boolean, numeric, string, or string-array schema
 *
 * @example
 * ```ts
 * isElicitPrimitiveSchema({ type: 'boolean', default: true }) // true
 * isElicitPrimitiveSchema({ type: 'object' }) // false
 * ```
 */
export function isElicitPrimitiveSchema(value: unknown): value is ElicitPrimitiveSchema {
	try {
		if (!isRecord(value)) return false
		const title = value['title']
		const description = value['description']
		if (!isUndefined(title) && !isString(title)) return false
		if (!isUndefined(description) && !isString(description)) return false

		const fallback = value['default']
		if (value['type'] === 'boolean') return isUndefined(fallback) || isBoolean(fallback)
		if (value['type'] === 'number' || value['type'] === 'integer') {
			const minimum = value['minimum']
			const maximum = value['maximum']
			return (
				(isUndefined(minimum) || isNumber(minimum)) &&
				(isUndefined(maximum) || isNumber(maximum)) &&
				(isUndefined(fallback) || isNumber(fallback))
			)
		}
		if (value['type'] === 'string') {
			const minimum = value['minLength']
			const maximum = value['maxLength']
			const format = value['format']
			const choices = value['enum']
			const names = value['enumNames']
			const titled = value['oneOf']
			return (
				(isUndefined(minimum) || isNumber(minimum)) &&
				(isUndefined(maximum) || isNumber(maximum)) &&
				(isUndefined(format) ||
					format === 'uri' ||
					format === 'email' ||
					format === 'date' ||
					format === 'date-time') &&
				(isUndefined(fallback) || isString(fallback)) &&
				(isUndefined(choices) || arrayOf(isString)(choices)) &&
				(isUndefined(names) || arrayOf(isString)(names)) &&
				(isUndefined(titled) ||
					(arrayOf(isRecord)(titled) &&
						titled.every((choice) => isString(choice['const']) && isString(choice['title']))))
			)
		}
		if (value['type'] !== 'array') return false
		const minimum = value['minItems']
		const maximum = value['maxItems']
		const items = value['items']
		if (
			(!isUndefined(minimum) && !isNumber(minimum)) ||
			(!isUndefined(maximum) && !isNumber(maximum)) ||
			(!isUndefined(fallback) && !arrayOf(isString)(fallback)) ||
			!isRecord(items)
		) {
			return false
		}
		if (items['type'] === 'string') return arrayOf(isString)(items['enum'])
		const choices = items['anyOf']
		return (
			arrayOf(isRecord)(choices) &&
			choices.every((choice) => isString(choice['const']) && isString(choice['title']))
		)
	} catch {
		return false
	}
}

/**
 * Determine whether a value is a form-mode elicitation parameter object.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when `value` has the restricted form elicitation shape
 *
 * @example
 * ```ts
 * isElicitRequestFormParams({
 *   message: 'Continue?',
 *   requestedSchema: { type: 'object', properties: {} },
 * }) // true
 * ```
 */
export function isElicitRequestFormParams(value: unknown): value is ElicitRequestFormParams {
	try {
		if (!isRecord(value)) return false
		const mode = value['mode']
		if (!isUndefined(mode) && mode !== 'form') return false
		if (!isString(value['message'])) return false
		const schema = value['requestedSchema']
		if (!isRecord(schema) || schema['type'] !== 'object' || !isRecord(schema['properties'])) {
			return false
		}
		const dialect = schema['$schema']
		if (!isUndefined(dialect) && !isString(dialect)) return false
		const required = schema['required']
		return (
			(isUndefined(required) || arrayOf(isString)(required)) &&
			Object.values(schema['properties']).every((property) => isElicitPrimitiveSchema(property))
		)
	} catch {
		return false
	}
}

/**
 * Determine whether a value is a URL-mode elicitation parameter object.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when `value` has the URL elicitation shape
 *
 * @example
 * ```ts
 * isElicitRequestURLParams({ mode: 'url', message: 'Authenticate', url: 'https://example.test' })
 * ```
 */
export function isElicitRequestURLParams(value: unknown): value is ElicitRequestURLParams {
	return (
		isRecord(value) &&
		value['mode'] === 'url' &&
		isString(value['message']) &&
		isString(value['url'])
	)
}

/**
 * Determine whether a value is an embedded `elicitation/create` request.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when `value` is a form- or URL-mode elicitation request
 *
 * @example
 * ```ts
 * isElicitRequest({
 *   method: 'elicitation/create',
 *   params: { message: 'Continue?', requestedSchema: { type: 'object', properties: {} } },
 * }) // true
 * ```
 */
export function isElicitRequest(value: unknown): value is ElicitRequest {
	if (!isRecord(value) || value['method'] !== 'elicitation/create') return false
	return isElicitRequestFormParams(value['params']) || isElicitRequestURLParams(value['params'])
}

/**
 * Determine whether a value is one legal embedded multi-round-trip request.
 *
 * @param value - The unknown value to inspect
 * @returns `true` for elicitation, deprecated sampling, or deprecated roots requests
 *
 * @example
 * ```ts
 * isInputRequest({ method: 'roots/list' }) // true — legal but not produced by this package
 * ```
 */
export function isInputRequest(value: unknown): value is InputRequest {
	if (isElicitRequest(value)) return true
	if (!isRecord(value)) return false
	const params = value['params']
	if (value['method'] === 'sampling/createMessage') return isRecord(params)
	return value['method'] === 'roots/list' && (isUndefined(params) || isRecord(params))
}

/**
 * Determine whether a value is a server-keyed map of embedded input requests.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when every own value is a legal {@link InputRequest}
 *
 * @example
 * ```ts
 * isInputRequests({ confirm: { method: 'roots/list' } }) // true; maps, never arrays
 * ```
 */
export function isInputRequests(value: unknown): value is InputRequests {
	try {
		return isRecord(value) && Object.values(value).every((request) => isInputRequest(request))
	} catch {
		return false
	}
}

/**
 * Determine whether a value is one elicitation response.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when action/content have the protocol shape
 *
 * @example
 * ```ts
 * isElicitResult({ action: 'accept', content: { approved: true } }) // true
 * ```
 */
export function isElicitResult(value: unknown): value is ElicitResult {
	try {
		if (!isRecord(value)) return false
		const action = value['action']
		if (action !== 'accept' && action !== 'decline' && action !== 'cancel') return false
		const content = value['content']
		if (isUndefined(content)) return true
		if (!isRecord(content)) return false
		return Object.values(content).every(
			(item) => isString(item) || isNumber(item) || isBoolean(item) || arrayOf(isString)(item),
		)
	} catch {
		return false
	}
}

/**
 * Determine whether a value is an MCP input-required result.
 *
 * @remarks
 * Enforces the at-least-one-of rule at runtime: `inputRequests`, `requestState`, or
 * both must be present and valid. Total over hostile input.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when `value` is a valid input-required result
 *
 * @example
 * ```ts
 * isInputRequiredResult({ resultType: 'input_required', requestState: 'opaque' }) // true
 * isInputRequiredResult({ resultType: 'input_required' }) // false
 * ```
 */
export function isInputRequiredResult(value: unknown): value is InputRequiredResult {
	try {
		if (!isRecord(value) || value['resultType'] !== 'input_required') return false
		const inputRequests = value['inputRequests']
		const requestState = value['requestState']
		if (!isUndefined(inputRequests) && !isInputRequests(inputRequests)) return false
		if (!isUndefined(requestState) && !isString(requestState)) return false
		return !isUndefined(inputRequests) || !isUndefined(requestState)
	} catch {
		return false
	}
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

/**
 * Determine whether a JSON-RPC request uses the modern per-request MCP wire shape.
 *
 * @remarks
 * Presence routes and validity answers: this guard checks only that
 * `params._meta` carries the reserved protocol-version key. The key's value is
 * deliberately not narrowed here, so a present non-string version remains modern
 * and is rejected later by `parseRequestContext` rather than falling through to
 * legacy dispatch. Total over hostile and malformed input.
 *
 * @param value - The already-parsed value to inspect
 * @returns `true` when the value is a request carrying the reserved version key
 */
export function isModernRequest(value: unknown): value is JSONRPCRequest {
	try {
		if (!isJSONRPCRequest(value)) return false
		const metadata = value.params?.['_meta']
		return isRecord(metadata) && Object.hasOwn(metadata, MCP_META_VERSION)
	} catch {
		return false
	}
}
