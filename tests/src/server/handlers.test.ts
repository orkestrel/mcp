import { describe, expect, it } from 'vitest'
import { createMCPPostHandler } from '@src/server'
import {
	collectSSE,
	createCalculatorServer,
	createJSONRPCNotification,
	createJSONRPCRequest,
} from '../../setup.js'

describe('createMCPPostHandler', () => {
	it('returns a JSON response for an id-bearing request', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), false)
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				body: JSON.stringify(createJSONRPCRequest({ method: 'ping' })),
			}),
		)

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
	})

	it('returns a parse error for malformed JSON', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), false)
		const response = await handler(
			new Request('http://localhost/mcp', { method: 'POST', body: '{ not json' }),
		)

		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({
			jsonrpc: '2.0',
			id: null,
			error: { code: -32700, message: 'Parse error' },
		})
	})

	it('returns an empty accepted response for a notification', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), false)
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				body: JSON.stringify(createJSONRPCNotification('notifications/initialized')),
			}),
		)

		expect(response.status).toBe(202)
		expect(await response.text()).toBe('')
	})

	it('frames a response as an event stream when negotiated', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), true)
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { accept: 'text/event-stream' },
				body: JSON.stringify(createJSONRPCRequest({ method: 'ping' })),
			}),
		)
		const events = await collectSSE(response)

		expect(events).toHaveLength(1)
		const event = events[0]
		if (event === undefined) throw new Error('Expected one event-stream response')
		expect(JSON.parse(event.data)).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
	})
})
