import type { JSONRPCMessage } from '@src/core'
import type { StartedServerInterface } from '../../../setupServer.js'
import type { Duplex } from 'node:stream'
import { createServer as createHTTPServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import {
	createMCPClient,
	DEFAULT_MCP_CACHE_TTL,
	MCP_META_SERVER,
	MCP_MODERN_VERSION,
} from '@src/core'
import { isRecord } from '@orkestrel/contract'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { createWebSocketClientTransport, createWebSocketServer } from '@src/server'
import {
	computeWebSocketAccept,
	encodeWebSocketFrame,
	WEBSOCKET_OPCODE_CLOSE,
	WEBSOCKET_OPCODE_TEXT,
} from '@orkestrel/websocket'
import { createTeardown, waitForDelay } from '@orkestrel/test'
import { createCalculatorServer, MODERN_METADATA } from '../../../setup.js'
import { startServer, startUpgradeServer } from '../../../setupServer.js'

// src/server/mcp/WebSocketClientTransport.ts — the WebSocket CLIENT transport (the egress
// mirror of createWebSocketServer), proven END TO END against the shipped createWebSocketServer
// over a REAL `node:http` server + a REAL MCPServer over a real ToolManager (stub tools, NO live
// model). The contract the assertions pin down: `start()` performs the RFC 6455
// handshake (validating the Sec-WebSocket-Accept) and opens a persistent frame channel; an
// MCPClient over it connects + discovers + calls the remote tools over real WS frames; a remote
// tool failure → a local throw; a `ws://` and an `http://` url both reach the endpoint; an
// upgrade declined by the server → `connect()` rejects; `session` is undefined for the stateless
// v1; and `disconnect()` closes cleanly. The per-connection bridge + frame decode/drop are pinned
// at the unit level in WebSocketServerTransport.test.ts (the same MCPClientTransportInterface).

const teardown = createTeardown()
afterEach(() => teardown.destroy())

// Teardown runs newest-first because a client is acquired after the server it connects to and must
// close before that server stops. An upgraded WebSocket is detached from the connection set that
// `closeIdleConnections()` and `closeAllConnections()` walk, so neither call reaches it. The owner
// must close the socket before the raw server can finish closing.

// Stand up a server exposing the stub-tool MCPServer over WebSocket (the spine upgrade seam) on
// an ephemeral port. `path` defaults to /mcp; pass a custom one to exercise the path option.
async function startWs(path?: string): Promise<StartedServerInterface> {
	const dispatcher = createDispatcher<unknown>()
	const server = createServer<unknown>({ dispatcher, state: () => undefined })
	server.upgrade(
		createWebSocketServer(createCalculatorServer(), {
			emitter: server.emitter,
			...(path === undefined ? {} : { path }),
		}),
	)
	const handle = await startServer(server)
	teardown.add(() => handle.stop())
	return handle
}

// Stand up a RAW `node:http` server that ANSWERS the upgrade with a structurally-valid 101
// (right `Upgrade` / `Connection` headers) but a BOGUS `Sec-WebSocket-Accept` — so the client's
// `start()` reaches the accept-validation branch and must reject on the mismatch (the security
// check is otherwise vacuously covered: the happy path never feeds a wrong accept). Returns the
// bound `http://…` base; tracked for `afterEach` close.
async function startBogusAcceptServer(): Promise<string> {
	const sockets: Duplex[] = []
	const server = createHTTPServer()
	teardown.add(
		() =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy()
				if (!server.listening) resolve()
				else server.close(() => resolve())
			}),
	)
	server.on('upgrade', (_request, socket) => {
		sockets.push(socket) // captured so teardown can destroy this detached upgrade socket
		// The client `socket.destroy()`s its end on the accept mismatch, so this server end sees an
		// ECONNRESET — swallow it (an expected, non-fatal teardown), never an uncaught 'error'.
		socket.on('error', () => {})
		// A well-formed switching-protocols line + headers, but a deliberately WRONG accept value
		// (never `computeWebSocketAccept(key)`), so the handshake fails the accept check.
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\n' +
				'Upgrade: websocket\r\n' +
				'Connection: Upgrade\r\n' +
				'Sec-WebSocket-Accept: wrong\r\n' +
				'\r\n',
		)
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address: unknown = server.address()
	const port = isRecord(address) && typeof address.port === 'number' ? address.port : 0
	return `http://127.0.0.1:${port}`
}

describe('WebSocketClientTransport — drive a remote MCP server over WebSocket frames', () => {
	it('connect → tools() → call(add): a value round-trips over real frames (ws:// url)', async () => {
		const handle = await startWs()
		// `handle.base` is http://… — use a ws:// url to prove the scheme conversion path.
		const url = `${handle.base.replace('http://', 'ws://')}/mcp`
		const client = createMCPClient({ transport: createWebSocketClientTransport({ url }) })

		await client.connect()
		expect(client.connected).toBe(true)

		const tools = await client.tools()
		expect(tools.map((tool) => tool.name)).toEqual(['add', 'boom'])

		expect(await client.call('add', {})).toEqual({ resultType: 'complete', value: 5 })

		await client.disconnect()
		expect(client.connected).toBe(false)
	})

	it('accepts an http:// url too (no scheme conversion needed)', async () => {
		const handle = await startWs()
		const client = createMCPClient({
			transport: createWebSocketClientTransport({ url: `${handle.base}/mcp` }),
		})
		await client.connect()
		expect(client.connected).toBe(true)
		expect(await client.call('add', {})).toEqual({ resultType: 'complete', value: 5 })
		await client.disconnect()
	})

	it('a remote erroring tool throws locally (isError → throw)', async () => {
		const handle = await startWs()
		const client = createMCPClient({
			transport: createWebSocketClientTransport({ url: `${handle.base}/mcp` }),
		})
		await client.connect()
		await expect(client.call('boom', {})).rejects.toThrow(/kaboom/)
		await client.disconnect()
	})

	it('connect() rejects when the server declines the upgrade (wrong path)', async () => {
		// The server claims only /mcp; a transport pointed at /nope gets its upgrade declined +
		// the socket destroyed, so the client handshake (start, run by connect) rejects.
		const handle = await startWs()
		const client = createMCPClient({
			transport: createWebSocketClientTransport({ url: `${handle.base}/nope` }),
		})
		// The declined upgrade rejects start() — the underlying socket is destroyed, so the
		// failure is a connection-level Error (a socket hang-up), surfaced by the handshake.
		await expect(client.connect()).rejects.toThrow(Error)
		expect(client.connected).toBe(false)
	})

	it('reaches a custom upgrade path when configured on both ends', async () => {
		const handle = await startWs('/rpc')
		const client = createMCPClient({
			transport: createWebSocketClientTransport({ url: `${handle.base}/rpc` }),
		})
		await client.connect()
		expect(await client.call('add', {})).toEqual({ resultType: 'complete', value: 5 })
		await client.disconnect()
	})

	it('the transport session is undefined for the stateless v1', async () => {
		const handle = await startWs()
		const transport = createWebSocketClientTransport({ url: `${handle.base}/mcp` })
		const client = createMCPClient({ transport })
		await client.connect()
		expect(transport.session).toBeUndefined()
		await client.disconnect()
	})

	// ── D2: `start()` re-asks after the suspension ───────────────────────────
	//
	// `start()` guards on `#socket === undefined`, then SUSPENDS across a real TCP connect and
	// HTTP upgrade before installing the socket it built. Every state it checked is stale by the
	// time the upgrade arrives: a second `start()` has run the same guard, or `close()` has ended
	// the transport. The observable is the peer's own tally — an upgraded socket nobody owns is
	// never closed by anyone, so it stays open forever, and that is exactly what an orphan is.

	it('two concurrent start()s bind one socket and orphan none', async () => {
		// The handshake is held open, so both upgrades are genuinely in flight at the same time
		// and both `start()` calls have already passed the `#socket === undefined` guard.
		const peer = await startUpgradeServer({ delay: 25 })
		teardown.add(() => peer.stop())
		const transport = createWebSocketClientTransport({ url: `${peer.base}/mcp` })

		await Promise.all([transport.start(), transport.start()])
		expect(peer.count).toBe(2) // the peer really did upgrade twice — the race happened

		await transport.close()
		await waitForDelay(60)
		// `close()` can only close the socket the transport HOLDS. Zero still open means the
		// loser was destroyed the moment it arrived; one means it is bound, live, and unreachable.
		expect(peer.open).toBe(0)
	})

	// The control, from OUTSIDE the population the row above covers: a SINGLE `start()`, which
	// must still install exactly one live socket. An instrument that only ever races two starts
	// cannot tell "re-asked correctly" from "never installs anything".
	it('a single start() still installs one live socket', async () => {
		const peer = await startUpgradeServer()
		teardown.add(() => peer.stop())
		const transport = createWebSocketClientTransport({ url: `${peer.base}/mcp` })

		await transport.start()
		await waitForDelay(20)
		expect(peer.count).toBe(1)
		expect(peer.open).toBe(1) // BOUND and live — not destroyed by an over-eager re-ask

		await transport.close()
		await waitForDelay(60)
		expect(peer.open).toBe(0)
	})

	it('ignores the old socket close after a new socket has replaced it', async () => {
		const handle = await startWs()
		const transport = createWebSocketClientTransport({ url: `${handle.base}/mcp` })
		const messages: JSONRPCMessage[] = []
		let closed = 0
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('close', () => (closed += 1))
		await transport.start()

		await transport.close()
		await transport.start()
		await waitForDelay(60)

		expect(closed).toBe(1)
		// `server/discover` is the canary because it is the modern era's own required RPC.
		// 2026-07-28 removes `ping`, so the reply that proves the replacement socket carries
		// traffic has to be one the bare server still answers.
		await transport.send({
			jsonrpc: '2.0',
			method: 'server/discover',
			id: 2,
			params: { _meta: MODERN_METADATA },
		})
		await waitForDelay(60)
		expect(messages).toEqual([
			{
				jsonrpc: '2.0',
				id: 2,
				result: {
					resultType: 'complete',
					supportedVersions: [MCP_MODERN_VERSION],
					capabilities: { tools: {} },
					ttlMs: DEFAULT_MCP_CACHE_TTL,
					cacheScope: 'private',
					_meta: {
						[MCP_META_SERVER]: { name: 'calculator', version: '1.0.0' },
					},
				},
			},
		])
		await transport.close()
	})

	it('a socket that is never restarted still fires close exactly once', async () => {
		const handle = await startWs()
		const transport = createWebSocketClientTransport({ url: `${handle.base}/mcp` })
		let closed = 0
		transport.emitter.on('close', () => (closed += 1))
		await transport.start()

		await transport.close()
		await waitForDelay(60)

		expect(closed).toBe(1)
	})

	it('close() during a suspended start() leaves no bound socket and re-emits nothing', async () => {
		// The peer appends one well-formed JSON-RPC text frame to the handshake, so a socket the
		// transport BOUND re-emits it on `message`; one it never bound cannot.
		const peer = await startUpgradeServer({
			delay: 60,
			frame: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
		})
		teardown.add(() => peer.stop())
		const transport = createWebSocketClientTransport({ url: `${peer.base}/mcp` })
		const received: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => received.push(message))

		const starting = transport.start()
		// Wait for the upgrade to REACH the peer, so the close lands on a handshake in progress
		// rather than on a connection that was never made.
		await waitForDelay(20)
		await transport.close() // while the upgrade is still on the wire
		await starting
		await waitForDelay(120)

		expect(peer.count).toBe(1) // the upgrade DID reach the peer — the vector reached the code
		expect(peer.open).toBe(0) // and nothing was left holding that connection open
		expect(received).toEqual([]) // a socket that was never bound re-emits nothing
		await expect(transport.send({ jsonrpc: '2.0', id: 2, method: 'ping' })).rejects.toThrow(
			/not connected/,
		)
	})

	it('binds exactly one socket when two start() calls race, destroying the loser', async () => {
		// Both handshakes complete; the second socket to arrive finds one already installed and
		// is destroyed rather than bound, so no orphan is left re-emitting frames at nobody.
		const peer = await startUpgradeServer()
		teardown.add(() => peer.stop())
		const transport = createWebSocketClientTransport({ url: `${peer.base}/mcp` })

		await Promise.all([transport.start(), transport.start()])
		await waitForDelay(60)

		expect(peer.count).toBe(2) // two upgrades were answered
		expect(peer.open).toBe(1) // exactly one socket survives — the bound one
		await transport.close()
		await waitForDelay(60)
		expect(peer.open).toBe(0)
	})

	it('rejects start() when the server returns a 101 with a bogus Sec-WebSocket-Accept', async () => {
		// The server answers a structurally-valid 101 but with `Sec-WebSocket-Accept: wrong` — the
		// handshake-accept check (accept === computeWebSocketAccept(key)) must FAIL, so start()
		// rejects and the socket is destroyed. This PINS that security check: without it (or with a
		// broken compare) the bogus accept would be silently accepted and this would hang/pass-green.
		const base = await startBogusAcceptServer()
		const transport = createWebSocketClientTransport({ url: `${base}/mcp` })
		await expect(transport.start()).rejects.toThrow(/Sec-WebSocket-Accept mismatch/)
		// The happy-path connect (a CORRECT accept → start() resolves) is the control, already
		// proven by the round-trip tests above against the real createWebSocketServer.
	})
})

// A raw peer that answers the upgrade with a real `101` and then HOLDS the socket, so the
// test decides when a frame reaches the client. `send` writes one unmasked text frame (the
// server-to-client direction, RFC 6455 §5.3), which is how a frame still on the wire when a
// client closes is reproduced deterministically.
interface HoldingPeerInterface {
	readonly base: string
	send(text: string): void
	stop(): Promise<void>
}

async function startHoldingPeer(): Promise<HoldingPeerInterface> {
	const sockets: Duplex[] = []
	const server = createHTTPServer()
	teardown.add(
		() =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy()
				if (!server.listening) resolve()
				else server.close(() => resolve())
			}),
	)
	server.on('upgrade', (request, socket) => {
		const key = request.headers['sec-websocket-key']
		if (typeof key !== 'string') {
			socket.destroy()
			return
		}
		sockets.push(socket)
		// The client destroys its half on close, so this end reads an ECONNRESET — an expected
		// outcome of the path under test, never an uncaught 'error'.
		socket.on('error', () => {})
		socket.resume()
		socket.write(
			'HTTP/1.1 101 Switching Protocols\r\n' +
				'Upgrade: websocket\r\n' +
				'Connection: Upgrade\r\n' +
				`Sec-WebSocket-Accept: ${computeWebSocketAccept(key)}\r\n\r\n`,
		)
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address: unknown = server.address()
	const port = isRecord(address) && typeof address.port === 'number' ? address.port : 0
	return {
		base: `http://127.0.0.1:${port}`,
		send(text: string): void {
			for (const socket of sockets) {
				socket.write(encodeWebSocketFrame(WEBSOCKET_OPCODE_TEXT, text))
			}
		},
		stop(): Promise<void> {
			return new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy()
				server.close(() => resolve())
			})
		},
	}
}

// A raw peer that answers the upgrade with a real `101` and an unmasked close frame in ONE
// write, so the close arrives in the handshake `head` the client hands `createNodeWebSocket`.
// The wrapper decodes that head inside its own constructor — before the transport has bound a
// single listener — so the socket the transport installs is already past OPEN and its `close`
// has already fired at nobody. That is the state where the transport's own flag knows nothing
// and the socket's `readyState` is the only source that does.
async function startClosingPeer(): Promise<string> {
	const sockets: Duplex[] = []
	const server = createHTTPServer()
	teardown.add(
		() =>
			new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy()
				if (!server.listening) resolve()
				else server.close(() => resolve())
			}),
	)
	server.on('upgrade', (request, socket) => {
		const key = request.headers['sec-websocket-key']
		if (typeof key !== 'string') {
			socket.destroy()
			return
		}
		sockets.push(socket)
		// The client half-closes when it processes the close frame, so this end reads an end /
		// reset that is the expected outcome of the path under test, never an uncaught 'error'.
		socket.on('error', () => {})
		socket.resume()
		socket.write(
			Buffer.concat([
				Buffer.from(
					'HTTP/1.1 101 Switching Protocols\r\n' +
						'Upgrade: websocket\r\n' +
						'Connection: Upgrade\r\n' +
						`Sec-WebSocket-Accept: ${computeWebSocketAccept(key)}\r\n\r\n`,
				),
				encodeWebSocketFrame(WEBSOCKET_OPCODE_CLOSE, Buffer.alloc(0)),
			]),
		)
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const address: unknown = server.address()
	const port = isRecord(address) && typeof address.port === 'number' ? address.port : 0
	return `http://127.0.0.1:${port}`
}

describe('WebSocketClientTransport — close releases what the connect acquired', () => {
	it('close() during a pending upgrade cancels the request instead of waiting for the peer', async () => {
		// The peer holds the handshake for 400ms, so an upgrade this transport cannot cancel
		// leaves `start()` suspended for the peer's whole delay.
		const peer = await startUpgradeServer({ delay: 400 })
		teardown.add(() => peer.stop())
		const transport = createWebSocketClientTransport({ url: `${peer.base}/mcp` })
		const starting = transport.start()
		await waitForDelay(30)

		await transport.close()

		// A cancelled upgrade settles `start()` well before the peer answers; an uncancellable
		// one settles only when the 101 finally arrives.
		await expect(
			Promise.race([
				starting.then(() => 'settled').catch(() => 'settled'),
				waitForDelay(120).then(() => 'pending'),
			]),
		).resolves.toBe('settled')
		expect(peer.count).toBe(1) // the upgrade reached the peer
		expect(peer.open).toBe(0) // and the socket carrying it is gone
	})

	it('rejects a send issued after close() as not connected', async () => {
		const handle = await startWs()
		const transport = createWebSocketClientTransport({ url: `${handle.base}/mcp` })
		await transport.start()

		// The control, from the state this assertion is NOT about: while the socket is bound the
		// same call resolves against the real shipped server, so the rejection below reports the
		// closed state rather than a `send` that never worked.
		await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).resolves.toBeUndefined()

		await transport.close()

		// `MCPClientTransportInterface.send` has a channel that cannot confirm a write answer a
		// closed channel from its own state. This transport's state is the released socket and its
		// answer is a REJECTION — not the browser face's silent drop, and not a queue that would
		// hold the message for a connection this transport can no longer open.
		await expect(transport.send({ jsonrpc: '2.0', id: 2, method: 'ping' })).rejects.toThrow(
			'WebSocket transport is not connected',
		)
	})

	it('rejects a send on a bound socket the peer already closed, and writes no frame', async () => {
		// `#socket === undefined` cannot answer this state: the socket IS bound. The peer's close
		// was decoded inside `createNodeWebSocket`, so this transport's `close` never fired and its
		// own flag is clear — the wrapper's `readyState` is the SECOND source that knows the
		// channel is gone, the same reading the server-side carrier makes. Without it the wrapper
		// drops the write, reports nothing, and this `send` resolves on a frame nobody wrote.
		const base = await startClosingPeer()
		const transport = createWebSocketClientTransport({ url: `${base}/mcp` })
		let closed = 0
		transport.emitter.on('close', () => (closed += 1))

		await transport.start()

		expect(closed).toBe(0) // the transport learned nothing — the state is the socket's alone
		await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow(
			'WebSocket transport is not connected',
		)
		// The control from the state this row is NOT about — a bound, OPEN socket resolving the
		// same call — is the first assertion of the preceding row, against the real shipped server.
	})

	it('rejects a send issued before start(), where the browser face queues one', async () => {
		// The faces diverge here, and the guide says so: the browser face holds a pre-open send
		// and flushes it when its socket opens, while this one holds no connection to flush a
		// message onto and refuses rather than promising a write it cannot schedule.
		const handle = await startWs()
		const transport = createWebSocketClientTransport({ url: `${handle.base}/mcp` })

		await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow(
			'WebSocket transport is not connected',
		)

		// The control: the same call on the same transport resolves once `start()` has bound a
		// socket, so the refusal reports the missing connection rather than a `send` that never
		// works, and nothing the refusal held is flushed onto the socket that follows.
		const messages: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		await transport.start()
		await expect(
			transport.send({
				jsonrpc: '2.0',
				method: 'server/discover',
				id: 2,
				params: { _meta: MODERN_METADATA },
			}),
		).resolves.toBeUndefined()
		await waitForDelay(60)

		expect(messages.map((message) => message.id)).toEqual([2])
		await transport.close()
	})

	it('close() releases the socket subscriptions — a later frame emits nothing', async () => {
		const peer = await startHoldingPeer()
		const transport = createWebSocketClientTransport({ url: `${peer.base}/mcp` })
		const messages: JSONRPCMessage[] = []
		const errors: unknown[] = []
		transport.emitter.on('message', (message) => messages.push(message))
		transport.emitter.on('error', (error) => errors.push(error))
		await transport.start()

		// Control: while the transport is open the peer's frame reaches it.
		peer.send(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
		await waitForDelay(40)
		expect(messages).toHaveLength(1)

		await transport.close()
		// The peer has not answered the close frame, so this one is still decodable wire.
		peer.send(JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} }))
		await waitForDelay(40)

		expect(messages).toHaveLength(1)
		expect(errors).toEqual([])
	})
})
