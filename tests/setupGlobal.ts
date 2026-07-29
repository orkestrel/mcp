import type { TestProject } from 'vitest/node'
import type { BrowserFixtureInterface } from './fixtures/browserServer.js'
import { fileURLToPath } from 'node:url'
import { isRecord } from '@orkestrel/contract'
import { createServer as createViteServer } from 'vite'

declare module 'vitest' {
	interface ProvidedContext {
		/** The external browser fixture's loopback origin. */
		readonly server: string
	}
}

/** The runnable export loaded into the fixture's isolated Node-side Vite graph. */
export interface BrowserFixtureModuleInterface {
	/** Start the external fixture. */
	start(): Promise<BrowserFixtureInterface>
}

/** Narrow the isolated fixture module before invoking its setup export. */
export function isBrowserFixtureModule(value: unknown): value is BrowserFixtureModuleInterface {
	return isRecord(value) && typeof value['start'] === 'function'
}

/**
 * Start the external Node fixture before Chromium receives the browser test graph.
 *
 * @param project - The Vitest browser project receiving the fixture URL
 * @returns A teardown that stops both the fixture and its isolated module runner
 */
export async function setup(project: TestProject): Promise<() => Promise<void>> {
	const workspace = fileURLToPath(new URL('../', import.meta.url))
	const runner = await createViteServer({
		configFile: false,
		root: workspace,
		appType: 'custom',
		resolve: {
			alias: {
				'@src/core': fileURLToPath(new URL('../src/core/index.ts', import.meta.url)),
				'@src/server': fileURLToPath(new URL('../src/server/index.ts', import.meta.url)),
			},
		},
		server: { middlewareMode: true },
	})
	try {
		const loaded: unknown = await runner.ssrLoadModule('/tests/fixtures/browserServer.ts')
		if (!isBrowserFixtureModule(loaded)) {
			throw new Error('Browser fixture module does not export start')
		}
		const fixture = await loaded.start()
		project.provide('server', fixture.base)
		return async () => {
			try {
				await fixture.stop()
			} finally {
				await runner.close()
			}
		}
	} catch (error) {
		await runner.close()
		throw error
	}
}
