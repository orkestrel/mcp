// The live-service harness for `@modelcontextprotocol/conformance` — the real foreign
// client that drives this package's server over a real socket (§16 live services).
//
// This file exists as TYPESCRIPT for one reason. The fixture below is the host half of
// every port `MCPServerOptions` publishes, so it is typed against the real exported
// interfaces: rename a port accessor and `npm run check` fails at compile time instead of
// twenty minutes later inside a foreign runner's summary. The same fixture as untyped
// JavaScript enforced nothing, and a public rename once took the suite 23/0 → 16/7 with
// every gate green.
//
// The ports are backed by PLAIN OBJECTS and no `@orkestrel/workspace`. That is the claim:
// no adapter is privileged, and what backs a port is the host's decision.

import type { ToolManagerInterface } from '@orkestrel/tool'
import type {
	MCPCompletion,
	MCPCompletionManagerInterface,
	MCPContent,
	MCPPrompt,
	MCPPromptManagerInterface,
	MCPPromptMessage,
	MCPResource,
	MCPResourceContents,
	MCPResourceManagerInterface,
	MCPServerOptions,
} from '@src/core'
import type { StartedServerInterface } from './setupServer.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { beforeAll } from 'vitest'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { createTool, createToolManager } from '@orkestrel/tool'
import { createMCPServer } from '@src/core'
import { createMCPRoutes } from '@src/server'
import { startServer } from './setupServer.js'

// ── The pinned runner ────────────────────────────────────────────────────────

/** The exact conformance runner build this suite is pinned to. */
export const CONFORMANCE_RELEASE = '0.2.0-alpha.10'

/** The npm specifier `npx` resolves for every runner invocation. */
export const CONFORMANCE_PACKAGE = `@modelcontextprotocol/conformance@${CONFORMANCE_RELEASE}`

/** The dated protocol revision the runner drives the server at. */
export const CONFORMANCE_SPEC = '2026-07-28'

/** The identity the fixture server answers `initialize` with. */
export const CONFORMANCE_IDENTITY = Object.freeze({
	name: 'orkestrel-conformance',
	version: '0.0.9',
})

/** One `✓ <scenario>: N passed, M failed` line in the runner's summary block. */
export const CONFORMANCE_TALLY = /^\S+ ([a-z0-9-]+): (\d+) passed, (\d+) failed$/

/** The runner's closing `Total: N passed, M failed` line. */
export const CONFORMANCE_TOTAL = /^Total: (\d+) passed, (\d+) failed$/

// ── The runner's reported shape ──────────────────────────────────────────────

/** One conformance scenario's tally, exactly as the runner's summary reports it. */
export interface ConformanceScenario {
	/** The scenario identifier, such as `dns-rebinding-protection`. */
	readonly name: string
	/** Checks the scenario passed. */
	readonly passed: number
	/** Checks the scenario failed. */
	readonly failed: number
}

/** The parsed outcome of one whole conformance run. */
export interface ConformanceResult {
	/** Every scenario tally in the order the runner reported it. */
	readonly scenarios: readonly ConformanceScenario[]
	/** The runner's own total of passed checks. */
	readonly passed: number
	/** The runner's own total of failed checks. */
	readonly failed: number
}

// ── The tool fixture ─────────────────────────────────────────────────────────

/**
 * The rich content the four content-block scenarios ask for VERBATIM.
 *
 * @remarks
 * A plain `execute` return is an ordinary domain value, and the server normalizes one
 * into text plus `structuredContent` exactly as it should — so a fixture with no
 * `execution` port cannot answer an image, an audio clip, an embedded resource, or a
 * mixed sequence, and its failures would measure the fixture rather than the library.
 * `MCPServerOptions.execution` is the shipped, documented port for precisely this.
 */
export const CONFORMANCE_CONTENT: Readonly<Record<string, readonly MCPContent[]>> = Object.freeze({
	test_image_content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
	test_audio_content: [{ type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav' }],
	test_embedded_resource: [
		{
			type: 'resource',
			resource: {
				uri: 'test://embedded-resource',
				mimeType: 'text/plain',
				text: 'This is an embedded resource content.',
			},
		},
	],
	test_multiple_content_types: [
		{ type: 'text', text: 'Multiple content types test:' },
		{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
		{
			type: 'resource',
			resource: {
				uri: 'test://mixed-content-resource',
				mimeType: 'application/json',
				text: '{"test":"data","value":123}',
			},
		},
	],
})

/**
 * Build the live tool registry the conformance scenarios call.
 *
 * @returns A fresh `ToolManagerInterface` holding every `test_*` tool
 */
export function buildConformanceTools(): ToolManagerInterface {
	const tools = createToolManager()
	tools.add(
		createTool({
			name: 'test_simple_text',
			description: 'Return the conformance suite simple-text fixture.',
			execute: () => 'This is a simple text response for testing.',
		}),
	)
	tools.add(
		createTool({
			name: 'test_image_content',
			description: 'Exercise the declared image-content conformance gap.',
			execute: () => ({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }),
		}),
	)
	tools.add(
		createTool({
			name: 'test_multiple_content_types',
			description: 'Exercise the declared mixed-content conformance gap.',
			execute: () => CONFORMANCE_CONTENT.test_multiple_content_types,
		}),
	)
	tools.add(
		createTool({
			name: 'test_audio_content',
			description: 'Exercise the declared audio-content conformance gap.',
			execute: () => ({ type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav' }),
		}),
	)
	tools.add(
		createTool({
			name: 'test_embedded_resource',
			description: 'Exercise the declared embedded-resource conformance gap.',
			execute: () => ({
				type: 'resource',
				resource: {
					uri: 'test://embedded-resource',
					mimeType: 'text/plain',
					text: 'This is an embedded resource content.',
				},
			}),
		}),
	)
	tools.add(
		createTool({
			name: 'test_error_handling',
			description: 'Return the conformance suite isolated tool-error fixture.',
			execute: () => {
				throw new Error('This tool intentionally returns an error for testing')
			},
		}),
	)
	tools.add(
		createTool({
			name: 'test_tool_with_progress',
			description: 'Exercise the declared tool-progress conformance gap.',
			execute: () => 'Tool execution completed.',
		}),
	)
	tools.add(
		createTool({
			name: 'test_header_parameter',
			description: 'Exercise the declared Mcp-Param header conformance gap.',
			parameters: {
				type: 'object',
				properties: {
					value: { type: 'string', 'x-mcp-header': 'value' },
				},
				required: ['value'],
			},
			execute: (values) => values,
		}),
	)
	return tools
}

// ── The resource fixture ─────────────────────────────────────────────────────
//
// The three host-owned registries the resource, prompt, and completion ports project.
// Each is an ordinary in-memory object — deliberately NOT a workspace and not a template
// engine — because the ports are ports: what backs them is the host's decision and this
// file is one host's answer.

/** The static resources the fixture advertises over `resources/list`. */
export const CONFORMANCE_RESOURCES: readonly MCPResource[] = Object.freeze([
	{
		uri: 'test://static-text',
		name: 'static-text',
		description: 'The conformance suite static text resource.',
		mimeType: 'text/plain',
	},
	{
		uri: 'test://static-binary',
		name: 'static-binary',
		description: 'The conformance suite static binary resource.',
		mimeType: 'image/png',
	},
])

/** The contents each static resource URI resolves to. */
export const CONFORMANCE_CONTENTS: Readonly<Record<string, readonly MCPResourceContents[]>> =
	Object.freeze({
		'test://static-text': [
			{
				uri: 'test://static-text',
				mimeType: 'text/plain',
				text: 'This is the content of the static text resource.',
			},
		],
		'test://static-binary': [
			{ uri: 'test://static-binary', mimeType: 'image/png', blob: 'iVBORw0KGgo=' },
		],
	})

/**
 * The already-substituted form of the fixture's one resource template.
 *
 * @remarks
 * The template is published as a DESCRIPTOR and matched HERE. MCP expands nothing: it
 * forwards the already-concrete `test://template/123/data` the client sent, and the party
 * that owns the template owns knowing its variables. `scenario resources-templates-read`
 * sends the substituted URI for exactly this reason, so a template engine inside MCP
 * would have nothing to do.
 */
export const CONFORMANCE_TEMPLATE = /^test:\/\/template\/([^/]+)\/data$/

/** The descriptor form of {@link CONFORMANCE_TEMPLATE}, as `resources/templates/list` advertises it. */
export const CONFORMANCE_DESCRIPTOR = 'test://template/{id}/data'

/**
 * Resolve one already-substituted template URI to its JSON document.
 *
 * @param uri - The concrete URI the client sent
 * @returns The document contents, or `undefined` when the URI is not this template's
 */
export function readConformanceTemplate(uri: string): readonly MCPResourceContents[] | undefined {
	const matched = CONFORMANCE_TEMPLATE.exec(uri)
	if (matched === null) return undefined
	const id = matched[1]
	if (id === undefined) return undefined
	return [
		{
			uri,
			mimeType: 'application/json',
			text: JSON.stringify({ id, templateTest: true, data: `Data for ID: ${id}` }),
		},
	]
}

// ── The prompt fixture ───────────────────────────────────────────────────────

/** The prompts the fixture advertises over `prompts/list`. */
export const CONFORMANCE_PROMPTS: readonly MCPPrompt[] = Object.freeze([
	{
		name: 'test_simple_prompt',
		description: 'The conformance suite simple-prompt fixture.',
	},
	{
		name: 'test_prompt_with_arguments',
		description: 'The conformance suite parameterized-prompt fixture.',
		arguments: [
			{ name: 'arg1', description: 'First test argument.', required: true },
			{ name: 'arg2', description: 'Second test argument.', required: true },
		],
	},
	{
		name: 'test_prompt_with_embedded_resource',
		description: 'The conformance suite embedded-resource prompt fixture.',
		arguments: [{ name: 'resourceUri', description: 'The resource to embed.', required: true }],
	},
	{
		name: 'test_prompt_with_image',
		description: 'The conformance suite image-prompt fixture.',
	},
])

/**
 * Fill one named prompt with the caller's arguments.
 *
 * @remarks
 * `arguments` are strings by contract, so filling a prompt is the host's own
 * substitution — the same division as the resource template above. MCP validates the
 * argument record and forwards it.
 *
 * @param name - The prompt name the client asked for
 * @param values - The string arguments the client supplied
 * @returns The prompt's messages, or `undefined` when this host owns no such prompt
 */
export function buildConformanceMessages(
	name: string,
	values: Readonly<Record<string, string>>,
): readonly MCPPromptMessage[] | undefined {
	if (name === 'test_simple_prompt') {
		return [
			{ role: 'user', content: { type: 'text', text: 'This is a simple prompt for testing.' } },
		]
	}
	if (name === 'test_prompt_with_arguments') {
		return [
			{
				role: 'user',
				content: {
					type: 'text',
					text: `Prompt with arguments: arg1='${values.arg1 ?? ''}', arg2='${values.arg2 ?? ''}'`,
				},
			},
		]
	}
	if (name === 'test_prompt_with_embedded_resource') {
		return [
			{
				role: 'user',
				content: {
					type: 'resource',
					resource: {
						uri: values.resourceUri ?? 'test://example-resource',
						mimeType: 'text/plain',
						text: 'Embedded resource content for testing.',
					},
				},
			},
			{
				role: 'user',
				content: { type: 'text', text: 'Please process the embedded resource above.' },
			},
		]
	}
	if (name === 'test_prompt_with_image') {
		return [
			{ role: 'user', content: { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' } },
			{ role: 'user', content: { type: 'text', text: 'Please analyze the image above.' } },
		]
	}
	return undefined
}

// ── The completion fixture ───────────────────────────────────────────────────
//
// Completion is a top-level capability, independent of the other two: the host owns
// reference lookup for BOTH arms, because the party that expands a template is the party
// that knows its variables. A reference this host does not recognize answers `undefined`,
// which MCP maps to `-32602` rather than inventing an empty candidate list.

/** The candidate values each prompt argument completes to. */
export const CONFORMANCE_CANDIDATES: Readonly<
	Record<string, Readonly<Record<string, readonly string[]>>>
> = Object.freeze({
	test_prompt_with_arguments: {
		arg1: ['testValue1', 'testAlpha', 'production'],
		arg2: ['testValue2', 'testBeta', 'staging'],
	},
	test_prompt_with_embedded_resource: {
		resourceUri: CONFORMANCE_RESOURCES.map((entry) => entry.uri),
	},
})

/** The candidate identifiers the fixture's resource template completes to. */
export const CONFORMANCE_IDENTIFIERS: readonly string[] = Object.freeze(['123', '456', '789'])

/**
 * Project one candidate list onto the fragment the client has typed so far.
 *
 * @param candidates - Every value the reference could complete to
 * @param value - The fragment already typed
 * @returns The matching candidates plus the unprojected total
 */
export function buildConformanceCompletion(
	candidates: readonly string[],
	value: string,
): MCPCompletion {
	return {
		values: candidates.filter((candidate) => candidate.startsWith(value)),
		total: candidates.length,
	}
}

// ── The assembled host ───────────────────────────────────────────────────────

/**
 * Build the whole conformance host — every port `MCPServerOptions` publishes, backed by
 * the plain objects above.
 *
 * @returns The server options one `createMCPServer` call away from a live fixture
 */
export function buildConformanceOptions(): MCPServerOptions {
	const resources: MCPResourceManagerInterface = {
		resources: () => ({ resources: CONFORMANCE_RESOURCES }),
		resource: (params) => CONFORMANCE_CONTENTS[params.uri] ?? readConformanceTemplate(params.uri),
		templates: () => ({
			resourceTemplates: [
				{
					uriTemplate: CONFORMANCE_DESCRIPTOR,
					name: 'template-data',
					description: 'One JSON document per identifier.',
					mimeType: 'application/json',
				},
			],
		}),
	}
	const prompts: MCPPromptManagerInterface = {
		prompts: () => ({ prompts: CONFORMANCE_PROMPTS }),
		prompt: (params) => {
			const messages = buildConformanceMessages(params.name, params.arguments ?? {})
			if (messages === undefined) return undefined
			const prompt = CONFORMANCE_PROMPTS.find((entry) => entry.name === params.name)
			if (prompt === undefined) return undefined
			return {
				resultType: 'complete',
				...(prompt.description === undefined ? {} : { description: prompt.description }),
				messages,
			}
		},
	}
	const completion: MCPCompletionManagerInterface = {
		complete: (params) => {
			const ref = params.ref
			if (ref.type === 'ref/prompt') {
				const prompt = CONFORMANCE_PROMPTS.find((entry) => entry.name === ref.name)
				if (prompt === undefined) return undefined
				const candidates = CONFORMANCE_CANDIDATES[ref.name]?.[params.argument.name] ?? []
				return buildConformanceCompletion(candidates, params.argument.value)
			}
			const known = CONFORMANCE_TEMPLATE.test(ref.uri) || ref.uri === CONFORMANCE_DESCRIPTOR
			if (!known) return undefined
			return buildConformanceCompletion(CONFORMANCE_IDENTIFIERS, params.argument.value)
		},
	}
	return {
		identity: CONFORMANCE_IDENTITY,
		tools: buildConformanceTools(),
		resources,
		prompts,
		completion,
		execution: async (context) => {
			// The request-scoped reporter exists only when the caller sent a `progressToken`, and
			// reporting is the executor's job rather than the server's — the port hands the reporter
			// over and the work decides what a step is. `tools-call-with-progress` specifies the three
			// steps below exactly (0/100, 50/100, 100/100) and counts them, so the fixture reports
			// what the scenario asks for rather than a shape of its own.
			if (context.progress !== undefined) {
				await context.progress.report({ progress: 0, total: 100 })
				await context.progress.report({ progress: 50, total: 100 })
				await context.progress.report({ progress: 100, total: 100 })
			}
			const content = CONFORMANCE_CONTENT[context.call.name]
			if (content !== undefined) return { resultType: 'complete', content }
			return await context.tools.execute(context.call)
		},
	}
}

/**
 * Start the conformance fixture on an ephemeral loopback port.
 *
 * @remarks
 * The whole spine is real: `createMCPServer` behind `createMCPRoutes` behind a real
 * `@orkestrel/server` listener, reachable over a real socket by any foreign client.
 * Call `stop()` in `afterAll`.
 *
 * @returns The started-server handle (`base` URL + `stop`)
 */
export async function startConformance(): Promise<StartedServerInterface<undefined>> {
	const mcp = createMCPServer(buildConformanceOptions())
	const dispatcher = createDispatcher<undefined>()
	dispatcher.add(createMCPRoutes<undefined>(mcp))
	return await startServer(createServer<undefined>({ dispatcher, state: () => undefined }))
}

// ── The foreign runner ───────────────────────────────────────────────────────

/**
 * Invoke the pinned conformance runner and collect everything it wrote.
 *
 * @remarks
 * `npx` is a `.cmd` shim on Windows and Node refuses to spawn one without a shell, so a
 * bare spawn dies with `ENOENT` before the runner ever starts. The shell is enabled on
 * that platform only, and every argument is a literal this file owns, so nothing is
 * interpolated into it beyond the caller's loopback URL.
 *
 * @param command - The runner subcommand and its options
 * @returns The runner's combined standard output and standard error
 */
export async function executeRunner(command: readonly string[]): Promise<string> {
	const runner = spawn('npx', ['--yes', CONFORMANCE_PACKAGE, ...command], {
		stdio: ['ignore', 'pipe', 'pipe'],
		shell: process.platform === 'win32',
	})
	const chunks: string[] = []
	runner.stdout.setEncoding('utf8')
	runner.stderr.setEncoding('utf8')
	runner.stdout.on('data', (chunk: string) => chunks.push(chunk))
	runner.stderr.on('data', (chunk: string) => chunks.push(chunk))
	await once(runner, 'close')
	return chunks.join('')
}

/**
 * Parse the runner's `=== SUMMARY ===` block.
 *
 * @param output - Everything the runner wrote
 * @returns The scenario tallies and totals, or `undefined` when it printed no summary
 */
export function parseConformance(output: string): ConformanceResult | undefined {
	const scenarios: ConformanceScenario[] = []
	for (const line of output.split(/\r?\n/)) {
		const totalled = CONFORMANCE_TOTAL.exec(line)
		if (totalled !== null) {
			const passed = totalled[1]
			const failed = totalled[2]
			if (passed === undefined || failed === undefined) return undefined
			return {
				scenarios,
				passed: Number.parseInt(passed, 10),
				failed: Number.parseInt(failed, 10),
			}
		}
		const tallied = CONFORMANCE_TALLY.exec(line)
		if (tallied === null) continue
		const name = tallied[1]
		const passed = tallied[2]
		const failed = tallied[3]
		if (name === undefined || passed === undefined || failed === undefined) continue
		scenarios.push({
			name,
			passed: Number.parseInt(passed, 10),
			failed: Number.parseInt(failed, 10),
		})
	}
	return undefined
}

/**
 * Drive the pinned runner's `server` suite against a live MCP endpoint.
 *
 * @param url - The fixture's absolute MCP endpoint
 * @returns The parsed run outcome
 * @throws When the runner produced no summary block, carrying everything it wrote
 */
export async function executeConformance(url: string): Promise<ConformanceResult> {
	const output = await executeRunner(['server', '--url', url, '--spec-version', CONFORMANCE_SPEC])
	const result = parseConformance(output)
	if (result === undefined) {
		throw new Error(
			`${CONFORMANCE_PACKAGE} printed no summary for ${url}. Its output was:\n${output}`,
		)
	}
	return result
}

/**
 * Warm the runner and prove it is the pinned build, before any scenario runs.
 *
 * @remarks
 * This is the live-service readiness gate (§16 live services): it downloads the runner
 * into the `npx` cache so the measured run does not pay for a cold fetch, and it throws
 * loudly rather than skipping when the runner cannot be reached or is the wrong build.
 *
 * @returns The version the runner reported
 * @throws When `npx` cannot produce the pinned runner, naming what to do about it
 */
export async function warmConformance(): Promise<string> {
	const output = await executeRunner(['--version'])
	for (const line of output.split(/\r?\n/)) {
		if (line.trim() === CONFORMANCE_RELEASE) return line.trim()
	}
	throw new Error(
		`The conformance project needs ${CONFORMANCE_PACKAGE}, which npx could not produce. ` +
			`Confirm this machine reaches the npm registry, then rerun \`npm run test:conformance\`. ` +
			`\`npx --yes ${CONFORMANCE_PACKAGE} --version\` wrote:\n${output}`,
	)
}

beforeAll(async () => {
	await warmConformance()
})
