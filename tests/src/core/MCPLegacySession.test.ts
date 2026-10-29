import { describe, expect, it } from 'vitest'
import { MCPLegacySession } from '../../../src/core/MCPLegacySession.js'

describe('MCPLegacySession', () => {
	it('claims the handshake once and retains its accepted discovery fields', async () => {
		const session = new MCPLegacySession()
		const response = { jsonrpc: '2.0' as const, id: 0, result: {} }
		expect(session.claim(response)).toBe(true)
		expect(session.claim(response)).toBe(false)
		session.expire(new Error('late deadline'))
		await expect(session.response).resolves.toBe(response)

		const identity = { name: 'peer', version: '1' }
		const capabilities = { tools: {} }
		session.accept(identity, capabilities, 'Read only')
		expect(session.identity).toBe(identity)
		expect(session.capabilities).toBe(capabilities)
		expect(session.instructions).toBe('Read only')
	})

	it('expires an unclaimed handshake and refuses a later claim', async () => {
		const session = new MCPLegacySession()
		const error = new Error('deadline')
		session.expire(error)
		session.expire(new Error('later deadline'))
		expect(session.claim({ jsonrpc: '2.0', id: 0, result: {} })).toBe(false)
		await expect(session.response).rejects.toBe(error)
		expect(session.identity).toBeUndefined()
		expect(session.capabilities).toBeUndefined()
		expect(session.instructions).toBeUndefined()
	})

	it('replaces one correlation without sharing it with another session', () => {
		const session = new MCPLegacySession()
		session.correlate(7, 'tools/list')
		const first = session.correlation(7)
		session.correlate(7, 'tools/call')
		expect(session.correlation(7)).toEqual({ method: 'tools/call' })
		expect(session.correlation(7)).not.toBe(first)
		expect(new MCPLegacySession().correlation(7)).toBeUndefined()
		session.forget(7)
		expect(session.correlation(7)).toBeUndefined()
	})
})
