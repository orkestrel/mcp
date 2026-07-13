import {
	isInitializeRequest,
	isJSONRPCMessage,
	isJSONRPCRequest,
	isJSONRPCResponse,
	isRequestId,
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
