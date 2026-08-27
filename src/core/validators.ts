import type { JSONValue } from '@orkestrel/contract'
import type {
	JSONRPCError,
	JSONRPCErrorResponse,
	JSONRPCId,
	JSONRPCInvocation,
	JSONRPCMessage,
	JSONRPCNotification,
	JSONRPCRequest,
	JSONRPCResponse,
	JSONRPCResultResponse,
	MCPAnnotations,
	MCPBlobResource,
	MCPCallResult,
	MCPClientCapabilities,
	MCPCompletion,
	MCPCompletionParams,
	MCPCompletionReference,
	MCPCompletionResult,
	MCPContent,
	MCPElicitFieldSchema,
	MCPElicitForm,
	MCPElicitRequest,
	MCPElicitResult,
	MCPElicitSchema,
	MCPElicitURL,
	MCPElicitValue,
	MCPHeaderPrimitive,
	MCPIcon,
	MCPIdentity,
	MCPInputRequest,
	MCPInputRequestMap,
	MCPInputResponse,
	MCPInputResult,
	MCPJSONLimitOptions,
	MCPLegacyResult,
	MCPLoggingLevel,
	MCPMetaObject,
	MCPNotificationMetaObject,
	MCPProgress,
	MCPPaginationParams,
	MCPPrompt,
	MCPPromptArgument,
	MCPPromptGetResult,
	MCPPromptMessage,
	MCPPromptPage,
	MCPResource,
	MCPResourceContents,
	MCPResourcePage,
	MCPResourceTemplate,
	MCPResourceTemplatePage,
	MCPResult,
	MCPResultMetaObject,
	MCPRoot,
	MCPRootResult,
	MCPSampleContent,
	MCPSampleResult,
	MCPServerCapabilities,
	MCPSubscriptionFilter,
	MCPSubscriptionResult,
	MCPTaskDetail,
	MCPTaskDetailResult,
	MCPTaskNotificationParams,
	MCPTaskResult,
	MCPTaskStatus,
	MCPTextResource,
	MCPLegacyVersion,
	MCPModernVersion,
	MCPVersion,
} from './types.js'
import {
	arrayOf,
	attempt,
	cloneJSONRecord,
	isBoolean,
	isFiniteNumber,
	isInteger,
	isRecord,
	isString,
	isUndefined,
} from '@orkestrel/contract'
import {
	MCP_META_SUBSCRIPTION,
	MCP_META_SERVER,
	MCP_META_VERSION,
	SUPPORTED_MCP_VERSIONS,
	SUPPORTED_LEGACY_PROTOCOL_VERSIONS,
	SUPPORTED_MODERN_PROTOCOL_VERSIONS,
} from './constants.js'
import { serializeJSON } from './helpers.js'

/** Determines whether a value is an exact finite JSON object. */
export function isJSONObject(value: unknown): value is Readonly<Record<string, JSONValue>> {
	return attempt(() => cloneJSONRecord(value)).success
}

/** Determines whether a string follows the dated MCP `_meta` key grammar. */
export function isMCPMetaKey(value: unknown): value is string {
	if (!isString(value)) return false
	const slash = value.indexOf('/')
	if (slash !== value.lastIndexOf('/')) return false
	const name = slash < 0 ? value : value.slice(slash + 1)
	if (slash >= 0) {
		const prefix = value.slice(0, slash)
		if (prefix.length === 0) return false
		for (const label of prefix.split('.')) {
			if (!/^[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) return false
		}
	}
	return name.length === 0 || /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(name)
}

/** Determines whether a value is exact finite MCP metadata with valid keys. */
export function isMCPMetaObject(value: unknown): value is MCPMetaObject {
	const owned = attempt(() => cloneJSONRecord(value))
	return owned.success && Object.keys(owned.value).every((key) => isMCPMetaKey(key))
}

/** Determines whether a value is exact result metadata with a valid reserved server identity. */
export function isMCPResultMetaObject(value: unknown): value is MCPResultMetaObject {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success || !Object.keys(owned.value).every((key) => isMCPMetaKey(key))) return false
	const identity = owned.value[MCP_META_SERVER]
	return isUndefined(identity) || isMCPIdentity(identity)
}

/**
 * Determines whether a value is exact notification metadata with a valid reserved
 * subscription id.
 *
 * @remarks
 * The reserved key is OPTIONAL, so a frame delivered outside a `subscriptions/listen`
 * stream passes with no stamp at all. When the key IS present its value must be a valid
 * {@link JSONRPCId}, because a stamp naming nothing addressable is worse than no stamp.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when the value is exact metadata whose subscription stamp, if present, is valid
 *
 * @example
 * ```ts
 * isMCPNotificationMetaObject({}) // true — an unstamped frame carries no subscription
 * isMCPNotificationMetaObject({ 'io.modelcontextprotocol/subscriptionId': 7 }) // true
 * isMCPNotificationMetaObject({ 'io.modelcontextprotocol/subscriptionId': null }) // false
 * ```
 */
export function isMCPNotificationMetaObject(value: unknown): value is MCPNotificationMetaObject {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success || !Object.keys(owned.value).every((key) => isMCPMetaKey(key))) return false
	const subscription = owned.value[MCP_META_SUBSCRIPTION]
	return isUndefined(subscription) || isJSONRPCId(subscription)
}

/** Determines whether a value is one dated MCP logging level. */
export function isMCPLoggingLevel(value: unknown): value is MCPLoggingLevel {
	return (
		value === 'debug' ||
		value === 'info' ||
		value === 'notice' ||
		value === 'warning' ||
		value === 'error' ||
		value === 'critical' ||
		value === 'alert' ||
		value === 'emergency'
	)
}

/**
 * Determines whether a value is standard padded base64 as required by JSON Schema `byte` format.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is an empty or completely padded standard base64 encoding
 */
export function isStandardBase64(value: unknown): value is string {
	return (
		isString(value) &&
		/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
	)
}

/**
 * Determines whether a value is one RFC 9110 field token.
 *
 * @remarks
 * A token is one or more `tchar`: the ASCII letters, the digits, and
 * ``!#$%&'*+-.^_`|~``. That set already excludes the empty string, whitespace, a colon, a
 * control character, and every non-ASCII code point, so it is the whole constraint an
 * `x-mcp-header` annotation's value must satisfy — the value is appended verbatim to
 * {@link MCP_PARAM_PREFIX} and must survive as an HTTP field name.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is a non-empty RFC 9110 token
 *
 * @example
 * ```ts
 * isFieldToken('Region') // true
 * isFieldToken('My Region') // false
 * ```
 */
export function isFieldToken(value: unknown): value is string {
	return isString(value) && /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)
}

/**
 * Determines whether a value is a JSON Schema type an `x-mcp-header` annotation may sit on.
 *
 * @remarks
 * `number` is refused deliberately: a JSON number has no interoperable decimal text form, so
 * a header carrying one could not be compared with the body byte for byte. `integer` renders
 * exactly, and the server compares it numerically.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is one of `'string'`, `'integer'`, or `'boolean'`
 *
 * @example
 * ```ts
 * isMCPHeaderPrimitive('integer') // true
 * isMCPHeaderPrimitive('number') // false
 * ```
 */
export function isMCPHeaderPrimitive(value: unknown): value is MCPHeaderPrimitive {
	return value === 'string' || value === 'integer' || value === 'boolean'
}

/**
 * Determines whether a value is one absolute URI under RFC 3986 syntax.
 *
 * @remarks
 * This host-neutral syntax guard does not resolve, normalize, decode, fetch, or apply a
 * scheme allowlist. Component scanning is bounded by the input length.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is an RFC 3986 URI rather than a relative reference
 */
export function isAbsoluteURI(value: unknown): value is string {
	if (!isString(value) || value.length === 0) return false
	const separator = value.indexOf(':')
	if (separator <= 0 || !/^[A-Za-z][A-Za-z0-9+.-]*$/.test(value.slice(0, separator))) {
		return false
	}
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index)
		if (code <= 0x20 || code >= 0x7f) return false
		if (value[index] === '%') {
			const escape = value.slice(index + 1, index + 3)
			if (escape.length !== 2 || !/^[0-9A-Fa-f]{2}$/.test(escape)) return false
			index += 2
		}
	}
	if (!/^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*$/.test(value)) return false

	const fragmentIndex = value.indexOf('#', separator + 1)
	if (fragmentIndex >= 0 && fragmentIndex !== value.lastIndexOf('#')) return false
	const beforeFragment = fragmentIndex < 0 ? value : value.slice(0, fragmentIndex)
	const fragment = fragmentIndex < 0 ? undefined : value.slice(fragmentIndex + 1)
	const queryIndex = beforeFragment.indexOf('?', separator + 1)
	const beforeQuery = queryIndex < 0 ? beforeFragment : beforeFragment.slice(0, queryIndex)
	const query = queryIndex < 0 ? undefined : beforeFragment.slice(queryIndex + 1)
	const hierarchy = beforeQuery.slice(separator + 1)
	for (const component of [query, fragment]) {
		if (component !== undefined && !/^[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]*$/.test(component)) {
			return false
		}
	}

	if (!hierarchy.startsWith('//')) {
		return /^[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*$/.test(hierarchy)
	}

	const authorityEnd = hierarchy.indexOf('/', 2)
	const authority = authorityEnd < 0 ? hierarchy.slice(2) : hierarchy.slice(2, authorityEnd)
	const path = authorityEnd < 0 ? '' : hierarchy.slice(authorityEnd)
	if (!/^[A-Za-z0-9\-._~!$&'()*+,;=:@/%]*$/.test(path)) return false
	const at = authority.lastIndexOf('@')
	if (at !== authority.indexOf('@')) return false
	const userinfo = at < 0 ? undefined : authority.slice(0, at)
	const hostport = at < 0 ? authority : authority.slice(at + 1)
	if (userinfo !== undefined && !/^[A-Za-z0-9\-._~!$&'()*+,;=:%]*$/.test(userinfo)) {
		return false
	}

	if (hostport.startsWith('[')) {
		const close = hostport.indexOf(']')
		if (close < 0) return false
		const literal = hostport.slice(1, close)
		const remainder = hostport.slice(close + 1)
		if (remainder.length > 0 && !/^:[0-9]*$/.test(remainder)) return false
		if (/^[vV][0-9A-Fa-f]+\.[A-Za-z0-9\-._~!$&'()*+,;=:]+$/.test(literal)) return true
		if (literal.includes('%') || literal.includes('[') || literal.includes(']')) return false
		const elision = literal.indexOf('::')
		if (elision !== literal.lastIndexOf('::')) return false
		const compressed = elision >= 0
		let groups: string[]
		if (compressed) {
			const left = literal.slice(0, elision)
			const right = literal.slice(elision + 2)
			if (
				(left.length > 0 && (left.startsWith(':') || left.endsWith(':'))) ||
				(right.length > 0 && (right.startsWith(':') || right.endsWith(':')))
			)
				return false
			groups = [
				...(left.length === 0 ? [] : left.split(':')),
				...(right.length === 0 ? [] : right.split(':')),
			]
		} else {
			if (literal.startsWith(':') || literal.endsWith(':')) return false
			groups = literal.split(':')
		}
		let units = 0
		for (let index = 0; index < groups.length; index += 1) {
			const group = groups[index]
			if (group === undefined || group.length === 0) return false
			if (group.includes('.')) {
				if (index !== groups.length - 1) return false
				const octets = group.split('.')
				if (octets.length !== 4) return false
				for (const octet of octets) {
					if (!/^(?:0|[1-9][0-9]{0,2})$/.test(octet) || Number(octet) > 255) return false
				}
				units += 2
			} else {
				if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) return false
				units += 1
			}
		}
		return compressed ? units < 8 : units === 8
	}

	if (hostport.includes('[') || hostport.includes(']')) return false
	const colon = hostport.lastIndexOf(':')
	if (colon !== hostport.indexOf(':')) return false
	const host = colon < 0 ? hostport : hostport.slice(0, colon)
	const port = colon < 0 ? undefined : hostport.slice(colon + 1)
	if (port !== undefined && !/^[0-9]*$/.test(port)) return false
	return /^[A-Za-z0-9\-._~!$&'()*+,;=%]*$/.test(host)
}

/**
 * Determines whether a value is one RFC 3339 `full-date` naming a real calendar day.
 *
 * @remarks
 * RFC 3339 §5.6 defines `date-mday` as `01-28`, `29`, `30`, or `31` BASED ON the month and
 * year, so the grammar is not satisfied by shape alone: `2026-02-30` and `2025-02-29` are
 * well-formed triples that name no day, and a downstream `new Date` rolls each of them
 * silently onto a different date rather than refusing it. February's length follows the
 * Gregorian leap rule — every fourth year except centuries that are not multiples of 400.
 *
 * The check is pure integer arithmetic on the matched fields and never constructs a `Date`,
 * because `Date` is exactly the component that performs the rollover this guard exists to
 * refuse. It is a SYNTAX guard: no time zone, locale, calendar era, or leap second applies.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is an RFC 3339 `full-date` for a day that exists
 *
 * @example
 * ```ts
 * isRFC3339Date('2026-02-28') // true
 * isRFC3339Date('2026-02-30') // false — February never has 30 days
 * isRFC3339Date('2024-02-29') // true — 2024 is a leap year
 * ```
 */
export function isRFC3339Date(value: unknown): value is string {
	if (!isString(value)) return false
	const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
	if (matched === null) return false
	const year = Number(matched[1])
	const month = Number(matched[2])
	const day = Number(matched[3])
	if (month < 1 || month > 12 || day < 1) return false
	if (month === 2) {
		return day <= ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28)
	}
	return day <= (month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31)
}

/**
 * Determines whether a value is one RFC 3339 `date-time` naming a real calendar day.
 *
 * @remarks
 * The `full-date` half is {@link isRFC3339Date}, so an impossible day is refused here for
 * the same reason it is refused there. The `full-time` half requires the literal `T`
 * separator (or its lowercase form), two-digit hour/minute/second, an optional fractional
 * second, and a mandatory offset — `Z` or `±HH:MM`. A space separator, a missing offset, and
 * a bare date all remain refused: RFC 3339 permits the space only by prior agreement, and
 * this package has none. Second `60` is admitted, because the grammar reserves it for a leap
 * second.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is an RFC 3339 `date-time` for a day that exists
 *
 * @example
 * ```ts
 * isRFC3339DateTime('2026-08-07T12:30:00Z') // true
 * isRFC3339DateTime('2026-02-30T00:00:00Z') // false — February never has 30 days
 * isRFC3339DateTime('2026-08-07 12:30:00Z') // false — the separator must be `T`
 * ```
 */
export function isRFC3339DateTime(value: unknown): value is string {
	if (!isString(value)) return false
	const matched =
		/^(\d{4}-\d{2}-\d{2})[Tt](?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
			value,
		)
	return matched !== null && isRFC3339Date(matched[1])
}

/**
 * Determines whether a value is one exact finite MCP progress payload.
 *
 * @param value - The unknown value to inspect
 * @returns Whether required progress and optional total/message fields match the dated schema
 */
export function isMCPProgress(value: unknown): value is MCPProgress {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const progress = owned.value
		if (!isFiniteNumber(progress['progress'])) return false
		const total = progress['total']
		const message = progress['message']
		return (
			(isUndefined(total) || isFiniteNumber(total)) && (isUndefined(message) || isString(message))
		)
	} catch {
		return false
	}
}

/**
 * Determines whether a value carries valid dated-schema MCP content annotations.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is valid MCP annotations
 */
export function isMCPAnnotations(value: unknown): value is MCPAnnotations {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const annotations = owned.value
		const audience = annotations['audience']
		const priority = annotations['priority']
		const lastModified = annotations['lastModified']
		if (
			!isUndefined(audience) &&
			(!Array.isArray(audience) ||
				!audience.every((role) => role === 'user' || role === 'assistant'))
		) {
			return false
		}
		if (!isUndefined(priority) && (!isFiniteNumber(priority) || priority < 0 || priority > 1)) {
			return false
		}
		return isUndefined(lastModified) || isString(lastModified)
	} catch {
		return false
	}
}

/**
 * Determines whether a value is one exact dated-schema MCP icon.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is a valid MCP icon
 */
export function isMCPIcon(value: unknown): value is MCPIcon {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const icon = owned.value
		if (!isAbsoluteURI(icon['src'])) return false
		const mimeType = icon['mimeType']
		const sizes = icon['sizes']
		const theme = icon['theme']
		return (
			(isUndefined(mimeType) || isString(mimeType)) &&
			(isUndefined(sizes) || (Array.isArray(sizes) && sizes.every((size) => isString(size)))) &&
			(isUndefined(theme) || theme === 'light' || theme === 'dark')
		)
	} catch {
		return false
	}
}

/** Determines whether a value is one complete dated MCP implementation identity. */
export function isMCPIdentity(value: unknown): value is MCPIdentity {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const identity = owned.value
		if (!isString(identity['name']) || !isString(identity['version'])) {
			return false
		}
		const title = identity['title']
		const description = identity['description']
		const website = identity['websiteUrl']
		const icons = identity['icons']
		return (
			(isUndefined(title) || isString(title)) &&
			(isUndefined(description) || isString(description)) &&
			(isUndefined(website) || isAbsoluteURI(website)) &&
			(isUndefined(icons) || (Array.isArray(icons) && icons.every((icon) => isMCPIcon(icon))))
		)
	} catch {
		return false
	}
}

/** Determines whether a value is one exact open dated client-capability declaration. */
export function isMCPClientCapabilities(value: unknown): value is MCPClientCapabilities {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const capabilities = owned.value
		for (const capability of Object.values(capabilities)) {
			if (!isJSONObject(capability)) return false
		}
		const experimental = capabilities['experimental']
		if (
			!isUndefined(experimental) &&
			(!isJSONObject(experimental) ||
				!Object.values(experimental).every((entry) => isJSONObject(entry)))
		) {
			return false
		}
		const sampling = capabilities['sampling']
		if (
			!isUndefined(sampling) &&
			(!isJSONObject(sampling) ||
				(!isUndefined(sampling['context']) && !isJSONObject(sampling['context'])) ||
				(!isUndefined(sampling['tools']) && !isJSONObject(sampling['tools'])))
		) {
			return false
		}
		const elicitation = capabilities['elicitation']
		if (!isUndefined(elicitation)) {
			if (!isJSONObject(elicitation)) return false
			const form = elicitation['form']
			const url = elicitation['url']
			if (!isUndefined(form) && !isJSONObject(form)) return false
			if (!isUndefined(url) && !isJSONObject(url)) return false
			if (Object.keys(elicitation).length > 0 && isUndefined(form) && isUndefined(url)) return false
		}
		const extensions = capabilities['extensions']
		if (!isUndefined(extensions)) {
			if (!isJSONObject(extensions)) return false
			for (const [key, extension] of Object.entries(extensions)) {
				if (!key.includes('/') || !isMCPMetaKey(key) || !isJSONObject(extension)) return false
			}
		}
		return true
	} catch {
		return false
	}
}

/** Determines whether a value is one exact open dated server-capability declaration. */
export function isMCPServerCapabilities(value: unknown): value is MCPServerCapabilities {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const capabilities = owned.value
		for (const capability of Object.values(capabilities)) {
			if (!isJSONObject(capability)) return false
		}
		const experimental = capabilities['experimental']
		if (
			!isUndefined(experimental) &&
			(!isJSONObject(experimental) ||
				!Object.values(experimental).every((entry) => isJSONObject(entry)))
		) {
			return false
		}
		for (const name of ['prompts', 'tools']) {
			const capability = capabilities[name]
			if (
				!isUndefined(capability) &&
				(!isJSONObject(capability) ||
					(!isUndefined(capability['listChanged']) && !isBoolean(capability['listChanged'])))
			) {
				return false
			}
		}
		const resources = capabilities['resources']
		if (
			!isUndefined(resources) &&
			(!isJSONObject(resources) ||
				(!isUndefined(resources['subscribe']) && !isBoolean(resources['subscribe'])) ||
				(!isUndefined(resources['listChanged']) && !isBoolean(resources['listChanged'])))
		) {
			return false
		}
		const extensions = capabilities['extensions']
		if (!isUndefined(extensions)) {
			if (!isJSONObject(extensions)) return false
			for (const [key, extension] of Object.entries(extensions)) {
				if (!key.includes('/') || !isMCPMetaKey(key) || !isJSONObject(extension)) return false
			}
		}
		return true
	} catch {
		return false
	}
}

/**
 * Determines whether a value is embedded textual MCP resource contents.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is embedded textual resource contents
 */
export function isMCPTextResource(value: unknown): value is MCPTextResource {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const resource = owned.value
		if (!isAbsoluteURI(resource['uri']) || !isString(resource['text'])) {
			return false
		}
		const mimeType = resource['mimeType']
		const metadata = resource['_meta']
		return (
			(isUndefined(mimeType) || isString(mimeType)) &&
			(isUndefined(metadata) || isMCPMetaObject(metadata))
		)
	} catch {
		return false
	}
}

/**
 * Determines whether a value is embedded blob MCP resource contents.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is embedded blob resource contents
 */
export function isMCPBlobResource(value: unknown): value is MCPBlobResource {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const resource = owned.value
		if (!isAbsoluteURI(resource['uri']) || !isStandardBase64(resource['blob'])) {
			return false
		}
		const mimeType = resource['mimeType']
		const metadata = resource['_meta']
		return (
			(isUndefined(mimeType) || isString(mimeType)) &&
			(isUndefined(metadata) || isMCPMetaObject(metadata))
		)
	} catch {
		return false
	}
}

/**
 * Determines whether a value is one `resources/list` descriptor.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is a valid resource descriptor
 */
export function isMCPResource(value: unknown): value is MCPResource {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const resource = owned.value
		const icons = resource['icons']
		const size = resource['size']
		return (
			isAbsoluteURI(resource['uri']) &&
			isString(resource['name']) &&
			(isUndefined(resource['title']) || isString(resource['title'])) &&
			(isUndefined(resource['description']) || isString(resource['description'])) &&
			(isUndefined(resource['mimeType']) || isString(resource['mimeType'])) &&
			(isUndefined(resource['annotations']) || isMCPAnnotations(resource['annotations'])) &&
			(isUndefined(size) || (isInteger(size) && size >= 0)) &&
			(isUndefined(icons) || (Array.isArray(icons) && icons.every((icon) => isMCPIcon(icon)))) &&
			(isUndefined(resource['_meta']) || isMCPMetaObject(resource['_meta']))
		)
	} catch {
		return false
	}
}

/**
 * Determines whether a value is one resource-template descriptor.
 *
 * @remarks
 * This guard validates the descriptor shape. Template expansion and the RFC 6570 feature
 * level belong to the consumer-supplied resource manager; this package projects the string.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is a valid resource-template descriptor
 */
export function isMCPResourceTemplate(value: unknown): value is MCPResourceTemplate {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const template = owned.value
		const icons = template['icons']
		return (
			isString(template['uriTemplate']) &&
			template['uriTemplate'].length > 0 &&
			isString(template['name']) &&
			(isUndefined(template['title']) || isString(template['title'])) &&
			(isUndefined(template['description']) || isString(template['description'])) &&
			(isUndefined(template['mimeType']) || isString(template['mimeType'])) &&
			(isUndefined(template['annotations']) || isMCPAnnotations(template['annotations'])) &&
			(isUndefined(icons) || (Array.isArray(icons) && icons.every((icon) => isMCPIcon(icon)))) &&
			(isUndefined(template['_meta']) || isMCPMetaObject(template['_meta']))
		)
	} catch {
		return false
	}
}

/**
 * Determines whether a value is structurally discriminated resource contents.
 *
 * @param value - The unknown value to inspect
 * @returns Whether exactly one of `text` and `blob` is present and valid
 */
export function isMCPResourceContents(value: unknown): value is MCPResourceContents {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	const resource = owned.value
	const text = Object.hasOwn(resource, 'text')
	const blob = Object.hasOwn(resource, 'blob')
	if (text === blob) return false
	return text ? isMCPTextResource(resource) : isMCPBlobResource(resource)
}

/**
 * Determines whether a value carries the shared optional pagination cursor.
 *
 * @param value - The unknown value to inspect
 * @returns Whether a present `cursor` is a string
 */
export function isMCPPaginationParams(value: unknown): value is MCPPaginationParams {
	const owned = attempt(() => cloneJSONRecord(value))
	return owned.success && (isUndefined(owned.value['cursor']) || isString(owned.value['cursor']))
}

/**
 * Determines whether a value is one consumer-owned resource page.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the resources and optional following cursor are valid
 */
export function isMCPResourcePage(value: unknown): value is MCPResourcePage {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	const resources = owned.value['resources']
	const cursor = owned.value['nextCursor']
	return (
		Array.isArray(resources) &&
		resources.every((resource) => isMCPResource(resource)) &&
		(isUndefined(cursor) || isString(cursor))
	)
}

/**
 * Determines whether a value is one consumer-owned resource-template page.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the templates and optional following cursor are valid
 */
export function isMCPResourceTemplatePage(value: unknown): value is MCPResourceTemplatePage {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	const templates = owned.value['resourceTemplates']
	const cursor = owned.value['nextCursor']
	return (
		Array.isArray(templates) &&
		templates.every((template) => isMCPResourceTemplate(template)) &&
		(isUndefined(cursor) || isString(cursor))
	)
}

/**
 * Determines whether a value is a string-valued MCP argument record.
 *
 * @param value - The unknown value to inspect
 * @returns Whether every own argument value is a string
 */
export function isMCPStringArguments(value: unknown): value is Readonly<Record<string, string>> {
	const owned = attempt(() => cloneJSONRecord(value))
	return owned.success && Object.values(owned.value).every((argument) => isString(argument))
}

/**
 * Determines whether a value is one prompt argument descriptor.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the prompt argument descriptor is valid
 */
export function isMCPPromptArgument(value: unknown): value is MCPPromptArgument {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	const argument = owned.value
	return (
		isString(argument['name']) &&
		(isUndefined(argument['title']) || isString(argument['title'])) &&
		(isUndefined(argument['description']) || isString(argument['description'])) &&
		(isUndefined(argument['required']) || isBoolean(argument['required']))
	)
}

/**
 * Determines whether a value is one `prompts/list` descriptor.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the prompt descriptor is valid
 */
export function isMCPPrompt(value: unknown): value is MCPPrompt {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	const prompt = owned.value
	const argumentsValue = prompt['arguments']
	const icons = prompt['icons']
	return (
		isString(prompt['name']) &&
		(isUndefined(prompt['title']) || isString(prompt['title'])) &&
		(isUndefined(prompt['description']) || isString(prompt['description'])) &&
		(isUndefined(argumentsValue) ||
			(Array.isArray(argumentsValue) &&
				argumentsValue.every((argument) => isMCPPromptArgument(argument)))) &&
		(isUndefined(icons) || (Array.isArray(icons) && icons.every((icon) => isMCPIcon(icon)))) &&
		(isUndefined(prompt['_meta']) || isMCPMetaObject(prompt['_meta']))
	)
}

/**
 * Determines whether a value is one prompt message with existing rich content.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the role and content are valid
 */
export function isMCPPromptMessage(value: unknown): value is MCPPromptMessage {
	const owned = attempt(() => cloneJSONRecord(value))
	return (
		owned.success &&
		(owned.value['role'] === 'user' || owned.value['role'] === 'assistant') &&
		isMCPContent(owned.value['content'])
	)
}

/**
 * Determines whether a value is one consumer-owned prompt page.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the prompts and optional following cursor are valid
 */
export function isMCPPromptPage(value: unknown): value is MCPPromptPage {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	const prompts = owned.value['prompts']
	const cursor = owned.value['nextCursor']
	return (
		Array.isArray(prompts) &&
		prompts.every((prompt) => isMCPPrompt(prompt)) &&
		(isUndefined(cursor) || isString(cursor))
	)
}

/**
 * Determines whether a value is one complete `prompts/get` result.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the prompt result and all messages are valid
 */
export function isMCPPromptGetResult(value: unknown): value is MCPPromptGetResult {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	const result = owned.value
	const messages = result['messages']
	return (
		result['resultType'] === 'complete' &&
		(isUndefined(result['description']) || isString(result['description'])) &&
		Array.isArray(messages) &&
		messages.every((message) => isMCPPromptMessage(message)) &&
		(isUndefined(result['_meta']) || isMCPResultMetaObject(result['_meta']))
	)
}

/**
 * Determines whether a value is a prompt or resource-template completion reference.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the discriminated reference is valid
 */
export function isMCPCompletionReference(value: unknown): value is MCPCompletionReference {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	const reference = owned.value
	return reference['type'] === 'ref/prompt'
		? isString(reference['name'])
		: reference['type'] === 'ref/resource' && isString(reference['uri'])
}

/**
 * Determines whether a value is one `completion/complete` parameter object.
 *
 * @param value - The unknown value to inspect
 * @returns Whether its reference, fragment, and optional string context are valid
 */
export function isMCPCompletionParams(value: unknown): value is MCPCompletionParams {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	const params = owned.value
	const argument = attempt(() => cloneJSONRecord(params['argument']))
	if (!argument.success) return false
	const context = params['context']
	if (!isUndefined(context)) {
		const ownedContext = attempt(() => cloneJSONRecord(context))
		if (
			!ownedContext.success ||
			(!isUndefined(ownedContext.value['arguments']) &&
				!isMCPStringArguments(ownedContext.value['arguments']))
		) {
			return false
		}
	}
	return (
		isMCPCompletionReference(params['ref']) &&
		isString(argument.value['name']) &&
		isString(argument.value['value'])
	)
}

/**
 * Determines whether a value is one host-produced completion candidate set.
 *
 * @param value - The unknown value to inspect
 * @returns Whether its candidates and optional result facts are valid
 */
export function isMCPCompletion(value: unknown): value is MCPCompletion {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	const completion = owned.value
	const values = completion['values']
	const total = completion['total']
	return (
		Array.isArray(values) &&
		values.every((candidate) => isString(candidate)) &&
		(isUndefined(total) || (isInteger(total) && total >= 0)) &&
		(isUndefined(completion['hasMore']) || isBoolean(completion['hasMore']))
	)
}

/**
 * Determines whether a value is one complete, capped `completion/complete` result.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the result is complete and carries at most 100 candidates
 */
export function isMCPCompletionResult(value: unknown): value is MCPCompletionResult {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success || owned.value['resultType'] !== 'complete') return false
	const completion = owned.value['completion']
	return (
		isMCPCompletion(completion) &&
		completion.values.length <= 100 &&
		(isUndefined(owned.value['_meta']) || isMCPResultMetaObject(owned.value['_meta']))
	)
}

/**
 * Determines whether a value is one exact dated-schema MCP tool content block.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is valid MCP content
 */
export function isMCPContent(value: unknown): value is MCPContent {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const content = owned.value
		if (!isString(content['type'])) return false
		const annotations = content['annotations']
		const metadata = content['_meta']
		if (!isUndefined(annotations) && !isMCPAnnotations(annotations)) return false
		if (!isUndefined(metadata) && !isMCPMetaObject(metadata)) return false
		switch (content['type']) {
			case 'text':
				return isString(content['text'])
			case 'image':
			case 'audio':
				return isStandardBase64(content['data']) && isString(content['mimeType'])
			case 'resource':
				return isMCPTextResource(content['resource']) || isMCPBlobResource(content['resource'])
			case 'resource_link': {
				const icons = content['icons']
				const size = content['size']
				return (
					isString(content['name']) &&
					isAbsoluteURI(content['uri']) &&
					(isUndefined(content['title']) || isString(content['title'])) &&
					(isUndefined(content['description']) || isString(content['description'])) &&
					(isUndefined(content['mimeType']) || isString(content['mimeType'])) &&
					(isUndefined(icons) ||
						(Array.isArray(icons) && icons.every((icon) => isMCPIcon(icon)))) &&
					(isUndefined(size) || (isInteger(size) && size >= 0))
				)
			}
			default:
				return false
		}
	} catch {
		return false
	}
}

/**
 * Determines whether a value is one modern MCP result.
 *
 * @remarks
 * The open contract's guard: a record carrying a string `resultType` and, when
 * present, exact result metadata. It deliberately does NOT narrow `resultType` to a
 * known value, because the dated schema keeps adding them — a caller that needs a
 * specific result uses that result's own guard, which narrows to its literal.
 * Mutually exclusive with {@link isMCPLegacyResult} on every input: this one needs
 * `resultType` present and a string, that one needs it absent. Total over hostile
 * input.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is a modern result
 *
 * @example
 * ```ts
 * isMCPResult({ resultType: 'complete' }) // true
 * isMCPResult({ resultType: 'task' }) // true — a later protocol value
 * isMCPResult({ tools: [] }) // false — no discriminator, so it is a legacy result
 * ```
 */
export function isMCPResult(value: unknown): value is MCPResult {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	const result = owned.value
	if (!isString(result['resultType'])) return false
	const metadata = result['_meta']
	return isUndefined(metadata) || isMCPResultMetaObject(metadata)
}

/**
 * Determines whether a value is one legacy-era MCP result.
 *
 * @remarks
 * The legacy revision has no result discriminator, so the absence of `resultType` is
 * the whole membership rule. Mutually exclusive with {@link isMCPResult}. Total over
 * hostile input.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is a legacy result
 *
 * @example
 * ```ts
 * isMCPLegacyResult({}) // true — the legacy `ping` result
 * isMCPLegacyResult({ resultType: 'complete' }) // false — a modern result
 * ```
 */
export function isMCPLegacyResult(value: unknown): value is MCPLegacyResult {
	const owned = attempt(() => cloneJSONRecord(value))
	return owned.success && !Object.hasOwn(owned.value, 'resultType')
}

/**
 * Determines whether a value is a complete modern MCP tool result.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is a complete MCP call result
 */
export function isMCPCallResult(value: unknown): value is MCPCallResult {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const result = owned.value
		if (result['resultType'] !== 'complete') return false
		const content = result['content']
		const error = result['isError']
		const metadata = result['_meta']
		return (
			Array.isArray(content) &&
			content.every((entry) => isMCPContent(entry)) &&
			(isUndefined(error) || isBoolean(error)) &&
			(isUndefined(metadata) || isMCPResultMetaObject(metadata))
		)
	} catch {
		return false
	}
}

/**
 * Determines whether a value is a modern MCP task-creation result.
 *
 * @remarks
 * The runtime enforcement of {@link MCPTaskManagerInterface.start}'s declared return
 * shape. The manager is consumer-supplied, so its types are a promise rather than a
 * proof: this is what stands between a manager that answers a numeric `taskId` and a
 * client that would receive one. `ttlMs` accepts `null` because the schema uses it to
 * mean "no expiry", which is distinct from an absent field, and both durations must be
 * INTEGER milliseconds because the schema formats them `int`.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is a well-formed `resultType: 'task'` result
 *
 * @example
 * ```ts
 * isMCPTaskResult({ resultType: 'task', taskId: 'a', status: 'working',
 *   createdAt: '', lastUpdatedAt: '', ttlMs: null }) // true
 * ```
 */
export function isMCPTaskResult(value: unknown): value is MCPTaskResult {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const result = owned.value
		if (result['resultType'] !== 'task') return false
		const message = result['statusMessage']
		const interval = result['pollIntervalMs']
		const lifetime = result['ttlMs']
		const metadata = result['_meta']
		return (
			isString(result['taskId']) &&
			isMCPTaskStatus(result['status']) &&
			isString(result['createdAt']) &&
			isString(result['lastUpdatedAt']) &&
			(lifetime === null || isInteger(lifetime)) &&
			(isUndefined(message) || isString(message)) &&
			(isUndefined(interval) || isInteger(interval)) &&
			(isUndefined(metadata) || isMCPResultMetaObject(metadata))
		)
	} catch {
		return false
	}
}

/**
 * Determines whether a value is one of the extension's task lifecycle states.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is an {@link MCPTaskStatus}
 *
 * @example
 * ```ts
 * isMCPTaskStatus('working') // true
 * isMCPTaskStatus('done') // false — not a state the extension defines
 * ```
 */
export function isMCPTaskStatus(value: unknown): value is MCPTaskStatus {
	return (
		value === 'working' ||
		value === 'input_required' ||
		value === 'completed' ||
		value === 'failed' ||
		value === 'cancelled'
	)
}

/**
 * Determines whether a value is one durable task's full snapshot.
 *
 * @remarks
 * The runtime enforcement of {@link MCPTaskManagerInterface.task}'s declared return shape,
 * and the guard `tasks/get` proves its answer with before it reaches the wire. `status`
 * selects what else must be present, exactly as the union declares: `input_required` owns
 * the requests to answer, `completed` owns the deferred call's result, `failed` owns the
 * JSON-RPC error that ended it, and `working` / `cancelled` own nothing further.
 *
 * A `completed` task's `result` is checked as an OBJECT and no further. The schema declares
 * it an open record, so its contents belong to whichever method was deferred; a guard that
 * demanded a protocol result here would refuse payloads the extension permits.
 * `ttlMs` and `pollIntervalMs` are integer milliseconds, per the schema's `int` formats.
 *
 * Unrecognized members stay valid, because this guard reads a value a consumer's manager
 * produced, and a guard over a foreign contract enforces the published contract and no more.
 * What is checked is what this package publishes as the contract.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is a well-formed {@link MCPTaskDetail}
 *
 * @example
 * ```ts
 * isMCPTaskDetail({ taskId: 'a', status: 'working', createdAt: '', lastUpdatedAt: '',
 *   ttlMs: null }) // true
 * isMCPTaskDetail({ taskId: 'a', status: 'completed', createdAt: '', lastUpdatedAt: '',
 *   ttlMs: null }) // false — a completed task owes its result
 * ```
 */
export function isMCPTaskDetail(value: unknown): value is MCPTaskDetail {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const detail = owned.value
		const status = detail['status']
		const message = detail['statusMessage']
		const interval = detail['pollIntervalMs']
		const lifetime = detail['ttlMs']
		if (
			!isString(detail['taskId']) ||
			!isMCPTaskStatus(status) ||
			!isString(detail['createdAt']) ||
			!isString(detail['lastUpdatedAt']) ||
			(lifetime !== null && !isInteger(lifetime)) ||
			(!isUndefined(message) && !isString(message)) ||
			(!isUndefined(interval) && !isInteger(interval))
		) {
			return false
		}
		if (status === 'input_required') return isMCPInputRequestMap(detail['inputRequests'])
		if (status === 'completed') return isRecord(detail['result'])
		if (status === 'failed') return isJSONRPCError(detail['error'])
		return true
	} catch {
		return false
	}
}

/**
 * Determines whether a value is the wire answer to `tasks/get`.
 *
 * @remarks
 * {@link isMCPTaskDetail} plus the stamp the METHOD owes. The schema types a `tasks/get`
 * reply as the detail intersected with the standard result, so `resultType: 'complete'` is
 * part of the answer rather than decoration on it — and an unstamped payload, or one
 * carrying the creation answer's `resultType: 'task'`, is a peer answering some other
 * shape. Use this guard wherever a `tasks/get` REPLY is read; use
 * {@link isMCPTaskDetail} wherever a consumer's manager answers directly.
 *
 * `_meta` is checked only when present, and only as result metadata: the server identity a
 * peer stamps there is the peer's to write.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is a well-formed {@link MCPTaskDetailResult}
 *
 * @example
 * ```ts
 * isMCPTaskDetailResult({ resultType: 'complete', taskId: 'a', status: 'working',
 *   createdAt: '', lastUpdatedAt: '', ttlMs: null }) // true
 * isMCPTaskDetailResult({ taskId: 'a', status: 'working', createdAt: '',
 *   lastUpdatedAt: '', ttlMs: null }) // false — the reply owes its `resultType`
 * ```
 */
export function isMCPTaskDetailResult(value: unknown): value is MCPTaskDetailResult {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	const result = owned.value
	if (result['resultType'] !== 'complete') return false
	const metadata = result['_meta']
	if (!isUndefined(metadata) && !isMCPResultMetaObject(metadata)) return false
	return isMCPTaskDetail(result)
}

/**
 * Determines whether a value is a `notifications/tasks` frame carrying a task snapshot.
 *
 * @remarks
 * The ADMISSION guard for a task transition: a subscription producer is consumer-written,
 * so the frame it hands over is foreign input, and this is what stands between a mutated
 * or half-built snapshot and a subscribed client. Both halves are checked — the method
 * literal the extension fixes, and params that hold together as an
 * {@link MCPTaskDetail} — because either alone admits a frame the other rejects.
 *
 * `_meta` is checked for SHAPE WHEN PRESENT and nothing more. The reserved subscription
 * stamp is the SERVER'S to write, after this guard admits the frame and the matcher agrees
 * to it, so a guard that demanded the stamp would refuse every frame a producer emits.
 *
 * @param value - The unknown value to inspect
 * @returns Whether the value is a well-formed `notifications/tasks` notification
 *
 * @example
 * ```ts
 * isMCPTaskNotification({ jsonrpc: '2.0', method: 'notifications/tasks',
 *   params: { taskId: 'a', status: 'working', createdAt: '', lastUpdatedAt: '',
 *     ttlMs: null } }) // true
 * isMCPTaskNotification({ jsonrpc: '2.0', method: 'notifications/tasks',
 *   params: { taskId: 'a' } }) // false — the params owe a whole snapshot
 * ```
 */
export function isMCPTaskNotification(value: unknown): value is JSONRPCNotification & {
	readonly method: 'notifications/tasks'
	readonly params: MCPTaskNotificationParams
} {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	const notification = owned.value
	if (!isJSONRPCNotification(notification)) return false
	if (notification['method'] !== 'notifications/tasks') return false
	const params = notification['params']
	if (!isRecord(params)) return false
	const metadata = params['_meta']
	if (!isUndefined(metadata) && !isMCPNotificationMetaObject(metadata)) return false
	return isMCPTaskDetail(params)
}

// Every guard here is a TOTAL function over the already-`JSON.parse`d
// value — adversarial input returns `false`, never throws. The raw-string
// `JSON.parse` (which CAN throw) happens in `MCPServer.handle` inside a try/catch;
// these guards only ever see a parsed `unknown`. Recursive structure is walked
// iteratively with explicit ancestor/depth bounds, and callback-capable boundaries use
// `attempt`, so totality is preserved without relying on the JavaScript call stack.

/**
 * Determines whether a value is a string within a UTF-8 byte bound.
 *
 * @param value - The unknown value to inspect
 * @param bytes - The maximum accepted encoded bytes
 * @returns `true` only for a string whose UTF-8 representation fits the bound
 *
 * @example
 * ```ts
 * isBoundedString('€', 3) // true
 * isBoundedString('€', 2) // false
 * ```
 */
export function isBoundedString(value: unknown, bytes: number): value is string {
	if (!isString(value) || !Number.isFinite(bytes) || !Number.isInteger(bytes) || bytes < 0) {
		return false
	}
	let measured = 0
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index)
		if (code <= 0x7f) measured += 1
		else if (code <= 0x7ff) measured += 2
		else if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1)
			if (next >= 0xdc00 && next <= 0xdfff) {
				measured += 4
				index += 1
			} else measured += 3
		} else measured += 3
		if (measured > bytes) return false
	}
	return true
}

/**
 * Determines whether a value is bounded, cycle-free exact JSON.
 *
 * @remarks
 * Traversal is iterative, ancestor-aware, and contained by {@link attempt}; deep input,
 * cycles, accessors, hostile proxies, and `Map`/`Set` return `false` rather than throwing.
 * The byte count matches `JSON.stringify` without first allocating the serialization.
 *
 * @param value - The unknown value to inspect
 * @param limits - Serialized byte, optional key, and nesting-depth bounds
 * @returns `true` only for safe JSON satisfying every bound
 *
 * @example
 * ```ts
 * isBoundedJSON({ ok: true }, { bytes: 16, keys: 1, depth: 1 }) // true
 * ```
 */
export function isBoundedJSON<T>(value: T, limits: MCPJSONLimitOptions): value is T & JSONValue {
	return serializeJSON(value, limits) !== undefined
}

/**
 * Determines whether a value is a valid JSON-RPC correlation id — a string or a
 * finite integer.
 *
 * @remarks
 * An id is present or it is not there at all: `undefined` is not an id (that
 * absence is what makes a call a notification) and `null` is not one either (MCP
 * omits an unreadable id rather than nulling it). A runtime numeric id must be a
 * finite integer; an empty string is a legal id, because the dated schema imposes
 * no minimum length. Total: any other input returns `false`.
 *
 * @param value - The already-parsed value to test
 * @returns `true` when `value` is a string or a finite integer
 *
 * @example
 * ```ts
 * isJSONRPCId(1)         // true
 * isJSONRPCId('')        // true — an empty string is a legal id
 * isJSONRPCId(undefined) // false — absence is not an id
 * isJSONRPCId(null)      // false — MCP omits an unreadable id
 * isJSONRPCId(1.5)       // false — a numeric id is an integer
 * ```
 */
export function isJSONRPCId(value: unknown): value is JSONRPCId {
	return isString(value) || isInteger(value)
}

/**
 * Determines whether a value is a supported {@link MCPVersion}.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when the value is one of {@link SUPPORTED_MCP_VERSIONS}
 */
export function isMCPVersion(value: unknown): value is MCPVersion {
	return isString(value) && SUPPORTED_MCP_VERSIONS.some((version) => version === value)
}

/**
 * Determines whether a value is a modern protocol revision accepted by a bare server.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when the value is one of {@link SUPPORTED_MODERN_PROTOCOL_VERSIONS}
 */
export function isMCPModernVersion(value: unknown): value is MCPModernVersion {
	return isString(value) && SUPPORTED_MODERN_PROTOCOL_VERSIONS.some((version) => version === value)
}

/**
 * Determines whether a value is a revision accepted by the optional legacy decorator.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when the value is one of {@link SUPPORTED_LEGACY_PROTOCOL_VERSIONS}
 */
export function isMCPLegacyVersion(value: unknown): value is MCPLegacyVersion {
	return isString(value) && SUPPORTED_LEGACY_PROTOCOL_VERSIONS.some((version) => version === value)
}

/**
 * Determines whether a value is an MCP {@link MCPSubscriptionFilter}.
 *
 * @remarks
 * Every filter field is optional. Boolean notification families accept only booleans,
 * `resourceSubscriptions` accepts only an array of string URIs, and `taskIds` accepts only
 * an array of string task identifiers. Unknown fields remain open for protocol extensions
 * and are ignored by the built-in subscription matcher. Total over hostile input.
 *
 * A malformed `taskIds` is refused here rather than dropped, so the listen request that
 * carried it fails outright instead of quietly agreeing to a narrower subscription than
 * the caller asked for.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when every recognized filter field has its protocol shape
 */
export function isMCPSubscriptionFilter(value: unknown): value is MCPSubscriptionFilter {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	const filter = owned.value
	const tools = filter['toolsListChanged']
	if (!isUndefined(tools) && !isBoolean(tools)) return false
	const prompts = filter['promptsListChanged']
	if (!isUndefined(prompts) && !isBoolean(prompts)) return false
	const resources = filter['resourcesListChanged']
	if (!isUndefined(resources) && !isBoolean(resources)) return false
	const subscriptions = filter['resourceSubscriptions']
	if (!isUndefined(subscriptions) && !arrayOf(isString)(subscriptions)) return false
	const tasks = filter['taskIds']
	return isUndefined(tasks) || arrayOf(isString)(tasks)
}

/**
 * Determines whether a value is a graceful `subscriptions/listen` result.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when the result is complete and carries a valid subscription id
 */
export function isMCPSubscriptionResult(value: unknown): value is MCPSubscriptionResult {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success || owned.value['resultType'] !== 'complete') return false
	const metadata = owned.value['_meta']
	return (
		isMCPResultMetaObject(metadata) &&
		isRecord(metadata) &&
		isJSONRPCId(metadata[MCP_META_SUBSCRIPTION])
	)
}

/**
 * Determines whether a value is one restricted primitive form-elicitation schema.
 *
 * @param value - The unknown value to inspect
 * @returns `true` for a supported boolean, numeric, string, or string-array schema
 *
 * @example
 * ```ts
 * isMCPElicitFieldSchema({ type: 'boolean', default: true }) // true
 * isMCPElicitFieldSchema({ type: 'object' }) // false
 * ```
 */
export function isMCPElicitFieldSchema(value: unknown): value is MCPElicitFieldSchema {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	const schema = owned.value
	try {
		const title = schema['title']
		const description = schema['description']
		if (!isUndefined(title) && !isString(title)) return false
		if (!isUndefined(description) && !isString(description)) return false

		const fallback = schema['default']
		if (schema['type'] === 'boolean') return isUndefined(fallback) || isBoolean(fallback)
		if (schema['type'] === 'number' || schema['type'] === 'integer') {
			const minimum = schema['minimum']
			const maximum = schema['maximum']
			return (
				(isUndefined(minimum) || isFiniteNumber(minimum)) &&
				(isUndefined(maximum) || isFiniteNumber(maximum)) &&
				(isUndefined(fallback) || isFiniteNumber(fallback))
			)
		}
		if (schema['type'] === 'string') {
			const minimum = schema['minLength']
			const maximum = schema['maxLength']
			const format = schema['format']
			const choices = schema['enum']
			const names = schema['enumNames']
			const titled = schema['oneOf']
			if (
				(!isUndefined(minimum) && (!isInteger(minimum) || minimum < 0)) ||
				(!isUndefined(maximum) && (!isInteger(maximum) || maximum < 0)) ||
				(!isUndefined(fallback) && !isString(fallback)) ||
				(!isUndefined(format) &&
					format !== 'uri' &&
					format !== 'email' &&
					format !== 'date' &&
					format !== 'date-time')
			) {
				return false
			}
			if (!isUndefined(choices) && (!Array.isArray(choices) || !choices.every(isString)))
				return false
			if (
				!isUndefined(names) &&
				(isUndefined(choices) || !Array.isArray(names) || !names.every(isString))
			)
				return false
			return !(
				!isUndefined(titled) &&
				(!Array.isArray(titled) ||
					!titled.every(
						(choice) =>
							isJSONObject(choice) && isString(choice['const']) && isString(choice['title']),
					))
			)
		}
		if (schema['type'] !== 'array') return false
		const minimum = schema['minItems']
		const maximum = schema['maxItems']
		const items = schema['items']
		if (
			(!isUndefined(minimum) && (!isInteger(minimum) || minimum < 0)) ||
			(!isUndefined(maximum) && (!isInteger(maximum) || maximum < 0)) ||
			(!isUndefined(fallback) &&
				(!Array.isArray(fallback) || !fallback.every((item) => isString(item)))) ||
			!isJSONObject(items)
		) {
			return false
		}
		const itemType = items['type']
		const choices = items['enum']
		const titled = items['anyOf']
		if (!isUndefined(itemType) && itemType !== 'string') return false
		if (!isUndefined(choices) && (!Array.isArray(choices) || !choices.every(isString))) return false
		if (
			!isUndefined(titled) &&
			(!Array.isArray(titled) ||
				!titled.every(
					(choice) =>
						isJSONObject(choice) && isString(choice['const']) && isString(choice['title']),
				))
		)
			return false
		return (itemType === 'string' && !isUndefined(choices)) || !isUndefined(titled)
	} catch {
		return false
	}
}

/**
 * Determines whether a value is the restricted top-level object schema a form elicitation issues.
 *
 * @remarks
 * The schema half of {@link isMCPElicitForm}, exported on its own because the issued schema
 * outlives the request that issued it: it is bound into protected continuation state and is
 * what {@link isElicitContent} enforces an accepted response against. Every declared property
 * must itself be one restricted {@link MCPElicitFieldSchema}; the schema is otherwise open, so
 * an unrecognized top-level annotation is data rather than a rejection.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when `value` is a restricted object schema of supported field schemas
 *
 * @example
 * ```ts
 * isMCPElicitSchema({ type: 'object', properties: { approved: { type: 'boolean' } } }) // true
 * isMCPElicitSchema({ type: 'object', properties: { nested: { type: 'object' } } }) // false
 * ```
 */
export function isMCPElicitSchema(value: unknown): value is MCPElicitSchema {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const schema: Readonly<Record<string, unknown>> = owned.value
		const properties = schema['properties']
		if (schema['type'] !== 'object' || !isJSONObject(properties)) return false
		const dialect = schema['$schema']
		if (!isUndefined(dialect) && !isString(dialect)) return false
		const required = schema['required']
		return (
			(isUndefined(required) ||
				(Array.isArray(required) && required.every((name) => isString(name)))) &&
			Object.values(properties).every((property) => isMCPElicitFieldSchema(property))
		)
	} catch {
		return false
	}
}

/**
 * Determines whether a value is a form-mode elicitation parameter object.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when `value` has the restricted form elicitation shape
 *
 * @example
 * ```ts
 * isMCPElicitForm({
 *   message: 'Continue?',
 *   requestedSchema: { type: 'object', properties: {} },
 * }) // true
 * ```
 */
export function isMCPElicitForm(value: unknown): value is MCPElicitForm {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const params = owned.value
		const mode = params['mode']
		if (!isUndefined(mode) && mode !== 'form') return false
		return isString(params['message']) && isMCPElicitSchema(params['requestedSchema'])
	} catch {
		return false
	}
}

/**
 * Determines whether a value is a URL-mode elicitation parameter object.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when `value` has the URL elicitation shape
 *
 * @example
 * ```ts
 * isMCPElicitURL({ mode: 'url', message: 'Authenticate', url: 'https://example.test' })
 * ```
 */
export function isMCPElicitURL(value: unknown): value is MCPElicitURL {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const params = owned.value
		return params['mode'] === 'url' && isString(params['message']) && isAbsoluteURI(params['url'])
	} catch {
		return false
	}
}

/**
 * Determines whether a value is an embedded `elicitation/create` request.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when `value` is a form- or URL-mode elicitation request
 *
 * @example
 * ```ts
 * isMCPElicitRequest({
 *   method: 'elicitation/create',
 *   params: { message: 'Continue?', requestedSchema: { type: 'object', properties: {} } },
 * }) // true
 * ```
 */
export function isMCPElicitRequest(value: unknown): value is MCPElicitRequest {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const request = owned.value
		if (request['method'] !== 'elicitation/create') return false
		return isMCPElicitForm(request['params']) || isMCPElicitURL(request['params'])
	} catch {
		return false
	}
}

/**
 * Determines whether a value is one legal embedded multi-round-trip request.
 *
 * @param value - The unknown value to inspect
 * @returns `true` for an embedded elicitation, sampling, or roots request
 *
 * @example
 * ```ts
 * isMCPInputRequest({ method: 'roots/list' }) // true — legal but not produced by this package
 * ```
 */
export function isMCPInputRequest(value: unknown): value is MCPInputRequest {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const request = owned.value
		if (isMCPElicitRequest(request)) return true
		const params = request['params']
		if (request['method'] === 'sampling/createMessage') return isRecord(params)
		return request['method'] === 'roots/list' && (isUndefined(params) || isRecord(params))
	} catch {
		return false
	}
}

/**
 * Determines whether a value is a consumer-keyed map of embedded input requests.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when every own value is a legal {@link MCPInputRequest}
 *
 * @example
 * ```ts
 * isMCPInputRequestMap({ confirm: { method: 'roots/list' } }) // true; maps, never arrays
 * ```
 */
export function isMCPInputRequestMap(value: unknown): value is MCPInputRequestMap {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		return Object.values(owned.value).every((request) => isMCPInputRequest(request))
	} catch {
		return false
	}
}

/**
 * Determines whether a value is one elicitation response.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when action/content have the protocol shape
 *
 * @example
 * ```ts
 * isMCPElicitResult({ action: 'accept', content: { approved: true } }) // true
 * ```
 */
export function isMCPElicitResult(value: unknown): value is MCPElicitResult {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const result = owned.value
		const action = result['action']
		if (action !== 'accept' && action !== 'decline' && action !== 'cancel') return false
		const content = result['content']
		if (action !== 'accept') return isUndefined(content)
		if (isUndefined(content)) return true
		if (!isJSONObject(content)) return false
		return Object.values(content).every(
			(item) =>
				isString(item) ||
				isFiniteNumber(item) ||
				isBoolean(item) ||
				(Array.isArray(item) && item.every((entry) => isString(entry))),
		)
	} catch {
		return false
	}
}

/**
 * Determines whether accepted elicitation content satisfies the exact schema that was issued.
 *
 * @remarks
 * {@link isMCPElicitResult} says a response has the SHAPE of a response; this says the
 * response answers the QUESTION that was asked. A server that protects the schema it issued
 * and then never enforces it has bought nothing, so this guard closes that gap: it is what
 * turns a bound schema into a checked one.
 *
 * Every own value must be one {@link MCPElicitValue} — a string, a finite number, a boolean,
 * or an array of strings. A value whose name is DECLARED in `schema.properties` must in
 * addition satisfy that field's schema: `integer` rejects a fraction, `minimum` / `maximum`
 * bound a number, `minLength` / `maxLength` bound a string by code points, `enum` and `oneOf`
 * bound it to a declared member, `format` is enforced (`uri` by {@link isAbsoluteURI}, `email`
 * by syntax, and `date` / `date-time` by {@link isRFC3339Date} / {@link isRFC3339DateTime},
 * which refuse a day the calendar does not have), and an array is bounded by `minItems` /
 * `maxItems` with every entry drawn from its `items.enum` or `items.anyOf`. Every name listed
 * in `schema.required` must be present.
 *
 * An UNDECLARED property remains valid: the restricted schema is open by default, so a client
 * that answers more than it was asked is not refused for it. A `schema` that is not itself a
 * valid {@link MCPElicitSchema} admits NOTHING — an unenforceable schema is never a permissive
 * one — which is why `schema` is accepted as `unknown` and checked rather than trusted. Total
 * over hostile content and hostile schemas alike.
 *
 * @param value - The accepted response content to check
 * @param schema - The exact {@link MCPElicitSchema} that was issued with the elicitation
 * @returns `true` when every declared and undeclared value is legal under `schema`
 *
 * @example
 * ```ts
 * const schema = {
 * 	type: 'object',
 * 	properties: { approved: { type: 'boolean' }, count: { type: 'integer', minimum: 1 } },
 * 	required: ['approved'],
 * }
 * isElicitContent({ approved: true, count: 2 }, schema) // true
 * isElicitContent({ approved: true, count: 2.5 }, schema) // false — not an integer
 * isElicitContent({ count: 2 }, schema) // false — `approved` is required
 * ```
 */
export function isElicitContent(
	value: unknown,
	schema: unknown,
): value is Readonly<Record<string, MCPElicitValue>> {
	const declared = attempt(() => cloneJSONRecord(schema))
	const owned = attempt(() => cloneJSONRecord(value))
	if (!declared.success || !owned.success || !isMCPElicitSchema(declared.value)) return false
	try {
		const content: Readonly<Record<string, unknown>> = owned.value
		const properties: unknown = declared.value['properties']
		const required: unknown = declared.value['required']
		if (!isJSONObject(properties)) return false
		if (Array.isArray(required)) {
			for (const name of required) {
				if (!isString(name) || !Object.hasOwn(content, name)) return false
			}
		}
		for (const [name, item] of Object.entries(content)) {
			if (
				!isString(item) &&
				!isFiniteNumber(item) &&
				!isBoolean(item) &&
				!(Array.isArray(item) && item.every((entry) => isString(entry)))
			) {
				return false
			}
			// An UNDECLARED property is data, not a violation: the restricted schema is open.
			if (!Object.hasOwn(properties, name)) continue
			const field: unknown = properties[name]
			if (!isJSONObject(field)) return false
			const declaredType = field['type']
			if (declaredType === 'boolean') {
				if (!isBoolean(item)) return false
				continue
			}
			if (declaredType === 'number' || declaredType === 'integer') {
				const minimum = field['minimum']
				const maximum = field['maximum']
				if (!isFiniteNumber(item)) return false
				if (declaredType === 'integer' && !Number.isInteger(item)) return false
				if (isFiniteNumber(minimum) && item < minimum) return false
				if (isFiniteNumber(maximum) && item > maximum) return false
				continue
			}
			if (declaredType === 'string') {
				const choices = field['enum']
				const titled = field['oneOf']
				const minimum = field['minLength']
				const maximum = field['maxLength']
				const format = field['format']
				if (!isString(item)) return false
				if (Array.isArray(choices) && !choices.includes(item)) return false
				if (
					Array.isArray(titled) &&
					!titled.some((choice) => isJSONObject(choice) && choice['const'] === item)
				) {
					return false
				}
				// Code points, not UTF-16 units: JSON Schema counts characters.
				const length = Array.from(item).length
				if (isInteger(minimum) && length < minimum) return false
				if (isInteger(maximum) && length > maximum) return false
				if (format === 'uri' && !isAbsoluteURI(item)) return false
				if (format === 'email' && !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(item)) return false
				if (format === 'date' && !isRFC3339Date(item)) return false
				if (format === 'date-time' && !isRFC3339DateTime(item)) return false
				continue
			}
			const items = field['items']
			const minimum = field['minItems']
			const maximum = field['maxItems']
			if (!Array.isArray(item) || !item.every((entry) => isString(entry))) return false
			if (isInteger(minimum) && item.length < minimum) return false
			if (isInteger(maximum) && item.length > maximum) return false
			if (!isJSONObject(items)) return false
			const choices = items['enum']
			const titled = items['anyOf']
			if (Array.isArray(choices) && !item.every((entry) => choices.includes(entry))) return false
			if (
				Array.isArray(titled) &&
				!item.every((entry) =>
					titled.some((choice) => isJSONObject(choice) && choice['const'] === entry),
				)
			) {
				return false
			}
		}
		return true
	} catch {
		return false
	}
}

/**
 * Determines whether a value is one filesystem root a client exposes.
 *
 * @remarks
 * The dated schema declares `uri` with `format: uri`, so this applies the same RFC 3986
 * check {@link isAbsoluteURI} gives every other `format: uri` field the package validates,
 * including a URL-mode elicitation's `url`. Total over hostile input.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when `value` carries an absolute `uri` and an optional string `name`
 *
 * @example
 * ```ts
 * isMCPRoot({ uri: 'file:///workspace', name: 'workspace' }) // true
 * isMCPRoot({ uri: 'workspace' }) // false — the schema declares `format: uri`
 * ```
 */
export function isMCPRoot(value: unknown): value is MCPRoot {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const root = owned.value
		const name = root['name']
		const metadata = root['_meta']
		if (!isAbsoluteURI(root['uri'])) return false
		if (!isUndefined(name) && !isString(name)) return false
		return isUndefined(metadata) || isMCPMetaObject(metadata)
	} catch {
		return false
	}
}

/**
 * Determines whether a value is one client answer to an embedded `roots/list` request.
 *
 * @remarks
 * The dated schema requires the `roots` array, and each root is checked by
 * {@link isMCPRoot}. Total over hostile input.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when `value` carries an array of valid roots
 *
 * @example
 * ```ts
 * isMCPRootResult({ roots: [{ uri: 'file:///workspace' }] }) // true
 * isMCPRootResult({ roots: {} }) // false — the schema requires an array
 * ```
 */
export function isMCPRootResult(value: unknown): value is MCPRootResult {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const result = owned.value
		const roots = result['roots']
		const metadata = result['_meta']
		if (!Array.isArray(roots) || !roots.every((root) => isMCPRoot(root))) return false
		return isUndefined(metadata) || isMCPMetaObject(metadata)
	} catch {
		return false
	}
}

/**
 * Determines whether a value is one block a sampling completion may carry.
 *
 * @remarks
 * The schema's `SamplingMessageContentBlock`: the text, image, and audio blocks
 * {@link isMCPContent} also admits, plus `tool_use` and `tool_result`. The resource arms of
 * {@link isMCPContent} are refused, because the schema leaves them out of a sampling
 * completion. A `tool_result` carries ordinary {@link isMCPContent} blocks and an open
 * `structuredContent`, which the schema constrains to no shape at all. Total over hostile
 * input.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when `value` is one legal sampling content block
 *
 * @example
 * ```ts
 * isMCPSampleContent({ type: 'text', text: 'Paris' }) // true
 * isMCPSampleContent({ type: 'tool_use', id: 'c1', name: 'lookup', input: {} }) // true
 * isMCPSampleContent({ type: 'resource_link', name: 'doc', uri: 'file:///doc' }) // false
 * ```
 */
export function isMCPSampleContent(value: unknown): value is MCPSampleContent {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const block = owned.value
		const metadata = block['_meta']
		if (!isUndefined(metadata) && !isMCPMetaObject(metadata)) return false
		if (block['type'] === 'tool_use') {
			return isString(block['id']) && isString(block['name']) && isRecord(block['input'])
		}
		if (block['type'] === 'tool_result') {
			const carried = block['content']
			const failed = block['isError']
			if (!Array.isArray(carried) || !carried.every((entry) => isMCPContent(entry))) return false
			if (!isUndefined(failed) && !isBoolean(failed)) return false
			return isString(block['toolUseId'])
		}
		if (!isMCPContent(block)) return false
		return block.type === 'text' || block.type === 'image' || block.type === 'audio'
	} catch {
		return false
	}
}

/**
 * Determines whether a value is one client answer to an embedded sampling request.
 *
 * @remarks
 * The schema's `CreateMessageResult` types `content` as an `anyOf` over one
 * {@link isMCPSampleContent} block or an ARRAY of them, so both are admitted here: a
 * tool-using model answers with `tool_use` and `tool_result` blocks, and a model answering in
 * several parts answers with the array. `stopReason` stays an open string because the schema
 * names four values and permits any other a provider reports. Total over hostile input.
 *
 * @param value - The unknown value to inspect
 * @returns `true` when `value` has the sampling-completion shape
 *
 * @example
 * ```ts
 * isMCPSampleResult({
 * 	role: 'assistant',
 * 	content: { type: 'text', text: 'Paris' },
 * 	model: 'test-model',
 * }) // true
 * isMCPSampleResult({
 * 	role: 'assistant',
 * 	content: [{ type: 'text', text: 'Paris' }],
 * 	model: 'test-model',
 * }) // true
 * ```
 */
export function isMCPSampleResult(value: unknown): value is MCPSampleResult {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const result = owned.value
		const role = result['role']
		const content = result['content']
		const reason = result['stopReason']
		const metadata = result['_meta']
		if (role !== 'user' && role !== 'assistant') return false
		if (!isString(result['model'])) return false
		const blocks = Array.isArray(content) ? content : [content]
		if (!blocks.every((block) => isMCPSampleContent(block))) return false
		if (!isUndefined(reason) && !isString(reason)) return false
		return isUndefined(metadata) || isMCPMetaObject(metadata)
	} catch {
		return false
	}
}

/**
 * Determines whether a response answers the exact embedded request that was issued.
 *
 * @remarks
 * A response carries no `method` of its own, so the ISSUED request selects which arm applies
 * — the same way {@link isElicitContent} takes the issued schema rather than trusting the
 * content to describe itself. A form elicitation is checked twice: once for the response
 * shape and once, on `accept`, for the content against the schema that round issued. A
 * URL-mode elicitation issues no schema, so only the shape is checked. A request this
 * package cannot recognize admits NOTHING, because an unrecognized question has no correct
 * answer. Total over hostile responses and hostile requests alike.
 *
 * @param value - The client's answer to check
 * @param request - The exact {@link MCPInputRequest} that was issued under the same key
 * @returns `true` when the answer is legal for that request
 *
 * @example
 * ```ts
 * isMCPInputResponse({ roots: [] }, { method: 'roots/list' }) // true
 * isMCPInputResponse({ roots: [] }, { method: 'sampling/createMessage', params: {} }) // false
 * ```
 */
export function isMCPInputResponse(value: unknown, request: unknown): value is MCPInputResponse {
	if (!isMCPInputRequest(request)) return false
	try {
		if (request.method === 'roots/list') return isMCPRootResult(value)
		if (request.method === 'sampling/createMessage') return isMCPSampleResult(value)
		if (!isMCPElicitResult(value)) return false
		if (value.action !== 'accept' || !isMCPElicitForm(request.params)) return true
		return isElicitContent(value.content ?? {}, request.params.requestedSchema)
	} catch {
		return false
	}
}

/**
 * Determines whether a value is an MCP input-required result.
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
 * isMCPInputResult({ resultType: 'input_required', requestState: 'opaque' }) // true
 * isMCPInputResult({ resultType: 'input_required' }) // false
 * ```
 */
export function isMCPInputResult(value: unknown): value is MCPInputResult {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	try {
		const result = owned.value
		if (result['resultType'] !== 'input_required') return false
		const inputRequests = result['inputRequests']
		const requestState = result['requestState']
		const metadata = result['_meta']
		if (!isUndefined(inputRequests) && !isMCPInputRequestMap(inputRequests)) return false
		if (!isUndefined(requestState) && !isString(requestState)) return false
		if (!isUndefined(metadata) && !isMCPResultMetaObject(metadata)) return false
		return !isUndefined(inputRequests) || !isUndefined(requestState)
	} catch {
		return false
	}
}

/**
 * Determines whether a parsed value is a {@link JSONRPCRequest}.
 *
 * @remarks
 * A request is a record with `jsonrpc === '2.0'`, a string `method`, and an `id`
 * that {@link isJSONRPCId} accepts. An id-less call is NOT a request — it is a
 * {@link JSONRPCNotification}, which {@link isJSONRPCNotification} answers for. The
 * guards are mutually exclusive on every input: this one requires a valid `id`
 * value, that one requires no own `id` member at all. `params`, when present, must
 * be a record. Total: any other input returns `false`.
 *
 * @param value - The already-parsed value to test
 * @returns `true` when `value` is a valid JSON-RPC request
 *
 * @example
 * ```ts
 * isJSONRPCRequest({ jsonrpc: '2.0', method: 'ping', id: 1 }) // true
 * isJSONRPCRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }) // false — a notification
 * isJSONRPCRequest({ jsonrpc: '1.0', method: 'ping', id: 1 }) // false
 * ```
 */
export function isJSONRPCRequest(value: unknown): value is JSONRPCRequest {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	const request = owned.value
	if (request['jsonrpc'] !== '2.0' || !isString(request['method'])) return false
	if (!isJSONRPCId(request['id'])) return false
	const params = request['params']
	return isUndefined(params) || isRecord(params)
}

/**
 * Determines whether a parsed value is a {@link JSONRPCNotification}.
 *
 * @remarks
 * A notification is a request-shaped call carrying NO `id` member — the protocol
 * forbids one, because nothing answers a notification. `params`, when present, must
 * be a record. Total: any other input returns `false`.
 *
 * @param value - The already-parsed value to test
 * @returns `true` when `value` is a valid JSON-RPC notification
 *
 * @example
 * ```ts
 * isJSONRPCNotification({ jsonrpc: '2.0', method: 'notifications/initialized' }) // true
 * isJSONRPCNotification({ jsonrpc: '2.0', method: 'ping', id: 1 }) // false — a request
 * ```
 */
export function isJSONRPCNotification(value: unknown): value is JSONRPCNotification {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	const notification = owned.value
	if (notification['jsonrpc'] !== '2.0' || !isString(notification['method'])) return false
	if (Object.hasOwn(notification, 'id')) return false
	const params = notification['params']
	return isUndefined(params) || isRecord(params)
}

/**
 * Determines whether a parsed value is a {@link JSONRPCInvocation} — a request or a
 * notification.
 *
 * @remarks
 * The union of {@link isJSONRPCRequest} and {@link isJSONRPCNotification}, which are
 * mutually exclusive, so a positive answer names exactly one arm. Total.
 *
 * @param value - The already-parsed value to test
 * @returns `true` when `value` is a valid JSON-RPC request or notification
 */
export function isJSONRPCInvocation(value: unknown): value is JSONRPCInvocation {
	return isJSONRPCRequest(value) || isJSONRPCNotification(value)
}

/**
 * Determines whether a parsed value is a {@link JSONRPCResultResponse} — the success
 * arm of a response.
 *
 * @remarks
 * A result answers a request, so `id` is REQUIRED and must be a valid
 * {@link isJSONRPCId}. The envelope must own a `result` and must NOT own an `error`,
 * which is what makes this guard and {@link isJSONRPCErrorResponse} mutually
 * exclusive on every input. `result` itself must be an object: either a modern
 * {@link isMCPResult} or a legacy {@link isMCPLegacyResult}, never a bare primitive.
 * Total.
 *
 * @param value - The already-parsed value to test
 * @returns `true` when `value` is a valid JSON-RPC result response
 *
 * @example
 * ```ts
 * isJSONRPCResultResponse({ jsonrpc: '2.0', id: 1, result: { resultType: 'complete' } }) // true
 * isJSONRPCResultResponse({ jsonrpc: '2.0', id: 1, result: 5 }) // false — a result is an object
 * ```
 */
export function isJSONRPCResultResponse(value: unknown): value is JSONRPCResultResponse {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	const response = owned.value
	if (response['jsonrpc'] !== '2.0' || !isJSONRPCId(response['id'])) return false
	if (Object.hasOwn(response, 'error') || !Object.hasOwn(response, 'result')) return false
	const result = response['result']
	return isMCPResult(result) || isMCPLegacyResult(result)
}

/**
 * Determines whether a value is one JSON-RPC `error` member.
 *
 * @remarks
 * The failure OBJECT, not the envelope carrying it — the shape a failed response owns
 * under `error`, and the shape a `failed` {@link MCPTaskDetail} owns under the same name,
 * which is why it is one guard rather than the same checks written twice.
 *
 * It is deliberately STRUCTURAL rather than exact-JSON: `data` is declared `unknown`, so
 * requiring the whole object to survive a JSON clone would refuse a legal error that
 * carried a non-JSON payload. Both callers here hand it an already-owned value.
 *
 * That choice is why the key reads are guarded. Every sibling guard clones first, and a
 * clone reads each key once behind a boundary that already owns totality; this one is the
 * family's only DIRECT reader, so it meets `code` and `message` exactly as the value defines
 * them — including as accessors that throw. Reading a named key off an unowned value is
 * itself the hostile step, and it is bounded here rather than allowed to escape. Total.
 *
 * @param value - The already-parsed value to test
 * @returns `true` when `value` carries an integer `code` and a string `message`
 *
 * @example
 * ```ts
 * isJSONRPCError({ code: -32602, message: 'Invalid params' }) // true
 * isJSONRPCError({ code: -32602.5, message: 'x' }) // false — a code is an integer
 * ```
 */
export function isJSONRPCError(value: unknown): value is JSONRPCError {
	if (!isRecord(value)) return false
	const read = attempt(() => isInteger(value['code']) && isString(value['message']))
	return read.success && read.value
}

/**
 * Determines whether a parsed value is a {@link JSONRPCErrorResponse} — the failure
 * arm of a response.
 *
 * @remarks
 * `id` is OPTIONAL here and only here: a peer that could not read the failed
 * request's id OMITS the member rather than sending `null`, so an absent `id` is
 * valid and a `null` one is not. The envelope must own an `error` and must NOT own a
 * `result`. `error` carries an integer `code` and a string `message`. Total.
 *
 * @param value - The already-parsed value to test
 * @returns `true` when `value` is a valid JSON-RPC error response
 *
 * @example
 * ```ts
 * isJSONRPCErrorResponse({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }) // true
 * isJSONRPCErrorResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'x' } }) // false
 * ```
 */
export function isJSONRPCErrorResponse(value: unknown): value is JSONRPCErrorResponse {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	const response = owned.value
	if (response['jsonrpc'] !== '2.0') return false
	if (Object.hasOwn(response, 'id') && !isJSONRPCId(response['id'])) return false
	if (Object.hasOwn(response, 'result') || !Object.hasOwn(response, 'error')) return false
	return isJSONRPCError(response['error'])
}

/**
 * Determines whether a parsed value is a {@link JSONRPCResponse}.
 *
 * @remarks
 * The union of the mutually exclusive arms. Total.
 *
 * @param value - The already-parsed value to test
 * @returns `true` when `value` is a valid JSON-RPC response
 */
export function isJSONRPCResponse(value: unknown): value is JSONRPCResponse {
	return isJSONRPCResultResponse(value) || isJSONRPCErrorResponse(value)
}

/**
 * Determines whether a parsed value is a {@link JSONRPCMessage} — an invocation or a
 * response.
 *
 * @remarks
 * The union of {@link isJSONRPCInvocation} and {@link isJSONRPCResponse}. Total.
 *
 * @param value - The already-parsed value to test
 * @returns `true` when `value` is a valid JSON-RPC message
 */
export function isJSONRPCMessage(value: unknown): value is JSONRPCMessage {
	return isJSONRPCInvocation(value) || isJSONRPCResponse(value)
}

/**
 * Determines whether a parsed value is an MCP `initialize` invocation.
 *
 * @param value - The already-parsed value to test
 * @returns `true` when `value` is a valid `initialize` request or notification
 *
 * @example
 * ```ts
 * isInitializeRequest({ jsonrpc: '2.0', method: 'initialize', id: 1 }) // true
 * isInitializeRequest({ jsonrpc: '2.0', method: 'ping', id: 1 }) // false
 * ```
 */
export function isInitializeRequest(value: unknown): value is JSONRPCInvocation {
	const owned = attempt(() => cloneJSONRecord(value))
	return owned.success && isJSONRPCInvocation(owned.value) && owned.value['method'] === 'initialize'
}

/**
 * Determines whether a JSON-RPC invocation uses the modern per-request MCP wire shape.
 *
 * @remarks
 * Presence routes and validity answers: this guard checks only that
 * `params._meta` carries the reserved protocol-version key. The key's value is
 * deliberately not narrowed here, so a present non-string version remains modern
 * and is rejected later by `parseRequestContext` rather than falling through to
 * legacy dispatch. Total over hostile and malformed input.
 *
 * @param value - The already-parsed value to inspect
 * @returns `true` when the value is an invocation carrying the reserved version key
 */
export function isModernRequest(value: unknown): value is JSONRPCInvocation {
	const owned = attempt(() => cloneJSONRecord(value))
	if (!owned.success) return false
	const request = owned.value
	if (!isJSONRPCInvocation(request)) return false
	const params = request['params']
	const metadata = isRecord(params) ? params['_meta'] : undefined
	return isRecord(metadata) && Object.hasOwn(metadata, MCP_META_VERSION)
}
