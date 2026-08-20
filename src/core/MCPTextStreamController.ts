import type { MCPStreamControllerInterface, MCPTextStreamControllerInterface } from './types.js'

/**
 * The string-boundary mirror of a controlled held-open result — the same exchange, already
 * serialized.
 *
 * @remarks
 * A TRANSLATION boundary and deliberately nothing else. It serializes each message and the
 * terminating response, and every lifecycle decision — return, throw, dispose, stop — ends
 * the typed exchange beneath it rather than this face. That is the whole design constraint: a
 * serialized face implemented as its own async generator would add a SECOND operation queue,
 * and the queue is exactly the defect the typed controller exists to remove — a `return()`
 * promptly settled at the text face and left queued at the typed one cancels nothing.
 *
 * One member is a narrowing rather than a pass-through, and it is worth knowing before it
 * surprises a producer. `return` receives a STRING; it cannot rebuild the typed
 * `JSONRPCResponse` the typed face would close on, and inventing one by parsing the
 * argument back would make this face decide what the exchange ended with. So it ends the
 * typed exchange with {@link MCPStreamControllerInterface.stop} — no terminal — and answers
 * its own consumer with the string it was handed. A cooperating producer therefore observes
 * its cancellation path here where the typed face would have run its normal return. That is
 * the honest translation of "the consumer already has its answer" when the answer is opaque
 * text, not a downgrade to work around.
 *
 * It accepts only a CONTROLLED typed stream. A raw generator would have no lifecycle to
 * delegate to, and this class refuses to grow one of its own.
 *
 * Delegation is total and it is what makes the ownership obligation transitive: `return`,
 * `throw`, `stop`, and dispose each end the TYPED exchange, so a pump holding only this
 * serialized face still releases the producer, the request lifetime, and the live server slot
 * behind it. There is no owner of last resort here either, for the same reason there is none
 * on the typed face.
 *
 * @example
 * ```ts
 * import { MCPTextStreamController } from '@orkestrel/mcp'
 *
 * const text = new MCPTextStreamController(controlled)
 * const first = await text.next() // one serialized notification
 * text.stop() // ends the TYPED exchange, not just this adapter
 * ```
 */
export class MCPTextStreamController implements MCPTextStreamControllerInterface {
	readonly #stream: MCPStreamControllerInterface

	/**
	 * Mirrors one controlled typed exchange as its serialized sequence.
	 *
	 * @param stream - The controlled typed stream this face serializes and delegates into
	 */
	constructor(stream: MCPStreamControllerInterface) {
		this.#stream = stream
	}

	/**
	 * Reads the next serialized message, or the serialized terminating response.
	 *
	 * @returns The next message as a string, or the terminal as the iteration's `return`
	 * @throws Whatever ended the typed exchange, unserialized — an abort is not a message
	 */
	async next(): Promise<IteratorResult<string, string>> {
		const result = await this.#stream.next()
		const text = JSON.stringify(result.value)
		return result.done === true ? { done: true, value: text } : { done: false, value: text }
	}

	/**
	 * Ends the exchange because the consumer already has its answer.
	 *
	 * @remarks
	 * The typed exchange ends with no terminal, because a string is not a
	 * `JSONRPCResponse` and this face never parses one back out of its argument. The
	 * supplied text is the answer to THIS consumer, and a cooperating producer sees its
	 * cancellation path rather than its normal return.
	 *
	 * @param value - The serialized terminal the consumer is ending on
	 * @returns That terminal as the iteration's `return`
	 */
	async return(value: string | PromiseLike<string>): Promise<IteratorResult<string, string>> {
		this.#stream.stop()
		return { done: true, value: await value }
	}

	/**
	 * Ends the exchange with a failure the consumer is raising.
	 *
	 * @param error - The failure to end the exchange with
	 * @returns Never — the returned promise always rejects
	 * @throws The supplied failure
	 */
	async throw(error: unknown): Promise<IteratorResult<string, string>> {
		this.#stream.stop()
		throw error
	}

	/**
	 * Ends the typed exchange permanently, with no terminal response.
	 *
	 * @returns Nothing
	 */
	stop(): void {
		this.#stream.stop()
	}

	/**
	 * Ends the typed exchange when the scope that owns this face exits.
	 *
	 * @remarks
	 * Delegates downward exactly as {@link stop} does — disposing the serialized arm is
	 * disposing the exchange, never just this adapter.
	 *
	 * @returns Resolves once the typed exchange has ended
	 */
	async [Symbol.asyncDispose](): Promise<void> {
		this.#stream.stop()
	}

	/**
	 * Iterates this exchange — the controller is its own iterator.
	 *
	 * @returns This controller
	 */
	[Symbol.asyncIterator](): MCPTextStreamControllerInterface {
		return this
	}
}
