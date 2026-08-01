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

const mcp = createMCPServer({
	identity: { name: 'orkestrel-conformance', version: '0.0.9' },
	tools,
})
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
console.log(
	'Expected baseline: 8 passed / 15 failed; dns-rebinding-protection: 2 passed / 0 failed',
)

try {
	const conformance = spawn('npx', conformanceArguments, { stdio: 'inherit' })
	const [code, signal] = await once(conformance, 'exit')
	if (signal !== null) throw new Error(`Conformance runner exited on signal ${String(signal)}`)
	exitCode = typeof code === 'number' ? code : 1
} finally {
	await server.stop()
	await server.destroy()
}

process.exitCode = exitCode
