// Proof of `tests/setupConformance.ts` — the host fixture the foreign runner drives, and the
// runner harness itself.
//
// The pinned runner is a development dependency already on disk, so every claim about it is
// settled by running it rather than by describing it: the version it reports is compared against
// the manifest pin, and the summary parser is fed a real run's output. The live pass over a
// running fixture is `tests/conformance.test.ts`; what this file owns is what the fixture and
// the harness promise before that pass starts.

import type { MCPInputContext } from '@src/core'
import { describe, expect, it } from 'vitest'
import { createMCPServer, MCP_META_SERVER, MCP_MODERN_VERSION } from '@src/core'
import { MCP_METHOD_HEADER, MCP_PROTOCOL_VERSION_HEADER } from '@src/server'
import { isRecord } from '@orkestrel/contract'
import {
	createHostilePeer,
	createJSONRPCRequest,
	MODERN_METADATA,
	modernRequest,
	postJSON,
} from './setup.js'
import {
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
} from './setupConformance.js'
import { existsSync } from 'node:fs'
import { normalize, resolve } from 'node:path'

// One selector context for one named tool at one point in its walk. The state is the only
// thing `buildConformanceInput` reads besides the name, so the request and the arguments stay
// the same inert values at every round.
function buildInputContext(name: string, state?: number): MCPInputContext {
	return {
		request: createJSONRPCRequest({ method: 'tools/call', params: { name: 'ignored' } }),
		name,
		arguments: {},
		...(state === undefined ? {} : { state }),
	}
}

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
		expect(driver).toMatch(/(?:^|\/)tests\/conformanceClient\.ts$/)
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
