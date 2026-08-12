import type { PlaywrightProviderOptions } from '@vitest/browser-playwright'
import type { UserConfig } from 'vite'
import { playwright } from '@vitest/browser-playwright'
import { chromium } from 'playwright'
import { defineConfig, mergeConfig } from 'vitest/config'
import tsconfig from './tsconfig.json' with { type: 'json' }
import { environmentBoundary, outputBoundary } from './configs/helpers.js'
import {
	accessSync,
	constants as FS_CONSTANTS,
	lstatSync,
	readdirSync,
	realpathSync,
	statSync,
} from 'node:fs'
import { basename, dirname, join, parse, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

export function resolveWorkspacePath(relativePath: string): string {
	return fileURLToPath(new URL(relativePath, import.meta.url))
}

// A generated root config must classify its own fixed proof without importing
// package source, so the exact-case check stays self-contained over Node APIs.
function isExactCaseFile(path: string): boolean {
	const full = resolvePath(path)
	try {
		const status = lstatSync(full)
		if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) return false
		const root = parse(full).root
		const segments = relative(root, full).split(sep)
		let parent = root
		for (const segment of segments) {
			try {
				if (!readdirSync(parent).includes(segment)) return false
			} catch {
				if (basename(realpathSync.native(join(parent, segment))) !== segment) return false
			}
			parent = join(parent, segment)
		}
		return true
	} catch {
		return false
	}
}

/** Chromium executable layouts inside a `chromium-<revision>` browsers-directory entry, per platform. */
export const CHROMIUM_LAYOUTS = Object.freeze([
	'chrome-linux/chrome',
	'chrome-linux64/chrome',
	'chrome-win/chrome.exe',
	'chrome-win64/chrome.exe',
	'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
	'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
])

/** Stable Playwright Chromium channels and their standard executable layouts. */
export const SYSTEM_BROWSER_CHANNELS = Object.freeze([
	Object.freeze({
		channel: 'chrome',
		layouts: Object.freeze({
			linux: '/opt/google/chrome/chrome',
			darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
			win32: Object.freeze(['Google', 'Chrome', 'Application', 'chrome.exe']),
		}),
	}),
	Object.freeze({
		channel: 'msedge',
		layouts: Object.freeze({
			linux: '/opt/microsoft/msedge/msedge',
			darwin: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
			win32: Object.freeze(['Microsoft', 'Edge', 'Application', 'msedge.exe']),
		}),
	}),
])

/**
 * Determine whether a path identifies an executable regular file.
 *
 * @param path - The filesystem path to inspect.
 * @returns Whether the path is a regular file with execute access.
 *
 * @example
 * ```ts
 * isBrowserExecutable('/opt/google/chrome/chrome')
 * ```
 */
export function isBrowserExecutable(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false
		accessSync(path, FS_CONSTANTS.X_OK)
		return true
	} catch {
		return false
	}
}

/**
 * Resolve a launchable Playwright-managed Chromium executable: the pinned revision when installed,
 * otherwise a `chromium` / `chromium.exe` alias or any other `chromium-*`
 * revision under the same Playwright browsers directory. A pinned-revision miss
 * is not Chromium absence — managed containers ship one usable build (often
 * behind a revision-agnostic alias) for many Playwright versions.
 *
 * @param pinned - The executable path for Playwright's pinned Chromium revision.
 * @returns The managed executable path, or `undefined` when none is executable.
 *
 * @example
 * ```ts
 * resolveManagedBrowser(chromium.executablePath())
 * ```
 */
export function resolveManagedBrowser(pinned: string): string | undefined {
	if (isBrowserExecutable(pinned)) return pinned
	let revisionRoot = dirname(pinned)
	for (;;) {
		if (/^chromium-\d+$/.test(basename(revisionRoot))) break
		const parent = dirname(revisionRoot)
		if (parent === revisionRoot) return undefined
		revisionRoot = parent
	}
	const browsersRoot = dirname(revisionRoot)
	for (const alias of ['chromium', 'chromium.exe']) {
		const candidate = resolvePath(browsersRoot, alias)
		if (isBrowserExecutable(candidate)) return candidate
	}
	let entries: readonly string[]
	try {
		entries = readdirSync(browsersRoot)
	} catch {
		return undefined
	}
	const revisions = entries
		.filter((entry) => /^chromium-\d+$/.test(entry))
		.sort((a, b) => Number(b.slice('chromium-'.length)) - Number(a.slice('chromium-'.length)))
	for (const revision of revisions) {
		for (const layout of CHROMIUM_LAYOUTS) {
			const candidate = resolvePath(browsersRoot, revision, layout)
			if (isBrowserExecutable(candidate)) return candidate
		}
	}
	return undefined
}

/**
 * Resolve the first installed stable system Chromium channel.
 *
 * @param platform - The Node platform whose standard layouts should be probed.
 * @param environment - The process environment supplying Windows installation roots.
 * @returns `chrome`, then `msedge`, or `undefined` when neither is executable.
 *
 * @example
 * ```ts
 * resolveSystemBrowser(process.platform, process.env)
 * ```
 */
export function resolveSystemBrowser(
	platform: NodeJS.Platform,
	environment: NodeJS.ProcessEnv,
): string | undefined {
	if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32') return undefined
	const roots = new Set<string>()
	if (platform === 'win32') {
		for (const root of [
			environment.LOCALAPPDATA,
			environment.PROGRAMFILES,
			environment['PROGRAMFILES(X86)'],
		]) {
			if (root !== undefined && root.length > 0) roots.add(root)
		}
		const homeDrive = environment.HOMEDRIVE
		if (homeDrive !== undefined && homeDrive.length > 0) {
			roots.add(join(homeDrive, 'Program Files'))
			roots.add(join(homeDrive, 'Program Files (x86)'))
		}
	}
	for (const browser of SYSTEM_BROWSER_CHANNELS) {
		if (platform === 'win32') {
			for (const root of roots) {
				if (isBrowserExecutable(join(root, ...browser.layouts.win32))) return browser.channel
			}
			continue
		}
		if (isBrowserExecutable(browser.layouts[platform])) return browser.channel
	}
	return undefined
}

/**
 * Resolve launch options for a managed Chromium or stable system browser.
 *
 * @param pinned - The executable path for Playwright's pinned Chromium revision.
 * @param platform - The Node platform whose standard system layouts should be probed.
 * @param environment - The process environment supplying Windows installation roots.
 * @returns Provider options for managed Chromium, Chrome, or Edge, or `undefined`.
 *
 * @remarks
 * An installed pinned revision returns an empty object so Playwright retains
 * its default launch semantics. A different managed executable is selected by
 * path; a system browser is selected by its stable Playwright channel.
 *
 * @example
 * ```ts
 * resolveBrowser(chromium.executablePath(), process.platform, process.env)
 * ```
 */
export function resolveBrowser(
	pinned: string,
	platform: NodeJS.Platform,
	environment: NodeJS.ProcessEnv,
): PlaywrightProviderOptions | undefined {
	const managed = resolveManagedBrowser(pinned)
	if (managed !== undefined) {
		return managed === pinned ? {} : { launchOptions: { executablePath: managed } }
	}
	const channel = resolveSystemBrowser(platform, environment)
	return channel === undefined ? undefined : { launchOptions: { channel } }
}

const browserPinned = chromium.executablePath()
const browserOptions = resolveBrowser(browserPinned, process.platform, process.env)

const resolve = {
	alias: Object.entries(tsconfig.compilerOptions.paths).reduce((aliases, [key, values]) => {
		const [path] = values
		if (path === undefined) throw new Error('tsconfig path alias ' + key + ' has no target')
		return Object.assign(aliases, { [key]: resolveWorkspacePath(path) })
	}, {}),
}

export const srcCore = (options?: UserConfig): UserConfig =>
	mergeConfig(
		{
			resolve,
			publicDir: false,
			build: {
				emptyOutDir: true,
				sourcemap: true,
				minify: false,
			},
			test: {
				name: { label: 'src:core', color: 'magenta' },
				include: ['tests/src/core/**/*.test.ts'],
				setupFiles: ['./tests/setup.ts'],
				environment: 'node',
				browser: { enabled: false },
			},
		},
		options ?? {},
	)

export const srcBrowser = (options?: UserConfig): UserConfig =>
	mergeConfig(
		{
			resolve,
			publicDir: false,
			plugins: [outputBoundary('dist/src/browser'), environmentBoundary('src/browser')],
			build: {
				emptyOutDir: true,
				sourcemap: true,
				minify: false,
				lib: {
					entry: resolveWorkspacePath('src/browser/index.ts'),
					formats: ['es'],
					fileName: () => 'index.js',
				},
				outDir: 'dist/src/browser',
				rolldownOptions: {
					external: (id: string) => id === '@src/core' || id.startsWith('@orkestrel/'),
					output: { paths: { '@src/core': '../core/index.js' } },
				},
			},
			test: {
				name: { label: 'src:browser', color: 'yellow' },
				include: ['tests/src/browser/**/*.test.ts'],
				exclude: ['tests/src/core/**/*.test.ts'],
				// The browser suite drives a real Node-face peer, so the fixture starts
				// before Chromium receives the graph and provides its origin.
				globalSetup: ['./tests/setupGlobal.ts'],
				setupFiles: ['./tests/setup.ts', './tests/setupBrowser.ts'],
				deps: {
					optimizer: {
						client: {
							enabled: true,
							// Prevent the Vitest browser mid-run "optimized dependencies
							// changed, reloading" stall.
							include: [
								'@vitest/browser/client',
								'vitest/browser',
								'vitest/internal/browser',
								'vitest',
							],
						},
					},
				},
				browser: {
					enabled: true,
					provider: playwright(browserOptions),
					instances: [{ browser: 'chromium', headless: true }],
				},
				fileParallelism: false,
			},
		},
		options ?? {},
	)

export const srcServer = (options?: UserConfig): UserConfig =>
	mergeConfig(
		{
			resolve,
			publicDir: false,
			plugins: [outputBoundary('dist/src/server'), environmentBoundary('src/server')],
			build: {
				emptyOutDir: true,
				sourcemap: true,
				minify: false,
				lib: {
					entry: resolveWorkspacePath('src/server/index.ts'),
					formats: ['es', 'cjs'],
					fileName: (format: string) => (format === 'es' ? 'index.js' : 'index.cjs'),
				},
				outDir: 'dist/src/server',
				target: 'node22',
				rolldownOptions: {
					platform: 'node',
					external: (id: string) =>
						id === '@src/core' || id.startsWith('node:') || id.startsWith('@orkestrel/'),
					output: [
						{
							format: 'es',
							entryFileNames: 'index.js',
							paths: { '@src/core': '../core/index.js' },
						},
						{
							format: 'cjs',
							entryFileNames: 'index.cjs',
							paths: { '@src/core': '../core/index.cjs' },
						},
					],
				},
			},
			test: {
				name: { label: 'src:server', color: 'red' },
				include: ['tests/src/server/**/*.test.ts'],
				exclude: ['tests/src/core/**/*.test.ts'],
				setupFiles: ['./tests/setup.ts', './tests/setupServer.ts'],
				environment: 'node',
				browser: { enabled: false },
			},
		},
		options ?? {},
	)

export const policy = (options?: UserConfig): UserConfig =>
	mergeConfig(
		{
			resolve,
			test: {
				name: { label: 'policy', color: 'white' },
				include: ['tests/policy.test.ts'],
				setupFiles: ['./tests/setup.ts'],
				environment: 'node',
				browser: { enabled: false },
			},
		},
		options ?? {},
	)

export const config = (options?: UserConfig): UserConfig =>
	mergeConfig(
		{
			resolve,
			test: {
				name: { label: 'config', color: 'yellow' },
				include: ['tests/config.test.ts'],
				setupFiles: ['./tests/setup.ts'],
				environment: 'node',
				browser: { enabled: false },
			},
		},
		options ?? {},
	)

export const guides = (options?: UserConfig): UserConfig =>
	mergeConfig(
		{
			resolve,
			test: {
				name: { label: 'guides', color: 'green' },
				include: ['tests/guides.test.ts'],
				exclude: ['tests/src/**/*.test.ts', 'tests/app/**/*.test.ts', 'tests/setup.test.ts'],
				setupFiles: ['./tests/setup.ts'],
				environment: 'node',
				browser: { enabled: false },
			},
		},
		options ?? {},
	)

// Where this package drifts from the official tooling it stays compatible with.
// The subject is this package, so the proof is hermetic and stays in `npm test`.
//
// Only `hookTimeout` is raised, because every second of the run is spent in the hook: the
// twenty-scenario run and the version probe both live there, and the assertions read an
// already-parsed result in single-digit milliseconds. Measured on this tree across four
// runs the whole hook took 0.95-1.04 s, against 2.6-6.2 s while the runner still came
// through `npx`. Thirty seconds is roughly thirty times the measured figure — slack for a
// loaded machine, not an allowance for a download, which no longer happens here.
export const conformance = (options?: UserConfig): UserConfig =>
	mergeConfig(
		{
			resolve,
			test: {
				name: { label: 'conformance', color: 'magenta' },
				include: ['tests/conformance.test.ts'],
				setupFiles: ['./tests/setup.ts'],
				environment: 'node',
				browser: { enabled: false },
				hookTimeout: 30_000,
			},
		},
		options ?? {},
	)

// A workbench, not a proof. No gate selects this project.
export const probe = (options?: UserConfig): UserConfig =>
	mergeConfig(
		{
			resolve,
			test: {
				name: { label: 'probe', color: 'gray' },
				include: ['tmp/probe/**/*.test.ts'],
				setupFiles: ['./tests/setup.ts'],
				environment: 'node',
				browser: { enabled: false },
			},
		},
		options ?? {},
	)

export default defineConfig({
	resolve,
	test: {
		projects: [
			srcCore,
			srcBrowser,
			srcServer,
			policy,
			config,
			...(isExactCaseFile(resolveWorkspacePath('tests/guides.test.ts')) ? [guides] : []),
			conformance,
			probe,
		],
	},
})
