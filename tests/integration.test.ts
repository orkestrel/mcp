// The built package, installed and driven from outside.
//
// `npm pack` writes the exact archive `npm publish` uploads; a temporary consumer installs that
// file and five programs drive it the way a dependent does. Nothing here reads `src/`, and
// nothing links the repository into the consumer: a path the manifest's `files` field omits is
// therefore missing from the consumer, and the program that needs it fails.
//
// Packing, installing, and compiling cost seconds, so this proof is its own `integration`
// project with its own timeout, kept out of `npm test` and required by `prepublishOnly`.

import type { ConsumerInterface } from './setupServer.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compileConsumer, createConsumer, runConsumer } from './setupServer.js'

describe('installed package consumer', () => {
	let consumer: ConsumerInterface

	beforeAll(async () => {
		consumer = await createConsumer()
	})

	afterAll(async () => {
		await consumer.stop()
	})

	// Each row reads the program's whole output rather than its `stdout` alone, so a failing
	// assertion carries the consumer's own diagnostic — a resolution error names the path the
	// tarball did not carry, which is the finding itself rather than a clue to it.
	it('serves the core, server, and browser faces to an ESM consumer', () => {
		const result = runConsumer(consumer, 'consumerImport.mjs')
		expect(`${result.stderr}${result.stdout}`).toContain(
			'import:core-dispatch,server-route,browser-frame',
		)
		expect(result.status).toBe(0)
	})

	it('serves the core and server faces to a CommonJS consumer and refuses the browser face', () => {
		const result = runConsumer(consumer, 'consumerRequire.cjs')
		expect(`${result.stderr}${result.stdout}`).toContain(
			'require:core-dispatch,server-route,browser-refused',
		)
		expect(result.status).toBe(0)
	})

	it('refuses an undeclared subpath with ERR_PACKAGE_PATH_NOT_EXPORTED', () => {
		const result = runConsumer(consumer, 'consumerSubpath.mjs')
		expect(`${result.stderr}${result.stdout}`).toContain('subpath:rejected')
		expect(result.status).toBe(0)
	})

	it('resolves every shipped declaration for a strict TypeScript consumer', () => {
		const result = compileConsumer(consumer, 'consumerTypes.ts')
		expect(`${result.stderr}${result.stdout}`).toBe('')
		expect(result.status).toBe(0)
	})

	// The control for the row above: a clean compile proves the shipped declarations were read
	// only if a misuse of them is rejected. Declarations that resolved to an untyped value would
	// pass that row just as quietly.
	it('reports TS2322 when a consumer misuses a shipped declaration', () => {
		const result = compileConsumer(consumer, 'consumerError.ts')
		const report = `${result.stderr}${result.stdout}`
		expect(report).toContain('TS2322')
		expect(report).toContain("Type 'string' is not assignable to type 'number'")
		expect(result.status).not.toBe(0)
	})
})
