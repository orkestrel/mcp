import { describe, expect, it } from 'vitest'
import { isMCPError, MCPError } from '@src/core'

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
