import { ScopeTransport } from '@src/browser'
import { describe, expect, it } from 'vitest'
import { MCPFixtureCell } from '../../../setup.js'
import { createScopeDouble } from '../../../setupBrowser.js'

describe('ScopeTransport', () => {
	it('replaces handlers and invokes them without a receiver', () => {
		const fixture = createScopeDouble()
		const transport = new ScopeTransport(fixture.scope)
		const receiver = new MCPFixtureCell<unknown>('unread')
		const messages: string[] = []
		transport.listen((message) => messages.push(`old:${message}`))
		transport.listen(function (this: unknown, message) {
			receiver.value = this
			messages.push(message)
		})

		transport.deliver('inbound')
		transport.send('outbound')
		expect(receiver.value).toBeUndefined()
		expect(messages).toEqual(['inbound'])
		expect(fixture.sent).toEqual(['outbound'])
	})

	it('retains the replaceable close callback across repeated closes', () => {
		const transport = new ScopeTransport(createScopeDouble().scope)
		const calls: string[] = []
		transport.closed(() => calls.push('old'))
		transport.closed(() => calls.push('current'))
		transport.close()
		transport.close()
		expect(calls).toEqual(['current', 'current'])
	})
})
