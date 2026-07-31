import {
	isJSONRPCMessage,
	isModernRequest,
	MCP_META_CAPABILITIES,
	MCP_META_CLIENT,
	MCP_META_VERSION,
	parseJSONRPCMessage,
	parseRequestContext,
} from '@src/core'
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

describe('parseRequestContext', () => {
	it('projects the required metadata and optional client identity', () => {
		const request = {
			jsonrpc: '2.0',
			method: 'tools/call',
			id: 1,
			params: {
				_meta: {
					[MCP_META_VERSION]: '2026-07-28',
					[MCP_META_CAPABILITIES]: { elicitation: {} },
					[MCP_META_CLIENT]: { name: 'agent', version: '1.0.0' },
				},
			},
		}

		expect(parseRequestContext(request)).toEqual({
			version: '2026-07-28',
			capabilities: { elicitation: {} },
			identity: { name: 'agent', version: '1.0.0' },
		})
	})

	it('accepts a string unsupported revision so the caller can return -32022', () => {
		const request = {
			jsonrpc: '2.0',
			method: 'tools/list',
			id: 1,
			params: {
				_meta: {
					[MCP_META_VERSION]: '2024-11-05',
					[MCP_META_CAPABILITIES]: {},
				},
			},
		}

		expect(parseRequestContext(request)).toEqual({
			version: '2024-11-05',
			capabilities: {},
		})
	})

	it('enforces defined output implies modern routing', () => {
		const requests: readonly unknown[] = [
			{
				jsonrpc: '2.0',
				method: 'tools/list',
				id: 1,
				params: {
					_meta: {
						[MCP_META_VERSION]: '2026-07-28',
						[MCP_META_CAPABILITIES]: {},
					},
				},
			},
			{ jsonrpc: '2.0', method: 'tools/list', id: 2 },
			null,
		]
		const unsound = requests.filter((request) => {
			const context = parseRequestContext(request)
			return context !== undefined && !isModernRequest(request)
		})

		expect(unsound).toEqual([])
	})

	it('maps guard-positive malformed required metadata to the -32602 parse failure', () => {
		const malformed: readonly unknown[] = [
			{
				jsonrpc: '2.0',
				method: 'tools/list',
				id: 1,
				params: {
					_meta: { [MCP_META_VERSION]: 7, [MCP_META_CAPABILITIES]: {} },
				},
			},
			{
				jsonrpc: '2.0',
				method: 'tools/list',
				id: 2,
				params: { _meta: { [MCP_META_VERSION]: '2026-07-28' } },
			},
			{
				jsonrpc: '2.0',
				method: 'tools/list',
				id: 3,
				params: {
					_meta: {
						[MCP_META_VERSION]: '2026-07-28',
						[MCP_META_CAPABILITIES]: {},
						[MCP_META_CLIENT]: { name: 'agent', version: 7 },
					},
				},
			},
		]

		expect(malformed.every(isModernRequest)).toBe(true)
		expect(malformed.map((request) => parseRequestContext(request))).toEqual([
			undefined,
			undefined,
			undefined,
		])
	})

	it('is total over hostile input', () => {
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()

		expect(parseRequestContext(proxy)).toBeUndefined()
	})
})
