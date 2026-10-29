import type { MiddlewareHandler } from '@orkestrel/server'
import { FACE, SOURCES } from './setupServer.js'
import {
	buildInputContext,
	respondFixtureOK,
	alignLoopClock,
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
	readLoopClock,
	startServer,
	startUpgradeServer,
	upgradeRequest,
	buildConformanceCompletion,
	buildConformanceInput,
	buildConformanceMessages,
	buildConformanceOptions,
	buildConformanceRound,
	buildConformanceTools,
	CONFORMANCE_AUTH,
	CONFORMANCE_CANDIDATES,
	CONFORMANCE_CLIENT_SCENARIOS,
	CONFORMANCE_CONTENT,
	CONFORMANCE_CONTENTS,
	CONFORMANCE_DESCRIPTOR,
	CONFORMANCE_ENTRY,
	CONFORMANCE_IDENTIFIERS,
	CONFORMANCE_IDENTITY,
	CONFORMANCE_PACKAGE,
	CONFORMANCE_PROMPTS,
	CONFORMANCE_REQUESTS,
	CONFORMANCE_RESOURCES,
	CONFORMANCE_ROUNDS,
	CONFORMANCE_SPEC,
	CONFORMANCE_TEMPLATE,
	executeConformance,
	executeRunner,
	parseConformance,
	parseConformanceClients,
	parseConformanceOutcome,
	readConformanceAnswers,
	readConformanceTemplate,
	readConformanceRelease,
	resolveConformanceDriver,
	resolveConformanceRunner,
	startConformance,
} from './setupServer.js'
import { describe, expect, it } from 'vitest'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { encodeWebSocketFrame, WEBSOCKET_OPCODE_TEXT } from '@orkestrel/websocket'
import { upgradeRequestPath } from '@src/server'
import { waitForDelay, createRecorder } from '@orkestrel/test'
import {
	createMCPClient,
	createMCPServer,
	MCP_META_SERVER,
	MCP_METHOD_HEADER,
	MCP_MODERN_VERSION,
	MCP_PROTOCOL_VERSION_HEADER,
} from '@src/core'
import {
	createCalculatorServer,
	createLoopbackTransport,
	createManualClock,
	waitForSettlement,
	createHostilePeer,
	createJSONRPCRequest,
	MODERN_METADATA,
	modernRequest,
	postJSON,
} from './setup.js'
import { isRecord } from '@orkestrel/contract'
import { existsSync } from 'node:fs'
import { normalize, resolve } from 'node:path'

// Proof of `tests/setupServer.ts` — the Node-only harnesses the server suites are driven over.
//
// Every case here uses the real resource the helper exists to provide: real host timers measured
// on `performance.now()`, real `node:stream` duplexes, real listeners on `127.0.0.1` ephemeral
// ports, real RFC 6455 handshakes, and a real `@orkestrel/guide` source view. Nothing is
// simulated, because a harness that only works against a simulation is a harness that proves
// nothing about the suites it carries.
//
// `findMissingNamedImports` also has a fence-grammar battery in `tests/guides.test.ts`, which is
// the suite that consumes it; what it owns here is its boundary — which specifier is checked
// against a face, which one is refused, and which one is skipped.

// A real `@orkestrel/guide` source view over a two-module package: `parse` is reachable from the
// barrel and `hidden` is not, so a fence importing either is checked against a genuine face.

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
		dispatcher.add({ method: 'GET', path: '/', name: 'root', handler: respondFixtureOK })
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
		dispatcher.add({ method: 'GET', path: '/', name: 'root', handler: respondFixtureOK })
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
		dispatcher.add({ method: 'GET', path: '/', name: 'root', handler: respondFixtureOK })
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
		dispatcher.add({ method: 'GET', path: '/', name: 'root', handler: respondFixtureOK })
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

describe('readLoopClock', () => {
	it('advances in whole milliseconds by the time performance.now() measures between readings', () => {
		const opened = performance.now()
		const before = readLoopClock()
		const inner = performance.now()
		alignLoopClock(5)
		const outer = performance.now()
		const after = readLoopClock()
		const closed = performance.now()
		expect(Number.isInteger(before)).toBe(true)
		expect(Number.isInteger(after)).toBe(true)
		// Each reading truncates by under 1 ms and a coarse clock trails by under 1 ms more.
		expect(after - before).toBeGreaterThan(outer - inner - 2)
		expect(after - before).toBeLessThan(closed - opened + 2)
	})
})

describe('alignLoopClock', () => {
	it('returns after the loop clock ticks and the offset elapses on performance.now()', () => {
		const before = readLoopClock()
		const opened = performance.now()
		alignLoopClock(0.5)
		const closed = performance.now()
		expect(readLoopClock()).toBeGreaterThan(before)
		expect(closed - opened).toBeGreaterThanOrEqual(0.5)
	})
})

// Proof of `tests/setupServer.ts` — the host fixture the foreign runner drives, and the
// runner harness itself.
//
// The pinned runner is a development dependency already on disk, so every claim about it is
// settled by running it rather than by describing it: the version it reports is compared against
// the manifest pin, and the summary parser is fed a real run's output. The live pass over a
// running fixture is `tests/conformance.test.ts`; what this file owns is what the fixture and
// the harness promise before that pass starts.

// One selector context for one named tool at one point in its walk. The state is the only
// thing `buildConformanceInput` reads besides the name, so the request and the arguments stay
// the same inert values at every round.

describe('the pinned runner', () => {
	it('resolves the installed entry and reports the release the manifest pins', async () => {
		const release = readConformanceRelease()
		const entry = resolveConformanceRunner()

		expect(CONFORMANCE_ENTRY).toBe(`${CONFORMANCE_PACKAGE}/dist/index.js`)
		expect(entry).toContain(normalize(CONFORMANCE_PACKAGE))
		// The manifest is the single authority for the version, and the build on disk is what
		// actually runs, so the pin is checked against what that build says about itself.
		expect((await executeRunner(['--version'])).trim()).toBe(release)
	})

	it('parses a real run of that runner against an endpoint nothing serves', async () => {
		const result = await executeConformance('http://127.0.0.1:1/mcp')

		expect(result.scenarios.length).toBeGreaterThan(0)
		// Almost nothing passes without a server, but not nothing: `sep-2164-resource-not-found`
		// reads a refused connection as a resource that is not there. So the claim is the
		// relationship a live fixture reverses, not a zero the runner's scenario set can move.
		expect(result.failed).toBeGreaterThan(result.passed)
		// The totals line and the scenario lines are separate parses of separate text, so their
		// agreement is a property of the parse rather than of one pattern.
		expect(result.scenarios.reduce((total, scenario) => total + scenario.failed, 0)).toBe(
			result.failed,
		)
		expect(result.scenarios.reduce((total, scenario) => total + scenario.passed, 0)).toBe(
			result.passed,
		)
	})

	it('throws with everything the runner wrote when it printed no summary', async () => {
		// A rejected `--url` makes the real runner exit before any summary block.
		await expect(executeConformance('not-a-url')).rejects.toThrow(CONFORMANCE_PACKAGE)
		await expect(executeConformance('not-a-url')).rejects.toThrow('Invalid server URL')
	})
})

describe('parseConformance', () => {
	it('reads each tally and the closing total out of a summary block', () => {
		const output = [
			'running scenarios',
			'=== SUMMARY ===',
			'✓ ping: 3 passed, 0 failed',
			'✗ tools-list: 1 passed, 2 failed',
			'Total: 4 passed, 2 failed',
			'✓ ignored-after-the-total: 9 passed, 9 failed',
		].join('\n')

		expect(parseConformance(output)).toEqual({
			scenarios: [
				{ name: 'ping', passed: 3, failed: 0 },
				{ name: 'tools-list', passed: 1, failed: 2 },
			],
			passed: 4,
			failed: 2,
		})
	})

	it('answers undefined when the runner printed no total', () => {
		expect(parseConformance('✓ ping: 3 passed, 0 failed')).toBeUndefined()
		expect(parseConformance('')).toBeUndefined()
		expect(parseConformance('Total: some passed, none failed')).toBeUndefined()
	})
})

describe('the client under test', () => {
	it('composes a command whose every token the runner can carry', () => {
		const command = resolveConformanceDriver()
		const tokens = command.split(' ')
		const driver = tokens.at(-1) ?? ''

		// The runner splits `--command` on spaces and appends the scenario URL, so the split is
		// the contract this command has to survive. Reading the driver back off the split is
		// what proves the path token stayed whole.
		expect(tokens[0]).toBe('node')
		expect(driver).toMatch(/(?:^|\/)tests\/fixtures\/conformanceClient\.ts$/)
		// The path is relative to the working directory, which is the runner's own, so it is
		// resolved against that directory on this host rather than assumed to be portable text.
		expect(existsSync(resolve(process.cwd(), driver))).toBe(true)
	})

	it('excludes the runner OAuth family from the recorded scenario set', () => {
		// The exclusion is the reason this set is written down rather than derived, so it is
		// proved here rather than left to the comment beside the constant.
		expect(
			CONFORMANCE_CLIENT_SCENARIOS.filter((name) => name.startsWith(CONFORMANCE_AUTH)),
		).toEqual([])
		expect(new Set(CONFORMANCE_CLIENT_SCENARIOS).size).toBe(CONFORMANCE_CLIENT_SCENARIOS.length)
	})
})

describe('parseConformanceOutcome', () => {
	it('reads the counts out of a client-mode result block', () => {
		const output = ['Checks:', 'Test Results:', 'Passed: 3/18, 15 failed, 2 warnings'].join('\n')

		expect(parseConformanceOutcome('http-custom-headers', output)).toEqual({
			name: 'http-custom-headers',
			passed: 3,
			failed: 15,
			warnings: 2,
		})
	})

	it('answers undefined when the runner printed no result block', () => {
		expect(parseConformanceOutcome('tools_call', '')).toBeUndefined()
		// The server mode's own total line is close enough in wording to reach the same parse if
		// the pattern were loose, so it is the control this parser has to refuse.
		expect(parseConformanceOutcome('tools_call', 'Total: 4 passed, 2 failed')).toBeUndefined()
		expect(parseConformanceOutcome('tools_call', 'Passed: 3/18, 15 failed')).toBeUndefined()
	})
})

describe('parseConformanceClients', () => {
	it('reads the client section alone out of a listing', () => {
		const output = [
			'Server scenarios (test against a server):',
			'  - tools-list [2026-07-28]',
			'',
			'Client scenarios (test against a client):',
			'  - tools_call [2025-06-18,2026-07-28]',
			'  - auth/metadata-default [2026-07-28]',
			'',
			'Authorization server scenarios (test against an authorization server):',
			'  - authorization-code-grant [2026-07-28]',
		].join('\n')

		expect(parseConformanceClients(output)).toEqual(['tools_call', 'auth/metadata-default'])
	})

	it('answers an empty set when the listing names no client section', () => {
		expect(parseConformanceClients('Server scenarios:\n  - tools-list [2026-07-28]')).toEqual([])
		expect(parseConformanceClients('')).toEqual([])
	})

	it('reads a real listing the same way it reads the fixture', async () => {
		const names = parseConformanceClients(
			await executeRunner(['list', '--spec-version', CONFORMANCE_SPEC]),
		)

		// The fixture proves the section boundary; this proves the pattern still matches what the
		// installed runner actually prints, which is the half a fixture can never settle.
		expect(names).toContain('tools_call')
		expect(names).not.toContain('tools-list')
		for (const scenario of CONFORMANCE_CLIENT_SCENARIOS) expect(names).toContain(scenario)
	})
})

describe('the fixture registries', () => {
	it('registers every tool the scenarios call, including the one that throws', async () => {
		const tools = buildConformanceTools()

		expect(tools.tools().map((tool) => tool.name)).toEqual([
			'test_simple_text',
			'test_image_content',
			'test_multiple_content_types',
			'test_audio_content',
			'test_embedded_resource',
			'test_error_handling',
			'test_tool_with_progress',
			'test_header_parameter',
			'json_schema_2020_12_tool',
			'test_input_required_result_elicitation',
			'test_input_required_result_sampling',
			'test_input_required_result_list_roots',
			'test_input_required_result_request_state',
			'test_input_required_result_multiple_inputs',
			'test_input_required_result_multi_round',
			'test_input_required_result_tampered_state',
			'test_input_required_result_capabilities',
			'test_missing_capability',
		])
		// SEP-2575 validates the -32021 refusal only against a tool the server LISTS, so this one
		// is listed and never runs: its round asks for a capability the probing call never declares.
		expect(tools.tool('test_missing_capability')).toBeDefined()
		// Every name the verbatim content table keys is a registered tool, so no row of that
		// table describes a tool the runner can never reach.
		for (const name of Object.keys(CONFORMANCE_CONTENT)) expect(tools.tool(name)).toBeDefined()
		const outcome = await tools.execute({ id: 'call-1', name: 'test_simple_text', arguments: {} })
		expect(outcome.success ? outcome.value : undefined).toBe(
			'This is a simple text response for testing.',
		)
		const failed = await tools.execute({ id: 'call-2', name: 'test_error_handling', arguments: {} })
		// The scenario suite needs a tool that fails, so the registry carries one that throws.
		expect(failed.success).toBe(false)
	})

	it('resolves a substituted template URI and refuses a sibling', () => {
		const identifier = CONFORMANCE_IDENTIFIERS[0] ?? ''
		const contents = readConformanceTemplate(`test://template/${identifier}/data`)

		expect(contents).toEqual([
			{
				uri: `test://template/${identifier}/data`,
				mimeType: 'application/json',
				text: JSON.stringify({
					id: identifier,
					templateTest: true,
					data: `Data for ID: ${identifier}`,
				}),
			},
		])
		expect(readConformanceTemplate(`test://template/${identifier}/other`)).toBeUndefined()
		expect(readConformanceTemplate('test://template//data')).toBeUndefined()
		expect(readConformanceTemplate('test://static-text')).toBeUndefined()
		// The descriptor is the published form of the same rule, so substituting it produces a
		// URI the matcher accepts.
		expect(CONFORMANCE_TEMPLATE.test(CONFORMANCE_DESCRIPTOR.replace('{id}', identifier))).toBe(true)
		// The static resources are a separate population, matched by the contents table alone.
		expect(
			CONFORMANCE_RESOURCES.map((resource) => ({
				uri: resource.uri,
				served: CONFORMANCE_CONTENTS[resource.uri] !== undefined,
				templated: readConformanceTemplate(resource.uri) !== undefined,
			})),
		).toEqual(
			CONFORMANCE_RESOURCES.map((resource) => ({
				uri: resource.uri,
				served: true,
				templated: false,
			})),
		)
	})

	it('fills every advertised prompt and refuses a name this host does not own', () => {
		const filledNames = CONFORMANCE_PROMPTS.filter((prompt) => {
			const values = Object.fromEntries(
				(prompt.arguments ?? []).map((argument) => [argument.name, `value-${argument.name}`]),
			)
			return (buildConformanceMessages(prompt.name, values)?.length ?? 0) > 0
		})

		// Every prompt the fixture advertises fills, so `prompts/list` names none the host
		// answers `undefined` for.
		expect(filledNames.map((prompt) => prompt.name)).toEqual(
			CONFORMANCE_PROMPTS.map((prompt) => prompt.name),
		)
		expect(buildConformanceMessages('test_prompt_nobody_advertised', {})).toBeUndefined()

		const filled = buildConformanceMessages('test_prompt_with_arguments', {
			arg1: 'alpha',
			arg2: 'beta',
		})
		const content = filled?.[0]?.content
		// The host owns the substitution, so the caller's arguments reach the message text.
		expect(content?.type === 'text' ? content.text : '').toContain("arg1='alpha', arg2='beta'")
	})

	it('projects candidates onto the typed fragment and keeps a list for every argument', () => {
		expect(buildConformanceCompletion(['testValue1', 'testAlpha', 'production'], 'test')).toEqual({
			values: ['testValue1', 'testAlpha'],
			total: 3,
		})
		// The total is the UNPROJECTED count, which is what a client pages against.
		expect(buildConformanceCompletion(['testValue1'], 'nothing-matches')).toEqual({
			values: [],
			total: 1,
		})
		expect(buildConformanceCompletion([], '')).toEqual({ values: [], total: 0 })

		const declared = CONFORMANCE_PROMPTS.flatMap((prompt) =>
			(prompt.arguments ?? []).map((argument) => `${prompt.name}.${argument.name}`),
		)
		const completable = CONFORMANCE_PROMPTS.flatMap((prompt) =>
			(prompt.arguments ?? [])
				.filter((argument) => CONFORMANCE_CANDIDATES[prompt.name]?.[argument.name] !== undefined)
				.map((argument) => `${prompt.name}.${argument.name}`),
		)

		// Every argument a prompt declares has candidates, so the completion port answers each
		// reference the runner can ask about.
		expect(completable).toEqual(declared)
		expect(CONFORMANCE_CANDIDATES['test_prompt_with_embedded_resource']?.['resourceUri']).toEqual(
			CONFORMANCE_RESOURCES.map((resource) => resource.uri),
		)
	})

	it('walks each tool’s rounds by the state the previous round carried', () => {
		const walked = buildConformanceInput(
			buildInputContext('test_input_required_result_multi_round'),
		)
		const next = buildConformanceInput(
			buildInputContext('test_input_required_result_multi_round', 0),
		)

		expect(walked).toEqual({
			requests: CONFORMANCE_ROUNDS['test_input_required_result_multi_round']?.[0],
			state: 0,
		})
		expect(next).toEqual({
			requests: CONFORMANCE_ROUNDS['test_input_required_result_multi_round']?.[1],
			state: 1,
		})
		// The rounds run out rather than repeating, which is how the tool finally executes.
		expect(
			buildConformanceInput(buildInputContext('test_input_required_result_multi_round', 1)),
		).toBeUndefined()
		// A tool absent from the table owes this host nothing at any state.
		expect(buildConformanceInput(buildInputContext('test_simple_text'))).toBeUndefined()
		expect(buildConformanceInput(buildInputContext('test_simple_text', 0))).toBeUndefined()
	})

	it('asks only for sampling wherever the scenario declares only sampling', () => {
		const gated = ['test_input_required_result_capabilities', 'test_missing_capability']
		const methods = gated.map((name) =>
			(CONFORMANCE_ROUNDS[name] ?? []).flatMap((round) =>
				Object.values(round).map((request) => request.method),
			),
		)

		expect(methods).toEqual([['sampling/createMessage'], ['sampling/createMessage']])
		// Every round the table declares is answerable: an empty one would seal state no retry
		// could satisfy, and the library refuses it.
		for (const rounds of Object.values(CONFORMANCE_ROUNDS)) {
			for (const round of rounds) expect(Object.keys(round).length).toBeGreaterThan(0)
		}
	})

	it('projects only the accepted string answers a verified retry carried', () => {
		expect(
			readConformanceAnswers({
				user_name: { action: 'accept', content: { context: 'alpha', count: 2 } },
				declined: { action: 'decline' },
				sampled: { role: 'assistant', content: { type: 'text', text: 'ignored' } },
			}),
		).toEqual({ context: 'alpha' })
		expect(readConformanceAnswers(undefined)).toEqual({})
		expect(readConformanceAnswers({})).toEqual({})
	})

	it('re-issues the prompt round until its own sealed carrier comes back', async () => {
		const issued = await buildConformanceRound({ name: 'test_input_required_result_prompt' })
		const carrier = issued?.requestState
		if (carrier === undefined) throw new Error('expected a sealed prompt carrier')

		expect(issued?.inputRequests).toEqual(CONFORMANCE_REQUESTS)
		expect(
			await buildConformanceRound({
				name: 'test_input_required_result_prompt',
				requestState: carrier,
			}),
		).toBeUndefined()
		// A carrier this host never sealed is re-issued rather than honoured.
		expect(
			await buildConformanceRound({
				name: 'test_input_required_result_prompt',
				requestState: 'forged',
			}),
		).toBeDefined()
		expect(await buildConformanceRound({ name: 'test_simple_prompt' })).toBeUndefined()
	})
})

describe('buildConformanceOptions', () => {
	it('answers each port the runner exercises from the plain objects backing it', async () => {
		const peer = createHostilePeer(createMCPServer(buildConformanceOptions()))
		try {
			await peer.send(JSON.stringify(modernRequest('resources/list', 'resources-1')))
			const listed = peer.response()?.result
			const resources = isRecord(listed) ? listed['resources'] : undefined

			expect(
				Array.isArray(resources) ? resources.map((entry) => isRecord(entry) && entry['uri']) : [],
			).toEqual(CONFORMANCE_RESOURCES.map((resource) => resource.uri))
			// The identity the fixture answers with rides on the modern result stamp.
			expect(
				isRecord(listed) && isRecord(listed['_meta'])
					? listed['_meta'][MCP_META_SERVER]
					: undefined,
			).toEqual(CONFORMANCE_IDENTITY)

			peer.clear()
			await peer.send(
				JSON.stringify(
					createJSONRPCRequest({
						method: 'resources/read',
						id: 'read-1',
						params: { uri: 'test://static-text', _meta: MODERN_METADATA },
					}),
				),
			)
			const read = peer.response()?.result
			expect(isRecord(read) ? read['contents'] : undefined).toEqual(
				CONFORMANCE_CONTENTS['test://static-text'],
			)

			peer.clear()
			await peer.send(
				JSON.stringify(
					createJSONRPCRequest({
						method: 'prompts/get',
						id: 'prompt-1',
						params: { name: 'test_simple_prompt', _meta: MODERN_METADATA },
					}),
				),
			)
			const prompt = peer.response()?.result
			expect(Array.isArray(isRecord(prompt) ? prompt['messages'] : undefined)).toBe(true)

			peer.clear()
			await peer.send(
				JSON.stringify(
					createJSONRPCRequest({
						method: 'completion/complete',
						id: 'complete-1',
						params: {
							ref: { type: 'ref/prompt', name: 'test_prompt_with_arguments' },
							argument: { name: 'arg1', value: 'test' },
							_meta: MODERN_METADATA,
						},
					}),
				),
			)
			const completion = peer.response()?.result
			const values = isRecord(completion) ? completion['completion'] : undefined
			expect(isRecord(values) ? values['values'] : undefined).toEqual(['testValue1', 'testAlpha'])
		} finally {
			peer.close()
		}
	})

	it('answers a content-block call with the verbatim content the scenario asks for', async () => {
		const peer = createHostilePeer(createMCPServer(buildConformanceOptions()))
		try {
			await peer.send(
				JSON.stringify(
					createJSONRPCRequest({
						method: 'tools/call',
						id: 'call-1',
						params: {
							name: 'test_multiple_content_types',
							arguments: {},
							_meta: MODERN_METADATA,
						},
					}),
				),
			)

			const result = peer.response()?.result
			// A plain `execute` return would be normalized into text plus structured content, so
			// this row is what the `execution` port exists for.
			expect(isRecord(result) ? result['content'] : undefined).toEqual(
				CONFORMANCE_CONTENT.test_multiple_content_types,
			)
		} finally {
			peer.close()
		}
	})
})

describe('startConformance', () => {
	it('serves the whole fixture spine on a real loopback socket', async () => {
		const handle = await startConformance()
		try {
			const answered = await postJSON(handle.base, modernRequest('tools/list', 'live-1'), {
				headers: {
					[MCP_PROTOCOL_VERSION_HEADER]: MCP_MODERN_VERSION,
					[MCP_METHOD_HEADER]: 'tools/list',
				},
			})

			expect(handle.base).toBe(`http://127.0.0.1:${handle.port}`)
			expect(answered.status).toBe(200)
			const decoded: unknown = await answered.json()
			const result = isRecord(decoded) ? decoded['result'] : undefined
			const tools = isRecord(result) ? result['tools'] : undefined
			expect(Array.isArray(tools) ? tools.length : 0).toBe(buildConformanceTools().count)
		} finally {
			await handle.stop()
		}
	})
})
