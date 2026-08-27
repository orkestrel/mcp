// The real foreign client driving this package's server end to end (live services).
// Protocol tests prove the protocol; this proves the integration, so it spawns a foreign
// process against a real socket. The runner is resolved from the pinned development
// dependency and the socket is local, so the run is hermetic and `npm test` gates it.

import type { StartedServerInterface } from './setupServer.js'
import type {
	ConformanceOutcome,
	ConformanceResult,
	ConformanceScenario,
} from './setupConformance.js'
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
} from './setupConformance.js'

// The recorded baseline, scenario by scenario, for the FULL 2026-07-28 server listing
// (`--suite all`). A bare total hides a scenario that stopped running, and this number has
// been wrong before — each time because the FIXTURE, not the library, could not answer. Every
// row with `failed: 0` is a check the shipped server passes; a row with a nonzero `failed` is a
// named LIBRARY gap this suite carries on purpose until a later change closes it, and the
// comment above each such row is the gap. Every row a fixture could answer has been answered,
// so a new nonzero row is a regression rather than an unfinished host.
//
// A row at `0 passed, 0 failed` is neither: its checks are SHOULD-level, so the runner reports
// WARNING and tallies nothing either way.
const EXPECTED: readonly ConformanceScenario[] = [
	// Green since a protocol header naming a MODERN revision began holding the request to that
	// revision's own rule: a body with no parsable modern `_meta` answers -32602 rather than
	// falling through the legacy door's -32022. The two SEP-2575 checks that moved are the
	// omitted `_meta` and the `_meta` omitting `protocolVersion`. The undeclared-capability pair
	// was already green: the fixture declares a `test_missing_capability` tool whose round asks
	// for `sampling/createMessage`, and the server refuses that round -32021 over HTTP 400
	// because the call declared no capabilities.
	{ name: 'server-stateless', passed: 28, failed: 0 },
	{ name: 'completion-complete', passed: 1, failed: 0 },
	{ name: 'tools-list', passed: 2, failed: 0 },
	{ name: 'tools-call-simple-text', passed: 1, failed: 0 },
	{ name: 'tools-call-image', passed: 1, failed: 0 },
	{ name: 'tools-call-audio', passed: 1, failed: 0 },
	{ name: 'tools-call-embedded-resource', passed: 1, failed: 0 },
	{ name: 'tools-call-mixed-content', passed: 1, failed: 0 },
	{ name: 'tools-call-error', passed: 1, failed: 0 },
	{ name: 'tools-call-with-progress', passed: 1, failed: 0 },
	{ name: 'json-schema-2020-12', passed: 7, failed: 0 },
	{ name: 'server-sse-multiple-streams', passed: 2, failed: 0 },
	{ name: 'resources-list', passed: 1, failed: 0 },
	{ name: 'resources-read-text', passed: 1, failed: 0 },
	{ name: 'resources-read-binary', passed: 1, failed: 0 },
	{ name: 'resources-templates-read', passed: 1, failed: 0 },
	{ name: 'sep-2164-resource-not-found', passed: 2, failed: 0 },
	{ name: 'prompts-list', passed: 1, failed: 0 },
	{ name: 'prompts-get-simple', passed: 1, failed: 0 },
	{ name: 'prompts-get-with-args', passed: 1, failed: 0 },
	{ name: 'prompts-get-embedded-resource', passed: 1, failed: 0 },
	{ name: 'prompts-get-with-image', passed: 1, failed: 0 },
	{ name: 'dns-rebinding-protection', passed: 2, failed: 0 },
	{ name: 'caching', passed: 7, failed: 0 },
	{ name: 'http-header-validation', passed: 13, failed: 0 },
	// Green since the POST handler began validating every `Mcp-Param-*` header its OWN tool
	// definitions annotate against the call's body. The checks that moved are three refusals,
	// each counted twice — once for the HTTP 400 and once for the -32020 error code: a Base64
	// sentinel with invalid padding, one with a non-alphabet character, and an omitted header
	// for a value the body supplies. The three that were already green are the accepts — a
	// well-formed sentinel decoded and matched, and a value missing either marker read as a
	// literal.
	{ name: 'http-custom-header-server-validation', passed: 9, failed: 0 },
	// The SEP-2322 rows below all drive `MCPServerOptions.input`, whose answer is the round the
	// consumer composed: its own keys, and any mixture of the elicitation, sampling, and roots
	// kinds the client declared. The prompt arm reaches the same wire the other way — the
	// prompt port returns its own `MCPInputResult` — which is what `-non-tool-request` proves.
	{ name: 'input-required-result-basic-elicitation', passed: 2, failed: 0 },
	{ name: 'input-required-result-basic-sampling', passed: 2, failed: 0 },
	{ name: 'input-required-result-basic-list-roots', passed: 2, failed: 0 },
	{ name: 'input-required-result-request-state', passed: 2, failed: 0 },
	{ name: 'input-required-result-multiple-input-requests', passed: 2, failed: 0 },
	{ name: 'input-required-result-multi-round', passed: 3, failed: 0 },
	// Passes at 0/0: the scenario's one check is a SHOULD, so a retry carrying `inputResponses`
	// without a `requestState` — which this server refuses with -32602 — reports WARNING and
	// the runner tallies neither a pass nor a fail.
	{ name: 'input-required-result-missing-input-response', passed: 0, failed: 0 },
	{ name: 'input-required-result-non-tool-request', passed: 2, failed: 0 },
	{ name: 'input-required-result-result-type', passed: 1, failed: 0 },
	{ name: 'input-required-result-unsupported-methods', passed: 1, failed: 0 },
	{ name: 'input-required-result-tampered-state', passed: 1, failed: 0 },
	{ name: 'input-required-result-capability-check', passed: 1, failed: 0 },
	// Passes at 0/0 for the same SHOULD reason as `-missing-input-response`.
	{ name: 'input-required-result-ignore-extra-params', passed: 0, failed: 0 },
	{ name: 'input-required-result-validate-input', passed: 2, failed: 0 },
]

/** Scenario names carrying a nonzero red baseline: the exact list a later change shrinks. */
const EXPECTED_RED = EXPECTED.filter((scenario) => scenario.failed > 0).map(
	(scenario) => scenario.name,
)

// The recorded baseline for the runner's own CLIENT mode, driving this package's
// `createMCPClient` over `createHTTPClientTransport` through every non-auth 2026-07-28
// client scenario. `CONFORMANCE_CLIENT_SCENARIOS` names the set and records why the
// `auth/*` family is out. The reading is per scenario for the same reason the server
// baseline is: a scenario that stopped running is invisible in a total.
//
// Every row with `failed: 0` is a check the shipped client passes. Each row with a nonzero
// `failed` is a named LIBRARY gap this suite carries on purpose, and the comment above it
// is the gap. A check the runner reports at SHOULD level tallies as a warning instead, so
// `warnings` is recorded beside the counts rather than folded into them.
//
// A SKIPPED check tallies as neither. `http-standard-headers` declares its Mcp-Method and
// Mcp-Name checks for `initialize`, `notifications/initialized`, `resources/list`,
// `resources/read`, `prompts/list`, and `prompts/get`; `MCPClientInterface` publishes no
// method that issues any of those, so the runner reports each SKIPPED rather than failed
// and the row tallies only the `tools/list` and `tools/call` checks the client does reach.
const EXPECTED_CLIENT: readonly ConformanceOutcome[] = [
	{ name: 'tools_call', passed: 1, failed: 0, warnings: 0 },
	{ name: 'request-metadata', passed: 8, failed: 0, warnings: 0 },
	// Green since `MCPCallOptions.input.state` became optional. The peer answers
	// `test_mrtr_no_state` with an `input_required` result carrying `inputRequests` and NO
	// `requestState`, and SEP-2322 requires the retry to answer it while omitting
	// `requestState`. While `state` was a required leaf that retry was unreachable through
	// the client's public surface, and the runner reported "Tool was not called by client or
	// MRTR flow not completed". The checks are the stateless round, the exact echo, the
	// distinct JSON-RPC id, the isolation of one call's round from another's, and the missing
	// `resultType` defaulting to complete.
	{ name: 'sep-2322-client-request-state', passed: 5, failed: 0, warnings: 0 },
	{ name: 'http-standard-headers', passed: 3, failed: 0, warnings: 0 },
	// Green since the HTTP client transports began caching each listed tool's `x-mcp-header`
	// annotations and projecting a call's own arguments onto `Mcp-Param-*` headers. The checks
	// that moved are the one asserting any header at all plus the per-parameter conversion and
	// encoding rows: a plain string literal, a decimal integer, both booleans, an empty value,
	// a name that must not collide with `Mcp-Method`, and the non-ASCII, whitespace-edged,
	// control-character, CRLF, and tab values that travel as the Base64 sentinel.
	{ name: 'http-custom-headers', passed: 18, failed: 0, warnings: 0 },
	// Green since the same transports began dropping an invalidly annotated definition from
	// the `tools/list` result they deliver: the driver calls exactly the tools the client
	// listed, so a definition the transport excluded is one the driver cannot call. The checks
	// that moved are the ten malformed definitions — an empty name, three non-primitive types,
	// two duplicate names, and four names outside the RFC 9110 token set.
	{ name: 'http-invalid-tool-headers', passed: 11, failed: 0, warnings: 0 },
	{ name: 'json-schema-ref-no-deref', passed: 1, failed: 0, warnings: 0 },
]

/** Client scenario names carrying a nonzero red baseline. */
const EXPECTED_CLIENT_RED = EXPECTED_CLIENT.filter((outcome) => outcome.failed > 0).map(
	(outcome) => outcome.name,
)

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
	let host: StartedServerInterface<undefined> | undefined
	let result: ConformanceResult
	let version: string

	beforeAll(async () => {
		host = await startConformance()
		version = (await executeRunner(['--version'])).trim()
		result = await executeConformance(`${host.base}${DEFAULT_MCP_PATH}`)
	})

	afterAll(async () => {
		await host?.stop()
	})

	// The baseline below is a baseline of ONE runner build, so an install that drifted off the
	// manifest pin would rewrite these numbers without touching this package. The manifest is
	// the single authority for the version and this is where the running process answers to it.
	it('runs the runner build the manifest pins', () => {
		expect(version).toBe(readConformanceRelease())
	})

	it('runs every 2026-07-28 server scenario against the recorded baseline', () => {
		expect(result.scenarios).toEqual(EXPECTED)
	})

	it('names the exact scenarios carrying the recorded red baseline', () => {
		expect(
			result.scenarios.filter((scenario) => scenario.failed > 0).map((scenario) => scenario.name),
		).toEqual(EXPECTED_RED)
	})

	it('protects against DNS rebinding', () => {
		const rebinding = result.scenarios.filter(
			(scenario) => scenario.name === 'dns-rebinding-protection',
		)
		expect(rebinding).toEqual([{ name: 'dns-rebinding-protection', passed: 2, failed: 0 }])
	})

	it('reports the recorded total', () => {
		expect([result.passed, result.failed]).toEqual([110, 0])
	})
})

describe('MCP client conformance', () => {
	let outcomes: readonly ConformanceOutcome[]
	let listing: string

	// The runner starts and stops each scenario's own server, so this block owns no listener
	// and needs no teardown. The budget covers one serial invocation per recorded scenario,
	// each of which launches the runner, binds an ephemeral port, and spawns the driver as
	// its own process.
	beforeAll(async () => {
		listing = await executeRunner(['list', '--spec-version', CONFORMANCE_SPEC])
		outcomes = await executeConformanceClient()
	}, 120_000)

	// The recorded set is a decision, so it is written down rather than derived from the
	// runner. This is what keeps that decision honest: the runner's own listing is the second
	// mechanism, and a client scenario it adds at this revision reddens here rather than
	// silently dropping out of the run.
	it('records every non-auth client scenario the runner reports at this revision', () => {
		expect(
			parseConformanceClients(listing).filter((name) => !name.startsWith(CONFORMANCE_AUTH)),
		).toEqual(CONFORMANCE_CLIENT_SCENARIOS)
	})

	it('runs every non-auth 2026-07-28 client scenario against the recorded baseline', () => {
		expect(outcomes).toEqual(EXPECTED_CLIENT)
	})

	it('names the exact client scenarios carrying the recorded red baseline', () => {
		expect(outcomes.filter((outcome) => outcome.failed > 0).map((outcome) => outcome.name)).toEqual(
			EXPECTED_CLIENT_RED,
		)
	})

	// No total is asserted here. Client mode prints no cross-scenario total when each
	// scenario runs on its own, so a total would be this file's own arithmetic over the array
	// it already compared — an assertion that cannot disagree with the thing it checks.
	it('reports no SHOULD-level warning on any client scenario', () => {
		expect(outcomes.filter((outcome) => outcome.warnings > 0)).toEqual([])
	})
})
