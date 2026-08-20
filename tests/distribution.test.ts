import { spawnSync } from 'node:child_process'
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import * as ts from 'typescript'

// The consumer this proof builds is the only subject that answers for the published artifact. A
// specifier resolved from this repository reaches the repository's own manifest, or the copy of an
// earlier release installed under `node_modules`, so every assertion below is rooted in the
// temporary consumer instead.
//
// This package publishes a `./browser` face its siblings do not, and it is deliberately
// asymmetric: `./browser` declares an `import` condition and no `require` one, because a browser
// build has no CommonJS consumer to serve. That asymmetry is asserted rather than skipped — a
// `require` of the browser face must be REFUSED, and a face that quietly grew a `require` target
// would be a change to the published contract that nothing else here would notice.

/** Each published face, its export key, and whether the manifest offers it to `require`. */
const FACES = Object.freeze([
	{ name: 'core', specifier: '@orkestrel/mcp', path: 'dist/src/core/index.d.ts', commonJS: true },
	{
		name: 'browser',
		specifier: '@orkestrel/mcp/browser',
		path: 'dist/src/browser/index.d.ts',
		commonJS: false,
	},
	{
		name: 'server',
		specifier: '@orkestrel/mcp/server',
		path: 'dist/src/server/index.d.ts',
		commonJS: true,
	},
])

/** Files npm includes independently of the manifest's `files` allowlist. */
const NPM_REQUIRED_FILES = Object.freeze(['LICENSE', 'package.json'])

/** The stdio peer the handshake rows drive: the packed server, reachable at every revision. */
const HANDSHAKE_PEER = `import { createMCPLegacy, createMCPServer } from '@orkestrel/mcp'
import { createStdioServer } from '@orkestrel/mcp/server'
import { createTool, createToolManager } from '@orkestrel/tool'

const tools = createToolManager()
tools.add(createTool({ name: 'add', execute: () => 5 }))
const mcp = createMCPServer({ identity: { name: 'handshake-peer', version: '1.0.0' }, tools })
createStdioServer(createMCPLegacy(mcp)).start()
`

/**
 * The red control's peer: a scripted stdio server with no modern seam.
 *
 * It speaks the wire protocol and nothing else — every non-`initialize` request is refused the
 * way a legacy-era server refuses an unknown method, and `initialize` is answered normally. It
 * reimplements no behavior this package owns: the client under test is the whole subject, and
 * this peer exists only to be the era the client must decide about.
 */
const HANDSHAKE_LEGACY_PEER = `let buffer = ''

function send(message) {
	process.stdout.write(JSON.stringify(message) + '\\n')
}

function answer(request) {
	if (request.id === undefined) return
	if (request.method === 'initialize') {
		send({
			jsonrpc: '2.0',
			id: request.id,
			result: {
				protocolVersion: request.params.protocolVersion,
				capabilities: {},
				serverInfo: { name: 'legacy-only-peer', version: '1.0.0' },
			},
		})
		return
	}
	send({
		jsonrpc: '2.0',
		id: request.id,
		error: { code: -32601, message: 'Method not found: ' + request.method },
	})
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
	buffer += chunk
	let newline = buffer.indexOf('\\n')
	while (newline !== -1) {
		const line = buffer.slice(0, newline)
		buffer = buffer.slice(newline + 1)
		if (line.length > 0) answer(JSON.parse(line))
		newline = buffer.indexOf('\\n')
	}
})
`

/**
 * The peer the refused pin names: it records that it ran, and does nothing else.
 *
 * A construction that refuses before the transport starts leaves this file unwritten, so its
 * absence is what "before any child spawns" means as a measurement rather than as a claim.
 */
const HANDSHAKE_MARKER_PEER = `import { writeFileSync } from 'node:fs'

writeFileSync(new URL('./spawned.txt', import.meta.url), 'the refused pin spawned a child\\n')
`

/**
 * The driver: one cold-spawned child per row, the client's outbound methods recorded.
 *
 * The recorder is a proxy over the REAL transport — it forwards every member and appends each
 * outbound method name — so a row's reading names the era the client actually chose, not the
 * era its negotiated revision implies. Each row's options arrive as parsed JSON, so a pin the
 * supported set excludes reaches the constructor as data rather than as a literal the compiler
 * would have refused first.
 */
const HANDSHAKE_DRIVER = `import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createMCPClient } from '@orkestrel/mcp'
import { createStdioClientTransport } from '@orkestrel/mcp/server'

function record(transport, methods) {
	return new Proxy(transport, {
		get(target, key) {
			if (key === 'send') {
				return async (message) => {
					if (typeof message.method === 'string') methods.push(message.method)
					await target.send(message)
				}
			}
			const value = Reflect.get(target, key, target)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
}

const rows = JSON.parse(readFileSync(new URL('./rows.json', import.meta.url), 'utf8'))
const readings = []

for (const row of rows) {
	const methods = []
	const transport = record(
		createStdioClientTransport({
			command: process.execPath,
			args: [fileURLToPath(new URL('./' + row.peer, import.meta.url))],
		}),
		methods,
	)
	let client
	try {
		client = createMCPClient({
			transport,
			identity: { name: 'handshake-driver', version: '1.0.0' },
			...row.options,
		})
	} catch (error) {
		readings.push({ label: row.label, phase: 'construct', message: error.message, code: error.code, methods })
		continue
	}
	try {
		await client.connect()
		readings.push({ label: row.label, phase: 'connect', version: client.version, methods })
	} catch (error) {
		readings.push({ label: row.label, phase: 'connect', message: error.message, code: error.code, methods })
	} finally {
		try {
			await client.disconnect()
		} catch {}
	}
}

writeFileSync(new URL('./readings.json', import.meta.url), JSON.stringify(readings))
`

/**
 * Each handshake row that must NEGOTIATE, with the revision it lands on and the methods the
 * client writes to get there.
 *
 * The method list is the discriminator: a legacy pin that reached its revision through
 * `server/discover` would satisfy the revision alone, and the eras differ in what they ask.
 *
 * The pin branches a conforming peer cannot exercise — the lying-peer legacy mismatch, the
 * discovery-omitting modern pin, and the applied probe deadline — are bound red-then-green by
 * the client proofs in `tests/src/core/MCPClient.test.ts`, so this matrix's subject is
 * end-to-end negotiation of the installed artifact.
 */
const HANDSHAKE = Object.freeze([
	{
		label: 'unpinned with no deadline',
		peer: 'peer.mjs',
		options: {},
		version: '2026-07-28',
		methods: ['server/discover'],
	},
	{
		label: 'unpinned with a configured deadline',
		peer: 'peer.mjs',
		options: { timeout: 15_000 },
		version: '2026-07-28',
		methods: ['server/discover'],
	},
	{
		label: 'pinned to the modern revision',
		peer: 'peer.mjs',
		options: { version: '2026-07-28', timeout: 15_000 },
		version: '2026-07-28',
		methods: ['server/discover'],
	},
	{
		label: 'pinned to 2025-11-25',
		peer: 'peer.mjs',
		options: { version: '2025-11-25', timeout: 15_000 },
		version: '2025-11-25',
		methods: ['initialize', 'notifications/initialized'],
	},
	{
		label: 'pinned to 2025-06-18',
		peer: 'peer.mjs',
		options: { version: '2025-06-18', timeout: 15_000 },
		version: '2025-06-18',
		methods: ['initialize', 'notifications/initialized'],
	},
	{
		label: 'unpinned against a peer with no modern seam',
		peer: 'legacy.mjs',
		options: { timeout: 15_000 },
		version: '2025-11-25',
		methods: ['server/discover', 'initialize', 'notifications/initialized'],
	},
])

/** Read one reading out of the driver's report, failing loudly rather than asserting on absence. */
function readHandshake(readings: unknown, label: string): unknown {
	if (!Array.isArray(readings)) throw new Error('the handshake driver reported no readings')
	const reading = readings.find((entry) => readField(entry, 'label') === label)
	if (reading === undefined) throw new Error(`the handshake driver skipped the row: ${label}`)
	return reading
}

/**
 * The value declarations one built `.d.ts` entry exposes, deduplicated and sorted.
 *
 * An overload pair declares one name twice — `buildModernResult` does — so the raw statement
 * count exceeds the export count while the two SETS still agree. The set is the claim.
 */
function readDeclaredNames(path: string): readonly string[] {
	const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
	const names = new Set<string>()
	for (const statement of source.statements) {
		if (
			(ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isEnumDeclaration(statement)) &&
			statement.name !== undefined
		) {
			names.add(statement.name.text)
		}
		if (ts.isVariableStatement(statement)) {
			for (const value of statement.declarationList.declarations) {
				if (ts.isIdentifier(value.name)) names.add(value.name.text)
			}
		}
	}
	return [...names].sort()
}

/** Read one string-keyed field off a value this proof has not yet narrowed. */
function readField(value: unknown, key: string): unknown {
	if (typeof value !== 'object' || value === null) return undefined
	return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Narrow a loaded entry's reported export list, failing loudly rather than degrading. */
function readNameList(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value) || !value.every((name) => typeof name === 'string')) {
		throw new Error(`${label} returned an invalid export set`)
	}
	return value
}

/** Read the package-relative paths reported by `npm pack --json`. */
function readPackedPaths(value: unknown): readonly string[] {
	const entries = readField(value, 'files')
	if (!Array.isArray(entries)) throw new Error('npm pack returned no file inventory')
	const paths: string[] = []
	for (const entry of entries) {
		const path = readField(entry, 'path')
		if (typeof path !== 'string') throw new Error('npm pack returned an invalid file inventory')
		paths.push(path)
	}
	return paths.sort()
}

/** Read the manifest paths that admit package content. */
function readManifestFiles(value: unknown): readonly string[] {
	const entries = readField(value, 'files')
	if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === 'string')) {
		throw new Error('The package manifest carries no file allowlist')
	}
	return entries
}

/** Report whether one packed path belongs to the manifest or npm's required metadata. */
function allowsPackedPath(path: string, allowlist: readonly string[]): boolean {
	if (NPM_REQUIRED_FILES.includes(path)) return true
	return allowlist.some(
		(entry) => path === entry || path.startsWith(`${entry.replace(/\/$/u, '')}/`),
	)
}

/** Return every packed path outside the manifest and npm-required population. */
function findUnexpectedPackedPaths(
	paths: readonly string[],
	allowlist: readonly string[],
): readonly string[] {
	return paths.filter((path) => !allowsPackedPath(path, allowlist)).sort()
}

/**
 * Pack the package, install the tarball into `consumer`, and provision the runtimes it names.
 *
 * Returns the packed inventory so a caller can assert what the tarball carries. Both proofs in
 * this file need the same consumer, and a second copy of this sequence would be a second thing
 * to keep honest.
 */
function buildPackedConsumer(root: string, scratch: string, consumer: string): readonly string[] {
	const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', scratch], {
		cwd: root,
		encoding: 'utf8',
	})
	if (pack.error !== undefined || pack.status !== 0) {
		throw new Error(`npm pack failed: ${pack.error?.message ?? pack.stderr}`)
	}
	const packed: unknown = JSON.parse(pack.stdout)
	if (!Array.isArray(packed)) throw new Error('npm pack returned no artifact list')
	const [packedArtifact] = packed
	const filename = readField(packedArtifact, 'filename')
	if (typeof filename !== 'string') throw new Error('npm pack returned no artifact filename')
	const packedPaths = readPackedPaths(packedArtifact)
	const tarball = join(scratch, filename)

	mkdirSync(consumer, { recursive: true })
	writeFileSync(
		join(consumer, 'package.json'),
		JSON.stringify({ name: 'mcp-distribution-consumer', private: true, type: 'module' }),
	)
	const install = spawnSync(
		'npm',
		['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
		{ cwd: consumer, encoding: 'utf8' },
	)
	const packageRoot = join(consumer, 'node_modules', '@orkestrel', 'mcp')
	if (install.status !== 0 || install.error !== undefined) {
		const code = readField(install.error, 'code')
		const denied = code === 'EPERM' || install.stderr.includes('EPERM')
		// `--mode release` is how the publish gate runs this file. An install that never happened
		// is a failure there rather than a fallback: extracting the tarball proves that it unpacks
		// and says nothing about whether a consumer can install it. An ordinary local run inside a
		// sandbox that denies a nested install still falls back.
		if (!denied || import.meta.env.MODE === 'release') {
			throw new Error(`npm install failed: ${install.error?.message ?? install.stderr}`)
		}
		const extraction = join(scratch, 'extraction')
		mkdirSync(extraction, { recursive: true })
		const unpack = spawnSync('tar', ['-xzf', tarball, '-C', extraction], { encoding: 'utf8' })
		if (unpack.error !== undefined || unpack.status !== 0) {
			throw new Error(`tar extraction failed: ${unpack.error?.message ?? unpack.stderr}`)
		}
		mkdirSync(dirname(packageRoot), { recursive: true })
		cpSync(join(extraction, 'package'), packageRoot, { recursive: true })
	}

	// Every runtime the package names must be resolvable from the consumer. A denied nested
	// install leaves them missing, and the peers are the consumer's to supply either way, so
	// the list is derived from the packed manifest rather than written down twice.
	const manifest: unknown = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
	const required = new Set<string>()
	for (const field of ['dependencies', 'peerDependencies']) {
		const declared = readField(manifest, field)
		if (typeof declared !== 'object' || declared === null) continue
		for (const name of Object.keys(declared)) required.add(name)
	}
	const require = createRequire(import.meta.url)
	for (const dependency of required) {
		const target = join(consumer, 'node_modules', ...dependency.split('/'))
		if (existsSync(target)) continue
		mkdirSync(dirname(target), { recursive: true })
		cpSync(dirname(require.resolve(`${dependency}/package.json`)), target, { recursive: true })
	}
	return packedPaths
}

it('installs the packed artifact and drives its faces, declarations, and resolution modes', () => {
	const root = fileURLToPath(new URL('../', import.meta.url))
	const scratch = mkdtempSync(join(tmpdir(), 'orkestrel-mcp-distribution-'))
	let controlDirectory: string | undefined

	try {
		controlDirectory = mkdtempSync(join(root, 'mcp-distribution-control-'))
		const controlFile = join(controlDirectory, 'unexpected.txt')
		const controlPath = relative(root, controlFile).replaceAll('\\', '/')
		// The control lives at the package root, outside the manifest `files` allowlist, so its
		// absence from the tarball proves the allowlist without a rival gitignore explanation.
		writeFileSync(controlFile, 'packed inventory negative control\n')
		const sourceManifest: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
		const allowlist = readManifestFiles(sourceManifest)
		const consumer = join(scratch, 'consumer')
		const packedPaths = buildPackedConsumer(root, scratch, consumer)
		const packageRoot = join(consumer, 'node_modules', '@orkestrel', 'mcp')
		expect(findUnexpectedPackedPaths(packedPaths, allowlist)).toEqual([])
		expect(packedPaths).not.toContain(controlPath)
		expect(findUnexpectedPackedPaths([...packedPaths, controlPath], allowlist)).toEqual([
			controlPath,
		])

		const manifest: unknown = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
		const exportsValue = readField(manifest, 'exports')
		if (typeof exportsValue !== 'object' || exportsValue === null) {
			throw new Error('The packed manifest carries no exports')
		}

		// Classify every absent export target at the boundary that omitted it.
		const targets: unknown[] = [exportsValue]
		const targetIssues: string[] = []
		let targetCount = 0
		while (targets.length > 0) {
			const target = targets.pop()
			if (typeof target === 'string') {
				if (target.startsWith('./')) {
					const path = target.slice(2)
					if (!allowsPackedPath(path, allowlist)) {
						targetIssues.push(`manifest excludes export target: ${target}`)
					} else if (!existsSync(join(root, path))) {
						targetIssues.push(`build output misses export target: ${target}`)
					} else if (!packedPaths.includes(path)) {
						targetIssues.push(`packed inventory misses export target: ${target}`)
					}
					targetCount += 1
				}
				continue
			}
			if (typeof target === 'object' && target !== null) targets.push(...Object.values(target))
		}
		expect(targetIssues).toEqual([])
		expect(targetCount).toBeGreaterThan(0)

		// The `require` map, read from the consumer. `./browser` is refused for the same reason
		// `./absent` is — the manifest offers neither to a CommonJS caller — and the control drawn
		// from outside the published subpath set is what makes that refusal a measurement.
		const consumerRequire = createRequire(join(consumer, 'control.cjs'))
		expect(() => consumerRequire.resolve('@orkestrel/mcp/absent')).toThrow(/Package subpath/u)
		expect(() => consumerRequire.resolve('@orkestrel/mcp/browser')).toThrow(/Package subpath/u)
		for (const face of FACES.filter((candidate) => candidate.commonJS)) {
			expect(consumerRequire.resolve(face.specifier)).toContain('@orkestrel')
		}

		const declared = new Map<string, readonly string[]>()
		for (const face of FACES) {
			const names = readDeclaredNames(join(packageRoot, face.path))
			expect(names.length).toBeGreaterThan(0)
			declared.set(face.name, names)
		}
		// The surface each face published on 2026-08-20, pinned so a silent shrink is visible. A
		// deliberate export change moves these numbers in the same commit.
		expect(declared.get('core')).toHaveLength(139)
		expect(declared.get('browser')).toHaveLength(19)
		expect(declared.get('server')).toHaveLength(44)

		// The negative control for the parity comparison below, drawn from OUTSIDE the population
		// it covers: `isRecord` is `@orkestrel/contract`'s and no face here republishes it. The
		// comparison must report a difference when it is planted, or an equal result means nothing.
		const planted = 'isRecord'
		for (const [name, names] of declared) {
			expect(names, `${name} unexpectedly publishes the control name`).not.toContain(planted)
			expect(names).not.toEqual([...names, planted].sort())
		}

		writeFileSync(
			join(consumer, 'import.mjs'),
			[
				"import * as core from '@orkestrel/mcp'",
				"import * as browser from '@orkestrel/mcp/browser'",
				"import * as server from '@orkestrel/mcp/server'",
				'console.log(JSON.stringify({',
				'core:Object.keys(core).sort(),',
				'browser:Object.keys(browser).sort(),',
				'server:Object.keys(server).sort(),',
				"coreCall:core.parseJSONRPCMessage({jsonrpc:'2.0',method:'ping'})!==undefined,",
				"browserCall:browser.decodeEvent('not json')===undefined,",
				"serverCall:typeof server.createStdioClientTransport({command:'node'}).session,",
				'}))',
			].join('\n'),
		)
		writeFileSync(
			join(consumer, 'require.cjs'),
			[
				"const core = require('@orkestrel/mcp')",
				"const server = require('@orkestrel/mcp/server')",
				'console.log(JSON.stringify({',
				'core:Object.keys(core).sort(),',
				'server:Object.keys(server).sort(),',
				"coreCall:core.parseJSONRPCMessage({jsonrpc:'2.0',method:'ping'})!==undefined,",
				"serverCall:typeof server.createStdioClientTransport({command:'node'}).session,",
				'}))',
			].join('\n'),
		)

		for (const entry of ['import.mjs', 'require.cjs']) {
			const loaded = spawnSync(process.execPath, [join(consumer, entry)], {
				cwd: consumer,
				encoding: 'utf8',
			})
			if (loaded.error !== undefined || loaded.status !== 0) {
				throw new Error(`${entry} failed: ${loaded.error?.message ?? loaded.stderr}`)
			}
			const result: unknown = JSON.parse(loaded.stdout)
			const formatFaces = FACES.filter((face) => entry === 'import.mjs' || face.commonJS)
			for (const face of formatFaces) {
				expect(readNameList(readField(result, face.name), `${entry} ${face.name}`)).toEqual(
					declared.get(face.name),
				)
			}
			// A loaded module whose exports are named correctly can still be inert, so each face
			// answers one call whose value the source could not have guessed wrong silently.
			expect(readField(result, 'coreCall')).toBe(true)
			expect(readField(result, 'serverCall')).toBe('undefined')
			// The browser face has no `require` target, so the CommonJS entry reports no reading for
			// it at all. Asserting that absence keeps this row unconditional AND pins the asymmetry.
			expect(readField(result, 'browserCall')).toBe(entry === 'import.mjs' ? true : undefined)
		}

		// The `moduleResolution` floor `README.md` states, compiled rather than asserted as a
		// sentence. Each mode builds a program over one consumer file importing every face,
		// with library checking on so the package's own declarations are read instead of skipped.
		const consumerSource = join(consumer, 'consumer.ts')
		writeFileSync(
			consumerSource,
			[
				"import { createMCPServer, type JSONRPCMessage } from '@orkestrel/mcp'",
				"import { decodeEvent } from '@orkestrel/mcp/browser'",
				"import { createStdioClientTransport } from '@orkestrel/mcp/server'",
				"export const decoded: JSONRPCMessage | undefined = decodeEvent('{}')",
				'export const build: typeof createMCPServer = createMCPServer',
				'export const spawn: typeof createStdioClientTransport = createStdioClientTransport',
			].join('\n'),
		)
		const modes = [
			{
				name: 'node16',
				module: ts.ModuleKind.Node16,
				resolution: ts.ModuleResolutionKind.Node16,
				supported: true,
			},
			{
				name: 'nodenext',
				module: ts.ModuleKind.NodeNext,
				resolution: ts.ModuleResolutionKind.NodeNext,
				supported: true,
			},
			{
				name: 'bundler',
				module: ts.ModuleKind.Preserve,
				resolution: ts.ModuleResolutionKind.Bundler,
				supported: true,
			},
			// The firing control is the one named mode the requirement excludes: the published
			// manifest carries no `typesVersions`, so `./browser` and `./server` resolve no
			// declarations under classic Node resolution and the same consumer stops compiling.
			{
				name: 'node10',
				module: ts.ModuleKind.CommonJS,
				resolution: ts.ModuleResolutionKind.Node10,
				supported: false,
			},
		]
		const diagnosed: string[] = []
		const compiled: string[] = []
		for (const mode of modes) {
			const program = ts.createProgram([consumerSource], {
				module: mode.module,
				moduleResolution: mode.resolution,
				target: ts.ScriptTarget.ESNext,
				strict: true,
				skipLibCheck: false,
				noEmit: true,
				types: ['node'],
				typeRoots: [join(root, 'node_modules', '@types')],
			})
			const diagnostics = program
				.getSemanticDiagnostics()
				.concat(program.getSyntacticDiagnostics(), program.getOptionsDiagnostics())
			if (diagnostics.length > 0) {
				diagnosed.push(
					`${mode.name}: ${diagnostics
						.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))
						.join(' | ')}`,
				)
				continue
			}
			compiled.push(mode.name)
		}
		expect(compiled).toEqual(modes.filter((mode) => mode.supported).map((mode) => mode.name))
		expect(diagnosed).toHaveLength(modes.filter((mode) => !mode.supported).length)
	} finally {
		rmSync(scratch, { recursive: true, force: true })
		if (controlDirectory !== undefined) {
			rmSync(controlDirectory, { recursive: true, force: true })
		}
	}
})

// The handshake the packed artifact performs, driven from the consumer that installed it. The
// client and the peer are both the tarball's own code, spawned cold per row, so what these rows
// read is what a developer who runs `npm install @orkestrel/mcp` gets — not what this
// repository's source graph resolves to.
it('negotiates every supported revision from the installed artifact and refuses what a pin excludes', () => {
	const root = fileURLToPath(new URL('../', import.meta.url))
	const scratch = mkdtempSync(join(tmpdir(), 'orkestrel-mcp-handshake-'))

	try {
		const consumer = join(scratch, 'consumer')
		buildPackedConsumer(root, scratch, consumer)

		writeFileSync(join(consumer, 'peer.mjs'), HANDSHAKE_PEER)
		writeFileSync(join(consumer, 'legacy.mjs'), HANDSHAKE_LEGACY_PEER)
		writeFileSync(join(consumer, 'marker.mjs'), HANDSHAKE_MARKER_PEER)
		writeFileSync(join(consumer, 'handshake.mjs'), HANDSHAKE_DRIVER)
		const refused = 'pinned outside the supported set'
		const control = 'pinned to the modern revision against a peer with no modern seam'
		writeFileSync(
			join(consumer, 'rows.json'),
			JSON.stringify([
				...HANDSHAKE.map((row) => ({ label: row.label, peer: row.peer, options: row.options })),
				{ label: refused, peer: 'marker.mjs', options: { version: '2020-01-01', timeout: 15_000 } },
				{
					label: control,
					peer: 'legacy.mjs',
					options: { version: '2026-07-28', timeout: 15_000 },
				},
			]),
		)

		const driven = spawnSync(process.execPath, [join(consumer, 'handshake.mjs')], {
			cwd: consumer,
			encoding: 'utf8',
		})
		if (driven.error !== undefined || driven.status !== 0) {
			throw new Error(`the handshake driver failed: ${driven.error?.message ?? driven.stderr}`)
		}
		const readings: unknown = JSON.parse(readFileSync(join(consumer, 'readings.json'), 'utf8'))

		// Each row is compared as a whole reading rather than field by field, so a failure names
		// the row it belongs to instead of reporting a bare revision string against another.
		for (const row of HANDSHAKE) {
			const reading = readHandshake(readings, row.label)
			expect({
				label: readField(reading, 'label'),
				version: readField(reading, 'version'),
				methods: readField(reading, 'methods'),
				message: readField(reading, 'message'),
			}).toEqual({
				label: row.label,
				version: row.version,
				methods: row.methods,
				message: undefined,
			})
		}

		// A pin the supported set excludes is refused where it is read, so the transport never
		// starts and the peer it names never runs. The marker file is what says so.
		const refusal = readHandshake(readings, refused)
		expect(readField(refusal, 'phase')).toBe('construct')
		expect(readField(refusal, 'code')).toBe(-32022)
		expect(readField(refusal, 'message')).toBe('Unsupported protocol version')
		expect(readField(refusal, 'methods')).toEqual([])
		expect(existsSync(join(consumer, 'spawned.txt'))).toBe(false)

		// The red control. The same peer answers the unpinned row in the table earlier — it
		// negotiates 2025-06-18's successor through the legacy fallback — so this row's failure
		// is the pin refusing that fallback, and nothing about the peer being unreachable. The
		// message is the peer's own refusal of `server/discover`, never a deadline: a client that
		// waited out its timeout instead would report the wait, and this assertion would break.
		const blocked = readHandshake(readings, control)
		expect(readField(blocked, 'phase')).toBe('connect')
		expect(readField(blocked, 'version')).toBeUndefined()
		expect(readField(blocked, 'code')).toBe(-32601)
		expect(readField(blocked, 'message')).toBe('Method not found: server/discover')
		expect(readField(blocked, 'methods')).toEqual(['server/discover'])
	} finally {
		rmSync(scratch, { recursive: true, force: true })
	}
})
