import type { MCPMessageTransportEventMap } from '@src/core'
import { describe, expect, it } from 'vitest'
import { createEmitter } from '@orkestrel/emitter'
import { StdioLifetime } from '../../../src/server/StdioLifetime.js'
import { CHILD_SCRIPT } from '../../setupServer.js'

describe('StdioLifetime', () => {
	it('spawns only when opened and retains its terminal evidence after close', async () => {
		const lifetime = new StdioLifetime(
			createEmitter<MCPMessageTransportEventMap>(),
			{ command: process.execPath, args: ['-e', CHILD_SCRIPT] },
			undefined,
		)
		expect(lifetime.child).toBeUndefined()
		expect(lifetime.evidence).toBeUndefined()
		try {
			lifetime.open()
			await lifetime.opened
			expect(lifetime.child).toBeDefined()
			expect(lifetime.closed).toBe(false)
			await lifetime.close()
			await lifetime.ended
			expect(lifetime.child).toBeUndefined()
			expect(lifetime.closed).toBe(true)
			expect(lifetime.reported).toBe(true)
			expect(lifetime.evidence).toBe('')
		} finally {
			await lifetime.close()
		}
	})

	it('reports an unopened lifetime once without spawning', async () => {
		const emitter = createEmitter<MCPMessageTransportEventMap>()
		const lifetime = new StdioLifetime(emitter, { command: process.execPath }, undefined)
		const reports: boolean[] = []
		emitter.on('close', () => reports.push(lifetime.reported))

		await lifetime.close()
		await lifetime.close()
		await lifetime.ended

		expect(reports).toEqual([false])
		expect(lifetime.reported).toBe(true)
		expect(lifetime.closed).toBe(true)
		expect(lifetime.child).toBeUndefined()
		expect(lifetime.evidence).toBeUndefined()
	})
})
