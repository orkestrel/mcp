import { describe, expect, it } from 'vitest'
import {
	isMCPError,
	MCPError,
	MCP_HEADER_MISMATCH,
	MCP_MISSING_CAPABILITY,
	MCP_UNSUPPORTED_VERSION,
} from '@src/core'

describe('MCPError', () => {
	it('preserves the remote message, numeric code, and structured context', () => {
		const error = new MCPError('Remote failure', -32042, { retry: false })

		expect(error).toBeInstanceOf(Error)
		expect(error.name).toBe('MCPError')
		expect(error.message).toBe('Remote failure')
		expect(error.code).toBe(-32042)
		expect(error.context).toEqual({ retry: false })
	})

	it('uses undefined context when the remote error carries no data', () => {
		expect(new MCPError('Missing', -32601).context).toBeUndefined()
	})

	it('represents HeaderMismatch without inventing a data payload', () => {
		const error = new MCPError('Header mismatch', MCP_HEADER_MISMATCH)

		expect(error.code).toBe(-32020)
		expect(error.context).toBeUndefined()
	})

	it('preserves MissingRequiredClientCapability data', () => {
		const context = { requiredCapabilities: { elicitation: { form: {} } } }
		const error = new MCPError(
			'Missing required client capability',
			MCP_MISSING_CAPABILITY,
			context,
		)

		expect(error.code).toBe(-32021)
		expect(error.context).toEqual(context)
	})

	it('preserves exact UnsupportedProtocolVersion negotiation data', () => {
		const context = {
			supported: ['2026-07-28', '2025-11-25', '2025-06-18'],
			requested: '2024-11-05',
		}
		const error = new MCPError('Unsupported protocol version', MCP_UNSUPPORTED_VERSION, context)

		expect(error.code).toBe(-32022)
		expect(error.context).toEqual(context)
	})
})

describe('isMCPError', () => {
	it('narrows only real MCPError instances', () => {
		const error = new MCPError('Remote failure', -32042)

		expect(isMCPError(error)).toBe(true)
		expect(isMCPError(new Error('Remote failure'))).toBe(false)
		expect(isMCPError({ name: 'MCPError', code: -32042, context: undefined })).toBe(false)
	})

	it('is total over hostile and primitive inputs', () => {
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()

		for (const value of [undefined, null, true, 0, '', Symbol('error'), proxy]) {
			expect(isMCPError(value)).toBe(false)
		}
	})
})
