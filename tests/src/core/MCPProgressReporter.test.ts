import type { JSONRPCNotification } from '@orkestrel/jsonrpc'
import type { MCPExecutionContext } from '@src/core'
import { MCPProgressReporter } from '@src/core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
	waitForSettlement,
	MCPFixtureCell,
	createResolverHook,
	createRejectResolverHook,
	MCP_PROGRESS_LIMITS,
} from '../../setup.js'

describe('MCPProgressReporter', () => {
	it('hands one report to take, settles backpressure, and stops idempotently', async () => {
		const reporter = new MCPProgressReporter(
			'progress-1',
			MCP_PROGRESS_LIMITS,
			new AbortController().signal,
		)
		const reported = reporter.report({ progress: 1, total: 2, message: 'halfway' })

		await expect(reporter.take()).resolves.toEqual({
			jsonrpc: '2.0',
			method: 'notifications/progress',
			params: { progressToken: 'progress-1', progress: 1, total: 2, message: 'halfway' },
		})
		await expect(reported).resolves.toBeUndefined()

		reporter.stop()
		reporter.stop()
		await expect(reporter.take()).rejects.toThrow('Progress reporter is stopped')
	})

	it('settles pending take and report work on abort', async () => {
		const takingController = new AbortController()
		const taking = new MCPProgressReporter(1, MCP_PROGRESS_LIMITS, takingController.signal)
		const pendingTake = taking.take()

		takingController.abort()
		await expect(pendingTake).rejects.toThrow('Progress reporter is stopped')
		await expect(taking.report({ progress: 1 })).rejects.toThrow('Progress reporter is stopped')

		const reportingController = new AbortController()
		const reporting = new MCPProgressReporter(2, MCP_PROGRESS_LIMITS, reportingController.signal)
		const pendingReport = reporting.report({ progress: 1 })

		reportingController.abort()
		await expect(pendingReport).rejects.toThrow('Progress reporter is stopped')
		reporting.stop()
	})

	it('stops when payload reflection aborts before slot commit', async () => {
		const controller = new AbortController()
		const reporter = new MCPProgressReporter('reentrant', MCP_PROGRESS_LIMITS, controller.signal)
		const traps = new MCPFixtureCell(0)
		const progress = new Proxy(
			{ progress: 1 },
			{
				ownKeys(target) {
					traps.value += 1
					if (traps.value === 1) controller.abort()
					return Reflect.ownKeys(target)
				},
			},
		)

		await expect(
			waitForSettlement(
				reporter.report(progress),
				50,
				'Timed out waiting for reentrant abort settlement',
			),
		).rejects.toThrow('Progress reporter is stopped')
		expect(traps.value).toBe(1)
		await expect(reporter.take()).rejects.toThrow('Progress reporter is stopped')
	})

	it('emits one owned progress snapshot despite later caller mutation', async () => {
		const reporter = new MCPProgressReporter(
			'owned',
			MCP_PROGRESS_LIMITS,
			new AbortController().signal,
		)
		const progress = { progress: 1, message: 'first' }
		const reported = reporter.report(progress)
		progress.progress = 999
		progress.message = 'changed'

		await expect(reporter.take()).resolves.toMatchObject({
			params: { progress: 1, message: 'first' },
		})
		await reported
		reporter.stop()
	})

	it('rejects a second pending take without abandoning the first', async () => {
		const reporter = new MCPProgressReporter(
			'single',
			MCP_PROGRESS_LIMITS,
			new AbortController().signal,
		)
		const first = reporter.take()
		await expect(reporter.take()).rejects.toThrow('Progress take is already pending')
		const reported = reporter.report({ progress: 1 })

		await expect(first).resolves.toMatchObject({ params: { progress: 1 } })
		await reported
		reporter.stop()
	})

	it('refuses a rival take entering on a full slot instead of stealing it', async () => {
		const reporter = new MCPProgressReporter(
			'full-slot',
			MCP_PROGRESS_LIMITS,
			new AbortController().signal,
		)
		const first = reporter.take()
		const reported = reporter.report({ progress: 1 })

		await expect(
			waitForSettlement(reporter.take(), 50, 'Timed out waiting for the full-slot take refusal'),
		).rejects.toThrow('Progress take is already pending')
		await expect(
			waitForSettlement(first, 50, 'Timed out waiting for the parked take to consume its slot'),
		).resolves.toMatchObject({ params: { progress: 1 } })
		await waitForSettlement(reported, 50, 'Timed out waiting for the full-slot report')
		reporter.stop()
	})

	it('refuses a resumed take a stop overtook before it reaches the resolver factory', async () => {
		const intrinsic = Promise.withResolvers
		const reporter = new MCPProgressReporter(
			'overtaken',
			MCP_PROGRESS_LIMITS,
			new AbortController().signal,
		)
		const refusal = new MCPFixtureCell<unknown>(undefined)
		const discarded = new MCPFixtureCell<unknown>(undefined)
		const factories = new MCPFixtureCell(0)
		const parked = reporter.take()
		const reported = reporter.report({ progress: 1 }).catch((error: unknown) => {
			discarded.value = error
		})
		const realm = {
			withResolvers: createResolverHook(intrinsic, () => {
				factories.value += 1
			}),
		}

		// Plain API, no hostile cause: the slot is filled and the parked waiter resolved, then stop
		// empties it again before the taker resumes. Re-entering the wait must ask the door before
		// reaching the resolver factory, the only caller-reachable code inside the loop.
		reporter.stop()
		Promise.withResolvers = realm.withResolvers
		try {
			await parked.catch((error: unknown) => {
				refusal.value = error
			})
		} finally {
			Promise.withResolvers = intrinsic
		}
		await reported
		expect(Promise.withResolvers).toBe(intrinsic)
		expect(factories.value).toBe(0)
		expect(refusal.value).toMatchObject({ message: 'Progress reporter is stopped' })
		expect(discarded.value).toMatchObject({ message: 'Progress reporter is stopped' })
	})

	it('rejects backpressure and stopped states before observing a hostile payload', async () => {
		const reads = new MCPFixtureCell(0)
		const hostile = Object.defineProperty({ progress: 2 }, 'message', {
			enumerable: true,
			get() {
				reads.value += 1
				return 'unobserved'
			},
		})
		const reporter = new MCPProgressReporter(
			'ordered',
			MCP_PROGRESS_LIMITS,
			new AbortController().signal,
		)
		const first = reporter.report({ progress: 1 })

		await expect(reporter.report(hostile)).rejects.toThrow(
			'Previous progress has not been consumed',
		)
		expect(reads.value).toBe(0)
		await reporter.take()
		await first
		reporter.stop()
		await expect(reporter.report(hostile)).rejects.toThrow('Progress reporter is stopped')
		expect(reads.value).toBe(0)
	})

	it('selects invalid while live and stopped once a hostile payload aborts mid-snapshot', async () => {
		const live = new MCPProgressReporter('live', MCP_PROGRESS_LIMITS, new AbortController().signal)
		for (const invalid of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
			await expect(live.report({ progress: invalid })).rejects.toThrow(
				'Progress is invalid or exceeds the configured limit',
			)
		}
		const reported = live.report({ progress: -1 })
		await expect(live.take()).resolves.toMatchObject({ params: { progress: -1 } })
		await reported
		live.stop()

		const controller = new AbortController()
		const stopping = new MCPProgressReporter('stopping', MCP_PROGRESS_LIMITS, controller.signal)
		const traps = new MCPFixtureCell(0)
		const hostile = new Proxy(
			{ progress: Number.NaN },
			{
				ownKeys(target) {
					traps.value += 1
					if (traps.value === 1) controller.abort()
					return Reflect.ownKeys(target)
				},
			},
		)

		await expect(
			waitForSettlement(stopping.report(hostile), 50, 'Timed out waiting for stopped selection'),
		).rejects.toThrow('Progress reporter is stopped')
		expect(traps.value).toBe(1)
		await expect(stopping.take()).rejects.toThrow('Progress reporter is stopped')
	})

	it('rejects when a deferred resolver hook aborts after the payload is observed', async () => {
		const intrinsic = Promise.withResolvers
		const controller = new AbortController()
		const reporter = new MCPProgressReporter('deferred', MCP_PROGRESS_LIMITS, controller.signal)
		const realm = {
			withResolvers: createResolverHook(intrinsic, () => {
				controller.abort()
			}),
		}
		const traps = new MCPFixtureCell(0)
		const hostile = new Proxy(
			{ progress: 1 },
			{
				ownKeys(target) {
					traps.value += 1
					if (traps.value === 1) Promise.withResolvers = realm.withResolvers
					return Reflect.ownKeys(target)
				},
			},
		)

		try {
			await expect(
				waitForSettlement(
					reporter.report(hostile),
					50,
					'Timed out waiting for deferred hook settlement',
				),
			).rejects.toThrow('Progress reporter is stopped')
		} finally {
			Promise.withResolvers = intrinsic
		}
		expect(Promise.withResolvers).toBe(intrinsic)
		expect(traps.value).toBe(1)
		await expect(reporter.take()).rejects.toThrow('Progress reporter is stopped')
	})

	it('rejects a reentrant report instead of orphaning the installed slot', async () => {
		const reporter = new MCPProgressReporter(
			'reentrant',
			MCP_PROGRESS_LIMITS,
			new AbortController().signal,
		)
		const inner: Array<Promise<void>> = []
		const traps = new MCPFixtureCell(0)
		const hostile = new Proxy(
			{ progress: 9 },
			{
				ownKeys(target) {
					traps.value += 1
					if (traps.value === 1) inner.push(reporter.report({ progress: 5 }))
					return Reflect.ownKeys(target)
				},
			},
		)

		await expect(
			waitForSettlement(
				reporter.report(hostile),
				50,
				'Timed out waiting for reentrant report settlement',
			),
		).rejects.toThrow('Previous progress has not been consumed')
		expect(traps.value).toBe(1)
		expect(inner).toHaveLength(1)
		await expect(reporter.take()).resolves.toMatchObject({ params: { progress: 5 } })
		await expect(
			waitForSettlement(Promise.all(inner), 50, 'Timed out waiting for the reentrant report'),
		).resolves.toEqual([undefined])
		reporter.stop()
	})

	it('rejects a take whose resolver hook stops the reporter before installation', async () => {
		const intrinsic = Promise.withResolvers
		const controller = new AbortController()
		const reporter = new MCPProgressReporter('hijacked', MCP_PROGRESS_LIMITS, controller.signal)
		const realm = {
			withResolvers: createResolverHook(intrinsic, () => {
				controller.abort()
			}),
		}

		Promise.withResolvers = realm.withResolvers
		try {
			await expect(
				waitForSettlement(reporter.take(), 50, 'Timed out waiting for hijacked take settlement'),
			).rejects.toThrow('Progress reporter is stopped')
		} finally {
			Promise.withResolvers = intrinsic
		}
		expect(Promise.withResolvers).toBe(intrinsic)
		await expect(reporter.report({ progress: 1 })).rejects.toThrow('Progress reporter is stopped')
	})

	it('refuses a take whose resolver hook parks a rival consumer', async () => {
		const intrinsic = Promise.withResolvers
		const reporter = new MCPProgressReporter(
			'rival',
			MCP_PROGRESS_LIMITS,
			new AbortController().signal,
		)
		const rival: Array<Promise<JSONRPCNotification>> = []
		const realm = {
			withResolvers: createResolverHook(intrinsic, () => {
				rival.push(reporter.take())
			}),
		}

		Promise.withResolvers = realm.withResolvers
		try {
			await expect(
				waitForSettlement(reporter.take(), 50, 'Timed out waiting for the rival take refusal'),
			).rejects.toThrow('Progress take is already pending')
		} finally {
			Promise.withResolvers = intrinsic
		}
		expect(Promise.withResolvers).toBe(intrinsic)
		expect(rival).toHaveLength(1)

		const reported = reporter.report({ progress: 1 })
		await expect(
			waitForSettlement(Promise.all(rival), 50, 'Timed out waiting for the parked rival take'),
		).resolves.toMatchObject([{ params: { progress: 1 } }])
		await reported
		reporter.stop()
	})

	// The rival case above and the installed-slot case below, arriving together. The hook parks a
	// rival consumer AND fills the slot, so the take that resumes after the factory finds a value
	// waiting — its own exit condition — while the waiter belongs to somebody else. Consuming on
	// that exit would put two live consumers on a one-consumer handoff, so the sole-consumer fact
	// has to be re-asked after the factory and before the exit, not only before the park.
	it('refuses a take whose resolver hook parks a rival consumer and fills the slot', async () => {
		const intrinsic = Promise.withResolvers
		const reporter = new MCPProgressReporter(
			'rival-slot',
			MCP_PROGRESS_LIMITS,
			new AbortController().signal,
		)
		const rival: Array<Promise<JSONRPCNotification>> = []
		const reported: Array<Promise<void>> = []
		const realm = {
			withResolvers: createResolverHook(intrinsic, () => {
				rival.push(reporter.take())
				reported.push(reporter.report({ progress: 7 }))
			}),
		}

		Promise.withResolvers = realm.withResolvers
		try {
			await expect(
				waitForSettlement(
					reporter.take(),
					50,
					'Timed out waiting for the filled-slot rival refusal',
				),
			).rejects.toThrow('Progress take is already pending')
		} finally {
			Promise.withResolvers = intrinsic
		}
		expect(Promise.withResolvers).toBe(intrinsic)
		expect(rival).toHaveLength(1)
		expect(reported).toHaveLength(1)

		// The slot the hook filled is the parked rival's, and the refused take left it intact.
		await expect(
			waitForSettlement(Promise.all(rival), 50, 'Timed out waiting for the parked rival take'),
		).resolves.toMatchObject([{ params: { progress: 7 } }])
		await waitForSettlement(Promise.all(reported), 50, 'Timed out waiting for the hooked report')
		reporter.stop()
	})

	it('consumes a slot its own resolver hook installs instead of parking behind it', async () => {
		const intrinsic = Promise.withResolvers
		const reporter = new MCPProgressReporter(
			'installed',
			MCP_PROGRESS_LIMITS,
			new AbortController().signal,
		)
		const reported: Array<Promise<void>> = []
		const realm = {
			withResolvers: createResolverHook(intrinsic, () => {
				reported.push(reporter.report({ progress: 3 }))
			}),
		}

		Promise.withResolvers = realm.withResolvers
		try {
			await expect(
				waitForSettlement(reporter.take(), 50, 'Timed out waiting for the installed slot'),
			).resolves.toMatchObject({ params: { progress: 3 } })
		} finally {
			Promise.withResolvers = intrinsic
		}
		expect(Promise.withResolvers).toBe(intrinsic)
		await expect(
			waitForSettlement(Promise.all(reported), 50, 'Timed out waiting for the hooked report'),
		).resolves.toEqual([undefined])
		reporter.stop()
	})

	it('clears every slot before stop invokes a hostile rejection hook', async () => {
		const intrinsic = Promise.withResolvers
		const reporter = new MCPProgressReporter(
			'ordered-stop',
			MCP_PROGRESS_LIMITS,
			new AbortController().signal,
		)
		const taken: Array<Promise<JSONRPCNotification>> = []
		const realm = {
			withResolvers: createRejectResolverHook(intrinsic, () => {
				taken.push(reporter.take())
			}),
		}

		Promise.withResolvers = realm.withResolvers
		try {
			const reported = reporter.report({ progress: 1 })
			reporter.stop()
			await expect(
				waitForSettlement(reported, 50, 'Timed out waiting for the stopped report'),
			).rejects.toThrow('Progress reporter is stopped')
			expect(taken).toHaveLength(1)
			await expect(
				waitForSettlement(Promise.all(taken), 50, 'Timed out waiting for the reentrant take'),
			).rejects.toThrow('Progress reporter is stopped')
		} finally {
			Promise.withResolvers = intrinsic
		}
		expect(Promise.withResolvers).toBe(intrinsic)
	})

	it('clears every slot before stop detaches its abort listener', async () => {
		const signal = new AbortController().signal
		const detach = signal.removeEventListener
		const reporter = new MCPProgressReporter('ordered-detach', MCP_PROGRESS_LIMITS, signal)
		const taken: Array<Promise<JSONRPCNotification>> = []
		Object.defineProperty(signal, 'removeEventListener', {
			configurable: true,
			value(type: string, listener: EventListenerOrEventListenerObject): void {
				taken.push(reporter.take())
				detach.call(signal, type, listener)
			},
		})

		try {
			const reported = reporter.report({ progress: 1 })
			reporter.stop()
			await expect(
				waitForSettlement(reported, 50, 'Timed out waiting for the detached report'),
			).rejects.toThrow('Progress reporter is stopped')
			expect(taken).toHaveLength(1)
			await expect(
				waitForSettlement(Promise.all(taken), 50, 'Timed out waiting for the detached take'),
			).rejects.toThrow('Progress reporter is stopped')
		} finally {
			Reflect.deleteProperty(signal, 'removeEventListener')
		}
		expect(Object.hasOwn(signal, 'removeEventListener')).toBe(false)
	})

	it('refuses a repeated or lower progress value once one commits', async () => {
		const reporter = new MCPProgressReporter(
			'increasing',
			MCP_PROGRESS_LIMITS,
			new AbortController().signal,
		)
		const first = reporter.report({ progress: 5 })
		await expect(reporter.take()).resolves.toMatchObject({ params: { progress: 5 } })
		await first

		for (const progress of [5, 4, 0]) {
			await expect(
				waitForSettlement(
					reporter.report({ progress }),
					50,
					`Timed out waiting for the refusal of progress ${progress}`,
				),
			).rejects.toThrow('Progress must strictly increase')
		}

		const next = reporter.report({ progress: 6 })
		await expect(reporter.take()).resolves.toMatchObject({ params: { progress: 6 } })
		await next
		reporter.stop()
	})

	it('exports the execution context role without a legacy input alias', () => {
		expectTypeOf<MCPExecutionContext>().toHaveProperty('signal')
		expectTypeOf<MCPExecutionContext>().toHaveProperty('progress')
	})
})
