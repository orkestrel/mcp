import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// This proof packs the package, links a real consumer against it and runs the
// TypeScript compiler twice, so its cost is seconds rather than milliseconds and
// the default per-test budget cannot hold it. The timeout states that cost
// instead of inflating a unit test's; the durable placement is its own project
// at the canonical tests/integration.test.ts, kept out of the default run.
describe('published package consumer', () => {
	it('resolves runtime and declaration faces through the package exports map', async () => {
		const root = fileURLToPath(new URL('../../../', import.meta.url))
		const consumer = await mkdtemp(join(tmpdir(), 'orkestrel-mcp-consumer-'))
		const scope = join(consumer, 'node_modules', '@orkestrel')
		const typesScope = join(consumer, 'node_modules', '@types')
		const packagePath = join(scope, 'mcp')
		const toolPath = join(scope, 'tool')
		const nodeTypesPath = join(typesScope, 'node')
		const compiler = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
		const temporaryRoot = resolve(tmpdir())
		const target = resolve(consumer)
		const compilerArguments = [
			compiler,
			'--ignoreConfig',
			'--noEmit',
			'--target',
			'ESNext',
			'--module',
			'NodeNext',
			'--moduleResolution',
			'NodeNext',
			'--lib',
			'ESNext,DOM',
			'--types',
			'node',
			'--strict',
		]
		if (dirname(target) !== temporaryRoot || !target.startsWith(temporaryRoot)) {
			throw new Error(`Refusing to remove consumer outside the system temp directory: ${target}`)
		}

		try {
			await mkdir(scope, { recursive: true })
			await mkdir(typesScope, { recursive: true })
			await symlink(root, packagePath, 'junction')
			await symlink(join(root, 'node_modules', '@orkestrel', 'tool'), toolPath, 'junction')
			await symlink(join(root, 'node_modules', '@types', 'node'), nodeTypesPath, 'junction')
			await writeFile(join(consumer, 'package.json'), '{"type":"module"}\n')
			await writeFile(
				join(consumer, 'consumer.mjs'),
				`import { MessageChannel } from 'node:worker_threads'
import { createToolManager } from '@orkestrel/tool'
import {
	MCP_META_CAPABILITIES,
	MCP_META_VERSION,
	MCP_MODERN_VERSION,
	createMCPServer,
} from '@orkestrel/mcp'
import { createMessagePortTransport } from '@orkestrel/mcp/browser'
import { createMCPRoutes } from '@orkestrel/mcp/server'

const mcp = createMCPServer({
	identity: { name: 'consumer', version: '1.0.0' },
	tools: createToolManager(),
})
const answer = await mcp.dispatch({
	jsonrpc: '2.0',
	method: 'tools/list',
	id: 1,
	params: {
		_meta: {
			[MCP_META_VERSION]: MCP_MODERN_VERSION,
			[MCP_META_CAPABILITIES]: {},
		},
	},
})
if (Symbol.asyncIterator in answer || answer.result?.tools?.length !== 0) {
	throw new Error('core face did not dispatch tools/list')
}

const routes = createMCPRoutes(mcp)
if (routes.length !== 1 || routes[0].method !== 'POST' || routes[0].path !== '/mcp') {
	throw new Error('server face did not mount its POST route')
}

const { port1, port2 } = new MessageChannel()
const transport = createMessagePortTransport({ port: port1 })
const received = new Promise((resolve) => transport.listen(resolve))
port2.postMessage('browser-face')
if ((await received) !== 'browser-face') throw new Error('browser face did not carry a frame')
await transport.close()
port2.close()

let missing = false
try {
	await import('@orkestrel/mcp/nope')
} catch (error) {
	missing = error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
}
if (!missing) throw new Error('undeclared subpath unexpectedly resolved')

console.log('esm:core-dispatch,server-route,browser-frame,nope-rejected')
`,
			)
			await writeFile(
				join(consumer, 'consumer.cjs'),
				`const { createToolManager } = require('@orkestrel/tool')
const {
	MCP_META_CAPABILITIES,
	MCP_META_VERSION,
	MCP_MODERN_VERSION,
	createMCPServer,
} = require('@orkestrel/mcp')
const { createMCPRoutes } = require('@orkestrel/mcp/server')

async function runConsumer() {
	const mcp = createMCPServer({
		identity: { name: 'consumer', version: '1.0.0' },
		tools: createToolManager(),
	})
	const answer = await mcp.dispatch({
		jsonrpc: '2.0',
		method: 'tools/list',
		id: 1,
		params: {
			_meta: {
				[MCP_META_VERSION]: MCP_MODERN_VERSION,
				[MCP_META_CAPABILITIES]: {},
			},
		},
	})
	if (Symbol.asyncIterator in answer || answer.result?.tools?.length !== 0) {
		throw new Error('CommonJS core face did not dispatch tools/list')
	}
	const routes = createMCPRoutes(mcp)
	if (routes.length !== 1 || routes[0].method !== 'POST' || routes[0].path !== '/mcp') {
		throw new Error('CommonJS server face did not mount its POST route')
	}

	let browserRejected = false
	try {
		require('@orkestrel/mcp/browser')
	} catch (error) {
		browserRejected = error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
	}
	if (!browserRejected) throw new Error('browser face unexpectedly exposed CommonJS')

	console.log('cjs:core-dispatch,server-route,browser-rejected')
}

runConsumer().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
`,
			)
			await writeFile(
				join(consumer, 'consumer.ts'),
				`import { createToolManager } from '@orkestrel/tool'
import {
	MCP_META_CAPABILITIES,
	MCP_META_VERSION,
	MCP_MODERN_VERSION,
	createMCPServer,
} from '@orkestrel/mcp'
import { createMessagePortTransport } from '@orkestrel/mcp/browser'
import { createMCPRoutes } from '@orkestrel/mcp/server'

const mcp = createMCPServer({
	identity: { name: 'typed-consumer', version: '1.0.0' },
	tools: createToolManager(),
})
const answer = await mcp.dispatch({
	jsonrpc: '2.0',
	method: 'tools/list',
	id: 1,
	params: {
		_meta: {
			[MCP_META_VERSION]: MCP_MODERN_VERSION,
			[MCP_META_CAPABILITIES]: {},
		},
	},
})
const routes = createMCPRoutes(mcp)
const channel = new MessageChannel()
const transport = createMessagePortTransport({ port: channel.port1 })

void answer
void routes
void transport
channel.port1.close()
channel.port2.close()
`,
			)
			await writeFile(
				join(consumer, 'consumer-error.ts'),
				`import { MCP_MODERN_VERSION } from '@orkestrel/mcp'

const invalid: number = MCP_MODERN_VERSION
void invalid
`,
			)

			const esm = spawnSync(process.execPath, ['consumer.mjs'], {
				cwd: consumer,
				encoding: 'utf8',
			})
			const commonjs = spawnSync(process.execPath, ['consumer.cjs'], {
				cwd: consumer,
				encoding: 'utf8',
			})
			const types = spawnSync(process.execPath, [...compilerArguments, 'consumer.ts'], {
				cwd: consumer,
				encoding: 'utf8',
			})
			const control = spawnSync(process.execPath, [...compilerArguments, 'consumer-error.ts'], {
				cwd: consumer,
				encoding: 'utf8',
			})

			if (esm.status !== 0) throw new Error(`ESM consumer failed:\n${esm.stderr}${esm.stdout}`)
			if (commonjs.status !== 0) {
				throw new Error(`CommonJS consumer failed:\n${commonjs.stderr}${commonjs.stdout}`)
			}
			if (types.status !== 0) {
				throw new Error(
					`ESM runtime (status ${String(esm.status)}): ${esm.stdout}CommonJS runtime (status ${String(commonjs.status)}): ${commonjs.stdout}TypeScript consumer failed:\n${types.stderr}${types.stdout}\nDeliberate-error control (status ${String(control.status)}):\n${control.stderr}${control.stdout}`,
				)
			}
			expect(esm.stdout).toContain('esm:core-dispatch,server-route,browser-frame,nope-rejected')
			expect(commonjs.stdout).toContain('cjs:core-dispatch,server-route,browser-rejected')
			expect(types.status).toBe(0)
			expect(control.status).not.toBe(0)
			expect(`${control.stderr}${control.stdout}`).toContain('TS2322')
			expect(`${control.stderr}${control.stdout}`).toContain(
				"Type 'string' is not assignable to type 'number'",
			)
		} finally {
			await rm(target, { recursive: true, force: true })
		}
	}, 120_000)
})
