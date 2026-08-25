// Proof of `tests/setupGlobal.ts` — the Vitest global-setup module that starts the external
// Node fixture before Chromium receives the browser test graph.
//
// `setup(project)` takes the live `TestProject` the runner owns and hands the fixture's origin
// to `project.provide`. Nothing in this project can construct that argument without an
// assertion, so the runner-driven half is proven where it actually runs: `vite.config.ts`
// declares this module as the `globalSetup` of the `src:browser` and `integration` projects, so
// every run of either drives `setup`, its `provide`, and the teardown it returns. A test double
// for `TestProject` would close that gap only by asserting a shape, which is what this file
// refuses to do.
//
// What is proven here is the narrowing that stands between the runner and the fixture, asserted
// against the real module `setup` loads — reached by a second route, a direct import instead of
// the isolated Vite runner's `ssrLoadModule`.

import { describe, expect, it } from 'vitest'
import { isBrowserFixtureModule } from './setupGlobal.js'
import * as fixtureModule from './fixtures/browserServer.js'
import * as siblingModule from './setupServer.js'

describe('isBrowserFixtureModule', () => {
	it('admits the fixture module the runner loads, and what it admits starts a live fixture', async () => {
		const loaded: unknown = fixtureModule

		expect(isBrowserFixtureModule(loaded)).toBe(true)
		if (!isBrowserFixtureModule(loaded)) throw new Error('unreachable: the guard admitted it')

		// The narrowing is only worth anything if the value it produces really does start the
		// fixture, so the admitted module is driven through the seam's own `start`.
		const running = await loaded.start()
		try {
			expect(running.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
			const answered = await fetch(`${running.base}/recorded`)
			expect(answered.status).toBe(200)
			expect(await answered.json()).toEqual([])
		} finally {
			await running.stop()
		}
	})

	it('refuses a sibling module, a lookalike key, a non-callable start, and every non-record', () => {
		// A real module namespace from the same directory: `setupServer` publishes `startServer`
		// and `startUpgradeServer`, so it is the prefix lookalike rather than an invented one.
		expect(isBrowserFixtureModule(siblingModule)).toBe(false)
		expect(isBrowserFixtureModule({ startServer: () => undefined })).toBe(false)
		expect(isBrowserFixtureModule({ start: 'start' })).toBe(false)
		expect(isBrowserFixtureModule({ start: undefined })).toBe(false)
		expect(isBrowserFixtureModule([{ start: () => undefined }])).toBe(false)
		expect(isBrowserFixtureModule(() => undefined)).toBe(false)
		expect(isBrowserFixtureModule(undefined)).toBe(false)
		expect(isBrowserFixtureModule(null)).toBe(false)
	})
})
