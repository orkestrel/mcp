// Proof of `tests/setup.ts` — the host-independent infrastructure every project loads.
//
// Each case asserts a contract a consuming suite relies on, and derives what it expects by a
// route the module cannot share: an envelope goes through the shipped wire parser rather than
// back through the factory that built it, the header table's own `parsed` column is checked
// against the real `parseRequestContext`, a nesting depth is walked rather than recomputed, and
// every instrument is calibrated against the outcome its own documentation names.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { BrowserFixtureInterface } from './fixtures/browserServer.js'
import type { JSONRPCMessage, MCPMethodOptions, MCPTaskContext } from '@src/core'
import {
	bindClient,
	bindServer,
	buildJSONRPCResult,
	createDuplexClientTransport,
	createMCPClient,
	createMCPServer,
	MCP_EXTENSION_TASKS,
	MCP_META_CAPABILITIES,
	MCP_META_VERSION,
	MCP_MODERN_VERSION,
	parseJSONRPCMessage,
	parseRequestContext,
} from '@src/core'
import { MCP_METHOD_HEADER, MCP_PROTOCOL_VERSION_HEADER } from '@src/server'
import { createToolManager } from '@orkestrel/tool'
import { isRecord } from '@orkestrel/contract'
import { createRecorder, waitForDelay } from '@orkestrel/test'
import {
	buildNestedRecord,
	collectSSE,
	createCalculatorServer,
	createHeaderProjectionRequest,
	createHostileCorpus,
	createHostilePeer,
	createJSONRPCNotification,
	createJSONRPCRequest,
	createLoopbackTransport,
	createManualClock,
	createMemoryTransport,
	createRecordingTransport,
	createSubscriptionRequest,
	createTaskServer,
	createThrowingKeys,
	GUARD_KEY_NAMES,
	HEADER_PROJECTION_CONTEXTS,
	inspectOwnerOfLastResort,
	isMCPMethodHandler,
	MemoryResourceManager,
	MODERN_METADATA,
	modernRequest,
	OWNER_OF_LAST_RESORT_SPELLINGS,
	postJSON,
	probeDuplex,
	probeOwnership,
	readMethods,
	readSSEStream,
	TASK_CAPABILITIES,
	TestTaskManager,
	throwOnRead,
	waitForSettlement,
} from './setup.js'
import { start } from './fixtures/browserServer.js'

const METHOD_OPTIONS: MCPMethodOptions = { signal: new AbortController().signal }

const TASK_CONTEXT: MCPTaskContext = {
	request: modernRequest('tools/call', 1),
	call: { id: 'call-1', name: 'render', arguments: {} },
	tools: createToolManager(),
}

describe('waitForSettlement', () => {
	it('returns the caller promise value once it settles', async () => {
		expect(await waitForSettlement(Promise.resolve('answered'))).toBe('answered')
		expect(
			await waitForSettlement(
				waitForDelay(5).then(() => 'late'),
				5_000,
			),
		).toBe('late')
	})

	it('rejects with the deadline message when nothing settles first', async () => {
		await expect(waitForSettlement(new Promise(() => {}), 10, 'nothing arrived')).rejects.toThrow(
			'nothing arrived',
		)
		await expect(waitForSettlement(new Promise(() => {}), 10)).rejects.toThrow(
			'Timed out waiting for promise settlement',
		)
	})

	it('surfaces the caller promise rejection rather than the deadline', async () => {
		const failure = new Error('the caller failed')
		await expect(waitForSettlement(Promise.reject(failure), 5_000)).rejects.toBe(failure)
	})
})

describe('the JSON-RPC envelope factories', () => {
	it('builds envelopes the shipped wire parser accepts', () => {
		const request = createJSONRPCRequest()
		const overridden = createJSONRPCRequest({
			method: 'tools/list',
			id: 'call-1',
			params: { a: 1 },
		})
		const notification = createJSONRPCNotification('notifications/initialized')

		expect(request).toEqual({ jsonrpc: '2.0', method: 'initialize', id: 1 })
		// The round trip goes through JSON and the real parser, so a factory that produced an
		// envelope only this file agrees with fails here.
		expect(parseJSONRPCMessage(JSON.parse(JSON.stringify(request)))).toEqual(request)
		expect(parseJSONRPCMessage(JSON.parse(JSON.stringify(overridden)))).toEqual(overridden)
		expect(parseJSONRPCMessage(JSON.parse(JSON.stringify(notification)))).toEqual(notification)
		// A notification carries no `id` at all, which is what makes it produce no response.
		expect(Object.hasOwn(notification, 'id')).toBe(false)
		expect(Object.hasOwn(notification, 'params')).toBe(false)
		expect(createJSONRPCNotification('notifications/progress', { progress: 1 }).params).toEqual({
			progress: 1,
		})
	})

	it('stamps the reserved metadata a modern request is recognized by', () => {
		const request = modernRequest('tools/list', 'modern-1')
		const subscription = createSubscriptionRequest('probe-open')

		expect(MODERN_METADATA[MCP_META_VERSION]).toBe(MCP_MODERN_VERSION)
		expect(Object.isFrozen(MODERN_METADATA)).toBe(true)
		// The real request reader is what decides modernity, so it is what the stamp is read by.
		expect(parseRequestContext(request)).toBeDefined()
		expect(parseRequestContext(subscription)).toBeDefined()
		expect(subscription.method).toBe('subscriptions/listen')
		expect(subscription.params?.['notifications']).toEqual({ toolsListChanged: true })
		// The same request without the stamp is not modern, so the stamp is doing the work.
		expect(parseRequestContext(createJSONRPCRequest({ method: 'tools/list' }))).toBeUndefined()
	})
})

describe('HEADER_PROJECTION_CONTEXTS', () => {
	it('declares each row as the real request reader answers it', () => {
		const answered = HEADER_PROJECTION_CONTEXTS.map((row) => {
			const request = createHeaderProjectionRequest(row.metadata)
			const declared = row.metadata[MCP_META_VERSION]
			return {
				label: row.label,
				method: request.method,
				stamped: request.params?.['_meta'] === row.metadata,
				parsed: parseRequestContext(request) !== undefined,
				// The header a face must send is the declared version itself, read off the metadata
				// rather than off the row that claims it.
				version: typeof declared === 'string' ? declared : undefined,
			}
		})

		expect(answered).toEqual(
			HEADER_PROJECTION_CONTEXTS.map((row) => ({
				label: row.label,
				method: 'tools/list',
				stamped: true,
				parsed: row.parsed,
				version: row.version,
			})),
		)
	})

	it('carries rows on both sides of the divergence it exists for', () => {
		expect(HEADER_PROJECTION_CONTEXTS.some((row) => row.parsed)).toBe(true)
		expect(HEADER_PROJECTION_CONTEXTS.some((row) => !row.parsed)).toBe(true)
		// A row that parses nothing yet still projects a header is the case that caught the
		// divergence between the two faces, so the table must keep one.
		expect(HEADER_PROJECTION_CONTEXTS.some((row) => !row.parsed && row.version !== undefined)).toBe(
			true,
		)
		expect(Object.isFrozen(HEADER_PROJECTION_CONTEXTS)).toBe(true)
	})
})

describe('the adversarial batteries', () => {
	it('draws every corpus row from outside the population a total guard admits', () => {
		const corpus = createHostileCorpus()

		expect(corpus.length).toBeGreaterThan(0)
		for (const row of corpus) expect(parseJSONRPCMessage(row)).toBeUndefined()
		// The rows are genuinely hostile to read: a naive clone of the whole corpus raises.
		expect(() => JSON.stringify(corpus)).toThrow('proxy that has been revoked')
	})

	it('rebuilds every single-use corpus row on each call', () => {
		const first = createHostileCorpus()
		const second = createHostileCorpus()

		// A revoked proxy and a cycle survive one use, so a shared object row would be a stale
		// instrument by the second suite that read it.
		const shared = first.filter(
			(row, index) => typeof row === 'object' && row !== null && Object.is(row, second[index]),
		)
		expect(shared).toEqual([])
	})

	it('keys a throwing accessor to each name in turn', () => {
		const [code, message] = createThrowingKeys(['code', 'message'])
		if (!isRecord(code) || !isRecord(message)) throw new Error('unreachable: rows are records')

		expect(() => code['code']).toThrow('must not escape')
		expect(() => message['message']).toThrow('must not escape')
		// Only the named key throws — every other key reads normally, which is what makes the
		// battery ask its question at the key rather than at the value.
		expect(code['message']).toBe('x')
		expect(message['code']).toBeUndefined()
		expect(message['jsonrpc']).toBe('2.0')
		expect(throwOnRead).toThrow('must not escape')
		expect(createThrowingKeys([])).toEqual([])
	})

	it('leaves the shipped parser total across every guard key', () => {
		for (const row of createThrowingKeys(GUARD_KEY_NAMES)) {
			expect(parseJSONRPCMessage(row)).toBeUndefined()
		}
	})

	it('keeps GUARD_KEY_NAMES frozen, unique, sorted, and carrying the envelope names', () => {
		expect(Object.isFrozen(GUARD_KEY_NAMES)).toBe(true)
		expect(new Set(GUARD_KEY_NAMES).size).toBe(GUARD_KEY_NAMES.length)
		expect([...GUARD_KEY_NAMES].sort()).toEqual([...GUARD_KEY_NAMES])
		for (const key of ['jsonrpc', 'method', 'id', 'params', 'result', 'error', 'code', 'message']) {
			expect(GUARD_KEY_NAMES).toContain(key)
		}
	})

	it('nests a record exactly as deep as it was asked to', () => {
		let level: unknown = buildNestedRecord(5)
		let walked = 0
		while (isRecord(level) && 'nested' in level) {
			level = level['nested']
			walked += 1
		}

		expect(walked).toBe(5)
		expect(level).toEqual({ leaf: true })
		expect(buildNestedRecord(0)).toEqual({ leaf: true })
	})
})

describe('isMCPMethodHandler', () => {
	it('admits any callable and refuses every value a registry cannot invoke', () => {
		expect(isMCPMethodHandler(() => undefined)).toBe(true)
		expect(isMCPMethodHandler(async () => undefined)).toBe(true)
		expect(isMCPMethodHandler(waitForDelay)).toBe(true)
		expect(isMCPMethodHandler({ handle: () => undefined })).toBe(false)
		expect(isMCPMethodHandler('handler')).toBe(false)
		expect(isMCPMethodHandler(undefined)).toBe(false)
		expect(isMCPMethodHandler(null)).toBe(false)
	})
})

describe('createCalculatorServer', () => {
	it('registers the value tool and the throwing tool every transport is driven over', async () => {
		const peer = createHostilePeer(createCalculatorServer())
		try {
			await peer.send(JSON.stringify(modernRequest('tools/list', 'list-1')))
			const listed = peer.response()?.result
			const tools = isRecord(listed) ? listed['tools'] : undefined
			expect(
				Array.isArray(tools) ? tools.map((tool) => isRecord(tool) && tool['name']) : [],
			).toEqual(['add', 'boom'])

			peer.clear()
			await peer.send(
				JSON.stringify(
					createJSONRPCRequest({
						method: 'tools/call',
						id: 'add-1',
						params: { name: 'add', arguments: {}, _meta: MODERN_METADATA },
					}),
				),
			)
			const added = peer.response()?.result
			expect(isRecord(added) ? added['structuredContent'] : undefined).toBe(5)

			peer.clear()
			await peer.send(
				JSON.stringify(
					createJSONRPCRequest({
						method: 'tools/call',
						id: 'boom-1',
						params: { name: 'boom', arguments: {}, _meta: MODERN_METADATA },
					}),
				),
			)
			const failed = peer.response()?.result
			expect(isRecord(failed) ? failed['isError'] : undefined).toBe(true)
		} finally {
			peer.close()
		}
	})
})

describe('createHostilePeer', () => {
	it('carries a hostile wire message to a real server and reports what it answered', async () => {
		const peer = createHostilePeer(createCalculatorServer())
		try {
			await peer.send('{ this is not json')

			// The answer is the server's own, decoded off the wire the peer wrote it to.
			expect(peer.response()?.error).toBeDefined()
			expect(peer.messages.length).toBe(1)
			expect(peer.responses().length).toBe(1)

			peer.clear()
			expect(peer.messages).toEqual([])
			expect(peer.response()).toBeUndefined()
		} finally {
			peer.close()
		}
	})

	it('stops carrying anything once it is closed', async () => {
		const peer = createHostilePeer(createCalculatorServer())
		peer.close()

		// `close` unbinds the server, so a later frame is answered by nobody. The bounded wait is
		// what turns "never answered" into an assertion instead of a hung suite.
		await expect(
			waitForSettlement(
				peer.send(JSON.stringify(modernRequest('tools/list', 'closed-1'))),
				25,
				'a closed peer answered',
			),
		).rejects.toThrow('a closed peer answered')
		expect(peer.messages).toEqual([])
	})
})

describe('createMemoryTransport', () => {
	it('records what it sent, delivers it to the peer, and fails when told to', async () => {
		const left = createMemoryTransport()
		const right = createMemoryTransport()
		const inbox = createRecorder<[string]>()
		const closed = createRecorder<[]>()
		left.connect(right)
		right.listen(inbox.handler)
		left.closed(closed.handler)

		await left.send('first')

		expect(left.sent).toEqual(['first'])
		expect(inbox.calls).toEqual([['first']])

		const failure = new Error('the wire is down')
		left.fail(failure)

		expect(left.failSend).toBe(failure)
		await expect(left.send('second')).rejects.toBe(failure)
		// A failed send records nothing and delivers nothing, so a scenario driving the failure
		// path cannot mistake it for a delivery.
		expect(left.sent).toEqual(['first'])
		expect(inbox.count).toBe(1)

		await left.close()
		await left.close()

		expect(left.closedCalls).toBe(2)
		expect(closed.count).toBe(2)
	})
})

describe('the in-process client transports', () => {
	it('emits the dispatched reply and answers a notification with nothing', async () => {
		const transport = createLoopbackTransport(createCalculatorServer())
		const replies = createRecorder<[JSONRPCMessage]>()
		transport.emitter.on('message', replies.handler)
		await transport.start()

		await transport.send(modernRequest('tools/list', 'loopback-1'))

		expect(replies.count).toBe(1)
		const [reply] = replies.calls[0] ?? []
		expect(reply !== undefined && 'result' in reply).toBe(true)
		expect(transport.duplex).toBe(true)
		expect(transport.session).toBeUndefined()

		await transport.send(createJSONRPCNotification('notifications/initialized'))

		expect(replies.count).toBe(1)
	})

	it('stamps every recorded frame with a reading taken while it was written', async () => {
		const transport = createRecordingTransport(createCalculatorServer())
		const replies = createRecorder<[JSONRPCMessage]>()
		transport.emitter.on('message', replies.handler)

		const before = performance.now()
		await transport.send(modernRequest('tools/list', 'recorded-1'))
		await transport.send(createJSONRPCNotification('notifications/initialized'))
		const after = performance.now()

		expect(transport.frames.map((frame) => frame.method)).toEqual([
			'tools/list',
			'notifications/initialized',
		])
		for (const frame of transport.frames) {
			expect(frame.at).toBeGreaterThanOrEqual(before)
			expect(frame.at).toBeLessThanOrEqual(after)
		}
		// Recording does not displace the dispatch it wraps.
		expect(replies.count).toBe(1)
	})
})

describe('probeOwnership', () => {
	it('reports a consumer that walks away from the exchange as holding it', async () => {
		const outcome = await probeOwnership(async (stream) => void (await stream.next()))

		expect(outcome.released).toBe(false)
		expect(outcome.failure).toBeUndefined()
	})

	it('reports a consumer that ends the exchange as releasing it', async () => {
		const outcome = await probeOwnership(async (stream) => {
			await stream.next()
			stream.stop()
		})

		expect(outcome.released).toBe(true)
		expect(outcome.failure).toBeUndefined()
	})

	it('surfaces what the consumer threw while still reporting the exchange it kept', async () => {
		const failure = new Error('the consumer failed')

		const outcome = await probeOwnership(async (stream) => {
			await stream.next()
			throw failure
		})

		// A pump that fails mid-exchange still owed the release, so the instrument reports the
		// failure and the leak together rather than letting the throw excuse the leak.
		expect(outcome.failure).toBe(failure)
		expect(outcome.released).toBe(false)
	})
})

describe('inspectOwnerOfLastResort', () => {
	it('reports each forbidden spelling a source declares and nothing for one that declares none', () => {
		expect(inspectOwnerOfLastResort('new FinalizationRegistry(() => stream.stop())')).toEqual([
			'FinalizationRegistry',
		])
		expect(
			inspectOwnerOfLastResort('setTimeout(end, 10)\nconst held = new WeakRef(stream)'),
		).toEqual(['WeakRef', 'setTimeout'])
		expect(inspectOwnerOfLastResort('await stream.next()\nstream.stop()')).toEqual([])
		expect(Object.isFrozen(OWNER_OF_LAST_RESORT_SPELLINGS)).toBe(true)
		expect(new Set(OWNER_OF_LAST_RESORT_SPELLINGS).size).toBe(OWNER_OF_LAST_RESORT_SPELLINGS.length)
	})
})

describe('probeDuplex and readMethods', () => {
	it('drives a client-initiated cancellation to the peer and returns every frame it received', async () => {
		const carrier = createMemoryTransport()
		const peer = createMemoryTransport()
		carrier.connect(peer)
		peer.connect(carrier)
		const unbind = bindServer(createCalculatorServer(), peer)
		const transport = createDuplexClientTransport(carrier)
		const client = createMCPClient({ transport })
		const unbindClient = bindClient(client, carrier)
		await client.connect()
		let read = carrier.sent.length

		const frames = await probeDuplex(client, async () => {
			const written = carrier.sent.slice(read)
			read = carrier.sent.length
			return written.flatMap((text) => {
				const message = parseJSONRPCMessage(JSON.parse(text))
				return message === undefined ? [] : [message]
			})
		})

		// Every frame is returned, not only the cancellation: an instrument that filtered could
		// not tell a dropped frame from a drain that sees nothing at all.
		expect(readMethods(frames)).toEqual(['tools/call', 'notifications/cancelled'])
		await client.disconnect()
		unbindClient()
		unbind()
	})

	it('reads one method per invocation and nothing from a response', () => {
		expect(
			readMethods([
				createJSONRPCRequest({ method: 'tools/list', id: 1 }),
				buildJSONRPCResult(1, {}),
				createJSONRPCNotification('notifications/cancelled'),
			]),
		).toEqual(['tools/list', 'notifications/cancelled'])
		expect(readMethods([])).toEqual([])
	})
})

describe('the SSE readers', () => {
	it('decodes a real body whose event and multi-byte character are split across chunks', async () => {
		const encoder = new TextEncoder()
		const bytes = encoder.encode('data: héllo\n\n')
		const chunks = [
			encoder.encode('event: mes'),
			encoder.encode('sage\ndata: {"ok":true}\n\n'),
			bytes.slice(0, 8),
			bytes.slice(8),
		]
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(chunk)
				controller.close()
			},
		})

		const events = await collectSSE(new Response(body))

		expect(events.map((event) => event.data)).toEqual(['{"ok":true}', 'héllo'])
		expect(events[0]?.event).toBe('message')
	})

	it('yields each event as its blank line arrives, and nothing for a bodyless response', async () => {
		const encoder = new TextEncoder()
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('data: first\n\ndata: second\n\n'))
				// The stream is never closed, so a reader that only answered at completion would
				// park here forever instead of yielding.
			},
		})

		const seen: string[] = []
		for await (const event of readSSEStream(new Response(body))) {
			seen.push(event.data)
			if (seen.length === 2) break
		}

		expect(seen).toEqual(['first', 'second'])
		expect(await collectSSE(new Response(null))).toEqual([])
	})
})

describe('createManualClock', () => {
	it('moves only when it is advanced', async () => {
		const clock = createManualClock(1_000)

		expect(clock.now()).toBe(1_000)
		await waitForDelay(20)
		// Real time passing moves nothing, which is what makes a TTL window deterministic.
		expect(clock.now()).toBe(1_000)

		clock.advance(50)
		clock.advance(25)

		expect(clock.now()).toBe(1_075)
		expect(createManualClock().now()).toBe(0)
	})
})

describe('MemoryResourceManager', () => {
	it('pages its records, answers an input-required read, and records every call', () => {
		const manager = new MemoryResourceManager()

		const first = manager.resources({}, METHOD_OPTIONS)
		const cursor = first.nextCursor
		if (cursor === undefined) throw new Error('unreachable: the first page carries a cursor')
		const second = manager.resources({ cursor }, METHOD_OPTIONS)

		expect(first.resources.map((resource) => resource.uri)).toEqual(['memory://resource/one'])
		expect(first.nextCursor).toBe('second')
		expect(second.resources.map((resource) => resource.uri)).toEqual(['memory://resource/two'])
		expect(second.nextCursor).toBeUndefined()
		expect(manager.cursors).toEqual([undefined, 'second'])

		expect(manager.resource({ uri: 'memory://resource/one' }, METHOD_OPTIONS)).toEqual([
			{ uri: 'memory://resource/one', text: 'one' },
		])
		expect(manager.resource({ uri: 'memory://resource/missing' }, METHOD_OPTIONS)).toBeUndefined()
		expect(manager.resource({ uri: 'memory://resource/input' }, METHOD_OPTIONS)).toEqual({
			resultType: 'input_required',
			requestState: 'resource-state',
		})
		expect(manager.reads.map((read) => read.uri)).toEqual([
			'memory://resource/one',
			'memory://resource/missing',
			'memory://resource/input',
		])

		expect(
			manager
				.templates({}, METHOD_OPTIONS)
				.resourceTemplates.map((template) => template.uriTemplate),
		).toEqual(['memory://resource/{name}'])
		// Every call the server made is recorded, which is what a dispatch assertion reads.
		expect(manager.options.length).toBe(6)
		for (const options of manager.options) expect(options).toBe(METHOD_OPTIONS)
	})
})

describe('TestTaskManager', () => {
	it('deduplicates by key and settles a task to completion with deterministic stamps', async () => {
		const manager = new TestTaskManager({ work: 5 })

		const created = await manager.start('call-1', TASK_CONTEXT, METHOD_OPTIONS)
		const repeated = await manager.start('call-1', TASK_CONTEXT, METHOD_OPTIONS)

		expect(created.status).toBe('working')
		expect(repeated.taskId).toBe(created.taskId)
		expect(manager.starts.map(([key]) => key)).toEqual(['call-1', 'call-1'])
		expect(manager.details.length).toBe(1)
		// The stamps come from a monotonic counter, so two runs produce identical snapshots.
		expect(created.createdAt).toBe(new Date(1_000).toISOString())
		expect(created.ttlMs).toBeNull()
		expect(Object.hasOwn(created, 'pollIntervalMs')).toBe(false)

		await manager.settle()

		const settled = await manager.task(created.taskId)
		expect(settled?.status).toBe('completed')
		expect(settled?.status === 'completed' ? settled.result : undefined).toEqual({
			resultType: 'complete',
			content: [{ type: 'text', text: created.taskId }],
		})
	})

	it('cancels a task on abort and on the request signal it was built to bind', async () => {
		const aborted = new TestTaskManager({ work: 5_000 })
		const abortedTask = await aborted.start('call-1', TASK_CONTEXT, METHOD_OPTIONS)
		await aborted.abort(abortedTask.taskId)

		expect((await aborted.task(abortedTask.taskId))?.status).toBe('cancelled')

		const controller = new AbortController()
		const bound = new TestTaskManager({ bind: true, work: 5_000 })
		const boundTask = await bound.start('call-1', TASK_CONTEXT, { signal: controller.signal })
		controller.abort()
		await bound.settle()

		// The hazard the port's own documentation names: a manager that hands the REQUEST's
		// signal to the work cancels the durable task when the request ends.
		expect((await bound.task(boundTask.taskId))?.status).toBe('cancelled')

		const unbound = new TestTaskManager({ work: 5 })
		const survivor = new AbortController()
		const survivingTask = await unbound.start('call-1', TASK_CONTEXT, { signal: survivor.signal })
		survivor.abort()
		await unbound.settle()

		expect((await unbound.task(survivingTask.taskId))?.status).toBe('completed')
	})

	it('purges only the tasks that can expire', async () => {
		const expiring = new TestTaskManager({ ttl: 60_000, work: 5 })
		const eternal = new TestTaskManager({ work: 5 })
		const expiringTask = await expiring.start('call-1', TASK_CONTEXT, METHOD_OPTIONS)
		const eternalTask = await eternal.start('call-1', TASK_CONTEXT, METHOD_OPTIONS)

		expiring.purge()
		eternal.purge()

		expect(expiringTask.ttlMs).toBe(60_000)
		expect(await expiring.task(expiringTask.taskId)).toBeUndefined()
		// `null` is the extension's spelling for "no expiry", not a zero-length one.
		expect(eternalTask.ttlMs).toBeNull()
		expect(await eternal.task(eternalTask.taskId)).toBeDefined()
		await Promise.all([expiring.settle(), eternal.settle()])
	})

	it('answers a caller it was not built for with the same undefined as a missing task', async () => {
		const manager = new TestTaskManager({ owner: 'owner-1', work: 5 })
		const task = await manager.start('call-1', TASK_CONTEXT, {
			signal: METHOD_OPTIONS.signal,
			caller: 'owner-1',
		})

		expect(
			await manager.task(task.taskId, { signal: METHOD_OPTIONS.signal, caller: 'owner-1' }),
		).toBeDefined()
		expect(
			await manager.task(task.taskId, { signal: METHOD_OPTIONS.signal, caller: 'owner-2' }),
		).toBeUndefined()
		expect(await manager.task(task.taskId)).toBeUndefined()
		expect(
			await manager.task('never-existed', { signal: METHOD_OPTIONS.signal, caller: 'owner-1' }),
		).toBeUndefined()
		await manager.settle()
	})

	it('holds an asking task until the named response arrives', async () => {
		const manager = new TestTaskManager({ asking: true, work: 5, poll: 250 })
		const task = await manager.start('call-1', TASK_CONTEXT, METHOD_OPTIONS)

		const asked = await manager.task(task.taskId)
		expect(task.status).toBe('input_required')
		expect(task.pollIntervalMs).toBe(250)
		expect(
			asked?.status === 'input_required' ? asked.inputRequests['approval']?.method : undefined,
		).toBe('elicitation/create')

		await manager.update(task.taskId, { unrelated: true })

		// Only the response the task asked for moves it on.
		expect((await manager.task(task.taskId))?.status).toBe('input_required')

		await manager.update(task.taskId, { approval: {} })

		expect((await manager.task(task.taskId))?.status).toBe('working')
		await manager.settle()
		expect((await manager.task(task.taskId))?.status).toBe('completed')
	})
})

describe('createTaskServer', () => {
	it('turns every call into a durable task the declaring client asked for', async () => {
		const tasks = new TestTaskManager({ work: 5 })
		const peer = createHostilePeer(createTaskServer(tasks))
		try {
			await peer.send(
				JSON.stringify(
					createJSONRPCRequest({
						method: 'tools/call',
						id: 'task-1',
						params: {
							name: 'render',
							arguments: {},
							_meta: {
								[MCP_META_VERSION]: MCP_MODERN_VERSION,
								[MCP_META_CAPABILITIES]: TASK_CAPABILITIES,
							},
						},
					}),
				),
			)

			expect(tasks.starts.map(([, context]) => context.call.name)).toEqual(['render'])
			const answered = peer.response()?.result
			expect(isRecord(answered) ? answered['resultType'] : undefined).toBe('task')
			await tasks.settle()
		} finally {
			peer.close()
		}
	})

	it('declares the tasks extension and nothing else', () => {
		expect(Object.isFrozen(TASK_CAPABILITIES)).toBe(true)
		expect(Object.keys(TASK_CAPABILITIES)).toEqual(['extensions'])
		expect(TASK_CAPABILITIES.extensions).toEqual({ [MCP_EXTENSION_TASKS]: {} })
	})

	it('answers the tasks methods nowhere on a server that configures none', async () => {
		// The negative control the fixture's own documentation names: a server from OUTSIDE the
		// extension's population, so "the client mirrors the server port" stays falsifiable.
		const peer = createHostilePeer(createCalculatorServer())
		try {
			await peer.send(JSON.stringify(modernRequest('tasks/get', 'task-2')))

			expect(peer.response()?.error?.code).toBe(-32601)
		} finally {
			peer.close()
		}
	})
})

describe('postJSON', () => {
	let fixture: BrowserFixtureInterface

	beforeAll(async () => {
		fixture = await start()
	})

	afterAll(async () => {
		await fixture.stop()
	})

	it('posts the serialized value to the default endpoint of a real server', async () => {
		const answered = await postJSON(fixture.base, modernRequest('tools/list', 'post-1'), {
			headers: {
				[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_VERSION,
				[MCP_METHOD_HEADER]: 'tools/list',
			},
		})

		// No `path` was given, so the request reached `/mcp` — the MCP endpoint the fixture
		// serves — and the server answered the id the body carried.
		expect(answered.status).toBe(200)
		const decoded: unknown = await answered.json()
		expect(isRecord(decoded) ? decoded['id'] : undefined).toBe('post-1')
	})

	it('merges the caller headers over the JSON content type and takes the given path', async () => {
		const answered = await postJSON(fixture.base, createJSONRPCRequest({ id: 'post-2' }), {
			path: '/headers',
			headers: { [MCP_METHOD_HEADER]: 'tools/list' },
		})

		const decoded: unknown = await answered.json()
		const result = isRecord(decoded) ? decoded['result'] : undefined
		// The fixture answers with the headers the request actually carried across the wire.
		expect(isRecord(result) ? result['method'] : undefined).toBe('tools/list')
		expect(isRecord(decoded) ? decoded['id'] : undefined).toBe('post-2')
	})
})

describe('createMCPServer over the shared fixtures', () => {
	it('serves the memory resource manager the dispatch suites hand it', async () => {
		const manager = new MemoryResourceManager()
		const mcp = createMCPServer({
			identity: { name: 'memory', version: '1.0.0' },
			tools: createToolManager(),
			resources: manager,
		})
		const peer = createHostilePeer(mcp)
		try {
			await peer.send(JSON.stringify(modernRequest('resources/list', 'resources-1')))

			const listed = peer.response()?.result
			const resources = isRecord(listed) ? listed['resources'] : undefined
			expect(
				Array.isArray(resources) ? resources.map((entry) => isRecord(entry) && entry['uri']) : [],
			).toEqual(['memory://resource/one'])
			// The manager saw the server's own per-request options rather than a literal this
			// file built, which is what a dispatch assertion reads back.
			expect(manager.options.length).toBe(1)
			expect(manager.options[0]?.signal).toBeInstanceOf(AbortSignal)
		} finally {
			peer.close()
		}
	})
})
