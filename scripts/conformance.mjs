// @ts-check

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { createTool, createToolManager } from '@orkestrel/tool'
import { createMCPServer } from '../dist/src/core/index.js'
import { createMCPRoutes } from '../dist/src/server/index.js'

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
		execute: () => [
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
		execute: (arguments_) => arguments_,
	}),
)

// The rich content blocks four scenarios ask for VERBATIM. A plain `execute` return is an
// ordinary domain value, and the server normalizes one into text plus `structuredContent`
// exactly as it should — so a fixture with no `execution` port cannot answer an image, an
// audio clip, an embedded resource, or a mixed sequence, and its failures measure the fixture
// rather than the library. `MCPServerOptions.execution` is the shipped, documented port for
// precisely this, so the fixture uses it and the number below is about this package.
/** @type {Readonly<Record<string, readonly import('../src/core/types.js').MCPContent[]>>} */
const RICH_CONTENT = {
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
}

// The three host-owned registries the Resources, Prompts, and completion ports project. Each is
// an ordinary in-memory object — deliberately NOT a workspace and not a template engine — because
// the ports are ports: what backs them is the host's decision and this file is one host's answer.
/** @type {readonly import('../src/core/types.js').MCPResource[]} */
const STATIC_RESOURCES = [
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
]
/** @type {Readonly<Record<string, readonly import('../src/core/types.js').MCPResourceContents[]>>} */
const STATIC_CONTENTS = {
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
}
// The template is published as a DESCRIPTOR and matched HERE. MCP expands nothing: it forwards
// the already-concrete `test://template/123/data` the client sent, and the party that owns the
// template owns knowing its variables. `scenario resources-templates-read` sends the substituted
// URI for exactly this reason, so a template engine inside MCP would have nothing to do.
const TEMPLATE_URI = /^test:\/\/template\/([^/]+)\/data$/

/** @type {import('../src/core/types.js').MCPResourceManagerInterface} */
const resources = {
	resources: () => ({ resources: STATIC_RESOURCES }),
	resource: (params) => {
		const contents = STATIC_CONTENTS[params.uri]
		if (contents !== undefined) return contents
		const matched = TEMPLATE_URI.exec(params.uri)
		if (matched === null) return undefined
		const id = matched[1]
		return [
			{
				uri: params.uri,
				mimeType: 'application/json',
				text: JSON.stringify({ id, templateTest: true, data: `Data for ID: ${id}` }),
			},
		]
	},
	templates: () => ({
		resourceTemplates: [
			{
				uriTemplate: 'test://template/{id}/data',
				name: 'template-data',
				description: 'One JSON document per identifier.',
				mimeType: 'application/json',
			},
		],
	}),
}

/** @type {readonly import('../src/core/types.js').MCPPrompt[]} */
const PROMPTS = [
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
]
// `arguments` are strings by contract, so filling a prompt is the host's own substitution — the
// same division as the templates above. MCP validates the argument record and forwards it.
/**
 * @type {Readonly<Record<
 *   string,
 *   (values: Readonly<Record<string, string>>) => readonly import('../src/core/types.js').MCPPromptMessage[]
 * >>}
 */
const PROMPT_MESSAGES = {
	test_simple_prompt: () => [
		{ role: 'user', content: { type: 'text', text: 'This is a simple prompt for testing.' } },
	],
	test_prompt_with_arguments: (values) => [
		{
			role: 'user',
			content: {
				type: 'text',
				text: `Prompt with arguments: arg1='${values.arg1 ?? ''}', arg2='${values.arg2 ?? ''}'`,
			},
		},
	],
	test_prompt_with_embedded_resource: (values) => [
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
	],
	test_prompt_with_image: () => [
		{ role: 'user', content: { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' } },
		{ role: 'user', content: { type: 'text', text: 'Please analyze the image above.' } },
	],
}

/** @type {import('../src/core/types.js').MCPPromptManagerInterface} */
const prompts = {
	prompts: () => ({ prompts: PROMPTS }),
	prompt: (params) => {
		const build = PROMPT_MESSAGES[params.name]
		if (build === undefined) return undefined
		const prompt = PROMPTS.find((entry) => entry.name === params.name)
		if (prompt === undefined) return undefined
		return {
			resultType: 'complete',
			...(prompt.description === undefined ? {} : { description: prompt.description }),
			messages: build(params.arguments ?? {}),
		}
	},
}

// Completion is a top-level capability, independent of the other two: the host owns reference
// lookup for BOTH arms, because the party that expands a template is the party that knows its
// variables. A reference this host does not recognize answers `undefined`, which MCP maps to
// `-32602` rather than inventing an empty candidate list.
/** @type {Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>} */
const PROMPT_CANDIDATES = {
	test_prompt_with_arguments: {
		arg1: ['testValue1', 'testAlpha', 'production'],
		arg2: ['testValue2', 'testBeta', 'staging'],
	},
	test_prompt_with_embedded_resource: { resourceUri: STATIC_RESOURCES.map((entry) => entry.uri) },
}
/** @type {import('../src/core/types.js').MCPCompletionManagerInterface} */
const completion = {
	complete: (params) => {
		if (params.ref.type === 'ref/prompt') {
			const name = params.ref.name
			const prompt = PROMPTS.find((entry) => entry.name === name)
			if (prompt === undefined) return undefined
			const candidates = PROMPT_CANDIDATES[name]?.[params.argument.name] ?? []
			return {
				values: candidates.filter((value) => value.startsWith(params.argument.value)),
				total: candidates.length,
			}
		}
		if (!TEMPLATE_URI.test(params.ref.uri) && params.ref.uri !== 'test://template/{id}/data') {
			return undefined
		}
		const candidates = ['123', '456', '789']
		return {
			values: candidates.filter((value) => value.startsWith(params.argument.value)),
			total: candidates.length,
		}
	},
}

/** @type {import('../src/core/types.js').MCPServerOptions} */
const options = {
	identity: { name: 'orkestrel-conformance', version: '0.0.9' },
	tools,
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
		const content = RICH_CONTENT[context.call.name]
		if (content !== undefined) return { resultType: 'complete', content }
		return await context.tools.execute(context.call)
	},
}
/** @type {import('../src/core/types.js').MCPServerInterface} */
const mcp = createMCPServer(options)
const dispatcher = createDispatcher()
dispatcher.add(createMCPRoutes(mcp))
const server = createServer({ dispatcher, state: () => undefined })
const port = await server.start()
const url = `http://127.0.0.1:${String(port)}/mcp`
const conformanceArguments = [
	'--yes',
	'@modelcontextprotocol/conformance@0.2.0-alpha.10',
	'server',
	'--url',
	url,
	'--spec-version',
	'2026-07-28',
]
let exitCode = 1

console.log(`Conformance target: ${url}`)
console.log('Expected baseline: 23 passed / 0 failed, dns-rebinding-protection included.')
console.log(
	'This number has been wrong twice, in the same way, and both times the fixture was the cause.',
)
console.log(
	'8/15 measured a fixture with no `execution` port; 13/10 measured one with no `resources`,',
)
console.log(
	'`prompts`, or `completion` port. Each omission failed scenarios the library already answers,',
)
console.log(
	'and each correction moved the number with NO change to src/ or dist/. A recorded baseline',
)
console.log('must measure the product, not the harness — so read this file before quoting it.')

try {
	// `npx` is a `.cmd` shim on Windows, and Node refuses to spawn one without a shell, so a
	// bare spawn dies with ENOENT before the runner ever starts. The shell is enabled on that
	// platform only; every argument here is a literal this file owns, so nothing is interpolated.
	const conformance = spawn('npx', conformanceArguments, {
		stdio: 'inherit',
		shell: process.platform === 'win32',
	})
	const [code, signal] = await once(conformance, 'exit')
	if (signal !== null) throw new Error(`Conformance runner exited on signal ${String(signal)}`)
	exitCode = typeof code === 'number' ? code : 1
} finally {
	await server.stop()
	await server.destroy()
}

process.exitCode = exitCode
