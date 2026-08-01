import { globSync, accessSync, constants as FS_CONSTANTS, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isBrowserVuePath } from './setup.js'
import { inspectCodingWorkspace } from './setupPolicy.js'
import { chromium } from 'playwright'
import { resolveChromium } from '../vite.config.js'

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

	it('resolves Chromium only to a real executable file', () => {
		const chromiumPath = resolveChromium(chromium.executablePath())
		if (chromiumPath === undefined) return

		expect(statSync(chromiumPath).isFile()).toBe(true)
		expect(() => accessSync(chromiumPath, FS_CONSTANTS.X_OK)).not.toThrow()
	})
})
