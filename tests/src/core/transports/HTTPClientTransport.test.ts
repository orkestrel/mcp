import type { JSONRPCMessage } from '@src/core'
import { describe, expect, it } from 'vitest'
import { isRecord } from '@orkestrel/contract'
import { HTTPClientTransport } from '@src/core'
import { waitForDelay } from '@orkestrel/test'

// src/core/transports/HTTPClientTransport.ts — the host-independent contract BOTH faces
// publish, driven through the injected `fetch` the class already takes. The round trips
// against a real Node-face server are proven in tests/src/server/integration.test.ts (Node)
// and tests/src/browser/factories.test.ts (a real browser); this file pins what needs a reply
// the wire cannot produce on demand: the RELEASE half, the sentinel stamping, the non-success
// rejection, and the `x-mcp-header` selection. The peer is a boundary stub for the platform
// `fetch`: it answers with a REAL `Response` over a REAL `ReadableStream`, and honors
// `init.signal` the way the platform does — erroring the body and failing the pending read.
// It reimplements nothing this package owns; the transport under test is the real one.

interface EndlessFetchInterface {
	/** The `fetch` to hand the transport through its public `fetch` option. */
	readonly answer: typeof fetch
	/** How many response bodies were cancelled through the signal the transport passed. */
	readonly cancelled: number
}

function createEndlessFetch(): EndlessFetchInterface {
	let cancelled = 0
	const encoder = new TextEncoder()
	const answer: typeof fetch = async (_input, init) => {
		const signal = init?.signal ?? undefined
		if (signal !== null && signal?.aborted === true) throw new Error('aborted before dispatch')
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				// One SSE comment: enough for the response headers to flush and the reader to park,
				// and not an event, so the transport never finishes decoding.
				controller.enqueue(encoder.encode(': open\n\n'))
				signal?.addEventListener(
					'abort',
					() => {
						cancelled += 1
						controller.error(new Error('response body cancelled'))
					},
					{ once: true },
				)
			},
		})
		return new Response(body, {
			status: 200,
			headers: { 'content-type': 'text/event-stream' },
		})
	}
	return {
		answer,
		get cancelled() {
			return cancelled
		},
	}
}

const REQUEST: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'tools/list' }

describe('HTTPClientTransport — close releases the request it has in flight', () => {
	it('close() cancels the response body a send is still reading', async () => {
		const peer = createEndlessFetch()
		const transport = new HTTPClientTransport({
			url: 'http://127.0.0.1:1/mcp',
			fetch: peer.answer,
		})
		const sending = transport.send(REQUEST)
		await waitForDelay(20)
		// The control: the reply never ends, so the write is still outstanding.
		expect(peer.cancelled).toBe(0)

		await transport.close()

		await expect(
			Promise.race([sending.then(() => 'settled'), waitForDelay(200).then(() => 'unsettled')]),
		).resolves.toBe('settled')
		expect(peer.cancelled).toBe(1)
	})

	it('surfaces the cancellation on error rather than throwing out of send', async () => {
		const peer = createEndlessFetch()
		const transport = new HTTPClientTransport({
			url: 'http://127.0.0.1:1/mcp',
			fetch: peer.answer,
		})
		const errors: unknown[] = []
		transport.emitter.on('error', (error) => errors.push(error))
		const sending = transport.send(REQUEST)
		await waitForDelay(20)

		await transport.close()
		await sending

		expect(errors).toHaveLength(1)
	})
})

// The browser half of the client's `Mcp-Name` stamping. The Node half asserts the same two
// rows in tests/src/server/transports/HTTPClientTransport.test.ts, and the wire form is
// written out literally rather than re-derived through `encodeSentinel`, so a row cannot
// agree with a broken encoder.

describe('HTTPClientTransport — Mcp-Name travels in the protocol sentinel form', () => {
	it('stamps a plain tool name literally and a name needing encoding as the sentinel', async () => {
		const names: Array<string | null> = []
		const transport = new HTTPClientTransport({
			url: 'http://127.0.0.1:1/mcp',
			fetch: (_input, init) => {
				names.push(new Headers(init?.headers).get('mcp-name'))
				return Promise.resolve(new Response(null, { status: 202 }))
			},
		})
		const metadata = {
			'io.modelcontextprotocol/protocolVersion': '2026-07-28',
			'io.modelcontextprotocol/clientCapabilities': {},
		}

		await transport.send({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'add', arguments: {}, _meta: metadata },
		})
		await transport.send({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: { name: 'café', arguments: {}, _meta: metadata },
		})

		expect(names).toEqual(['add', '=?base64?Y2Fmw6k=?='])
	})
})

// A non-success reply is ONE contract for every face, and it is the transport's own decision
// rather than the peer's: the peer answered, so leaving the caller to wait out its deadline for
// a failure this class already read is what the rejection exists to prevent. The rows below
// drive the class directly through its injected `fetch`, which is the seam both
// `createHTTPClientTransport` factories hand it.

describe('HTTPClientTransport — a non-success reply carrying no message rejects send', () => {
	it('rejects with the status and body shape when the error body is not JSON-RPC', async () => {
		const transport = new HTTPClientTransport({
			url: 'http://127.0.0.1:1/mcp',
			fetch: () => Promise.resolve(Response.json({ error: 'unavailable' }, { status: 502 })),
		})

		await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).rejects.toThrow(
			'HTTP 502 response contained an application/json body that was not a JSON-RPC message',
		)
	})

	it('emits a valid JSON-RPC error body at a non-success status instead of rejecting', async () => {
		const answer = { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }
		const transport = new HTTPClientTransport({
			url: 'http://127.0.0.1:1/mcp',
			fetch: () => Promise.resolve(Response.json(answer, { status: 404 })),
		})
		const delivered: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => delivered.push(message))

		await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

		expect(delivered).toEqual([answer])
	})
})

describe('HTTPClientTransport — close is idempotent', () => {
	it('emits close once however many times it is called', async () => {
		const transport = new HTTPClientTransport({ url: 'http://127.0.0.1:1/mcp' })
		let closed = 0
		transport.emitter.on('close', () => (closed += 1))

		await transport.close()
		await transport.close()
		await transport.close()

		expect(closed).toBe(1)
	})
})

// The browser half of SEP-2243's `x-mcp-header` contract. The Node face asserts the same rows
// in tests/src/server/transports/HTTPClientTransport.test.ts, and the sentinel wire form is
// written out literally rather than re-derived, so a row cannot agree with a broken encoder.

const ANNOTATED_TOOLS = {
	jsonrpc: '2.0',
	id: 1,
	result: {
		resultType: 'complete',
		ttlMs: 0,
		cacheScope: 'private',
		nextCursor: 'page-2',
		tools: [
			{
				name: 'valid_tool',
				inputSchema: {
					type: 'object',
					properties: {
						region: { type: 'string', 'x-mcp-header': 'Region' },
						priority: { type: 'integer', 'x-mcp-header': 'Priority' },
						verbose: { type: 'boolean', 'x-mcp-header': 'Verbose' },
						query: { type: 'string' },
					},
				},
			},
			{
				name: 'invalid_duplicate_diff_case',
				inputSchema: {
					type: 'object',
					properties: {
						field1: { type: 'string', 'x-mcp-header': 'MyField' },
						field2: { type: 'string', 'x-mcp-header': 'myfield' },
					},
				},
			},
		],
	},
}

const CALL_METADATA = {
	'io.modelcontextprotocol/protocolVersion': '2026-07-28',
	'io.modelcontextprotocol/clientCapabilities': {},
}

// A listing that advertises one annotated tool, and the fresh listing that no longer carries
// it. A `tools/list` sent with no `cursor` REPLACES what the caller was told, so the second
// of these leaves the transport with nothing to project for `gone`. The Node face pins the
// same interleaving, plus the continuation half.
const GONE_LISTING = {
	jsonrpc: '2.0',
	id: 1,
	result: {
		resultType: 'complete',
		ttlMs: 0,
		cacheScope: 'private',
		tools: [
			{
				name: 'gone',
				inputSchema: {
					type: 'object',
					properties: { region: { type: 'string', 'x-mcp-header': 'Region' } },
				},
			},
		],
	},
}

const EMPTY_LISTING = {
	jsonrpc: '2.0',
	id: 2,
	result: { resultType: 'complete', ttlMs: 0, cacheScope: 'private', tools: [] },
}

// Two pages of ONE listing, the second requested with the cursor the first handed back. A
// continuation ACCUMULATES, so both tools stay projectable.
const FIRST_PAGE = {
	jsonrpc: '2.0',
	id: 1,
	result: {
		resultType: 'complete',
		ttlMs: 0,
		cacheScope: 'private',
		nextCursor: 'page-2',
		tools: [
			{
				name: 'paged_one',
				inputSchema: {
					type: 'object',
					properties: { region: { type: 'string', 'x-mcp-header': 'Region' } },
				},
			},
		],
	},
}

const SECOND_PAGE = {
	jsonrpc: '2.0',
	id: 2,
	result: {
		resultType: 'complete',
		ttlMs: 0,
		cacheScope: 'private',
		tools: [
			{
				name: 'paged_two',
				inputSchema: {
					type: 'object',
					properties: { priority: { type: 'integer', 'x-mcp-header': 'Priority' } },
				},
			},
		],
	},
}

describe('HTTPClientTransport — the x-mcp-header contract', () => {
	it('excludes an invalidly annotated tool and reports the exclusion on error', async () => {
		const messages: JSONRPCMessage[] = []
		const faults: unknown[] = []
		const transport = new HTTPClientTransport({
			url: 'http://127.0.0.1:1/mcp',
			fetch: () => Promise.resolve(Response.json(ANNOTATED_TOOLS)),
		})
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('error', (error) => faults.push(error))

		await transport.send({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: { _meta: CALL_METADATA },
		})

		const delivered = messages[0]
		if (delivered === undefined || !('result' in delivered) || !isRecord(delivered.result)) {
			throw new Error('the transport delivered no tools/list result')
		}
		const tools = delivered.result['tools']
		if (!Array.isArray(tools)) throw new Error('the delivered result carries no tool array')
		expect(tools.map((tool) => (isRecord(tool) ? tool['name'] : undefined))).toEqual(['valid_tool'])
		// The rest of the result travels through untouched — the cache stamps a caller reads
		// freshness from, and the cursor it pages with.
		expect(delivered.result['resultType']).toBe('complete')
		expect(delivered.result['ttlMs']).toBe(0)
		expect(delivered.result['nextCursor']).toBe('page-2')
		expect(faults).toHaveLength(1)
		expect(String(faults[0])).toContain('invalid_duplicate_diff_case')
	})

	it('projects a listed tool arguments into encoded Mcp-Param headers, omitting a null', async () => {
		const headers: Headers[] = []
		const transport = new HTTPClientTransport({
			url: 'http://127.0.0.1:1/mcp',
			fetch: (_input, init) => {
				headers.push(new Headers(init?.headers))
				return Promise.resolve(Response.json(ANNOTATED_TOOLS))
			},
		})

		await transport.send({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: { _meta: CALL_METADATA },
		})
		await transport.send({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/call',
			params: {
				name: 'valid_tool',
				arguments: { region: ' padded ', priority: 42, verbose: null, query: 'SELECT 1' },
				_meta: CALL_METADATA,
			},
		})

		const called = headers[1]
		if (called === undefined) throw new Error('the transport issued no call')
		expect(called.get('mcp-param-region')).toBe('=?base64?IHBhZGRlZCA=?=')
		expect(called.get('mcp-param-priority')).toBe('42')
		expect(called.get('mcp-param-verbose')).toBeNull()
		expect(called.get('mcp-param-query')).toBeNull()
	})

	it('projects nothing for a tool it never carried a listing for', async () => {
		const headers: Headers[] = []
		const transport = new HTTPClientTransport({
			url: 'http://127.0.0.1:1/mcp',
			fetch: (_input, init) => {
				headers.push(new Headers(init?.headers))
				return Promise.resolve(new Response(null, { status: 202 }))
			},
		})

		await transport.send({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'valid_tool', arguments: { region: 'us-west1' }, _meta: CALL_METADATA },
		})

		const called = headers[0]
		if (called === undefined) throw new Error('the transport issued no call')
		expect(called.get('mcp-name')).toBe('valid_tool')
		expect(called.get('mcp-param-region')).toBeNull()
	})

	it('projects nothing for a tool a later cursorless listing no longer carries', async () => {
		const headers: Headers[] = []
		let issued = 0
		const transport = new HTTPClientTransport({
			url: 'http://127.0.0.1:1/mcp',
			fetch: (_input, init) => {
				headers.push(new Headers(init?.headers))
				issued += 1
				if (issued === 1) return Promise.resolve(Response.json(GONE_LISTING))
				if (issued === 2) return Promise.resolve(Response.json(EMPTY_LISTING))
				return Promise.resolve(new Response(null, { status: 202 }))
			},
		})

		await transport.send({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: { _meta: CALL_METADATA },
		})
		await transport.send({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
			params: { _meta: CALL_METADATA },
		})
		await transport.send({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'gone', arguments: { region: 'us-west1' }, _meta: CALL_METADATA },
		})

		const called = headers[2]
		if (called === undefined) throw new Error('the transport issued no call')
		expect(called.get('mcp-name')).toBe('gone')
		expect(called.get('mcp-param-region')).toBeNull()
	})

	// Overlapping listings: `send` opens an independent `fetch` per call, so two `tools/list`
	// answers can arrive in the opposite order to their requests. The stub holds the first
	// answer back to script exactly that arrival order — it answers with real `Response`
	// objects and reimplements nothing this package owns. The Node face pins the same rows.
	it('caches nothing from a listing a fresh one superseded before its answer arrived', async () => {
		const headers: Headers[] = []
		let issued = 0
		let release: ((response: Response) => void) | undefined
		const transport = new HTTPClientTransport({
			url: 'http://127.0.0.1:1/mcp',
			fetch: (_input, init) => {
				headers.push(new Headers(init?.headers))
				issued += 1
				if (issued === 1) {
					return new Promise<Response>((resolve) => {
						release = resolve
					})
				}
				if (issued === 2) return Promise.resolve(Response.json(EMPTY_LISTING))
				return Promise.resolve(new Response(null, { status: 202 }))
			},
		})

		// A continuation goes out first and its answer is held; the fresh cursorless listing
		// sent behind it lands first and replaces the table.
		const superseded = transport.send({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: { cursor: 'page-2', _meta: CALL_METADATA },
		})
		await transport.send({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
			params: { _meta: CALL_METADATA },
		})
		if (release === undefined) throw new Error('the transport issued no continuation')
		release(Response.json(SECOND_PAGE))
		await superseded
		await transport.send({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'paged_two', arguments: { priority: 3 }, _meta: CALL_METADATA },
		})

		const called = headers[2]
		if (called === undefined) throw new Error('the transport issued no call')
		expect(called.get('mcp-name')).toBe('paged_two')
		expect(called.get('mcp-param-priority')).toBeNull()
	})

	// Withholding the cache is not withholding the answer. The caller still receives the
	// superseded page with its invalid definition dropped and the exclusion still on `error`;
	// only the projection table is left alone.
	it('excludes and reports an invalid definition on a superseded listing it caches nothing from', async () => {
		const headers: Headers[] = []
		const messages: JSONRPCMessage[] = []
		const faults: unknown[] = []
		let issued = 0
		let release: ((response: Response) => void) | undefined
		const transport = new HTTPClientTransport({
			url: 'http://127.0.0.1:1/mcp',
			fetch: (_input, init) => {
				headers.push(new Headers(init?.headers))
				issued += 1
				if (issued === 1) {
					return new Promise<Response>((resolve) => {
						release = resolve
					})
				}
				if (issued === 2) return Promise.resolve(Response.json(EMPTY_LISTING))
				return Promise.resolve(new Response(null, { status: 202 }))
			},
		})
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('error', (error) => faults.push(error))

		const superseded = transport.send({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: { cursor: 'page-2', _meta: CALL_METADATA },
		})
		await transport.send({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
			params: { _meta: CALL_METADATA },
		})
		if (release === undefined) throw new Error('the transport issued no continuation')
		release(Response.json(ANNOTATED_TOOLS))
		await superseded
		await transport.send({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'valid_tool', arguments: { region: 'us-west1' }, _meta: CALL_METADATA },
		})

		const delivered = messages[1]
		if (delivered === undefined || !('result' in delivered) || !isRecord(delivered.result)) {
			throw new Error('the transport delivered no superseded tools/list result')
		}
		const tools = delivered.result['tools']
		if (!Array.isArray(tools)) throw new Error('the delivered result carries no tool array')
		expect(tools.map((tool) => (isRecord(tool) ? tool['name'] : undefined))).toEqual(['valid_tool'])
		expect(faults).toHaveLength(1)
		expect(String(faults[0])).toContain('invalid_duplicate_diff_case')
		// The page was delivered whole and cached not at all.
		const called = headers[2]
		if (called === undefined) throw new Error('the transport issued no call')
		expect(called.get('mcp-param-region')).toBeNull()
	})

	it('keeps both pages projectable when a fresh listing and its own continuation overlap', async () => {
		const headers: Headers[] = []
		let issued = 0
		let listing: ((response: Response) => void) | undefined
		let continuation: ((response: Response) => void) | undefined
		const transport = new HTTPClientTransport({
			url: 'http://127.0.0.1:1/mcp',
			fetch: (_input, init) => {
				headers.push(new Headers(init?.headers))
				issued += 1
				if (issued === 1) {
					return new Promise<Response>((resolve) => {
						listing = resolve
					})
				}
				if (issued === 2) {
					return new Promise<Response>((resolve) => {
						continuation = resolve
					})
				}
				return Promise.resolve(new Response(null, { status: 202 }))
			},
		})

		// Both pages of ONE listing are in flight together, and they answer in order.
		const fresh = transport.send({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
			params: { _meta: CALL_METADATA },
		})
		const paged = transport.send({
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
			params: { cursor: 'page-2', _meta: CALL_METADATA },
		})
		if (listing === undefined || continuation === undefined) {
			throw new Error('the transport issued no listing')
		}
		listing(Response.json(FIRST_PAGE))
		await fresh
		continuation(Response.json(SECOND_PAGE))
		await paged
		await transport.send({
			jsonrpc: '2.0',
			id: 3,
			method: 'tools/call',
			params: { name: 'paged_one', arguments: { region: 'us-west1' }, _meta: CALL_METADATA },
		})
		await transport.send({
			jsonrpc: '2.0',
			id: 4,
			method: 'tools/call',
			params: { name: 'paged_two', arguments: { priority: 3 }, _meta: CALL_METADATA },
		})

		const first = headers[2]
		const second = headers[3]
		if (first === undefined || second === undefined) {
			throw new Error('the transport issued no call')
		}
		expect(first.get('mcp-param-region')).toBe('us-west1')
		expect(second.get('mcp-param-priority')).toBe('3')
	})
})
