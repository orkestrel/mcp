import { globSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isBrowserVuePath } from './setup.js'
import {
	derivePolicyTokens,
	inspectCodingWorkspace,
	inspectPolicyPurity,
	inspectPolicyWorkspace,
	POLICY_SOURCE_ENVIRONMENTS,
	readPackageName,
} from './setupPolicy.js'
import { chromium } from 'playwright'
import { isBrowserExecutable, resolveBrowser, SYSTEM_BROWSER_CHANNELS } from '../vite.config.js'

const POLICY_PLANTED_PATH = 'tests/setupPolicy.ts'
const POLICY_TOKENS = derivePolicyTokens(readPackageName(process.cwd()))

describe('repository coding law', () => {
	it('keeps Vue single-file components exclusively in browser environments', () => {
		const files = globSync('{app,src}/**/*.vue')

		expect(files.every(isBrowserVuePath)).toBe(true)
	})

	it('enforces source placement, exports, readonly contracts, and syntax law', () => {
		expect(inspectCodingWorkspace(process.cwd())).toEqual([])
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

describe('fleet policy purity', () => {
	it('keeps fleet policy files free of this package architecture', () => {
		expect(inspectPolicyWorkspace(process.cwd())).toEqual([])
	})

	it('reports planted package architecture, so a clean sweep is evidence', () => {
		const token = POLICY_TOKENS[0]
		const environment = POLICY_SOURCE_ENVIRONMENTS[0]
		if (token === undefined || environment === undefined) {
			throw new Error('The package manifest derived no policy token to plant')
		}
		const planted = [
			'export const ' + token + '_PATH = []',
			"export const path = 'src/" + environment + "/index.ts'",
			'',
		].join('\n')

		expect(inspectPolicyPurity(POLICY_PLANTED_PATH, planted, POLICY_TOKENS)).toEqual([
			POLICY_PLANTED_PATH + ':1:14 forbids the ' + token + ' package token',
			POLICY_PLANTED_PATH + ':2:21 forbids a source-environment path literal',
		])
	})
})
