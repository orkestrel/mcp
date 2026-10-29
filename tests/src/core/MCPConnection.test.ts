import { describe, expect, it } from 'vitest'
import { MCPConnection } from '../../../src/core/MCPConnection.js'
import { createFixturePeer } from '../../setup.js'

describe('MCPConnection', () => {
	it('keeps a failed close owed and joins a running retry', async () => {
		const peer = createFixturePeer({
			reply: () => undefined,
			close: { fault: (count) => count === 1, hold: (count) => count === 2 },
		})
		const connection = new MCPConnection(peer, async (current) => {
			await peer.start()
			current.claim()
			current.accept('2026-07-28')
		})
		expect(peer.started).toBe(0)
		await connection.negotiation
		expect(connection.settled).toBe(true)
		expect(connection.connected).toBe(true)
		connection.supersede()
		expect(connection.version).toBeUndefined()
		expect(connection.connected).toBe(false)
		expect(connection.superseded).toBe(true)

		await expect(connection.close()).rejects.toThrow('transport close failed')
		expect(connection.owed).toBe(true)
		const closing = connection.close()
		const joining = connection.close()
		expect(peer.closed).toBe(2)
		peer.release()
		await Promise.all([closing, joining])
		expect(connection.owed).toBe(false)
		expect(peer.live).toBe(0)
	})

	it('keeps a released transport discharged when its pending start later claims it', async () => {
		const peer = createFixturePeer({ reply: () => undefined })
		const connection = new MCPConnection(peer, async (current) => {
			current.claim()
		})
		connection.release()
		await connection.negotiation
		expect(connection.superseded).toBe(true)
		expect(connection.owed).toBe(false)
		expect(connection.connected).toBe(false)
		expect(peer.closed).toBe(0)
	})
})
