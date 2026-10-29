import { createMCPServer, MCPServerBinding } from '@src/core'
import { createTool, createToolManager } from '@orkestrel/tool'
import { waitForAbort } from '@orkestrel/test'
import { describe, expect, it } from 'vitest'
import { createMemoryTransport, modernRequest } from '../../setup.js'

describe('MCPServerBinding', () => {
	it('aborts an active dispatch when detached and leaves the carrier open', async () => {
		const entered = Promise.withResolvers<AbortSignal>()
		const tools = createToolManager()
		tools.add(
			createTool({
				name: 'park',
				execute: async (_arguments, context) => {
					entered.resolve(context.signal)
					await waitForAbort(context.signal)
					return undefined
				},
			}),
		)
		const server = createMCPServer({ identity: { name: 'binding', version: '1' }, tools })
		const carrier = createMemoryTransport()
		const binding = new MCPServerBinding(server, carrier)
		try {
			const request = modernRequest('tools/call', 1)
			carrier.deliver(
				JSON.stringify({
					...request,
					params: { ...request.params, name: 'park', arguments: {} },
				}),
			)
			const signal = await entered.promise
			expect(signal.aborted).toBe(false)
			binding.stop()
			expect(signal.aborted).toBe(true)
			expect(carrier.closedCalls).toBe(0)
		} finally {
			binding.stop()
			tools.destroy()
		}
	})
})
