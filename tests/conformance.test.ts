// The real foreign client driving this package's server end to end (live services).
// Protocol tests prove the protocol; this proves the integration, so it spawns a foreign
// process against a real socket. The runner is resolved from the pinned development
// dependency and the socket is local, so the run is hermetic and `npm test` gates it.

import type { StartedServerInterface } from './setupServer.js'
import type { ConformanceResult, ConformanceScenario } from './setupConformance.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_MCP_PATH } from '@src/server'
import {
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
	executeRunner,
	readConformanceDrift,
	readConformanceRelease,
	readFileDigest,
	startConformance,
} from './setupConformance.js'

// The recorded baseline, scenario by scenario, for the FULL 2026-07-28 server listing
// (`--suite all`). A bare total hides a scenario that stopped running, and this number has
// been wrong before — each time because the FIXTURE, not the library, could not answer. Every
// row with `failed: 0` is a check the shipped server passes; a row with a nonzero `failed` is
// a named red baseline this suite carries on purpose until a later change shrinks it. Read
// `tmp/units/m0-report.md` for the runner's per-check message behind each nonzero row.
const EXPECTED: readonly ConformanceScenario[] = [
	// Fails: the fixture answers only 2025-06-18 and 2025-11-25 protocol versions, so every
	// SEP-2575 `_meta.protocolVersion` check that targets 2026-07-28 sees -32022 instead of the
	// -32602 the check expects.
	{ name: 'server-stateless', passed: 24, failed: 4 },
	{ name: 'completion-complete', passed: 1, failed: 0 },
	{ name: 'tools-list', passed: 2, failed: 0 },
	{ name: 'tools-call-simple-text', passed: 1, failed: 0 },
	{ name: 'tools-call-image', passed: 1, failed: 0 },
	{ name: 'tools-call-audio', passed: 1, failed: 0 },
	{ name: 'tools-call-embedded-resource', passed: 1, failed: 0 },
	{ name: 'tools-call-mixed-content', passed: 1, failed: 0 },
	{ name: 'tools-call-error', passed: 1, failed: 0 },
	{ name: 'tools-call-with-progress', passed: 1, failed: 0 },
	// Fails: the scenario calls a `json_schema_2020_12_tool` this fixture's tool registry does
	// not declare.
	{ name: 'json-schema-2020-12', passed: 0, failed: 1 },
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
	// Fails: SEP-2243 wants a 400 response and a -32020 `HeaderMismatch` JSON-RPC error for a
	// mismatched or invalid `Mcp-Param` header; the shipped route accepts both and answers 200.
	{ name: 'http-custom-header-server-validation', passed: 3, failed: 6 },
	// Fails: SEP-2322 MRTR scenarios need a tool that returns `resultType: 'input_required'`
	// through a named `test_input_required_result_elicitation` tool (and a matching prompt for
	// `input-required-result-non-tool-request`); this fixture declares neither.
	{ name: 'input-required-result-basic-elicitation', passed: 0, failed: 1 },
	{ name: 'input-required-result-basic-sampling', passed: 0, failed: 1 },
	{ name: 'input-required-result-basic-list-roots', passed: 0, failed: 1 },
	{ name: 'input-required-result-request-state', passed: 0, failed: 1 },
	{ name: 'input-required-result-multiple-input-requests', passed: 0, failed: 1 },
	{ name: 'input-required-result-multi-round', passed: 0, failed: 1 },
	// Passes at 0/0: every check the scenario runs reports WARNING (not FAILURE) once its
	// prerequisite tool call answers `tool not found`, so the runner tallies no pass and no
	// fail.
	{ name: 'input-required-result-missing-input-response', passed: 0, failed: 0 },
	{ name: 'input-required-result-non-tool-request', passed: 0, failed: 1 },
	{ name: 'input-required-result-result-type', passed: 0, failed: 1 },
	{ name: 'input-required-result-unsupported-methods', passed: 1, failed: 0 },
	{ name: 'input-required-result-tampered-state', passed: 0, failed: 1 },
	{ name: 'input-required-result-capability-check', passed: 0, failed: 1 },
	{ name: 'input-required-result-ignore-extra-params', passed: 1, failed: 0 },
	{ name: 'input-required-result-validate-input', passed: 0, failed: 0 },
]

/** Scenario names carrying a nonzero red baseline: the exact list a later change shrinks. */
const EXPECTED_RED = EXPECTED.filter((scenario) => scenario.failed > 0).map(
	(scenario) => scenario.name,
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
		expect(result.scenarios.filter((scenario) => scenario.failed > 0).map((scenario) => scenario.name)).toEqual(
			EXPECTED_RED,
		)
	})

	it('protects against DNS rebinding', () => {
		const rebinding = result.scenarios.filter(
			(scenario) => scenario.name === 'dns-rebinding-protection',
		)
		expect(rebinding).toEqual([{ name: 'dns-rebinding-protection', passed: 2, failed: 0 }])
	})

	it('reports the recorded total', () => {
		expect([result.passed, result.failed]).toEqual([74, 21])
	})
})
