import { isJSONRPCMessage, parseJSONRPCMessage } from '@src/core'
import { describe, expect, it } from 'vitest'

// parseJSONRPCMessage narrows an already-parsed value to a JSONRPCMessage or
// undefined (AGENTS §14 — total; the raw-string JSON.parse happens in
// MCPServer.handle). Sound with isJSONRPCMessage: a guard-valid input is returned
// unchanged, every non-undefined output satisfies the guard.

describe('parseJSONRPCMessage', () => {
	it('returns a request unchanged', () => {
		const request = { jsonrpc: '2.0', method: 'ping', id: 1 }

		expect(parseJSONRPCMessage(request)).toBe(request)
	})

	it('returns a response unchanged', () => {
		const response = { jsonrpc: '2.0', id: 1, result: {} }

		expect(parseJSONRPCMessage(response)).toBe(response)
	})

	it('returns undefined for a non-message record', () => {
		expect(parseJSONRPCMessage({ method: 'ping' })).toBeUndefined()
	})

	it('returns undefined for adversarial input', () => {
		for (const value of [null, undefined, 42, 'x', [1, 2], true]) {
			expect(parseJSONRPCMessage(value)).toBeUndefined()
		}
	})

	it('is sound with isJSONRPCMessage (output always satisfies the guard)', () => {
		const samples: readonly unknown[] = [
			{ jsonrpc: '2.0', method: 'ping', id: 1 },
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			{ jsonrpc: '2.0', id: 1, result: {} },
			{ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } },
			{ not: 'a message' },
			null,
			[1, 2],
		]
		// Every non-undefined output must satisfy the guard — collect any violator and
		// assert unconditionally (no conditional expect).
		const unsound = samples
			.map((value) => parseJSONRPCMessage(value))
			.filter((parsed) => parsed !== undefined && !isJSONRPCMessage(parsed))

		expect(unsound).toEqual([])
	})
})
