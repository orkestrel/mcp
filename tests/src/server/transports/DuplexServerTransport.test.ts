import { DuplexServerTransport, StdioServerTransport } from '@src/server'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createJSONRPCRequest, MCPFixtureCell } from '../../../setup.js'

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
		const request = createJSONRPCRequest()
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
})
