import type {
	JSONRPCNotification,
	MCPJSONLimitOptions,
	MCPProgress,
	MCPProgressInterface,
} from './types.js'
import { snapshotJSON } from './cloners.js'
import { buildProgressNotification } from './helpers.js'
import { isMCPProgress } from './validators.js'

/**
 * A bounded, request-scoped progress handoff between one producer and one serial consumer.
 *
 * The reporter holds at most one owned progress item. {@link report} applies backpressure until
 * {@link take} consumes that slot. It has no replay, queue, concurrent-consumer coordination,
 * task state, or durable-work semantics; stopping or aborting the request discards the slot and
 * rejects pending work.
 *
 * @example
 * ```ts
 * import { MCPProgressReporter } from '@orkestrel/mcp'
 *
 * const reporter = new MCPProgressReporter(
 * 	'call-1',
 * 	{ bytes: 256, keys: 3, depth: 1 },
 * 	new AbortController().signal,
 * )
 * const reported = reporter.report({ progress: 1, total: 2 })
 * const notification = await reporter.take()
 * await reported
 * reporter.stop()
 * ```
 */
export class MCPProgressReporter implements MCPProgressInterface {
	readonly #token: string | number
	readonly #limits: MCPJSONLimitOptions
	readonly #signal: AbortSignal
	readonly #listener: () => void
	#value: MCPProgress | undefined
	#waiter: PromiseWithResolvers<void> | undefined
	#consumed: PromiseWithResolvers<void> | undefined
	#last: number | undefined
	#stopped = false

	/**
	 * Create one non-durable progress slot for an active request.
	 *
	 * @param token - The opaque progress token copied into each notification
	 * @param limits - The byte, key, and depth bounds applied to every progress payload
	 * @param signal - The request signal whose abort permanently stops the reporter
	 */
	constructor(token: string | number, limits: MCPJSONLimitOptions, signal: AbortSignal) {
		this.#token = token
		this.#limits = limits
		this.#signal = signal
		this.#listener = this.stop.bind(this)
		if (signal.aborted) this.stop()
		else signal.addEventListener('abort', this.#listener, { once: true })
	}

	/**
	 * Publish one bounded, strictly increasing progress value and await its consumption.
	 *
	 * @param progress - The progress payload to own and hand to the serial consumer
	 * @returns A promise resolving after {@link take} consumes the item
	 * @throws When stopped, a previous item remains unconsumed, the payload is invalid or outside
	 *   its bounds, or its `progress` value does not strictly increase
	 */
	async report(progress: MCPProgress): Promise<void> {
		this.#requireIdle()
		const snapshot = snapshotJSON(progress, this.#limits)
		const owned = snapshot?.[0]
		const consumed = Promise.withResolvers<void>()
		this.#requireIdle()
		if (!isMCPProgress(owned))
			throw new Error('Progress is invalid or exceeds the configured limit')
		if (this.#last !== undefined && owned.progress <= this.#last) {
			throw new Error('Progress must strictly increase')
		}
		this.#last = owned.progress
		this.#value = owned
		this.#consumed = consumed
		this.#waiter?.resolve()
		await consumed.promise
	}

	/**
	 * Take the next progress notification, waiting for the single producer slot when empty.
	 *
	 * @returns The official progress notification carrying the original token
	 * @throws When the reporter stops or another consumer already has a pending take
	 */
	async take(): Promise<JSONRPCNotification> {
		// The loop's own condition is a door too: a take arriving on a full slot skips the body
		// entirely, so the entry facts are asked here rather than only inside it. Without this a
		// rival consumer would walk past a parked consumer's waiter and take the slot it is owed.
		this.#requireSoleConsumer()
		while (this.#value === undefined) {
			this.#requireSoleConsumer()
			const waiter = Promise.withResolvers<void>()
			// The factory is the only caller-reachable code in the loop, and both ways out of the
			// iteration lie past it: the exit below and the park beneath that. So the door runs
			// here, ahead of both, rather than on the parking path alone — a hook that fills the
			// slot AND parks a rival would otherwise send this take out of the loop to consume an
			// item the rival is owed, putting two live consumers on a one-consumer handoff.
			this.#requireSoleConsumer()
			// A slot that arrived while the factory ran is an answer, not a refusal: re-enter the
			// loop and consume it rather than parking behind a value already sitting in the slot.
			if (this.#value !== undefined) continue
			this.#waiter = waiter
			await waiter.promise
			this.#waiter = undefined
		}
		const progress = this.#value
		this.#value = undefined
		const consumed = this.#consumed
		this.#consumed = undefined
		consumed?.resolve()
		return buildProgressNotification(this.#token, progress)
	}

	/**
	 * Permanently stop the reporter, reject pending work, and detach its abort listener.
	 *
	 * Repeated calls are idempotent. No queued or replayable progress survives the first call.
	 *
	 * @returns Nothing
	 */
	stop(): void {
		if (this.#stopped) return
		this.#stopped = true
		const waiter = this.#waiter
		const consumed = this.#consumed
		this.#waiter = undefined
		this.#consumed = undefined
		this.#value = undefined
		this.#signal.removeEventListener('abort', this.#listener)
		const error = new Error('Progress reporter is stopped')
		waiter?.reject(error)
		consumed?.reject(error)
	}

	// Reject a report that enters, or reaches its final check, while stopped or still holding an
	// unconsumed slot. Both doors run the same rule, so hostile work between them cannot pass one
	// door on a state the other already refused.
	#requireIdle(): void {
		if (this.#stopped) throw new Error('Progress reporter is stopped')
		if (this.#value !== undefined || this.#consumed !== undefined) {
			throw new Error('Previous progress has not been consumed')
		}
	}

	// Reject a take that enters, re-enters the wait, or reaches its final check, while stopped or
	// while another consumer already holds the waiter. Every door runs the same rule, so hostile
	// work between them cannot pass one door on a state another already refused.
	#requireSoleConsumer(): void {
		if (this.#stopped) throw new Error('Progress reporter is stopped')
		if (this.#waiter !== undefined) throw new Error('Progress take is already pending')
	}
}
