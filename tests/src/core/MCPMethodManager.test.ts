import type {
	JSONRPCNotification,
	JSONRPCRequest,
	JSONRPCResponse,
	MCPMethodHandler,
	MCPStream,
} from '@src/core'
import { buildJSONRPCResult, MCPMethodManager } from '@src/core'
import { describe, expect, expectTypeOf, it } from 'vitest'

// MCPMethodManager is the modern method registry MCPServer dispatches through — a
// name-keyed store of real handlers (AGENTS §16: real functions, no mocks). Covers
// registration, resolution, the unregistered lookup, replacement under an existing name,
// and the fact that resolution hands back the EXACT function that was registered.
//
// The seam carries the REQUEST arm alone, so neither handler narrows anything: a
// notification never reaches this registry, and answering is not optional.

async function ok(request: JSONRPCRequest): Promise<JSONRPCResponse> {
	return buildJSONRPCResult(request.id, { from: 'ok' })
}

async function other(request: JSONRPCRequest): Promise<JSONRPCResponse> {
	return buildJSONRPCResult(request.id, { from: 'other' })
}

describe('MCPMethodManager', () => {
	it('resolves a registered method to the exact handler that was registered', () => {
		const methods = new MCPMethodManager()
		methods.add('tools/call', ok)

		expect(methods.method('tools/call')).toBe(ok)
	})

	it('resolves an unregistered method to undefined (the -32601 signal, not a sentinel)', () => {
		const methods = new MCPMethodManager()

		expect(methods.method('tools/call')).toBeUndefined()
	})

	it('replaces the handler when a name is registered twice', () => {
		const methods = new MCPMethodManager()
		methods.add('tools/call', ok)
		methods.add('tools/call', other)

		expect(methods.method('tools/call')).toBe(other)
	})

	it('keeps registrations independent per name', () => {
		const methods = new MCPMethodManager()
		methods.add('tools/call', ok)
		methods.add('tools/list', other)

		expect(methods.method('tools/call')).toBe(ok)
		expect(methods.method('tools/list')).toBe(other)
	})

	it('registers an empty method name as an ordinary name', () => {
		const methods = new MCPMethodManager()
		methods.add('', ok)

		expect(methods.method('')).toBe(ok)
		expect(methods.method('tools/call')).toBeUndefined()
	})

	it('runs a resolved handler and returns its response', async () => {
		const methods = new MCPMethodManager()
		methods.add('tools/call', ok)
		const handler = methods.method('tools/call')
		if (handler === undefined) throw new Error('expected a registered handler')

		const options = { signal: new AbortController().signal }

		expect(await handler({ jsonrpc: '2.0', method: 'tools/call', id: 7 }, options)).toEqual({
			jsonrpc: '2.0',
			id: 7,
			result: { from: 'ok' },
		})
	})

	it('keeps the registered-method contract on the response or raw-stream arms', () => {
		expectTypeOf<Awaited<ReturnType<MCPMethodHandler>>>().toEqualTypeOf<
			JSONRPCResponse | MCPStream
		>()
	})

	it('narrows the registered-method parameter to the request arm', () => {
		expectTypeOf<Parameters<MCPMethodHandler>[0]>().toEqualTypeOf<JSONRPCRequest>()
		expectTypeOf<JSONRPCNotification>().not.toExtend<Parameters<MCPMethodHandler>[0]>()
	})
})
