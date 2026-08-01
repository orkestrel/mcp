import type { StreamInterface } from '@orkestrel/server'
import type { MCPKeepaliveOptions } from '../types.js'
import { DEFAULT_MCP_KEEPALIVE_INTERVAL, SSE_KEEPALIVE_COMMENT } from '../constants.js'
import { createReadableStream } from '../helpers.js'

/**
 * The HTTP response-disconnect bridge for an MCP SSE stream.
 *
 * @remarks
 * Composes the incoming request signal with a controller owned by the MCP HTTP face. The
 * returned {@link signal} therefore observes both an incomplete request body and cancellation
 * of the streamed response body. {@link bridge} preserves the supplied SSE response while
 * forwarding its body through a cancellation-aware stream. While that response is held open,
 * the bridge writes SSE comment frames at the configured keepalive interval so an idle dead
 * client becomes observable to the HTTP writer. It never decides how an abort changes handler
 * or session state.
 */
export class HTTPDisconnect {
	readonly #abort = new AbortController()
	readonly #lifecycle = new AbortController()
	readonly #interval: number
	readonly #signal: AbortSignal
	#timer: ReturnType<typeof setInterval> | undefined

	constructor(signal: AbortSignal, options?: MCPKeepaliveOptions) {
		this.#interval = options?.interval ?? DEFAULT_MCP_KEEPALIVE_INTERVAL
		this.#signal = AbortSignal.any([signal, this.#abort.signal])
	}

	get signal(): AbortSignal {
		return this.#signal
	}

	/**
	 * Bridge cancellation of an SSE response body into this disconnect signal.
	 *
	 * @param stream - The open SSE stream whose response will be consumed by the HTTP writer
	 * @returns A response with the same status and headers whose body forwards the SSE bytes
	 */
	bridge(stream: StreamInterface): Response {
		const response = stream.response
		const body = response.body
		if (body === null) throw new Error('MCP SSE response has no body')
		const reader = body.getReader()
		// This timer is SSE transport liveness, not polling for producer work: an idle response
		// must write to let the HTTP writer observe a dead socket and cancel the body.
		this.#timer = setInterval(() => {
			if (stream.closed) this.#stop()
			else stream.comment(SSE_KEEPALIVE_COMMENT)
		}, this.#interval)
		this.#signal.addEventListener('abort', () => this.#stop(), {
			once: true,
			signal: this.#lifecycle.signal,
		})
		if (this.#signal.aborted || stream.closed) this.#stop()
		return new Response(
			createReadableStream<Uint8Array>(
				async (controller) => {
					try {
						const chunk = await reader.read()
						if (chunk.done) {
							this.#stop()
							controller.close()
						} else controller.enqueue(chunk.value)
					} catch (error) {
						this.#stop()
						controller.error(error)
					}
				},
				async (reason) => {
					this.#abort.abort()
					this.#stop()
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

	#stop(): void {
		if (this.#timer !== undefined) {
			clearInterval(this.#timer)
			this.#timer = undefined
		}
		this.#lifecycle.abort()
	}
}
