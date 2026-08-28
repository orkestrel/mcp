import type { StreamInterface } from '@orkestrel/server'
import type { MCPKeepaliveOptions } from './types.js'
import { sanitizeBudget } from '@orkestrel/contract'
import { DEFAULT_MCP_KEEPALIVE_INTERVAL, SSE_KEEPALIVE_COMMENT } from './constants.js'
import { createReadableStream } from './helpers.js'

/**
 * Composes one incoming HTTP request lifetime with one MCP-owned SSE response lifetime.
 *
 * @remarks
 * The composed {@link signal} observes request abort and EVERY way this response can end
 * without one: consumer cancellation of the bridged body, a forwarding failure mid-pump, and a
 * keepalive tick that finds the SSE stream already closed. That last pair is the whole point of
 * the composition — a client that vanishes mid-stream aborts nothing by itself, so unless this
 * object raises the signal on its own failure paths, the handler, the controlled stream, and
 * the producer behind them all keep running for a response that can no longer be written.
 * Graceful upstream completion is the one terminal that does NOT abort: the body simply closes,
 * because the exchange finished rather than ended.
 *
 * {@link bridge} preserves the source response status and headers, forwards its body bytes, and
 * owns keepalive comments plus listener/timer cleanup until upstream completion, request abort,
 * or consumer cancellation. This is a single-response lifecycle object, not a reusable bridge:
 * a second {@link bridge} call THROWS rather than arming a second keepalive over one lifecycle.
 * It supplies no handler or session policy.
 *
 * The keepalive interval is a BUDGET, sanitized like every other numeric knob in this package:
 * anything that is not a positive integer — `0`, a negative, a fractional value, `NaN`,
 * `Infinity` — falls back to {@link DEFAULT_MCP_KEEPALIVE_INTERVAL}, and a larger value clamps
 * to Node's `2_147_483_647` ms timer maximum. None may reach the platform's timer floor, where
 * an idle-liveness tick becomes the polling this package forbids everywhere else.
 *
 * @example
 * ```ts
 * import { HTTPDisconnect } from '@orkestrel/mcp/server'
 * import { openStream } from '@orkestrel/server'
 *
 * const disconnect = new HTTPDisconnect(request.signal, { interval: 15_000 })
 * const stream = openStream()
 * const response = disconnect.bridge(stream)
 * ```
 */
export class HTTPDisconnect {
	readonly #response = new AbortController()
	readonly #lifecycle = new AbortController()
	readonly #interval: number
	readonly #signal: AbortSignal
	#timer: ReturnType<typeof setInterval> | undefined
	#bridged = false
	#pulling = false

	/**
	 * Creates the lifecycle composition for one request and its future SSE response.
	 *
	 * @param signal - The incoming request signal
	 * @param options - Optional keepalive `interval` in milliseconds; an invalid value falls back
	 *   to {@link DEFAULT_MCP_KEEPALIVE_INTERVAL}, and one above Node's timer maximum clamps to it
	 */
	constructor(signal: AbortSignal, options?: MCPKeepaliveOptions) {
		// `sanitizeBudget` rejects `NaN`, `Infinity`, a negative, and a fractional value; `0` is a
		// non-negative integer so it passes, and `setInterval(fn, 0)` is the same busy loop every
		// one of those produces. A keepalive cadence is therefore bounded below at one, not zero.
		const interval = sanitizeBudget(options?.interval, DEFAULT_MCP_KEEPALIVE_INTERVAL)
		this.#interval =
			interval > 0 ? Math.min(interval, 2_147_483_647) : DEFAULT_MCP_KEEPALIVE_INTERVAL
		this.#signal = AbortSignal.any([signal, this.#response.signal])
	}

	/**
	 * The signal aborted by the incoming request, or by any end of this response that is not
	 * its graceful completion.
	 *
	 * @returns The composed lifecycle signal
	 */
	get signal(): AbortSignal {
		return this.#signal
	}

	/**
	 * Bridges one open SSE response through cancellation-aware byte forwarding and keepalives.
	 *
	 * Consumer cancellation, a read failure while forwarding, and a keepalive tick that finds the
	 * SSE stream already closed each abort {@link signal}; consumer cancellation also cancels the
	 * upstream reader. Upstream completion closes the returned body without inventing an abort.
	 * Every terminal path clears the keepalive timer and detaches the bridge-owned abort listener.
	 *
	 * @param stream - The open SSE stream whose response will be consumed by the HTTP writer
	 * @returns A one-use response preserving status, status text, headers, and SSE body bytes
	 * @throws When this disconnect has already bridged a stream, or the supplied SSE response
	 *   has no body
	 */
	bridge(stream: StreamInterface): Response {
		// One disconnect composes ONE request with ONE response, and the guard is what makes that
		// enforced rather than merely documented. A second call used to overwrite `#timer`, which
		// left the first interval running with no handle able to clear it, and its own abort
		// listener registered against a `#lifecycle` the first bridge's terminal had already
		// aborted — so the second bridge carried neither cleanup. Refuse before taking the
		// reader, so the stream a mis-wired caller passed is still bridgeable elsewhere.
		if (this.#bridged) throw new Error('MCP SSE response is already bridged')
		this.#bridged = true
		const response = stream.response
		const body = response.body
		if (body === null) throw new Error('MCP SSE response has no body')
		const reader = body.getReader()
		// This timer is SSE transport liveness, not polling for producer work: an idle response
		// must write to let the HTTP writer observe a dead socket and cancel the body.
		this.#timer = setInterval(() => {
			if (stream.closed) {
				// A close observed while `reader.read()` is still outstanding is the graceful
				// `end()` drain window. The read itself will release once it observes the terminal.
				if (!this.#pulling) this.#abort()
			} else stream.comment(SSE_KEEPALIVE_COMMENT)
		}, this.#interval)
		// The composed signal already aborted, so this listener only has to release the bridge's
		// own timer and listener — raising the signal again would be answering an event with
		// itself.
		this.#signal.addEventListener('abort', () => this.#release(), {
			once: true,
			signal: this.#lifecycle.signal,
		})
		if (this.#signal.aborted) this.#release()
		else if (stream.closed) this.#abort()
		return new Response(
			createReadableStream<Uint8Array>(
				async (controller) => {
					this.#pulling = true
					try {
						const chunk = await reader.read()
						if (chunk.done) {
							// The exchange FINISHED. Release the bridge without raising the signal:
							// an abort here would tell a handler that already answered that its
							// request was cancelled.
							this.#release()
							controller.close()
						} else controller.enqueue(chunk.value)
					} catch (error) {
						this.#abort()
						controller.error(error)
					} finally {
						this.#pulling = false
					}
				},
				async (reason) => {
					this.#abort()
					await reader.cancel(reason)
				},
			),
			{
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
			},
		)
	}

	// Give up this bridge's OWN resources — the keepalive timer and the abort listener — without
	// saying anything about the request. The terminal a graceful completion takes.
	#release(): void {
		if (this.#timer !== undefined) {
			clearInterval(this.#timer)
			this.#timer = undefined
		}
		this.#lifecycle.abort()
	}

	// End the response lifetime: release first, so the listener is already detached, then raise
	// the composed signal for every owner still holding it. Idempotent — `abort()` is.
	#abort(): void {
		this.#release()
		this.#response.abort()
	}
}
