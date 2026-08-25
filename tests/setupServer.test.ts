// Proof of `tests/setupServer.ts` — the Node-only harnesses the server suites are driven over.
//
// Every case here uses the real resource the helper exists to provide: real `node:stream`
// duplexes, real listeners on `127.0.0.1` ephemeral ports, real RFC 6455 handshakes, and a real
// `@orkestrel/guide` source view. Nothing is simulated, because a harness that only works
// against a simulation is a harness that proves nothing about the suites it carries.
//
// `findMissingNamedImports` also has a fence-grammar battery in `tests/guides.test.ts`, which is
// the suite that consumes it; what it owns here is its boundary — which specifier is checked
// against a face, which one is refused, and which one is skipped.

import { describe, expect, it } from 'vitest'
import type { MiddlewareHandler } from '@orkestrel/server'
import type { SourceInterface } from '@orkestrel/guide'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { createSource } from '@orkestrel/guide'
import { encodeWebSocketFrame, WEBSOCKET_OPCODE_TEXT } from '@orkestrel/websocket'
import { upgradeRequestPath } from '@src/server'
import { waitForDelay } from '@orkestrel/test'
import { createMCPClient } from '@src/core'
import { createRecorder } from '@orkestrel/test'
import {
	createCalculatorServer,
	createLoopbackTransport,
	createManualClock,
	waitForSettlement,
} from './setup.js'
import {
	closeResource,
	createClockMiddleware,
	createDelayMiddleware,
	createRequestStub,
	createStreamStub,
	duplexPair,
	findMissingNamedImports,
	flushSocket,
	isIncomingMessage,
	openClientSocket,
	readClientFrames,
	startServer,
	startUpgradeServer,
	upgradeRequest,
} from './setupServer.js'

// A real `@orkestrel/guide` source view over a two-module package: `parse` is reachable from the
// barrel and `hidden` is not, so a fence importing either is checked against a genuine face.
const FACE: SourceInterface = createSource({
	files: {
		'lib/index.ts': "export * from './parsers.js'\n",
		'lib/parsers.ts': 'export function parse(text: string): string {\n\treturn text\n}\n',
		'lib/hidden.ts': 'export function hidden(): void {}\n',
	},
	module: 'lib',
})
const SOURCES: ReadonlyMap<string, SourceInterface> = new Map([['@scope/lib', FACE]])

function respondOK(): Response {
	return new Response('ok')
}

describe('findMissingNamedImports', () => {
	it('reports only the named imports its mapped face does not publish', () => {
		expect(FACE.surface().map((symbol) => symbol.name)).toEqual(['parse'])
		expect(
			findMissingNamedImports("import { parse } from '@scope/lib'", SOURCES, '@scope/root'),
		).toEqual([])
		expect(
			findMissingNamedImports("import { parse, hidden } from '@scope/lib'", SOURCES, '@scope/root'),
		).toEqual(['hidden'])
		// An unmapped foreign specifier is checked against no face, so it contributes nothing.
		expect(
			findMissingNamedImports("import { anything } from '@other/package'", SOURCES, '@scope/root'),
		).toEqual([])
		// A comment is masked to spaces by Guide's projection before any statement is surfaced.
		expect(
			findMissingNamedImports("// import { hidden } from '@scope/lib'", SOURCES, '@scope/root'),
		).toEqual([])
	})

	it('refuses a self specifier nothing maps and a repository alias', () => {
		expect(() =>
			findMissingNamedImports("import { parse } from '@scope/root'", SOURCES, '@scope/root'),
		).toThrow('Unmapped self specifier: @scope/root')
		expect(() =>
			findMissingNamedImports("import { parse } from '@scope/root/server'", SOURCES, '@scope/root'),
		).toThrow('Unmapped self specifier: @scope/root/server')
		// A public example must import through a published specifier, never through an alias.
		expect(() =>
			findMissingNamedImports("import { parse } from '@src/core'", SOURCES, '@scope/root'),
		).toThrow('Repository alias specifier: @src/core')
		expect(() =>
			findMissingNamedImports("import { parse } from '@app/core'", SOURCES, '@scope/root'),
		).toThrow('Repository alias specifier: @app/core')
	})
})

describe('createRequestStub', () => {
	it('carries the fields a real reader reads and defaults the rest', () => {
		const stub = createRequestStub({ url: '/mcp?session=1', method: 'GET' })

		// The real `node:http` reader is what the stub exists to satisfy, so it is what reads it.
		expect(upgradeRequestPath(stub)).toBe('/mcp')
		expect(stub.method).toBe('GET')
		expect(stub.headers).toEqual({})
		expect(upgradeRequestPath(createRequestStub())).toBe('/')
		expect(createRequestStub({ headers: { upgrade: 'websocket' } }).headers['upgrade']).toBe(
			'websocket',
		)
		expect(createRequestStub({ socket: { remoteAddress: '127.0.0.1' } }).socket.remoteAddress).toBe(
			'127.0.0.1',
		)
	})

	it('narrows on the headers a reader needs and refuses a shape without them', () => {
		expect(isIncomingMessage({ headers: {} })).toBe(true)
		expect(isIncomingMessage({ url: '/mcp' })).toBe(false)
		expect(isIncomingMessage('headers')).toBe(false)
		expect(isIncomingMessage(null)).toBe(false)
		expect(isIncomingMessage(undefined)).toBe(false)
	})
})

describe('createStreamStub', () => {
	it('records what an inert stream accepted and reports that it ended', async () => {
		const stream = createStreamStub()

		expect(stream.write({ data: 'first' })).toBe(true)
		stream.write({ data: 'second' })
		stream.comment('keepalive')
		await stream.drain()

		expect(stream.events).toEqual(['first', 'second'])
		expect(stream.comments).toEqual(['keepalive'])
		expect(stream.ended).toBe(false)
		expect(stream.closed).toBe(false)

		stream.end()

		expect(stream.ended).toBe(true)
		expect(stream.closed).toBe(true)
		// The default body closes on its first read, so a bridge reading it is released.
		expect(await stream.response.body?.getReader().read()).toEqual({ done: true, value: undefined })
	})

	it('raises the fault it was built with, on the face that fault belongs to', async () => {
		const failure = new Error('the socket went away')
		const writing = createStreamStub({ write: failure })

		expect(() => writing.write({ data: 'first' })).toThrow(failure)
		expect(writing.events).toEqual([])

		const raising = createStreamStub({ body: failure })

		await expect(raising.response.body?.getReader().read()).rejects.toBe(failure)
	})

	it('parks a reader on a pending body instead of releasing it', async () => {
		const pending = createStreamStub({ pending: true })
		const reader = pending.response.body?.getReader()

		// A held-open exchange nobody completed: what the bridge does WHILE it waits is only
		// observable because this read never settles.
		await expect(
			waitForSettlement(reader?.read() ?? Promise.resolve(undefined), 25, 'the body settled'),
		).rejects.toThrow('the body settled')
	})
})

describe('duplexPair', () => {
	it('carries bytes in both directions across two real Node streams', async () => {
		const [server, peer] = duplexPair()
		const fromPeer: Buffer[] = []
		const fromServer: Buffer[] = []
		server.on('data', (chunk: Buffer) => void fromPeer.push(chunk))
		peer.on('data', (chunk: Buffer) => void fromServer.push(chunk))

		server.write(Buffer.from('to the client'))
		peer.write(Buffer.from('to the server'))
		await flushSocket()

		expect(Buffer.concat(fromServer).toString()).toBe('to the client')
		expect(Buffer.concat(fromPeer).toString()).toBe('to the server')
		server.destroy()
		peer.destroy()
	})

	it('strips the handshake and decodes each frame off the running buffer', async () => {
		const [server, peer] = duplexPair()
		const reader = readClientFrames(peer)
		const frame = encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'second')

		server.write(
			Buffer.concat([
				Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n'),
				encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, 'first'),
			]),
		)
		await flushSocket()

		expect(reader.frames.map((decoded) => decoded.payload.toString())).toEqual(['first'])

		// A frame split across writes stays in the running buffer until it is complete, which is
		// what makes the reader safe against however the kernel chunks the wire.
		server.write(frame.subarray(0, 3))
		await flushSocket()

		expect(reader.frames.length).toBe(1)

		server.write(frame.subarray(3))
		await flushSocket()

		expect(reader.frames.map((decoded) => decoded.payload.toString())).toEqual(['first', 'second'])
		expect(reader.frames.map((decoded) => decoded.opcode)).toEqual([
			WEBSOCKET_OPCODE_TEXT,
			WEBSOCKET_OPCODE_TEXT,
		])
		server.destroy()
		peer.destroy()
	})
})

describe('startUpgradeServer and openClientSocket', () => {
	it('completes a real handshake, re-emits its trailing frame, and counts the socket open', async () => {
		const peer = await startUpgradeServer({ frame: 'from the peer' })
		try {
			const socket = await openClientSocket(peer.base, '/mcp')
			const deadline = performance.now() + 1_000
			while (socket.frames.length === 0 && performance.now() < deadline) await waitForDelay(5)

			expect(peer.count).toBe(1)
			expect(peer.open).toBe(1)
			expect(socket.frames.map((frame) => frame.payload.toString())).toEqual(['from the peer'])

			socket.close()
			await socket.closed
			const closing = performance.now() + 1_000
			while (peer.open > 0 && performance.now() < closing) await waitForDelay(5)

			// An upgraded socket the client destroyed reaches zero; an orphan never would.
			expect(peer.open).toBe(0)
			expect(peer.count).toBe(1)
		} finally {
			await peer.stop()
		}
	})

	it('holds the handshake open for the delay it was given', async () => {
		const peer = await startUpgradeServer({ delay: 40 })
		try {
			const started = performance.now()
			const socket = await openClientSocket(peer.base, '/mcp')
			const elapsed = performance.now() - started

			// `openClientSocket` resolves on the handshake, so the caller knows the socket is
			// CLAIMED before it acts — which is only true if it really waited for the `101`.
			expect(elapsed).toBeGreaterThanOrEqual(35)
			expect(peer.count).toBe(1)
			socket.close()
			await socket.closed
		} finally {
			await peer.stop()
		}
	})
})

describe('upgradeRequest', () => {
	it('reports a claimed upgrade and a declined one without ever rejecting', async () => {
		const peer = await startUpgradeServer()
		try {
			// The extra header is merged over the upgrade headers the driver always sends, and the
			// peer answers `101` only for a request that carried a key.
			const claimed = await upgradeRequest(peer.base, '/mcp', {
				'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
			})
			const keyless = await upgradeRequest(peer.base, '/mcp')

			expect(claimed).toEqual({ claimed: true, status: 101, protocol: undefined })
			expect(keyless.claimed).toBe(false)
		} finally {
			await peer.stop()
		}

		const dispatcher = createDispatcher<unknown>()
		dispatcher.add({ method: 'GET', path: '/', name: 'root', handler: respondOK })
		const handle = await startServer(
			createServer<unknown>({ dispatcher, state: () => undefined, host: '127.0.0.1' }),
		)
		try {
			const declined = await upgradeRequest(handle.base, '/mcp')

			// No handler claimed the socket, so the spine destroyed it un-upgraded — an expected
			// outcome the driver reports rather than throws.
			expect(declined.claimed).toBe(false)
		} finally {
			await closeResource(handle)
		}
	})
})

describe('startServer and closeResource', () => {
	it('binds an ephemeral loopback port a real client reaches, and releases it', async () => {
		const dispatcher = createDispatcher<unknown>()
		dispatcher.add({ method: 'GET', path: '/', name: 'root', handler: respondOK })
		const handle = await startServer(
			createServer<unknown>({ dispatcher, state: () => undefined, host: '127.0.0.1' }),
		)

		expect(handle.base).toBe(`http://127.0.0.1:${handle.port}`)
		expect(handle.port).toBeGreaterThan(0)
		expect(await (await fetch(handle.base)).text()).toBe('ok')

		// `closeResource` picks the release method the resource declares, and the release is
		// idempotent, so a suite that already released one inline tears down exactly once.
		await closeResource(handle)
		await closeResource(handle)

		await expect(fetch(handle.base)).rejects.toThrow('fetch failed')
	})

	it('releases a client and a bare transport through the method each one declares', async () => {
		const transport = createLoopbackTransport(createCalculatorServer())
		const closes = createRecorder<[]>()
		transport.emitter.on('close', closes.handler)
		const client = createMCPClient({ transport: createLoopbackTransport(createCalculatorServer()) })
		await client.connect()

		// A client declares `disconnect` and a bare transport declares `close`; the narrowing is
		// structural, so each member is released through the one method it has.
		await closeResource(client)
		await closeResource(transport)

		expect(client.connected).toBe(false)
		expect(closes.count).toBe(1)
	})
})

describe('the request middlewares', () => {
	it('advances the manual clock inside every request it handles', async () => {
		const clock = createManualClock(1_000)
		const dispatcher = createDispatcher<unknown>()
		dispatcher.add({ method: 'GET', path: '/', name: 'root', handler: respondOK })
		const server = createServer<unknown>({
			dispatcher,
			state: () => undefined,
			host: '127.0.0.1',
		})
		server.use(createClockMiddleware<unknown>(clock, 60))
		const handle = await startServer(server)
		try {
			await fetch(handle.base)
			await fetch(handle.base)

			// Clock time passes INSIDE the request, which is what makes "the instant of the last
			// access" falsifiable against "the instant the request started".
			expect(clock.now()).toBe(1_120)
		} finally {
			await closeResource(handle)
		}
	})

	it('holds every request it handles open for real time before delegating', async () => {
		const dispatcher = createDispatcher<unknown>()
		dispatcher.add({ method: 'GET', path: '/', name: 'root', handler: respondOK })
		const server = createServer<unknown>({
			dispatcher,
			state: () => undefined,
			host: '127.0.0.1',
		})
		const delay: MiddlewareHandler<unknown> = createDelayMiddleware<unknown>(40)
		server.use(delay)
		const handle = await startServer(server)
		try {
			const started = performance.now()
			await fetch(handle.base)
			const elapsed = performance.now() - started

			expect(elapsed).toBeGreaterThanOrEqual(35)
		} finally {
			await closeResource(handle)
		}
	})
})
