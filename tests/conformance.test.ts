// The real foreign client driving this package's server end to end (§16 live services).
// Protocol tests prove the protocol; this proves the integration, so it needs the network
// and stays out of `npm test`. Run it with `npm run test:conformance`.

import type { StartedServerInterface } from './setupServer.js'
import type { ConformanceResult, ConformanceScenario } from './setupConformance.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_MCP_PATH } from '@src/server'
import { executeConformance, startConformance } from './setupConformance.js'

// The recorded baseline, scenario by scenario. A bare total hides a scenario that stopped
// running, and this number has been wrong twice — both times because the FIXTURE, not the
// library, could not answer. Every row below is a check the shipped server passes.
const EXPECTED: readonly ConformanceScenario[] = [
	{ name: 'completion-complete', passed: 1, failed: 0 },
	{ name: 'tools-list', passed: 2, failed: 0 },
	{ name: 'tools-call-simple-text', passed: 1, failed: 0 },
	{ name: 'tools-call-image', passed: 1, failed: 0 },
	{ name: 'tools-call-audio', passed: 1, failed: 0 },
	{ name: 'tools-call-embedded-resource', passed: 1, failed: 0 },
	{ name: 'tools-call-mixed-content', passed: 1, failed: 0 },
	{ name: 'tools-call-error', passed: 1, failed: 0 },
	{ name: 'tools-call-with-progress', passed: 1, failed: 0 },
	{ name: 'server-sse-multiple-streams', passed: 2, failed: 0 },
	{ name: 'resources-list', passed: 1, failed: 0 },
	{ name: 'resources-read-text', passed: 1, failed: 0 },
	{ name: 'resources-read-binary', passed: 1, failed: 0 },
	{ name: 'resources-templates-read', passed: 1, failed: 0 },
	{ name: 'prompts-list', passed: 1, failed: 0 },
	{ name: 'prompts-get-simple', passed: 1, failed: 0 },
	{ name: 'prompts-get-with-args', passed: 1, failed: 0 },
	{ name: 'prompts-get-embedded-resource', passed: 1, failed: 0 },
	{ name: 'prompts-get-with-image', passed: 1, failed: 0 },
	{ name: 'dns-rebinding-protection', passed: 2, failed: 0 },
]

describe('MCP server conformance', () => {
	// `host` stays optional because `afterAll` runs even when `beforeAll` threw, and the
	// listener must be released in exactly that case.
	let host: StartedServerInterface<undefined> | undefined
	let result: ConformanceResult

	beforeAll(async () => {
		host = await startConformance()
		result = await executeConformance(`${host.base}${DEFAULT_MCP_PATH}`)
	})

	afterAll(async () => {
		await host?.stop()
	})

	it('runs every recorded scenario with no failure', () => {
		expect(result.scenarios).toEqual(EXPECTED)
	})

	it('protects against DNS rebinding', () => {
		const rebinding = result.scenarios.filter(
			(scenario) => scenario.name === 'dns-rebinding-protection',
		)
		expect(rebinding).toEqual([{ name: 'dns-rebinding-protection', passed: 2, failed: 0 }])
	})

	it('reports the recorded total', () => {
		expect([result.passed, result.failed]).toEqual([23, 0])
	})
})
