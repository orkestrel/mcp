import type { StreamInterface } from '@orkestrel/server'
import { HTTPDisconnect } from '@src/server'
import { describe, expect, it } from 'vitest'
import { openStream } from '@orkestrel/server'
import { waitForDelay } from '@orkestrel/test'
import { waitForSettlement } from '../../../setup.js'
import { createStreamStub } from '../../../setupServer.js'

describe('HTTPDisconnect', () => {
	it('propagates incoming request abort to the composed signal', async () => {
		const request = new AbortController()
		const stream = openStream()
		const disconnect = new HTTPDisconnect(request.signal, { interval: 10 })
		const response = disconnect.bridge(stream)
		const body = response.body
		if (body === null) throw new Error('Bridged response has no body')
		const reader = body.getReader()

		try {
			const keepalive = await waitForSettlement(
				reader.read(),
				250,
				'Timed out waiting for the pre-abort keepalive',
			)
			expect(keepalive.done).toBe(false)
			expect(new TextDecoder().decode(keepalive.value)).toBe(': keepalive\n\n')

			request.abort()
			expect(disconnect.signal.aborted).toBe(true)
			const afterAbort = reader.read()
			await waitForDelay(10)
			await expect(
				waitForSettlement(
					afterAbort,
					30,
					'Timed out as expected after request abort stopped keepalives',
				),
			).rejects.toThrow('Timed out as expected after request abort stopped keepalives')
		} finally {
			try {
				await waitForSettlement(
					reader.cancel(),
					250,
					'Timed out cancelling the request-abort reader',
				)
			} finally {
				stream.end()
			}
		}
	})

	it('forwards status, headers, and SSE body bytes', async () => {
		const stream = openStream({ status: 201, headers: { 'x-probe': 'forwarded' } })
		const disconnect = new HTTPDisconnect(new AbortController().signal, { interval: 10 })
		const response = disconnect.bridge(stream)

		try {
			stream.write({ event: 'result', data: 'ready' })
			stream.end()
			const text = await waitForSettlement(
				response.text(),
				250,
				'Timed out reading forwarded SSE bytes',
			)

			expect(response.status).toBe(201)
			expect(response.headers.get('x-probe')).toBe('forwarded')
			expect(text).toBe('event: result\ndata: ready\n\n')
		} finally {
			stream.end()
		}
	})

	it('writes keepalive comments while the upstream stream is idle', async () => {
		const stream = openStream()
		const disconnect = new HTTPDisconnect(new AbortController().signal, { interval: 10 })
		const response = disconnect.bridge(stream)
		const body = response.body
		if (body === null) throw new Error('Bridged response has no body')
		const reader = body.getReader()

		try {
			const chunk = await waitForSettlement(
				reader.read(),
				250,
				'Timed out waiting for an SSE keepalive',
			)
			expect(chunk.done).toBe(false)
			expect(new TextDecoder().decode(chunk.value)).toBe(': keepalive\n\n')
		} finally {
			try {
				await waitForSettlement(reader.cancel(), 250, 'Timed out cancelling the keepalive reader')
			} finally {
				stream.end()
			}
		}
	})

	it('aborts and cancels upstream when the response consumer cancels', async () => {
		const stream = openStream()
		const disconnect = new HTTPDisconnect(new AbortController().signal, { interval: 10 })
		const response = disconnect.bridge(stream)
		const body = response.body
		if (body === null) throw new Error('Bridged response has no body')
		const reader = body.getReader()

		try {
			await waitForSettlement(
				reader.cancel('consumer closed'),
				250,
				'Timed out cancelling the bridged response',
			)
			expect(disconnect.signal.aborted).toBe(true)
			expect(stream.closed).toBe(true)
		} finally {
			try {
				await waitForSettlement(
					reader.cancel(),
					250,
					'Timed out finalizing the cancelled response reader',
				)
			} finally {
				stream.end()
			}
		}
	})

	// Row 10 — the pump-failure path. `#abort()` used to abort the LISTENER-DETACH controller,
	// so the composed signal stayed live and the handler, the controlled stream, and the
	// producer behind them all kept running for a response that could no longer be written.
	it('aborts the composed signal when forwarding the upstream body fails', async () => {
		const failure = new Error('upstream body boom')
		const stream = createStreamStub({ body: failure })
		const disconnect = new HTTPDisconnect(new AbortController().signal, { interval: 10 })
		const response = disconnect.bridge(stream)
		const body = response.body
		if (body === null) throw new Error('Bridged response has no body')
		const reader = body.getReader()

		await expect(
			waitForSettlement(reader.read(), 250, 'Timed out waiting for the forwarding failure'),
		).rejects.toBe(failure)

		expect(disconnect.signal.aborted).toBe(true)
	})

	// Row 11 — a SEPARATE proof, because the keepalive reaches `#abort()` through a different
	// door than the pump does. One chunk is written first so the forwarding queue is full and
	// the pump is NOT parked on a read: that is the dead-writer shape, where the interval is
	// the only observer left to notice that the SSE stream underneath has gone.
	it('aborts the composed signal when a keepalive tick finds the SSE stream closed', async () => {
		const stream = openStream()
		const disconnect = new HTTPDisconnect(new AbortController().signal, { interval: 10 })
		disconnect.bridge(stream)
		stream.write({ data: 'first' })
		await waitForDelay()

		stream.end()
		await waitForDelay(60)

		expect(disconnect.signal.aborted).toBe(true)
	})

	it('does not abort graceful completion while its final read is still draining', async () => {
		const completion = Promise.withResolvers<void>()
		let ended = false
		const stream: StreamInterface = {
			response: new Response(
				new ReadableStream<Uint8Array>({
					async pull(controller) {
						await completion.promise
						controller.close()
					},
				}),
			),
			get closed() {
				return ended
			},
			write() {
				return true
			},
			comment() {},
			async drain() {},
			end() {
				ended = true
			},
		}
		const disconnect = new HTTPDisconnect(new AbortController().signal, { interval: 10 })
		const response = disconnect.bridge(stream)
		const body = response.body
		if (body === null) throw new Error('Bridged response has no body')

		try {
			await waitForDelay()
			stream.end()
			await waitForDelay(30)

			expect(stream.closed).toBe(true)
			expect(disconnect.signal.aborted).toBe(false)
			completion.resolve()
			expect(await response.text()).toBe('')
			expect(disconnect.signal.aborted).toBe(false)
		} finally {
			completion.resolve()
			if (!body.locked) await body.cancel()
		}
	})

	// The control, drawn from OUTSIDE the population the two rows above cover: a disconnect
	// that is never bridged has no timer, no listener, and no reachable `#abort()`. Its signal
	// must be reported LIVE — otherwise an always-aborted assertion would be indistinguishable
	// from a correct one.
	it('reports a never-bridged disconnect live, however long nothing happens', async () => {
		const disconnect = new HTTPDisconnect(new AbortController().signal, { interval: 10 })

		await waitForDelay(40)

		expect(disconnect.signal.aborted).toBe(false)
	})

	// ── W05-B row 25 — the keepalive interval is a BOUND, not a suggestion ─────
	//
	// The interval reached `setInterval` raw, and this class's own TSDoc called that deliberate:
	// "applies the configured interval directly without normalization". `interval: 0` therefore
	// turned an SSE liveness tick into a busy loop firing at the timer's floor — the polling
	// architecture AGENTS forbids — and `-1` / `NaN` do the same, since neither is a delay any
	// host can honour. Every other numeric knob in this package is sanitized; this one is now too.

	it.each([
		{ label: 'zero', interval: 0 },
		{ label: 'negative', interval: -1 },
		{ label: 'fractional', interval: 0.5 },
		{ label: 'subnormal', interval: Number.MIN_VALUE },
		{ label: 'infinite', interval: Number.POSITIVE_INFINITY },
		{ label: 'NaN', interval: Number.NaN },
		{ label: 'above the Node timer maximum', interval: 2_147_483_648 },
	])('refuses a $label interval instead of busy-looping the keepalive', async ({ interval }) => {
		// A `pending` body parks the bridge's reader, so the keepalive timer is the only thing
		// running and every tick it takes is recorded as a comment.
		const stream = createStreamStub({ pending: true })
		const disconnect = new HTTPDisconnect(new AbortController().signal, { interval })
		disconnect.bridge(stream)

		await waitForDelay(50)

		// A hostile value coerced by the host to its timer floor ticks as fast as the loop will
		// schedule it. A bounded one falls back or clamps above that floor, so not one is written.
		expect(disconnect.signal.aborted).toBe(false)
		expect(stream.comments).toEqual([])
	})

	// The control, from OUTSIDE the population the two rows above cover: a LEGITIMATE interval,
	// which must still tick. A bound that refused every value would satisfy both assertions above
	// while silently removing the liveness tick the whole class exists for.
	it('still ticks on a legitimate interval', async () => {
		const stream = createStreamStub({ pending: true })
		const disconnect = new HTTPDisconnect(new AbortController().signal, { interval: 15 })
		disconnect.bridge(stream)

		await waitForDelay(50)

		expect(stream.comments.length).toBeGreaterThan(0)
		expect(stream.comments[0]).toBe('keepalive')
	})

	it('closes on upstream completion without inventing an abort', async () => {
		const stream = openStream()
		const disconnect = new HTTPDisconnect(new AbortController().signal, { interval: 10 })
		const response = disconnect.bridge(stream)
		const body = response.body
		if (body === null) throw new Error('Bridged response has no body')
		const reader = body.getReader()

		try {
			stream.end()
			const chunk = await waitForSettlement(
				reader.read(),
				250,
				'Timed out waiting for upstream completion',
			)
			expect(chunk.done).toBe(true)
			expect(disconnect.signal.aborted).toBe(false)
		} finally {
			try {
				await waitForSettlement(
					reader.cancel(),
					250,
					'Timed out finalizing the completed response reader',
				)
			} finally {
				stream.end()
			}
		}
	})

	// ── The single-response lifecycle, enforced rather than only documented ────
	//
	// The class doc has always said "This is a single-response lifecycle object, not a reusable
	// bridge", and nothing held a caller to it. `HTTPDisconnect` is exported and its own
	// `@example` shows a consumer constructing and bridging directly, so the second call was
	// reachable — and it did two things at once. It overwrote `#timer`, which left the FIRST
	// interval running with no handle anywhere that could clear it (a ref'd timer, alive for the
	// process's life). And the first bridge's terminal aborts `#lifecycle`, so the second
	// bridge's abort listener registered against an already-aborted signal and was never added
	// at all — leaving the second bridge with neither cleanup either.

	it('refuses a second bridge instead of building a second response over one lifecycle', () => {
		const first = createStreamStub({ pending: true })
		const second = createStreamStub({ pending: true })
		const disconnect = new HTTPDisconnect(new AbortController().signal, { interval: 10 })

		expect(disconnect.bridge(first).status).toBe(200)
		expect(() => disconnect.bridge(second)).toThrow('MCP SSE response is already bridged')
		// The refusal happens before anything is taken from the second stream, so a caller that
		// mis-wired one is free to bridge it from its own disconnect.
		expect(second.response.bodyUsed).toBe(false)
	})

	it('orphans no keepalive timer: release stops every tick a refused second bridge could have started', async () => {
		const first = createStreamStub({ pending: true })
		const second = createStreamStub({ pending: true })
		const request = new AbortController()
		const disconnect = new HTTPDisconnect(request.signal, { interval: 10 })
		disconnect.bridge(first)
		expect(() => disconnect.bridge(second)).toThrow('MCP SSE response is already bridged')

		await waitForDelay(50)
		expect(first.comments.length).toBeGreaterThan(0)

		request.abort()
		const settled = first.comments.length
		await waitForDelay(50)

		// One armed timer, one handle, one `clearInterval`. A second bridge would have replaced
		// that handle and left this stream ticking past its own release.
		expect(first.comments.length).toBe(settled)
		expect(second.comments).toEqual([])
	})

	// The control, drawn from OUTSIDE the population the two rows above cover: a FIRST bridge is
	// never refused, and the stream it was given still ticks. A guard that refused every call
	// would satisfy both rows above while removing the class's whole reason to exist.
	it('CONTROL — a first bridge on a fresh disconnect is accepted and ticks', async () => {
		const stream = createStreamStub({ pending: true })
		const disconnect = new HTTPDisconnect(new AbortController().signal, { interval: 10 })

		expect(() => disconnect.bridge(stream)).not.toThrow()
		await waitForDelay(50)

		expect(stream.comments.length).toBeGreaterThan(0)
	})
})
