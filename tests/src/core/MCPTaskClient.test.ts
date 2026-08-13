import type { MCPClientInterface, MCPTaskDetail } from '@src/core'
import type { TestFrame, TestTransportInterface } from '../../setup.js'
import { describe, expect, it } from 'vitest'
import {
	createMCPClient,
	isMCPError,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_METHOD_NOT_FOUND,
	MCPTaskClient,
} from '@src/core'
import { waitForDelay } from '@orkestrel/test'
import {
	createCalculatorServer,
	createRecordingTransport,
	createTaskServer,
	TASK_CAPABILITIES,
	TestTaskManager,
} from '../../setup.js'

// The CLIENT half of the draft Tasks extension, over a real MCPServer with the extension
// configured, reached through a real in-process transport that records every frame it carries
// and when it carried it (AGENTS §16 — no mocks, no fake clock).
//
// Two claims dominate this file and both are stated as controls first:
//
//  1. `client.tasks` MIRRORS the server port. Its control is a server configured WITHOUT
//     `task` — a peer from outside the extension's population — where all three methods must
//     surface `-32601` cleanly instead of inventing a local answer.
//  2. The package ships NO POLLING LOOP. Its control is a consumer-written scheduler that DOES
//     poll, run through the same recorder over the same real elapsed window, so the instrument
//     is proven able to see polling before any silence beside it is read as meaningful. This is
//     deliberately NOT a source scan: the previous unit's scan enumerated four spellings and a
//     live engine walked past all four.

// How long every timing scenario watches the wire, and the hint the peer publishes. The window
// is many multiples of the interval, so a loop of ANY period at or below the hint leaves frames.
const POLL_INTERVAL = 10
const WATCH_WINDOW = 140
// Longer than the watch window, so the task is genuinely still `working` while it is observed.
const TASK_WORK = 200

interface TaskScenario {
	readonly client: MCPClientInterface
	readonly transport: TestTransportInterface
	readonly tasks: TestTaskManager
}

// A connected client whose peer defers every `tools/call` into a durable task. The capability
// declaration is what entitles the client to the three `tasks/*` methods at all: the server
// checks it FIRST, before it reads a single parameter.
async function connectTaskClient(options: { readonly poll?: number } = {}): Promise<TaskScenario> {
	const tasks = new TestTaskManager({
		work: TASK_WORK,
		...(options.poll === undefined ? {} : { poll: options.poll }),
	})
	const transport = createRecordingTransport(createTaskServer(tasks))
	const client = createMCPClient({ transport, capabilities: TASK_CAPABILITIES })
	await client.connect()
	return { client, transport, tasks }
}

// Start one durable task and answer its handle. The `resultType` narrowing is the assertion:
// a peer that ran the call inline would fail here rather than further down.
async function startTask(client: MCPClientInterface): Promise<string> {
	const outcome = await client.call('render', { page: 3 })
	if (outcome.resultType !== 'task') {
		throw new Error(`expected a deferred call, got '${outcome.resultType}'`)
	}
	return outcome.taskId
}

// THE CONTROL INSTRUMENT: a scheduler this package does not provide and never will. It is the
// consumer's half of `pollIntervalMs` — read, wait the hinted interval, read again — written
// here in full precisely because writing it is the consumer's job. Its presence in this file is
// what proves the recorder beside it can see a loop.
async function scheduleTaskPolling(
	client: MCPClientInterface,
	id: string,
	interval: number,
	window: number,
): Promise<readonly MCPTaskDetail[]> {
	const seen: MCPTaskDetail[] = []
	const until = performance.now() + window
	while (performance.now() < until) {
		seen.push(await client.tasks.task(id))
		await waitForDelay(interval)
	}
	return seen
}

function countFrames(frames: readonly TestFrame[], method: string): number {
	return frames.filter((frame) => frame.method === method).length
}

describe('MCPTaskClient — the shape', () => {
	it('exposes exactly task / update / abort, and no plural accessor', async () => {
		const { client } = await connectTaskClient()

		expect(typeof client.tasks.task).toBe('function')
		expect(typeof client.tasks.update).toBe('function')
		expect(typeof client.tasks.abort).toBe('function')
		// MCP defines no `tasks/list`, so there is nothing a plural accessor could answer. The
		// ABSENCE is the contract; a member here would be this package inventing a method.
		expect('tasks' in client.tasks).toBe(false)
		expect('start' in client.tasks).toBe(false)
		await client.disconnect()
	})

	it('reads, answers, and stops a real durable task over the wire', async () => {
		const { client, tasks, transport } = await connectTaskClient()
		const id = await startTask(client)

		const working = await client.tasks.task(id)
		expect(working.taskId).toBe(id)
		expect(working.status).toBe('working')

		await client.tasks.abort(id)
		const stopped = await client.tasks.task(id)
		expect(stopped.status).toBe('cancelled')

		// The three wire spellings, in the order the calls were made — this client's own
		// vocabulary says `abort`, and the method on the wire stays the protocol's `tasks/cancel`.
		expect(transport.frames.map((frame) => frame.method)).toEqual([
			'server/discover',
			'tools/call',
			'tasks/get',
			'tasks/cancel',
			'tasks/get',
		])
		await tasks.settle()
		await client.disconnect()
	})

	it('answers an input_required task through update', async () => {
		const tasks = new TestTaskManager({ asking: true })
		const transport = createRecordingTransport(createTaskServer(tasks))
		const client = createMCPClient({ transport, capabilities: TASK_CAPABILITIES })
		await client.connect()
		const id = await startTask(client)

		expect((await client.tasks.task(id)).status).toBe('input_required')
		await client.tasks.update(id, { approval: { action: 'accept' } })

		expect((await client.tasks.task(id)).status).not.toBe('input_required')
		await tasks.settle()
		await client.disconnect()
	})

	// `undefined` would be a lookup-miss this client MANUFACTURED. The peer answers the same
	// `-32602` for a task that never existed, one whose TTL purged it, and one belonging to
	// another principal — deliberately byte-identical — so producing a distinction here would
	// mean matching on message text and republishing what the peer refused to publish.
	it('rejects rather than answering undefined for a task it cannot read', async () => {
		const { client } = await connectTaskClient()

		await expect(client.tasks.task('never-existed')).rejects.toThrow(/no task is available/)
		const failure = await client.tasks.task('never-existed').catch((error: unknown) => error)
		expect(isMCPError(failure) && failure.code).toBe(JSONRPC_INVALID_PARAMS)
		await client.disconnect()
	})

	// CONTROL, from outside the extension's population: a peer that configured no `task` at all.
	// Every scenario above runs against a server that opted IN, so nothing there can show what
	// happens at the boundary — and the honest answer is the wire's, not a local refusal.
	it('CONTROL — surfaces -32601 from a peer that configured no task extension', async () => {
		const transport = createRecordingTransport(createCalculatorServer())
		const client = createMCPClient({ transport, capabilities: TASK_CAPABILITIES })
		await client.connect()

		for (const attempt of [
			client.tasks.task('any'),
			client.tasks.update('any', {}),
			client.tasks.abort('any'),
		]) {
			const failure = await attempt.catch((error: unknown) => error)
			expect(isMCPError(failure) && failure.code).toBe(JSONRPC_METHOD_NOT_FOUND)
		}
		// It ASKED all three times. A client that had refused locally would show none of these,
		// and would have passed this row on a refusal the peer never made.
		expect(transport.frames.map((frame) => frame.method)).toEqual([
			'server/discover',
			'tasks/get',
			'tasks/update',
			'tasks/cancel',
		])
		await client.disconnect()
	})

	// The port is a published contract, so it has to be usable without an `MCPClient` behind it.
	// This also pins the one thing the class is given: a correlated-request door and a deadline.
	it('issues the three wire methods through the request door it was handed', async () => {
		const issued: Array<
			readonly [string, Readonly<Record<string, unknown>> | undefined, number | undefined]
		> = []
		const client = new MCPTaskClient({
			request: async (method, params, deadline) => {
				issued.push([method, params, deadline])
				return { taskId: 't', status: 'working', createdAt: '', lastUpdatedAt: '', ttlMs: null }
			},
			timeout: 25,
		})

		await client.task('t')
		await client.update('t', { approval: true })
		await client.abort('t')

		expect(issued).toEqual([
			['tasks/get', { taskId: 't' }, 25],
			['tasks/update', { taskId: 't', inputResponses: { approval: true } }, 25],
			['tasks/cancel', { taskId: 't' }, 25],
		])
	})

	it('refuses a peer answer that is not a well-formed task', async () => {
		const client = new MCPTaskClient({
			// A `completed` task owes its result, so this snapshot does not hold together — the
			// same guard the server proves its own answer with catches it before a caller narrows
			// on `status` and reads a member that is not there.
			request: async () => ({
				taskId: 't',
				status: 'completed',
				createdAt: '',
				lastUpdatedAt: '',
				ttlMs: null,
			}),
		})

		const failure = await client.task('t').catch((error: unknown) => error)
		expect(isMCPError(failure) && failure.code).toBe(JSONRPC_INVALID_PARAMS)
	})
})

describe('MCPTaskClient — pollIntervalMs is a datum, not a loop', () => {
	// THE CONTROL, and it runs FIRST: an instrument that has never produced its positive verdict
	// cannot tell a silent client from a broken recorder. A consumer-written scheduler polls the
	// same client, through the same transport, across the same real window — and the recorder
	// must see it.
	it('CONTROL — the recorder sees a consumer-written scheduler polling over real time', async () => {
		const { client, tasks, transport } = await connectTaskClient({ poll: POLL_INTERVAL })
		const id = await startTask(client)
		const mark = transport.frames.length

		const started = performance.now()
		const seen = await scheduleTaskPolling(client, id, POLL_INTERVAL, WATCH_WINDOW)
		const elapsed = performance.now() - started

		expect(elapsed).toBeGreaterThanOrEqual(WATCH_WINDOW - 5)
		expect(seen.length).toBeGreaterThanOrEqual(3)
		expect(countFrames(transport.frames.slice(mark), 'tasks/get')).toBe(seen.length)
		await tasks.settle()
		await client.disconnect()
	})

	// THE CLAIM. Same client, same transport, same recorder, a window at least as long as the
	// control's and more than ten times the peer's own hinted interval — and nobody schedules
	// anything. Zero frames of ANY method, not merely zero `tasks/get`: a cache warmer, a
	// keep-alive, or a terminal-await helper would each show here too.
	it('writes NOTHING over a window many times the peer’s hinted interval', async () => {
		const { client, tasks, transport } = await connectTaskClient({ poll: POLL_INTERVAL })
		const id = await startTask(client)
		const mark = transport.frames.length

		const started = performance.now()
		await waitForDelay(WATCH_WINDOW)
		const elapsed = performance.now() - started

		expect(elapsed).toBeGreaterThanOrEqual(WATCH_WINDOW - 5)
		expect(elapsed / POLL_INTERVAL).toBeGreaterThan(10)
		expect(transport.frames.slice(mark)).toEqual([])

		// And one ask is exactly one frame — the one-shot read this package DOES supply.
		await client.tasks.task(id)
		expect(transport.frames.slice(mark).map((frame) => frame.method)).toEqual(['tasks/get'])
		await tasks.settle()
		await client.disconnect()
	})

	// The datum itself: carried to the caller untouched, so a consumer can schedule on it. The
	// package reading it is what would be a loop; the package HIDING it would be worse — a
	// consumer could then not schedule at all.
	it('carries the peer’s pollIntervalMs to the caller untouched', async () => {
		const { client, tasks } = await connectTaskClient({ poll: POLL_INTERVAL })
		const outcome = await client.call('render', { page: 3 })

		expect(outcome.resultType).toBe('task')
		if (outcome.resultType !== 'task') throw new Error('expected a deferred call')
		expect(outcome.pollIntervalMs).toBe(POLL_INTERVAL)
		expect((await client.tasks.task(outcome.taskId)).pollIntervalMs).toBe(POLL_INTERVAL)
		await tasks.settle()
		await client.disconnect()
	})

	// A manager that pushes instead of publishing a hint omits the member entirely, and the
	// absence must stay an absence — never a `0`, a `-1`, or an invented default.
	it('leaves pollIntervalMs absent when the peer published none', async () => {
		const { client, tasks } = await connectTaskClient()
		const id = await startTask(client)

		const detail = await client.tasks.task(id)
		expect(detail.pollIntervalMs).toBeUndefined()
		expect(Object.hasOwn(detail, 'pollIntervalMs')).toBe(false)
		await tasks.settle()
		await client.disconnect()
	})
})

describe('MCPTaskClient — cancellation never reaches a task', () => {
	// The population BOUNDARY, not a member of it. `call`'s `options.signal` withdraws one caller
	// from one in-flight request; a call that already answered `resultType: 'task'` is a request
	// that is OVER. Aborting afterwards must therefore reach nothing at all — no `tasks/cancel`,
	// and no `notifications/cancelled` either, because there is no longer a pending request to
	// name.
	it('sends ZERO task frames when a call that already became a task is aborted', async () => {
		const { client, tasks, transport } = await connectTaskClient()
		const controller = new AbortController()

		const outcome = await client.call('render', { page: 3 }, { signal: controller.signal })
		expect(outcome.resultType).toBe('task')
		const mark = transport.frames.length
		controller.abort()
		await waitForDelay(20)

		expect(transport.frames.slice(mark)).toEqual([])
		// The instrument's positive verdict, on the same recorder: aborting a request that is
		// STILL in flight does write a frame, so the zero above is a fact about the boundary
		// rather than a recorder that stopped looking.
		const live = new AbortController()
		const pending = client.call('render', { page: 4 }, { signal: live.signal })
		live.abort()
		await expect(pending).rejects.toThrow(/was aborted/)
		expect(countFrames(transport.frames.slice(mark), 'notifications/cancelled')).toBe(1)
		expect(countFrames(transport.frames.slice(mark), 'tasks/cancel')).toBe(0)
		await tasks.settle()
		await client.disconnect()
	})
})
