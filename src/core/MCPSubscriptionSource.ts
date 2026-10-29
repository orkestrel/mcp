import type {
	JSONRPCNotification,
	MCPLimitOptions,
	MCPMethodOptions,
	MCPServerOptions,
	MCPSubscriptionFilter,
	MCPSubscriptionOptions,
} from './types.js'
import { matchesSubscriptionNotification } from './helpers.js'
import { parseJSONRPCMessage } from './parsers.js'
import { isJSONRPCNotification } from './validators.js'

/** Owns one subscription producer, its registry listeners, and its unread registry frame. */
export class MCPSubscriptionSource {
	readonly #server: MCPServerOptions
	readonly #limits: Required<MCPLimitOptions>
	readonly #stream: ReadableStream<JSONRPCNotification | undefined>
	#frame: JSONRPCNotification | undefined
	#failure: { readonly error: unknown } | undefined
	#iterator: AsyncIterator<JSONRPCNotification> | undefined

	constructor(
		server: MCPServerOptions,
		notifications: MCPSubscriptionFilter,
		options: MCPMethodOptions,
		limits: Required<MCPLimitOptions>,
	) {
		this.#server = server
		this.#limits = limits
		this.#stream = new ReadableStream<JSONRPCNotification | undefined>({
			start: this.#startSubscription.bind(this, notifications, options, server.subscription),
			pull: this.#pullSubscription.bind(this, notifications, options),
		})
	}

	/** Exposes the demand-driven producer and registry queue. */
	get stream(): ReadableStream<JSONRPCNotification | undefined> {
		return this.#stream
	}

	/** Releases the registry coalescing mark only when its own frame was consumed. */
	consume(notification: JSONRPCNotification): void {
		if (notification === this.#frame) this.#frame = undefined
	}

	/** Raises a producer failure after the queued frames have drained. */
	finish(): void {
		if (this.#failure !== undefined) throw this.#failure.error
	}

	async #startSubscription(
		notifications: MCPSubscriptionFilter,
		options: MCPMethodOptions,
		configured: MCPSubscriptionOptions | undefined,
		controller: ReadableStreamDefaultController<JSONRPCNotification | undefined>,
	): Promise<void> {
		const emitter = this.#server.tools.emitter
		const changed = this.#change.bind(this, controller, options.signal)
		if (options.signal.aborted) {
			controller.error(options.signal.reason)
			return
		}
		// Skip listener registration on destroyed registries without relying on emitter tolerance.
		if (notifications.toolsListChanged === true && !emitter.destroyed) {
			emitter.on('add', changed)
			emitter.on('remove', changed)
			emitter.on('clear', changed)
		}
		options.signal.addEventListener(
			'abort',
			() => {
				emitter.off('add', changed)
				emitter.off('remove', changed)
				emitter.off('clear', changed)
				const iterator = this.#iterator
				this.#iterator = undefined
				if (iterator !== undefined) this.#releaseProducer(iterator, options.signal.reason)
				controller.error(options.signal.reason)
			},
			{ once: true },
		)
		try {
			if (configured === undefined) return
			const source = await configured.producer(notifications, options)
			const iterator = source[Symbol.asyncIterator]()
			if (options.signal.aborted) this.#releaseProducer(iterator, options.signal.reason)
			else this.#iterator = iterator
		} catch (error) {
			this.#failSubscription(options.signal, controller, error)
		}
	}

	#change(
		controller: ReadableStreamDefaultController<JSONRPCNotification | undefined>,
		signal: AbortSignal,
	): void {
		// #change is registered only when the honoured filter carries the tools family, and the
		// graceful close runs only when that filter omits it, so this guard's failure check is the
		// whole closed-stream test: a stream with these listeners closes on a failure or its signal
		// and on nothing else.
		if (signal.aborted || this.#failure !== undefined || this.#frame !== undefined) return
		const notification: JSONRPCNotification = {
			jsonrpc: '2.0',
			method: 'notifications/tools/list_changed',
		}
		this.#frame = notification
		controller.enqueue(notification)
	}

	async #pullSubscription(
		notifications: MCPSubscriptionFilter,
		options: MCPMethodOptions,
		controller: ReadableStreamDefaultController<JSONRPCNotification | undefined>,
	): Promise<void> {
		try {
			if (options.signal.aborted) return
			const next = await this.#iterator?.next()
			if (options.signal.aborted) return
			if (next === undefined || next.done === true) {
				this.#iterator = undefined
				if (notifications.toolsListChanged !== true) controller.close()
				return
			}
			// Own before matching: a foreign getter cannot change the frame between reads.
			const owned = parseJSONRPCMessage(next.value, {
				bytes: this.#limits.message,
				depth: this.#limits.depth,
			})
			// A discarded item still settles this pull. The outer reader skips it and
			// requests the next item, preserving demand through unmatched producer frames.
			controller.enqueue(
				owned !== undefined &&
					isJSONRPCNotification(owned) &&
					owned.method !== 'notifications/tools/list_changed' &&
					matchesSubscriptionNotification(owned, notifications)
					? owned
					: undefined,
			)
		} catch (error) {
			this.#failSubscription(options.signal, controller, error)
		}
	}

	#failSubscription(
		signal: AbortSignal,
		controller: ReadableStreamDefaultController<JSONRPCNotification | undefined>,
		error: unknown,
	): void {
		if (signal.aborted) return
		this.#failure = { error }
		controller.close()
	}

	// The reason is the release's argument because a `ReadableStream`-backed producer reads it
	// as the cancel reason: without it the owner's pending writes reject with `undefined` and
	// name nothing. A generator-backed producer ignores the argument, so it costs that case
	// nothing.
	#releaseProducer(iterator: AsyncIterator<JSONRPCNotification>, reason: unknown): void {
		void iterator.return?.(reason)?.catch(() => undefined)
	}
}
