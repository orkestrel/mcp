import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { inspectPolicyPurity, inspectCodingWorkspace } from './setupPolicy.js'
import { isBrowserVuePath } from './setup.js'
import { chromium } from 'playwright'
import { isBrowserExecutable, resolveBrowser, SYSTEM_BROWSER_CHANNELS } from '../vite.config.js'

describe('repository coding law', () => {
	it('keeps Vue single-file components exclusively in browser environments', () => {
		const files = globSync('{app,src}/**/*.vue')

		expect(files.every(isBrowserVuePath)).toBe(true)
	})

	it('enforces source placement, exports, readonly contracts, and syntax law', () => {
		expect(inspectCodingWorkspace(process.cwd())).toEqual([])
	})

	it('keeps fleet policy free of package architecture', () => {
		for (const path of ['tests/policy.test.ts', 'tests/setupPolicy.ts']) {
			expect([path, inspectPolicyPurity(path, readFileSync(path, 'utf8'))]).toEqual([path, []])
		}
	})

	it('reports planted package architecture tokens', () => {
		const identifier = ['M', 'C', 'P'].join('')
		const task = ['tasks', '/'].join('')
		const browser = ['src', '/browser/'].join('')
		const planted = [
			`const ${identifier}Probe = 1`,
			`const method = '${task}get'`,
			`const path = '${browser}types.ts'`,
		].join('\n')

		expect(inspectPolicyPurity('planted.ts', planted)).toEqual([
			'planted.ts:1:7 contains package architecture identifier',
			'planted.ts:2:16 contains package architecture task path',
			'planted.ts:3:14 contains package architecture browser path',
		])
	})
})

describe('runner configuration', () => {
	it('resolves only a real managed executable or stable system browser channel', () => {
		const options = resolveBrowser(chromium.executablePath(), process.platform, process.env)
		let valid = options === undefined
		if (options !== undefined) {
			const channel = options.launchOptions?.channel
			valid =
				channel === undefined
					? isBrowserExecutable(options.launchOptions?.executablePath ?? chromium.executablePath())
					: SYSTEM_BROWSER_CHANNELS.some((browser) => browser.channel === channel)
		}
		expect(valid).toBe(true)
	})
})
