import type {
	JSONRPCNotification,
	JSONRPCResponse,
	MCPStream,
	MCPStreamControllerInterface,
} from './types.js'

/**
 * The one cancellation engine every modern held-open result leaves `MCPServer` through.
 *
 * @remarks
 * A native async generator decides cancellation with a QUEUE: `return()` and `throw()` wait
 * behind a `next()` the producer has not answered, so a consumer abandoning a source parked
 * on an event that will never arrive waits forever for its own cancellation. This class
 * arbitrates instead of queueing. It keeps at most ONE read outstanding against the source,
 * settles the consumer's read itself, aborts the request's lifetime BEFORE it delegates
 * cleanup to the producer — so a cooperating producer is woken rather than waited on —
 * contains every promise the producer settles late, and makes every closure path idempotent.
 *
 * The three closures are deliberately different answers: the source's own return is the
 * terminal RESPONSE, `return(value)` is the consumer saying it has the answer already, and
 * {@link stop} is an owner saying there will be no answer at all. Only the first is a
 * message a peer ever sees.
 *
 * A producer's own resource cleanup remains the producer's: JavaScript cannot settle work a
 * generator is suspended inside, so the signal is how an uncooperative producer is asked to
 * finish, and this controller never blocks its consumer on the answer.
 *
 * **What this class does NOT have is an owner of last resort.** No finalizer, no timer, no
 * timeout ends an exchange nobody released. That absence is the design: an exchange holds a
 * producer, a request lifetime and a live server slot, so a silent background release would
 * turn "a pump forgot its obligation" from a reproducible defect into a nondeterministic one,
 * and GC timing is not a lifecycle. Whoever is handed one of these ends it on every exit —
 * see {@link import('./types.js').MCPStreamControllerInterface}.
 *
 * @example
 * ```ts
 * import { MCPStreamController } from '@orkestrel/mcp'
 *
 * const closure = new AbortController()
 * const stream = new MCPStreamController(source, closure.signal, closure)
 * const first = await stream.next() // one notification
 * stream.stop() // ends the exchange now, however long the producer takes to notice
 * ```
 */
export class MCPStreamController implements MCPStreamControllerInterface {
	readonly #source: MCPStream
	readonly #signal: AbortSignal
	readonly #closure: AbortController
	readonly #listener: () => void
	#waiter: PromiseWithResolvers<IteratorResult<JSONRPCNotification, JSONRPCResponse>> | undefined
	#terminal: JSONRPCResponse | undefined
	#error: unknown
	#closed = false

	/**
	 * Control one produced stream for the lifetime of one request.
	 *
	 * @param source - The produced held-open result whose cancellation this controller owns
	 * @param signal - The request signal every closure settles against; its abort ends the exchange
	 * @param closure - The request's lifetime controller, aborted the moment the exchange ends
	 */
	constructor(source: MCPStream, signal: AbortSignal, closure: AbortController) {
		this.#source = source
		this.#signal = signal
		this.#closure = closure
		this.#listener = this.#abort.bind(this)
		if (signal.aborted) this.#fail(signal.reason)
		else signal.addEventListener('abort', this.#listener, { once: true })
	}

	/**
	 * Read the next message, or the terminating response that ends the exchange.
	 *
	 * @remarks
	 * At most one read is outstanding against the source at a time, and a rival read is
	 * refused rather than queued: two live consumers on one held-open answer would split a
	 * sequence neither of them could reassemble. A read parked on the producer settles as
	 * soon as the exchange closes, whatever the producer is doing.
	 *
	 * @returns The next notification, or the terminal response as the iteration's `return`
	 * @throws The abort reason when the request ended, or the source's own failure
	 */
	async next(): Promise<IteratorResult<JSONRPCNotification, JSONRPCResponse>> {
		if (this.#closed) return this.#exhausted()
		if (this.#waiter !== undefined) throw new Error('A stream read is already pending')
		const waiter = Promise.withResolvers<IteratorResult<JSONRPCNotification, JSONRPCResponse>>()
		this.#waiter = waiter
		const pending = this.#source.next()
		// The consumer may leave before the producer answers, and the promise it abandons is
		// this controller's to contain rather than the runtime's to report.
		void pending.catch(() => undefined)
		let result: IteratorResult<JSONRPCNotification, JSONRPCResponse>
		try {
			result = await Promise.race([pending, waiter.promise])
		} catch (error) {
			if (!this.#closed) this.#fail(error)
			throw error
		}
		if (this.#closed) return this.#exhausted()
		this.#waiter = undefined
		if (result.done !== true) return result
		this.#complete(result.value)
		return { done: true, value: result.value }
	}

	/**
	 * End the exchange because the consumer already has its answer.
	 *
	 * @param value - The terminal the consumer is ending on
	 * @returns That terminal as the iteration's `return`
	 */
	async return(
		value: JSONRPCResponse | PromiseLike<JSONRPCResponse>,
	): Promise<IteratorResult<JSONRPCNotification, JSONRPCResponse>> {
		const terminal = await value
		this.#complete(terminal)
		return { done: true, value: terminal }
	}

	/**
	 * End the exchange with a failure the consumer is raising.
	 *
	 * @param error - The failure to end the exchange with
	 * @returns Never — the returned promise always rejects
	 * @throws The supplied failure
	 */
	async throw(error: unknown): Promise<IteratorResult<JSONRPCNotification, JSONRPCResponse>> {
		this.#fail(error)
		throw error
	}

	/**
	 * End the exchange permanently, with no terminal response.
	 *
	 * @remarks
	 * Idempotent, and the operation an owner that is not the consumer uses: a transport whose
	 * connection closed, a pump whose write failed. A parked read settles with the request's
	 * abort reason and every later read settles the same way.
	 *
	 * @returns Nothing
	 */
	stop(): void {
		if (this.#closed) return
		this.#closure.abort()
		if (!this.#closed) this.#fail(this.#closure.signal.reason)
	}

	/**
	 * End the exchange when the scope that owns it exits.
	 *
	 * @remarks
	 * {@link stop} under the name a `finally` calls it by, so a pump discharges its ownership
	 * with one statement covering the normal return and every abandoning exit alike.
	 * Idempotent, and a no-op for an exchange that already ended on its terminal.
	 *
	 * @returns Resolves once the exchange has ended
	 */
	async [Symbol.asyncDispose](): Promise<void> {
		this.stop()
	}

	/**
	 * Iterate this exchange — the controller is its own iterator.
	 *
	 * @returns This controller
	 */
	[Symbol.asyncIterator](): MCPStreamControllerInterface {
		return this
	}

	// The request signal ended the exchange: the caller's own abort, or this controller's
	// closure of the request lifetime, which are the same event by the time it arrives here.
	#abort(): void {
		this.#fail(this.#signal.reason)
	}

	// Normal completion — the source produced its terminal, so the exchange keeps it and
	// answers every later read with it.
	#complete(terminal: JSONRPCResponse): void {
		if (this.#closed) return
		this.#closed = true
		this.#terminal = terminal
		this.#release()
		this.#waiter?.resolve({ done: true, value: terminal })
		this.#waiter = undefined
		void this.#source.return(terminal).catch(() => undefined)
	}

	// Closure with NO terminal — an abort, a consumer throw, a stop, or the source's own
	// failure. The exchange keeps the reason and answers every later read by raising it.
	#fail(error: unknown): void {
		if (this.#closed) return
		this.#closed = true
		this.#error = error
		this.#release()
		this.#waiter?.reject(error)
		this.#waiter = undefined
		void this.#source.throw(error).catch(() => undefined)
	}

	// Detach from the request signal and abort the request's lifetime. Both closures run this
	// BEFORE they delegate to the source, so a producer parked on the signal is already awake
	// when its cleanup arrives.
	#release(): void {
		this.#signal.removeEventListener('abort', this.#listener)
		this.#closure.abort()
	}

	// The answer a read gets once the exchange is over: the terminal it ended on, or the
	// reason it ended without one.
	#exhausted(): IteratorResult<JSONRPCNotification, JSONRPCResponse> {
		const terminal = this.#terminal
		if (terminal === undefined) throw this.#error
		return { done: true, value: terminal }
	}
}
