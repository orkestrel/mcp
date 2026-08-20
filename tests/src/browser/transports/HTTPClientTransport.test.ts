import type { JSONRPCMessage } from '@src/core'
import { describe, expect, it } from 'vitest'
import { HTTPClientTransport } from '@src/browser'
import { waitForDelay } from '@orkestrel/test'

// src/browser/transports/HTTPClientTransport.ts — what the browser face owes a caller that
// closes it. The round trip against the real Node-face server is proven in
// tests/src/browser/factories.test.ts; this file pins the RELEASE half, which needs a reply
// that never arrives. The peer is a boundary stub for the platform `fetch`: it answers with a
// REAL `Response` over a REAL `ReadableStream` that stays open, and honors `init.signal` the
// way the platform does — erroring the body and failing the pending read. It reimplements
// nothing this package owns; the transport under test is the real one.

interface EndlessFetchInterface {
	/** The `fetch` to hand the transport through its public `fetch` option. */
	readonly answer: typeof fetch
	/** How many response bodies were cancelled through the signal the transport passed. */
	readonly cancelled: number
}

function createEndlessFetch(): EndlessFetchInterface {
	let cancelled = 0
	const encoder = new TextEncoder()
	const answer: typeof fetch = async (_input, init) => {
		const signal = init?.signal ?? undefined
		if (signal !== null && signal?.aborted === true) throw new Error('aborted before dispatch')
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				// One SSE comment: enough for the response headers to flush and the reader to park,
				// and not an event, so the transport never finishes decoding.
				controller.enqueue(encoder.encode(': open\n\n'))
				signal?.addEventListener(
					'abort',
					() => {
						cancelled += 1
						controller.error(new Error('response body cancelled'))
					},
					{ once: true },
				)
			},
		})
		return new Response(body, {
			status: 200,
			headers: { 'content-type': 'text/event-stream' },
		})
	}
	return {
		answer,
		get cancelled() {
			return cancelled
		},
	}
}

const REQUEST: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'tools/list' }

describe('HTTPClientTransport — close releases the request it has in flight', () => {
	it('close() cancels the response body a send is still reading', async () => {
		const peer = createEndlessFetch()
		const transport = new HTTPClientTransport({
			url: 'http://127.0.0.1:1/mcp',
			fetch: peer.answer,
		})
		const sending = transport.send(REQUEST)
		await waitForDelay(20)
		// The control: the reply never ends, so the write is still outstanding.
		expect(peer.cancelled).toBe(0)

		await transport.close()

		await expect(
			Promise.race([sending.then(() => 'settled'), waitForDelay(200).then(() => 'unsettled')]),
		).resolves.toBe('settled')
		expect(peer.cancelled).toBe(1)
	})

	it('surfaces the cancellation on error rather than throwing out of send', async () => {
		const peer = createEndlessFetch()
		const transport = new HTTPClientTransport({
			url: 'http://127.0.0.1:1/mcp',
			fetch: peer.answer,
		})
		const errors: unknown[] = []
		transport.emitter.on('error', (error) => errors.push(error))
		const sending = transport.send(REQUEST)
		await waitForDelay(20)

		await transport.close()
		await sending

		expect(errors).toHaveLength(1)
	})
})

describe('HTTPClientTransport — close is idempotent', () => {
	it('emits close once however many times it is called', async () => {
		const transport = new HTTPClientTransport({ url: 'http://127.0.0.1:1/mcp' })
		let closed = 0
		transport.emitter.on('close', () => (closed += 1))

		await transport.close()
		await transport.close()
		await transport.close()

		expect(closed).toBe(1)
	})
})
