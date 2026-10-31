import type { MCPMessageTransportEventMap } from '@src/core'
import { createEmitter } from '@orkestrel/emitter'
import { DuplexServerTransport, StdioServerTransport } from '@src/server'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createRPCMessage, MCPFixtureCell } from '../../../setup.js'

describe('DuplexServerTransport', () => {
	it('filters responses and replaces the invocation callback without binding its receiver', async () => {
		const input = new PassThrough()
		const output = new PassThrough()
		const carrier = new StdioServerTransport(input, output)
		const transport = new DuplexServerTransport(carrier)
		const receiver = new MCPFixtureCell<unknown>('unread')
		const received: string[] = []
		transport.listen((message) => received.push(`old:${message}`))
		transport.listen(function (this: unknown, message) {
			receiver.value = this
			received.push(message)
		})
		const request = createRPCMessage()
		try {
			carrier.emitter.emit('message', { jsonrpc: '2.0', id: 1, result: {} })
			carrier.emitter.emit('message', request)
			expect(received).toEqual([JSON.stringify(request)])
			expect(receiver.value).toBeUndefined()
		} finally {
			await transport.close()
			input.destroy()
			output.destroy()
		}
	})

	it('refuses an invocation carrying a member no JSON text can hold, without a throw', () => {
		const thrown: unknown[] = []
		// A custom carrier whose emitter records a listener throw instead of swallowing it.
		const emitter = createEmitter<MCPMessageTransportEventMap>({
			error: (error) => thrown.push(error),
		})
		const transport = new DuplexServerTransport({
			emitter,
			session: undefined,
			duplex: true,
			start: () => Promise.resolve(),
			send: () => Promise.resolve(),
			close: () => Promise.resolve(),
		})
		const received: string[] = []
		transport.listen((message) => received.push(message))
		const request = createRPCMessage()

		emitter.emit('message', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { count: 1n } })
		emitter.emit('message', request)

		expect(thrown).toEqual([])
		expect(received).toEqual([JSON.stringify(request)])
	})
})
