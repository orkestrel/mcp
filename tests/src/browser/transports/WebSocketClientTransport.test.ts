import type { JSONRPCMessage } from '@src/core'
import { describe, expect, inject, it } from 'vitest'
import { WebSocketClientTransport } from '@src/browser'
import { waitForDelay } from '@orkestrel/test'
import { MODERN_METADATA } from '../../../setup.js'

// src/browser/transports/WebSocketClientTransport.ts — what the browser face owes the socket
// it borrowed. The round trip against the real Node-face WebSocket server is proven in
// tests/src/browser/factories.test.ts; this file pins the RELEASE half. A socket this
// transport closed keeps firing its own native events afterwards, so a close that leaves the
// bridge installed lets a superseded socket end a connection it no longer owns.

const serverURL = inject('server')

describe('WebSocketClientTransport — close releases the socket it bound', () => {
	it('ignores the old socket close after a new socket has replaced it', async () => {
		const transport = new WebSocketClientTransport({ url: `${serverURL}/mcp` })
		const messages: JSONRPCMessage[] = []
		let closed = 0
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('close', () => (closed += 1))
		await transport.start()

		await transport.close()
		await transport.start()
		// The first socket's native `close` lands here, after the second is already live.
		await waitForDelay(60)

		expect(closed).toBe(1)
		await transport.send({
			jsonrpc: '2.0',
			method: 'ping',
			id: 2,
			params: { _meta: MODERN_METADATA },
		})
		await waitForDelay(60)

		// The replacement connection is still the one this transport is talking over.
		expect(messages).toHaveLength(1)
		await transport.close()
	})

	it('emits close once however many times it is called', async () => {
		const transport = new WebSocketClientTransport({ url: `${serverURL}/mcp` })
		let closed = 0
		transport.emitter.on('close', () => (closed += 1))
		await transport.start()

		await transport.close()
		await transport.close()
		await waitForDelay(60)

		expect(closed).toBe(1)
	})
})
