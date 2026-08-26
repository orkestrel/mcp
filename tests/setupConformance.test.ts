// Proof of `tests/setupConformance.ts` — the host fixture the foreign runner drives, and the
// runner harness itself.
//
// The pinned runner is a development dependency already on disk, so every claim about it is
// settled by running it rather than by describing it: the version it reports is compared against
// the manifest pin, and the summary parser is fed a real run's output. The live pass over a
// running fixture is `tests/conformance.test.ts`; what this file owns is what the fixture and
// the harness promise before that pass starts.

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
	buildConformanceMessages,
	buildConformanceOptions,
	buildConformanceTools,
	CONFORMANCE_CANDIDATES,
	CONFORMANCE_CONTENT,
	CONFORMANCE_CONTENTS,
	CONFORMANCE_DESCRIPTOR,
	CONFORMANCE_ENTRY,
	CONFORMANCE_IDENTIFIERS,
	CONFORMANCE_IDENTITY,
	CONFORMANCE_PACKAGE,
	CONFORMANCE_PROMPTS,
	CONFORMANCE_RESOURCES,
	CONFORMANCE_TEMPLATE,
	executeConformance,
	executeRunner,
	parseConformance,
	readConformanceTemplate,
	readConformanceRelease,
	resolveConformanceRunner,
	startConformance,
} from './setupConformance.js'
import { normalize } from 'node:path'

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
		expect(result.passed).toBe(0)
		expect(result.failed).toBeGreaterThan(0)
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
		])
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
