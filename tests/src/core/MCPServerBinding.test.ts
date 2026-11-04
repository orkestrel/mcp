import { JSONRPC_INVALID_REQUEST } from '@orkestrel/jsonrpc'
import { createMCPServer, isMCPError, MCPServerBinding } from '@src/core'
import { createTool, createToolManager } from '@orkestrel/tool'
import { requireValue, waitForAbort, waitForCondition, waitForDelay } from '@orkestrel/test'
import { describe, expect, it } from 'vitest'
import { createMemoryTransport, modernRequest } from '../../setup.js'

describe('MCPServerBinding', () => {
	it('answers a well-formed response with nothing and reports it on the error event', async () => {
		const tools = createToolManager()
		const server = createMCPServer({ identity: { name: 'binding', version: '1' }, tools })
		const errors: unknown[] = []
		server.emitter.on('error', (error) => errors.push(error))
		const carrier = createMemoryTransport()
		const binding = new MCPServerBinding(server, carrier)
		try {
			carrier.deliver(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
			await waitForDelay()

			expect(carrier.sent).toEqual([])
			expect(errors).toHaveLength(1)
			expect(isMCPError(errors[0]) && errors[0].code).toBe(JSONRPC_INVALID_REQUEST)
		} finally {
			binding.stop()
			tools.destroy()
		}
	})

	it('answers a malformed request under its own id', async () => {
		const tools = createToolManager()
		const server = createMCPServer({ identity: { name: 'binding', version: '1' }, tools })
		const carrier = createMemoryTransport()
		const binding = new MCPServerBinding(server, carrier)
		try {
			carrier.deliver(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 5 }))
			await waitForCondition('the refusal to reach the carrier', () => carrier.sent.length > 0)

			expect(JSON.parse(requireValue(carrier.sent[0]))).toEqual({
				jsonrpc: '2.0',
				id: 9,
				error: { code: JSONRPC_INVALID_REQUEST, message: 'Invalid Request' },
			})
		} finally {
			binding.stop()
			tools.destroy()
		}
	})

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
