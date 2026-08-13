import type { JSONRPCMessage } from '@src/core'
import type { StartedServerInterface, TestUpgradeInterface } from '../../../setupServer.js'
import type { Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { createServer as createHTTPServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createMCPClient, MCP_META_SERVER } from '@src/core'
import { isRecord } from '@orkestrel/contract'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { createWebSocketClientTransport, createWebSocketServer } from '@src/server'
import { waitForDelay } from '@orkestrel/test'
import { createCalculatorServer, MODERN_METADATA } from '../../../setup.js'
import { createTeardown, startServer, startUpgradeServer } from '../../../setupServer.js'

// src/server/mcp/WebSocketClientTransport.ts — the WebSocket CLIENT transport (the egress
// mirror of createWebSocketServer), proven END TO END against the shipped createWebSocketServer
// over a REAL `node:http` server + a REAL MCPServer over a real ToolManager (stub tools, NO live
// model — AGENTS §16). The contract the assertions pin down: `start()` performs the RFC 6455
// handshake (validating the Sec-WebSocket-Accept) and opens a persistent frame channel; an
// MCPClient over it connects + discovers + calls the remote tools over real WS frames; a remote
// tool failure → a local throw; a `ws://` and an `http://` url both reach the endpoint; an
// upgrade declined by the server → `connect()` rejects; `session` is undefined for the stateless
// v1; and `disconnect()` closes cleanly. The per-connection bridge + frame decode/drop are pinned
// at the unit level in WebSocketServerTransport.test.ts (the same MCPClientTransportInterface).

const teardown = createTeardown<StartedServerInterface>((handle) => handle.stop())

// A raw `node:http` server plus the upgraded sockets it claimed — tracked together so teardown
// can DESTROY each lingering upgrade socket before closing the server.
interface RawServerHandle {
	readonly server: Server
	readonly sockets: Duplex[]
}

// A second registrar for the RAW `node:http` server the bogus-handshake test stands up (it
// writes a malformed 101 by hand, so it cannot be a spine `Server`). Closed in `afterEach` —
// an UPGRADED socket is detached from the server's tracked-connection set, so neither `close`'s
// drain nor `closeAllConnections()` reaches it; destroy each captured socket FIRST, then `close`
// (whose callback now fires promptly, since no connection remains).
// A third registrar for the raw upgrade RECORDER the D2 rows drive (rows 23-24): it completes
// real handshakes and tallies the sockets it upgraded, so it owns its own `stop`.
const upgradeTeardown = createTeardown<TestUpgradeInterface>((peer) => peer.stop())

const rawTeardown = createTeardown<RawServerHandle>(
	({ server, sockets }) =>
		new Promise<void>((resolve) => {
			for (const socket of sockets) socket.destroy()
			server.close(() => resolve())
		}),
)

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
	return teardown.track(await startServer(server))
}

// Stand up a RAW `node:http` server that ANSWERS the upgrade with a structurally-valid 101
// (right `Upgrade` / `Connection` headers) but a BOGUS `Sec-WebSocket-Accept` — so the client's
// `start()` reaches the accept-validation branch and must reject on the mismatch (the security
// check is otherwise vacuously covered: the happy path never feeds a wrong accept). Returns the
// bound `http://…` base; tracked for `afterEach` close.
async function startBogusAcceptServer(): Promise<string> {
	const server = createHTTPServer()
	const sockets: Duplex[] = []
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
	rawTeardown.track({ server, sockets })
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

	// ── W05-B rows 23-24 — D2: `start()` re-asks after the suspension ──────────
	//
	// `start()` guards on `#socket === undefined`, then SUSPENDS across a real TCP connect and
	// HTTP upgrade before installing the socket it built. Every state it checked is stale by the
	// time the upgrade arrives: a second `start()` has run the same guard, or `close()` has ended
	// the transport. The observable is the peer's own tally — an upgraded socket nobody owns is
	// never closed by anyone, so it stays open forever, and that is exactly what an orphan is.

	it('two concurrent start()s bind one socket and orphan none (row 23)', async () => {
		// The handshake is held open, so both upgrades are genuinely in flight at the same time
		// and both `start()` calls have already passed the `#socket === undefined` guard.
		const peer = upgradeTeardown.track(await startUpgradeServer({ delay: 25 }))
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
		const peer = upgradeTeardown.track(await startUpgradeServer())
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
		await transport.send({
			jsonrpc: '2.0',
			method: 'ping',
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

	it('close() during a suspended start() destroys the arriving socket and re-emits nothing (row 24)', async () => {
		// The peer appends one well-formed JSON-RPC text frame to the handshake, so a socket the
		// transport BOUND re-emits it on `message`; a destroyed one cannot.
		const peer = upgradeTeardown.track(
			await startUpgradeServer({
				delay: 25,
				frame: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
			}),
		)
		const transport = createWebSocketClientTransport({ url: `${peer.base}/mcp` })
		const received: JSONRPCMessage[] = []
		transport.emitter.on('message', (message) => received.push(message))

		const starting = transport.start()
		await transport.close() // while the upgrade is still on the wire
		await starting
		await waitForDelay(60)

		expect(peer.count).toBe(1) // the upgrade DID complete — the vector reached the code
		expect(peer.open).toBe(0) // and the socket nobody wanted was destroyed
		expect(received).toEqual([]) // a socket that was never bound re-emits nothing
		await expect(transport.send({ jsonrpc: '2.0', id: 2, method: 'ping' })).rejects.toThrow(
			/not connected/,
		)
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
