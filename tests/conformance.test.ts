import type { StartedServerInterface } from './setupServer.js'
import type { ConformanceOutcome, ConformanceResult } from './setupServer.js'
import { requireValue } from '@orkestrel/test'
import { MCPFixtureCell } from './setup.js'
import {
	MCP_CONFORMANCE_CLIENT_RED,
	MCP_CONFORMANCE_CLIENT,
	MCP_CONFORMANCE_SERVER_RED,
	MCP_CONFORMANCE_SERVER,
} from './setupServer.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_MCP_PATH } from '@src/server'
import {
	CONFORMANCE_AUTH,
	CONFORMANCE_CLIENT_SCENARIOS,
	CONFORMANCE_SPEC,
	TASK_SCHEMA_CAPABILITY_ROWS,
	TASK_SCHEMA_CREATE_ROWS,
	TASK_SCHEMA_DETAIL_ROWS,
	TASK_SCHEMA_DIGEST,
	TASK_SCHEMA_ID_ROWS,
	TASK_SCHEMA_METHOD_ROWS,
	TASK_SCHEMA_NOTIFICATION_ROWS,
	TASK_SCHEMA_PATH,
	TASK_SCHEMA_RESULT_ROWS,
	TASK_SCHEMA_STATUS_ROWS,
	TASK_SCHEMA_SUBSCRIPTION_ROWS,
	TASK_SCHEMA_TASK_ROWS,
	executeConformance,
	executeConformanceClient,
	executeRunner,
	parseConformanceClients,
	readConformanceDrift,
	readConformanceRelease,
	readFileDigest,
	startConformance,
} from './setupServer.js'

// The real foreign client driving this package's server end to end (live services).
// Protocol tests prove the protocol; this proves the integration, so it spawns a foreign
// process against a real socket. The runner is resolved from the pinned development
// dependency and the socket is local, so the run is hermetic and `npm test` gates it.

// The recorded baseline, scenario by scenario, for the FULL 2026-07-28 server listing
// (`--suite all`). A bare total hides a scenario that stopped running, and this number has
// been wrong before — each time because the FIXTURE, not the library, could not answer. Every
// row with `failed: 0` is a check the shipped server passes; a row with a nonzero `failed` is a
// named LIBRARY gap this suite carries on purpose until a later change closes it, and the
// comment above each such row is the gap. Every row a fixture could answer has been answered,
// so a new nonzero row is a regression rather than an unfinished host.
//
// A `SHOULD`-level check is neither: the runner reports WARNING and tallies nothing either way,
// so a row records only the MUST-level checks beside it.
//
// Every row also carries the runner's own `wire-schema-valid` check, which reads every JSON-RPC
// message this server sent against the spec's JSON schema for the negotiated revision. The
// runner emits that check only where it observed a message on its own instrumented client path,
// so `server-stateless`, `server-sse-multiple-streams`, and `dns-rebinding-protection` — which
// drive raw HTTP outside it — carry none. The per-row comments name each scenario's own checks
// and leave that one to this paragraph.
describe('Tasks schema authority pins', () => {
	it("pins the vendored schema's raw-byte digest", () => {
		expect(
			readConformanceDrift(
				'Tasks schema bytes',
				readFileDigest(TASK_SCHEMA_PATH),
				'SHA-256',
				TASK_SCHEMA_DIGEST,
			),
		).toBeUndefined()
	})

	it.each(TASK_SCHEMA_ID_ROWS)('$symbol matches the Tasks schema', (row) => {
		expect(
			readConformanceDrift(row.symbol, row.expected, 'Tasks schema', row.model),
		).toBeUndefined()
	})
})

describe('Tasks schema task conformance', () => {
	it.each(TASK_SCHEMA_TASK_ROWS)('$symbol matches the Tasks schema', (row) => {
		expect(
			readConformanceDrift(row.symbol, row.expected, 'Tasks schema', row.model),
		).toBeUndefined()
	})

	it.each(TASK_SCHEMA_STATUS_ROWS)('$symbol matches the Tasks schema', (row) => {
		expect(
			readConformanceDrift(row.symbol, row.expected, 'Tasks schema', row.model),
		).toBeUndefined()
	})

	it.each(TASK_SCHEMA_DETAIL_ROWS)('$symbol matches the Tasks schema', (row) => {
		expect(
			readConformanceDrift(row.symbol, row.expected, 'Tasks schema', row.model),
		).toBeUndefined()
	})
})

describe('Tasks schema result conformance', () => {
	it.each(TASK_SCHEMA_CREATE_ROWS)('$symbol matches the Tasks schema', (row) => {
		expect(
			readConformanceDrift(row.symbol, row.expected, 'Tasks schema', row.model),
		).toBeUndefined()
	})

	it.each(TASK_SCHEMA_RESULT_ROWS)('$symbol matches the Tasks schema', (row) => {
		expect(
			readConformanceDrift(row.symbol, row.expected, 'Tasks schema', row.model),
		).toBeUndefined()
	})
})

describe('Tasks schema notification conformance', () => {
	it.each(TASK_SCHEMA_NOTIFICATION_ROWS)('$symbol matches the Tasks schema', (row) => {
		expect(
			readConformanceDrift(row.symbol, row.expected, 'Tasks schema', row.model),
		).toBeUndefined()
	})

	it.each(TASK_SCHEMA_SUBSCRIPTION_ROWS)('$symbol matches the Tasks schema', (row) => {
		expect(
			readConformanceDrift(row.symbol, row.expected, 'Tasks schema', row.model),
		).toBeUndefined()
	})
})

describe('Tasks schema capability and method conformance', () => {
	it.each(TASK_SCHEMA_CAPABILITY_ROWS)('$symbol matches the Tasks schema', (row) => {
		expect(
			readConformanceDrift(row.symbol, row.expected, 'Tasks schema', row.model),
		).toBeUndefined()
	})

	it.each(TASK_SCHEMA_METHOD_ROWS)('$symbol matches the Tasks schema', (row) => {
		expect(
			readConformanceDrift(row.symbol, row.expected, 'Tasks schema', row.model),
		).toBeUndefined()
	})
})

describe('MCP server conformance', () => {
	// `host` stays optional because `afterAll` runs even when `beforeAll` threw, and the
	// listener must be released in exactly that case.
	const host = new MCPFixtureCell<StartedServerInterface<undefined> | undefined>(undefined)
	const result = new MCPFixtureCell<ConformanceResult | undefined>(undefined)
	const version = new MCPFixtureCell<string | undefined>(undefined)

	beforeAll(async () => {
		host.value = await startConformance()
		version.value = (await executeRunner(['--version'])).trim()
		result.value = await executeConformance(`${host.value.base}${DEFAULT_MCP_PATH}`)
	})

	afterAll(async () => {
		await host.value?.stop()
	})

	// The baseline below is a baseline of ONE runner build, so an install that drifted off the
	// manifest pin would rewrite these numbers without touching this package. The manifest is
	// the single authority for the version and this is where the running process answers to it.
	it('runs the runner build the manifest pins', () => {
		expect(version.value).toBe(readConformanceRelease())
	})

	it('runs every 2026-07-28 server scenario against the recorded baseline', () => {
		expect(requireValue(result.value).scenarios).toEqual(MCP_CONFORMANCE_SERVER)
	})

	it('names the exact scenarios carrying the recorded red baseline', () => {
		expect(
			requireValue(result.value)
				.scenarios.filter((scenario) => scenario.failed > 0)
				.map((scenario) => scenario.name),
		).toEqual(MCP_CONFORMANCE_SERVER_RED)
	})

	it('protects against DNS rebinding', () => {
		const rebinding = requireValue(result.value).scenarios.filter(
			(scenario) => scenario.name === 'dns-rebinding-protection',
		)
		expect(rebinding).toEqual([{ name: 'dns-rebinding-protection', passed: 2, failed: 0 }])
	})

	it('reports the recorded total', () => {
		expect([requireValue(result.value).passed, requireValue(result.value).failed]).toEqual([147, 0])
	})
})

describe('MCP client conformance', () => {
	const outcomes = new MCPFixtureCell<readonly ConformanceOutcome[] | undefined>(undefined)
	const listing = new MCPFixtureCell<string | undefined>(undefined)

	// The runner starts and stops each scenario's own server, so this block owns no listener
	// and needs no teardown. The budget covers one serial invocation per recorded scenario,
	// each of which launches the runner, binds an ephemeral port, and spawns the driver as
	// its own process.
	beforeAll(async () => {
		listing.value = await executeRunner(['list', '--spec-version', CONFORMANCE_SPEC])
		outcomes.value = await executeConformanceClient()
	}, 120_000)

	// The recorded set is a decision, so it is written down rather than derived from the
	// runner. This is what keeps that decision honest: the runner's own listing is the second
	// mechanism, and a client scenario it adds at this revision reddens here rather than
	// silently dropping out of the run.
	it('records every non-auth client scenario the runner reports at this revision', () => {
		expect(
			parseConformanceClients(requireValue(listing.value)).filter(
				(name) => !name.startsWith(CONFORMANCE_AUTH),
			),
		).toEqual(CONFORMANCE_CLIENT_SCENARIOS)
	})

	it('runs every non-auth 2026-07-28 client scenario against the recorded baseline', () => {
		expect(outcomes.value).toEqual(MCP_CONFORMANCE_CLIENT)
	})

	it('names the exact client scenarios carrying the recorded red baseline', () => {
		expect(
			requireValue(outcomes.value)
				.filter((outcome) => outcome.failed > 0)
				.map((outcome) => outcome.name),
		).toEqual(MCP_CONFORMANCE_CLIENT_RED)
	})

	// No total is asserted here. Client mode prints no cross-scenario total when each
	// scenario runs on its own, so a total would be this file's own arithmetic over the array
	// it already compared — an assertion that cannot disagree with the thing it checks.
	it('reports no SHOULD-level warning on any client scenario', () => {
		expect(requireValue(outcomes.value).filter((outcome) => outcome.warnings > 0)).toEqual([])
	})
})
