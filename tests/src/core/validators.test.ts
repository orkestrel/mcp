import {
	isElicitRequest,
	isElicitPrimitiveSchema,
	isElicitResult,
	isFormElicitationSupported,
	isInitializeRequest,
	isInputRequests,
	isInputRequiredResult,
	isJSONRPCMessage,
	isJSONRPCRequest,
	isJSONRPCResponse,
	isMCPVersion,
	isModernRequest,
	isRequestId,
	isSubscriptionFilter,
	MCP_META_CAPABILITIES,
	MCP_META_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@src/core'
import { describe, expect, it } from 'vitest'

// The JSON-RPC 2.0 wire guards (AGENTS §14 — total functions over an already-parsed
// `unknown`; adversarial input returns `false`, never throws). A request without an
// `id` is a valid notification shape; a response carries an `id` (string / number /
// null) and EXACTLY ONE of result / error.

describe('isRequestId', () => {
	it('accepts a string id', () => {
		expect(isRequestId('abc')).toBe(true)
	})

	it('accepts a numeric id', () => {
		expect(isRequestId(1)).toBe(true)
	})

	it('accepts an absent id (undefined ⇒ a notification)', () => {
		expect(isRequestId(undefined)).toBe(true)
	})

	it('rejects a null id (valid only on a response)', () => {
		expect(isRequestId(null)).toBe(false)
	})

	it('rejects an object, an array, and a boolean', () => {
		for (const value of [{}, { id: 1 }, [], [1], true, false]) {
			expect(isRequestId(value)).toBe(false)
		}
	})
})

describe('isMCPVersion', () => {
	it('accepts every supported revision and rejects removed or unknown revisions', () => {
		for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
			expect(isMCPVersion(version)).toBe(true)
		}
		expect(isMCPVersion('2025-03-26')).toBe(false)
		expect(isMCPVersion('2024-11-05')).toBe(false)
	})

	it('is total over non-string values', () => {
		for (const value of [undefined, null, 7, {}, [], true]) {
			expect(isMCPVersion(value)).toBe(false)
		}
	})
})

describe('isSubscriptionFilter', () => {
	it('accepts empty, complete, and extension-bearing filters', () => {
		expect(isSubscriptionFilter({})).toBe(true)
		expect(
			isSubscriptionFilter({
				toolsListChanged: true,
				promptsListChanged: false,
				resourcesListChanged: true,
				resourceSubscriptions: ['resource://one'],
				extension: { future: true },
			}),
		).toBe(true)
	})

	it('rejects invalid recognized fields and remains total over hostile input', () => {
		for (const value of [
			{ toolsListChanged: 'yes' },
			{ promptsListChanged: 1 },
			{ resourcesListChanged: null },
			{ resourceSubscriptions: ['resource://one', 2] },
			null,
			[],
		]) {
			expect(isSubscriptionFilter(value)).toBe(false)
		}
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()
		expect(isSubscriptionFilter(proxy)).toBe(false)
	})
})

describe('multi-round-trip validators', () => {
	it('recognizes implicit and explicit form capabilities but not URL-only support', () => {
		expect(isFormElicitationSupported({ elicitation: {} })).toBe(true)
		expect(isFormElicitationSupported({ elicitation: { form: {} } })).toBe(true)
		expect(isFormElicitationSupported({ elicitation: { form: {}, url: {} } })).toBe(true)
		expect(isFormElicitationSupported({ elicitation: { url: {} } })).toBe(false)
		expect(isFormElicitationSupported({ elicitation: { extension: {} } })).toBe(false)
		expect(isFormElicitationSupported({})).toBe(false)
	})

	it('validates every restricted primitive elicitation schema family', () => {
		for (const schema of [
			{ type: 'boolean', default: true },
			{ type: 'number', minimum: 0, maximum: 5, default: 2 },
			{ type: 'integer', minimum: 1 },
			{ type: 'string', format: 'email', minLength: 3 },
			{ type: 'string', oneOf: [{ const: 'yes', title: 'Yes' }] },
			{ type: 'array', items: { type: 'string', enum: ['one'] }, default: ['one'] },
			{ type: 'array', items: { anyOf: [{ const: 'one', title: 'One' }] } },
		]) {
			expect(isElicitPrimitiveSchema(schema)).toBe(true)
		}
		expect(isElicitPrimitiveSchema({ type: 'object' })).toBe(false)
		expect(isElicitPrimitiveSchema({ type: 'string', format: 'phone' })).toBe(false)
		expect(isElicitPrimitiveSchema({ type: 'array', items: { type: 'string' } })).toBe(false)
		expect(isElicitPrimitiveSchema({ type: 'array', items: { anyOf: [{ const: 1 }] } })).toBe(false)
	})

	it('validates both elicitation modes while retaining deprecated legal input union members', () => {
		expect(
			isElicitRequest({
				method: 'elicitation/create',
				params: {
					message: 'Approve?',
					requestedSchema: {
						type: 'object',
						properties: { approved: { type: 'boolean' } },
						required: ['approved'],
					},
				},
			}),
		).toBe(true)
		expect(
			isElicitRequest({
				method: 'elicitation/create',
				params: {
					message: 'Approve?',
					requestedSchema: {
						type: 'object',
						properties: { approved: { type: 'object' } },
					},
				},
			}),
		).toBe(false)
		expect(
			isElicitRequest({
				method: 'elicitation/create',
				params: { mode: 'url', message: 'Authenticate', url: 'https://example.test' },
			}),
		).toBe(true)
		expect(
			isInputRequests({
				sample: { method: 'sampling/createMessage', params: {} },
				roots: { method: 'roots/list' },
			}),
		).toBe(true)
	})

	it('accepts only keyed request maps and enforces input-required at-least-one-of', () => {
		const requests = {
			confirm: {
				method: 'elicitation/create',
				params: {
					mode: 'form',
					message: 'Approve?',
					requestedSchema: { type: 'object', properties: {} },
				},
			},
		}

		expect(isInputRequests(requests)).toBe(true)
		expect(isInputRequests([requests.confirm])).toBe(false)
		expect(isInputRequiredResult({ resultType: 'input_required', inputRequests: requests })).toBe(
			true,
		)
		expect(
			isInputRequiredResult({
				resultType: 'input_required',
				inputRequests: requests,
				requestState: 'opaque',
			}),
		).toBe(true)
		expect(isInputRequiredResult({ resultType: 'input_required', requestState: 'opaque' })).toBe(
			true,
		)
		expect(isInputRequiredResult({ resultType: 'input_required' })).toBe(false)
		expect(
			isInputRequiredResult({ resultType: 'input_required', inputRequests: [requests.confirm] }),
		).toBe(false)
	})

	it('validates elicitation result values and remains total over hostile input', () => {
		expect(
			isElicitResult({
				action: 'accept',
				content: { approved: true, count: 2, tags: ['one', 'two'] },
			}),
		).toBe(true)
		expect(isElicitResult({ action: 'decline' })).toBe(true)
		expect(isElicitResult({ action: 'accept', content: { nested: {} } })).toBe(false)
		expect(isElicitResult({ action: 'unknown' })).toBe(false)

		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()
		expect(isFormElicitationSupported(proxy)).toBe(false)
		expect(isInputRequests(proxy)).toBe(false)
		expect(isInputRequiredResult(proxy)).toBe(false)
	})
})

describe('isJSONRPCRequest', () => {
	it('accepts a request with a numeric id', () => {
		expect(isJSONRPCRequest({ jsonrpc: '2.0', method: 'ping', id: 1 })).toBe(true)
	})

	it('accepts a request with a string id', () => {
		expect(isJSONRPCRequest({ jsonrpc: '2.0', method: 'ping', id: 'abc' })).toBe(true)
	})

	it('accepts a notification (no id)', () => {
		expect(isJSONRPCRequest({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(true)
	})

	it('accepts a request with a params record', () => {
		expect(
			isJSONRPCRequest({ jsonrpc: '2.0', method: 'tools/call', id: 1, params: { a: 1 } }),
		).toBe(true)
	})

	it('rejects a wrong jsonrpc version', () => {
		expect(isJSONRPCRequest({ jsonrpc: '1.0', method: 'ping', id: 1 })).toBe(false)
	})

	it('rejects a missing method', () => {
		expect(isJSONRPCRequest({ jsonrpc: '2.0', id: 1 })).toBe(false)
	})

	it('rejects a non-string method', () => {
		expect(isJSONRPCRequest({ jsonrpc: '2.0', method: 42, id: 1 })).toBe(false)
	})

	it('rejects a null id (valid only on a response)', () => {
		expect(isJSONRPCRequest({ jsonrpc: '2.0', method: 'ping', id: null })).toBe(false)
	})

	it('rejects a non-record params', () => {
		expect(isJSONRPCRequest({ jsonrpc: '2.0', method: 'ping', id: 1, params: [1, 2] })).toBe(false)
	})

	it('is total on adversarial input (null, primitives, arrays)', () => {
		for (const value of [null, undefined, 42, 'x', [], [1], true]) {
			expect(isJSONRPCRequest(value)).toBe(false)
		}
	})
})

describe('isJSONRPCResponse', () => {
	it('accepts a success response with a result', () => {
		expect(isJSONRPCResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } })).toBe(true)
	})

	it('accepts a success response with a null result value and a null id', () => {
		expect(isJSONRPCResponse({ jsonrpc: '2.0', id: null, result: null })).toBe(true)
	})

	it('accepts an error response', () => {
		expect(
			isJSONRPCResponse({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid' } }),
		).toBe(true)
	})

	it('rejects a response carrying BOTH result and error', () => {
		expect(
			isJSONRPCResponse({
				jsonrpc: '2.0',
				id: 1,
				result: {},
				error: { code: -1, message: 'x' },
			}),
		).toBe(false)
	})

	it('rejects a response carrying NEITHER result nor error', () => {
		expect(isJSONRPCResponse({ jsonrpc: '2.0', id: 1 })).toBe(false)
	})

	it('rejects an error object missing a numeric code', () => {
		expect(isJSONRPCResponse({ jsonrpc: '2.0', id: 1, error: { message: 'x' } })).toBe(false)
	})

	it('rejects a request (no id member, has method) as a response', () => {
		expect(isJSONRPCResponse({ jsonrpc: '2.0', method: 'ping' })).toBe(false)
	})

	it('is total on adversarial input', () => {
		for (const value of [null, undefined, 0, 'x', [], true]) {
			expect(isJSONRPCResponse(value)).toBe(false)
		}
	})
})

describe('isJSONRPCMessage', () => {
	it('accepts a request', () => {
		expect(isJSONRPCMessage({ jsonrpc: '2.0', method: 'ping', id: 1 })).toBe(true)
	})

	it('accepts a response', () => {
		expect(isJSONRPCMessage({ jsonrpc: '2.0', id: 1, result: {} })).toBe(true)
	})

	it('rejects a non-message record', () => {
		expect(isJSONRPCMessage({ hello: 'world' })).toBe(false)
	})
})

describe('isInitializeRequest', () => {
	it('accepts an initialize request', () => {
		expect(isInitializeRequest({ jsonrpc: '2.0', method: 'initialize', id: 1 })).toBe(true)
	})

	it('rejects another method', () => {
		expect(isInitializeRequest({ jsonrpc: '2.0', method: 'ping', id: 1 })).toBe(false)
	})

	it('rejects a non-request', () => {
		expect(isInitializeRequest({ jsonrpc: '2.0', id: 1, result: {} })).toBe(false)
	})
})

describe('isModernRequest', () => {
	it('routes a request with the reserved protocol-version key as modern', () => {
		expect(
			isModernRequest({
				jsonrpc: '2.0',
				method: 'tools/list',
				id: 1,
				params: {
					_meta: {
						[MCP_META_VERSION]: '2026-07-28',
						[MCP_META_CAPABILITIES]: {},
					},
				},
			}),
		).toBe(true)
	})

	it('routes on key presence even when the protocol-version value is not a string', () => {
		expect(
			isModernRequest({
				jsonrpc: '2.0',
				method: 'tools/list',
				id: 1,
				params: { _meta: { [MCP_META_VERSION]: 7 } },
			}),
		).toBe(true)
	})

	it('does not mistake unrelated legacy metadata for the modern discriminator', () => {
		expect(
			isModernRequest({
				jsonrpc: '2.0',
				method: 'tools/list',
				id: 1,
				params: { _meta: { progressToken: 'token' } },
			}),
		).toBe(false)
	})

	it('is total over hostile and malformed input', () => {
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()

		for (const value of [proxy, null, [], { params: { _meta: {} } }]) {
			expect(isModernRequest(value)).toBe(false)
		}
	})
})
