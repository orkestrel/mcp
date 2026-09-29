import { describe, expect, it } from 'vitest'
import { isWebMCPDocument, isWebMCPRegistry, isWebMCPToolEvent } from '@src/browser'
import { isRecord } from '@orkestrel/contract'
import { createHostileValues } from '@orkestrel/test'
import { buildRegistry, REGISTRY_MEMBERS } from '../../setupBrowser.js'
import { installModelContext, ToolActivatedEvent } from '../../fixtures/modelContext.js'

// src/browser/validators.ts — the WebMCP feature detection, run against a REAL `Document`.
// The population that matters is platform class instances, not plain objects: a `Document`
// reaches `modelContext` through nothing, and a `ModelContext` reaches every operation through
// its prototype chain, so a guard built on an exact-record check would fail closed on both.
//
// The member list and the case builder are `tests/setupBrowser.ts`'s, so the WebIDL spelling
// every case is drawn from has one home rather than a copy per test file.

describe('isWebMCPRegistry — narrowing a prototype-carried registry, not a plain record', () => {
	it('accepts a class instance whose operations arrive through its prototype', () => {
		const fixture = installModelContext(document.implementation.createHTMLDocument())

		expect(isWebMCPRegistry(fixture.registry)).toBe(true)
		// The control the guard must not be built on: an exact-record check refuses this exact
		// value, which is why `isRecord` appears here as the rejected alternative rather than
		// as the instrument.
		expect(isRecord(fixture.registry)).toBe(false)
	})

	it('accepts a plain record carrying every registry operation', () => {
		// The positive control for the two refusals below: the same builder, omitting nothing,
		// so each refusal differs from an accepted value in exactly the member it names.
		expect(isWebMCPRegistry(buildRegistry())).toBe(true)
	})

	it('refuses a registry missing any one operation it would go on to call', () => {
		// Collected rather than asserted in the loop, so a failure names every operation the
		// guard stopped reading instead of stopping at the first one.
		const accepted = REGISTRY_MEMBERS.filter((member) => isWebMCPRegistry(buildRegistry(member)))

		expect(accepted).toEqual([])
	})

	it('refuses a value carrying a registry operation that is not callable', () => {
		const partial = buildRegistry()
		partial['executeTool'] = 'executeTool'

		expect(isWebMCPRegistry(partial)).toBe(false)
	})

	it('refuses every value that is not an object at all', () => {
		expect(isWebMCPRegistry(undefined)).toBe(false)
		expect(isWebMCPRegistry(null)).toBe(false)
		expect(isWebMCPRegistry('modelContext')).toBe(false)
		expect(isWebMCPRegistry(0)).toBe(false)
	})

	it('stays total against a value whose member read throws', () => {
		const hostile = Object.create(null, {
			registerTool: {
				get: () => {
					throw new Error('hostile accessor')
				},
			},
		})

		expect(isWebMCPRegistry(hostile)).toBe(false)
	})

	it('refuses every adversarial value without throwing', () => {
		for (const [index, value] of createHostileValues().entries()) {
			let accepted: boolean | undefined
			expect(() => {
				accepted = isWebMCPRegistry(value)
			}, `hostile value ${index}`).not.toThrow()
			expect(accepted, `hostile value ${index}`).toBe(false)
		}
	})
})

describe('isWebMCPDocument — the feature detection a page runs before building a bridge', () => {
	it('accepts a real Document after a registry is installed on it', () => {
		const host = document.implementation.createHTMLDocument()
		expect(isWebMCPDocument(host)).toBe(false)

		installModelContext(host)

		expect(isWebMCPDocument(host)).toBe(true)
	})

	it('refuses a document whose modelContext is not a registry', () => {
		const host = document.implementation.createHTMLDocument()
		Object.defineProperty(host, 'modelContext', { value: {}, configurable: true })

		expect(isWebMCPDocument(host)).toBe(false)
	})

	it('detects the registry exactly where this page exposes the property', () => {
		// The assertion pins the relationship rather than the reading, so it holds on any host: the
		// guard accepts this page exactly where it carries the property. A host shipping the property
		// under a shape the guard refuses reddens here rather than reporting a refusal that reads
		// like the ordinary absence.
		expect(isWebMCPDocument(document)).toBe('modelContext' in document)
	})

	it('refuses every adversarial value without throwing', () => {
		for (const [index, value] of createHostileValues().entries()) {
			let accepted: boolean | undefined
			expect(() => {
				accepted = isWebMCPDocument(value)
			}, `hostile value ${index}`).not.toThrow()
			expect(accepted, `hostile value ${index}`).toBe(false)
		}
	})
})

describe('isWebMCPToolEvent — narrowing a dispatched event onto the toolName shape', () => {
	it('accepts a ToolActivatedEvent and refuses a plain Event', () => {
		expect(isWebMCPToolEvent(new ToolActivatedEvent('toolactivated', { toolName: 'lookup' }))).toBe(
			true,
		)
		expect(isWebMCPToolEvent(new Event('toolactivated'))).toBe(false)
	})
})
