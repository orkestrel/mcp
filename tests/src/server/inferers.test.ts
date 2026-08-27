import type { MCPHeaderParameter } from '@src/core'
import {
	JSONRPC_INVALID_PARAMS,
	JSONRPC_METHOD_NOT_FOUND,
	MCP_HEADER_MISMATCH,
	MCP_MISSING_CAPABILITY,
	MCP_UNSUPPORTED_VERSION,
	buildJSONRPCError,
	buildJSONRPCResult,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	inferHeaderTarget,
	inferLegacyVersion,
	inferParameterRefusal,
	inferStatus,
} from '@src/server'
import { createJSONRPCRequest } from '../../setup.js'

describe('inferHeaderTarget', () => {
	it.each([
		{ method: 'tools/call', params: { name: 'add' }, target: 'add' },
		{ method: 'prompts/get', params: { name: 'greet' }, target: 'greet' },
		{ method: 'resources/read', params: { uri: 'memory://one' }, target: 'memory://one' },
	])('reads the $method target the standard header names', (row) => {
		expect(
			inferHeaderTarget(createJSONRPCRequest({ method: row.method, params: row.params })),
		).toBe(row.target)
	})

	it.each(['server/discover', 'tools/list', 'resources/list', 'prompts/list'])(
		'reads no target for %s',
		(method) => {
			expect(
				inferHeaderTarget(createJSONRPCRequest({ method, params: { name: 'add', uri: 'x://y' } })),
			).toBeUndefined()
		},
	)

	it('reads no target when the named member is absent or not a string', () => {
		expect(inferHeaderTarget(createJSONRPCRequest({ method: 'tools/call' }))).toBeUndefined()
		expect(
			inferHeaderTarget(createJSONRPCRequest({ method: 'tools/call', params: { name: 7 } })),
		).toBeUndefined()
		expect(
			inferHeaderTarget(createJSONRPCRequest({ method: 'resources/read', params: { uri: null } })),
		).toBeUndefined()
	})
})

describe('inferLegacyVersion', () => {
	it('pins a requested supported legacy revision', () => {
		expect(
			inferLegacyVersion(createJSONRPCRequest({ params: { protocolVersion: '2025-06-18' } })),
		).toBe('2025-06-18')
	})

	it('selects the newest legacy revision for a modern or unsupported request', () => {
		expect(
			inferLegacyVersion(createJSONRPCRequest({ params: { protocolVersion: '2026-07-28' } })),
		).toBe('2025-11-25')
		expect(
			inferLegacyVersion(createJSONRPCRequest({ params: { protocolVersion: '2099-01-01' } })),
		).toBe('2025-11-25')
	})
})

describe('inferStatus', () => {
	it('maps notifications to 202 and successful responses to 200', () => {
		expect(inferStatus(undefined, 'modern')).toBe(202)
		expect(inferStatus(buildJSONRPCResult(1, {}), 'modern')).toBe(200)
	})

	it.each([
		MCP_HEADER_MISMATCH,
		MCP_MISSING_CAPABILITY,
		MCP_UNSUPPORTED_VERSION,
		JSONRPC_INVALID_PARAMS,
	])('maps modern error %i to 400', (code) => {
		expect(inferStatus(buildJSONRPCError(1, code, 'failed'), 'modern')).toBe(400)
	})

	it('maps modern method-not-found to 404', () => {
		expect(inferStatus(buildJSONRPCError(1, JSONRPC_METHOD_NOT_FOUND, 'missing'), 'modern')).toBe(
			404,
		)
	})

	it('keeps every legacy in-band error at HTTP 200', () => {
		expect(inferStatus(buildJSONRPCError(1, JSONRPC_INVALID_PARAMS, 'invalid'), 'legacy')).toBe(200)
		expect(inferStatus(buildJSONRPCError(1, JSONRPC_METHOD_NOT_FOUND, 'missing'), 'legacy')).toBe(
			200,
		)
	})
})

// A request carrying exactly the fields one row supplies. Local to this file: no other suite
// needs it, and `tests/setup.ts` owns only helpers more than one suite shares.
function createHeaderRequest(headers: Readonly<Record<string, string>>): Request {
	return new Request('http://localhost/mcp', { method: 'POST', headers })
}

describe('inferParameterRefusal', () => {
	const PARAMETERS: readonly MCPHeaderParameter[] = [
		{ name: 'Region', path: ['region'], primitive: 'string' },
		{ name: 'Count', path: ['count'], primitive: 'integer' },
		{ name: 'Verbose', path: ['verbose'], primitive: 'boolean' },
		{ name: 'Zone', path: ['routing', 'zone'], primitive: 'string' },
	]

	it('answers nothing when every recognized header agrees with the body', () => {
		expect(
			inferParameterRefusal(
				createHeaderRequest({
					'Mcp-Param-Region': 'us-west1',
					'Mcp-Param-Count': '42',
					'Mcp-Param-Verbose': 'false',
					'Mcp-Param-Zone': '=?base64?IHBhZGRlZCA=?=',
				}),
				PARAMETERS,
				{ region: 'us-west1', count: 42, verbose: false, routing: { zone: ' padded ' } },
			),
		).toBeUndefined()
	})

	it('answers nothing for an empty parameter table whatever the request carries', () => {
		expect(
			inferParameterRefusal(createHeaderRequest({ 'Mcp-Param-Region': 'anything' }), [], {
				region: 'us-west1',
			}),
		).toBeUndefined()
	})

	it('answers nothing for a header no parameter names', () => {
		expect(
			inferParameterRefusal(
				createHeaderRequest({ 'Mcp-Param-Unknown': 'anything' }),
				PARAMETERS,
				{},
			),
		).toBeUndefined()
	})

	it('names the first offending parameter in table order', () => {
		expect(
			inferParameterRefusal(createHeaderRequest({}), PARAMETERS, {
				region: 'us-west1',
				count: 42,
			}),
		).toBe("Required Mcp-Param-Region header is missing; the request body carries 'region'.")
	})

	it('refuses an invalid sentinel without echoing the value the peer sent', () => {
		const refusal = inferParameterRefusal(
			createHeaderRequest({ 'Mcp-Param-Region': '=?base64?SGVsbG8?=' }),
			PARAMETERS,
			{ region: 'Hello' },
		)

		expect(refusal).toBe('Mcp-Param-Region header value is not a valid Base64 sentinel.')
		expect(refusal).not.toContain('SGVsbG8')
	})

	it('reads a nested parameter at its own property path', () => {
		expect(
			inferParameterRefusal(createHeaderRequest({ 'Mcp-Param-Zone': 'b' }), PARAMETERS, {
				routing: { zone: 'a' },
			}),
		).toBe("Mcp-Param-Zone header does not match the request body value at 'routing.zone'.")
	})

	it('leaves a parameter whose body value contradicts its declared type unvalidated', () => {
		// The tool registry owns the disagreement between a declared `integer` and a supplied
		// string; refusing it here would report an argument fault as a header fault.
		expect(
			inferParameterRefusal(createHeaderRequest({}), PARAMETERS, { count: 'seven' }),
		).toBeUndefined()
	})
})
