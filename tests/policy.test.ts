import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isBrowserVuePath } from './setup.js'
import { inspectCodingWorkspace } from './setupPolicy.js'
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

	it('keeps retired server error codes out of published source', () => {
		const occurrences = globSync('src/**/*.ts').flatMap((path) => {
			const source = readFileSync(path, 'utf8')
			return ['-32002', '-32042']
				.filter((code) => source.includes(code))
				.map((code) => `${path}: ${code}`)
		})

		expect(occurrences).toEqual([])
	})

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
