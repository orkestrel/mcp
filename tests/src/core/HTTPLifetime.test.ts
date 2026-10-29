import { describe, expect, it } from 'vitest'
import { HTTPLifetime } from '../../../src/core/HTTPLifetime.js'

describe('HTTPLifetime', () => {
	it('aborts its requests without carrying the protocol into a new lifetime', () => {
		const lifetime = new HTTPLifetime()
		const signal = lifetime.signal
		lifetime.accept('2025-11-25')
		expect(lifetime.protocol).toBe('2025-11-25')
		expect(signal.aborted).toBe(false)

		lifetime.abort()
		expect(signal.aborted).toBe(true)
		const replacement = new HTTPLifetime()
		expect(replacement.protocol).toBeUndefined()
		expect(replacement.signal.aborted).toBe(false)
		expect(replacement.signal).not.toBe(signal)
	})
})
