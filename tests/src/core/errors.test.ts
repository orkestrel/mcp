import { describe, expect, expectTypeOf, it } from 'vitest'
import { isMCPError, isMCPToolError, MCPError, MCPToolError } from '@src/core'

describe('MCPToolError', () => {
	it('is an Error that carries its message, the TOOL code, and its name', () => {
		const error = new MCPToolError('tool exploded')

		expect(error).toBeInstanceOf(Error)
		expect(error.message).toBe('tool exploded')
		expect(error.code).toBe('TOOL')
		expect(error.name).toBe('MCPToolError')
		expectTypeOf(error.code).toEqualTypeOf<'TOOL'>()
	})

	it('carries no payload beyond the message and code', () => {
		expect(Object.keys(new MCPToolError('tool exploded')).sort()).toEqual(['code', 'name'])
	})
})

describe('isMCPToolError', () => {
	it('accepts an MCPToolError', () => {
		expect(isMCPToolError(new MCPToolError('tool exploded'))).toBe(true)
	})

	it('refuses a plain Error, an MCPError, and non-errors', () => {
		expect(isMCPToolError(new Error('tool exploded'))).toBe(false)
		expect(isMCPToolError(new MCPError('Method not found', -32601))).toBe(false)
		expect(isMCPToolError({ code: 'TOOL', message: 'tool exploded' })).toBe(false)
		expect(isMCPToolError('tool exploded')).toBe(false)
		expect(isMCPToolError(undefined)).toBe(false)
	})

	it('is not recognized by isMCPError', () => {
		expect(isMCPError(new MCPToolError('tool exploded'))).toBe(false)
	})
})
