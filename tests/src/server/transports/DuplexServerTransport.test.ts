import { JSONRPC_INVALID_REQUEST } from '@orkestrel/jsonrpc'
import type { MCPMessageTransportEventMap } from '@src/core'
import { buildInboundFault, isMCPError } from '@src/core'
import { waitForCondition } from '@orkestrel/test'
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
		const written: string[] = []
		const errors: unknown[] = []
		carrier.emitter.on('error', (error) => errors.push(error))
		output.on('data', (chunk: Buffer) => written.push(chunk.toString()))
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
			// JSON-RPC gives no response to a response, so the stray one is reported and unanswered.
			expect(written).toEqual([])
			expect(errors).toHaveLength(1)
			expect(isMCPError(errors[0]) && errors[0].context).toBeUndefined()
		} finally {
			await transport.close()
			input.destroy()
			output.destroy()
		}
	})

	it('refuses an invocation carrying a member no JSON text can hold, without a throw', () => {
		const thrown: unknown[] = []
		const sent: unknown[] = []
		// A custom carrier whose emitter records a listener throw instead of swallowing it.
		const emitter = createEmitter<MCPMessageTransportEventMap>({
			error: (error) => thrown.push(error),
		})
		const transport = new DuplexServerTransport({
			emitter,
			session: undefined,
			duplex: true,
			start: () => Promise.resolve(),
			send: (message) => {
				sent.push(message)
				return Promise.resolve()
			},
			close: () => Promise.resolve(),
		})
		const received: string[] = []
		transport.listen((message) => received.push(message))
		const request = createRPCMessage()

		emitter.emit('message', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { count: 1n } })
		emitter.emit('message', request)

		expect(thrown).toEqual([])
		expect(received).toEqual([JSON.stringify(request)])
		// A malformed request carrying an id is the one thing this transport answers.
		expect(sent).toEqual([
			{
				jsonrpc: '2.0',
				id: 2,
				error: { code: JSONRPC_INVALID_REQUEST, message: 'Invalid Request' },
			},
		])
	})

	it('emits error and answers nothing for a value with no id and for a malformed response', () => {
		const sent: unknown[] = []
		const errors: unknown[] = []
		const emitter = createEmitter<MCPMessageTransportEventMap>()
		emitter.on('error', (error) => errors.push(error))
		const transport = new DuplexServerTransport({
			emitter,
			session: undefined,
			duplex: true,
			start: () => Promise.resolve(),
			send: (message) => {
				sent.push(message)
				return Promise.resolve()
			},
			close: () => Promise.resolve(),
		})
		const received: string[] = []
		transport.listen((message) => received.push(message))

		emitter.emit('message', JSON.parse('{"jsonrpc":"2.0","method":5}'))
		emitter.emit('message', { jsonrpc: '2.0', id: 3, result: 1n })

		expect(received).toEqual([])
		expect(sent).toEqual([])
		expect(errors).toHaveLength(2)
	})

	it('reports a refusal the carrier could not write on its error event', async () => {
		const errors: unknown[] = []
		const failure = new Error('carrier write failed')
		const emitter = createEmitter<MCPMessageTransportEventMap>()
		emitter.on('error', (error) => errors.push(error))
		const transport = new DuplexServerTransport({
			emitter,
			session: undefined,
			duplex: true,
			start: () => Promise.resolve(),
			send: () => Promise.reject(failure),
			close: () => Promise.resolve(),
		})
		transport.listen(() => {})

		emitter.emit('error', buildInboundFault({ id: 4, method: 5 }, 'non-JSON-RPC line'))

		await waitForCondition('the write failure to be reported', () => errors.includes(failure))

		expect(errors).toContain(failure)
	})

	it('rejects an outbound message that does not decode, and writes nothing', async () => {
		const sent: unknown[] = []
		const transport = new DuplexServerTransport({
			emitter: createEmitter<MCPMessageTransportEventMap>(),
			session: undefined,
			duplex: true,
			start: () => Promise.resolve(),
			send: (message) => {
				sent.push(message)
				return Promise.resolve()
			},
			close: () => Promise.resolve(),
		})

		await expect(transport.send('{')).rejects.toSatisfy(isMCPError)
		await expect(transport.send('{"not":"a message"}')).rejects.toSatisfy(isMCPError)
		expect(sent).toEqual([])
		await transport.send(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
		expect(sent).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }])
	})
})
