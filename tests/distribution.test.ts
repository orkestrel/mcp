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
import { dirname, join } from 'node:path'
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

it('installs the packed artifact and drives its faces, declarations, and resolution modes', () => {
	const root = fileURLToPath(new URL('../', import.meta.url))
	const scratch = mkdtempSync(join(tmpdir(), 'orkestrel-mcp-distribution-'))

	try {
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
		const tarball = join(scratch, filename)

		const consumer = join(scratch, 'consumer')
		mkdirSync(consumer)
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
			mkdirSync(extraction)
			const unpack = spawnSync('tar', ['-xzf', tarball, '-C', extraction], { encoding: 'utf8' })
			if (unpack.error !== undefined || unpack.status !== 0) {
				throw new Error(`tar extraction failed: ${unpack.error?.message ?? unpack.stderr}`)
			}
			mkdirSync(dirname(packageRoot), { recursive: true })
			cpSync(join(extraction, 'package'), packageRoot, { recursive: true })
		}

		const manifest: unknown = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
		const exportsValue = readField(manifest, 'exports')
		if (typeof exportsValue !== 'object' || exportsValue === null) {
			throw new Error('The packed manifest carries no exports')
		}

		// Every runtime the package names must be resolvable from the consumer. A denied nested
		// install leaves them missing, and the peers are the consumer's to supply either way, so
		// the list is derived from the packed manifest rather than written down twice.
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

		// Every `exports` target names a file the tarball actually carries.
		const targets: unknown[] = [exportsValue]
		const missingTargets: string[] = []
		let targetCount = 0
		while (targets.length > 0) {
			const target = targets.pop()
			if (typeof target === 'string') {
				if (target.startsWith('./')) {
					if (!existsSync(join(packageRoot, target.slice(2)))) missingTargets.push(target)
					targetCount += 1
				}
				continue
			}
			if (typeof target === 'object' && target !== null) targets.push(...Object.values(target))
		}
		expect(missingTargets).toEqual([])
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
		expect(declared.get('core')).toHaveLength(140)
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
	}
})
