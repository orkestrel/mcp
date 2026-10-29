import type { MCPSessionEntry } from '@src/server'
import { MCPSession, MCPSessionStore } from '@src/server'
import { describe, expect, it } from 'vitest'

describe('MCPSessionStore', () => {
	it('keys entries by their session identifier and preserves replacement identity', () => {
		const store = new MCPSessionStore()
		const session = new MCPSession('session')
		const entry: MCPSessionEntry = { session, touched: 10, version: '2025-06-18' }
		const replacement: MCPSessionEntry = { ...entry, touched: 20 }

		expect(store.get(session.id)).toBeUndefined()
		store.set(entry)
		expect(store.get(session.id)).toBe(entry)
		store.set(replacement)
		expect(store.get(session.id)).toBe(replacement)
		expect(store.get('other')).toBeUndefined()
	})

	it('removes the named session once without removing another session', () => {
		const store = new MCPSessionStore()
		const first: MCPSessionEntry = {
			session: new MCPSession('first'),
			touched: 10,
			version: '2025-06-18',
		}
		const second: MCPSessionEntry = { ...first, session: new MCPSession('second') }
		store.set(first)
		store.set(second)

		expect(store.delete('first')).toBe(true)
		expect(store.delete('first')).toBe(false)
		expect(store.get('first')).toBeUndefined()
		expect(store.get('second')).toBe(second)
	})

	it('sweeps the inclusive idle boundary and retains later entries', () => {
		const store = new MCPSessionStore()
		for (const touched of [9, 10, 11]) {
			store.set({
				session: new MCPSession(String(touched)),
				touched,
				version: '2025-06-18',
			})
		}

		store.sweep(10)
		expect(store.get('9')).toBeUndefined()
		expect(store.get('10')).toBeUndefined()
		expect(store.get('11')?.touched).toBe(11)
		store.sweep(11)
		expect(store.get('11')).toBeUndefined()
	})
})
