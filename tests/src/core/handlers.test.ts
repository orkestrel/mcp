import { bindClient, createDuplexClientTransport, createMCPClient } from '@src/core'
import { describe, expect, it } from 'vitest'
import { createRecorder } from '@orkestrel/test'
import { createMemoryTransport } from '../../setup.js'

describe('bindClient transport ownership', () => {
	it('detaches callbacks without closing the carrier or announcing a later close', () => {
		const carrier = createMemoryTransport()
		const transport = createDuplexClientTransport(carrier)
		const client = createMCPClient({ transport })
		const closes = createRecorder<readonly []>()
		transport.emitter.on('close', closes.handler)
		const unbind = bindClient(client, carrier)

		unbind()
		expect(carrier.closedCalls).toBe(0)
		carrier.close()
		expect(carrier.closedCalls).toBe(1)
		expect(closes.calls).toEqual([])
	})
})
