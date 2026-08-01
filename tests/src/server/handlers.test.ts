import { describe, expect, it } from 'vitest'
import { MCP_META_CAPABILITIES, MCP_META_VERSION, MCP_PROTOCOL_VERSION } from '@src/core'
import {
	createMCPPostHandler,
	MCP_METHOD_HEADER,
	MCP_NAME_HEADER,
	MCP_PROTOCOL_VERSION_HEADER,
} from '@src/server'
import {
	collectSSE,
	createCalculatorServer,
	createJSONRPCNotification,
	createJSONRPCRequest,
} from '../../setup.js'

describe('createMCPPostHandler', () => {
	it('returns a JSON response for an id-bearing request', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), false)
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { [MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18' },
				body: JSON.stringify(createJSONRPCRequest({ method: 'ping' })),
			}),
		)

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
	})

	it('accepts a supported protocol-version header', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), false)
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { [MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18' },
				body: JSON.stringify(createJSONRPCRequest({ method: 'ping' })),
			}),
		)

		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
	})

	it('rejects an unsupported protocol-version header before dispatch', async () => {
		const mcp = createCalculatorServer()
		let requests = 0
		mcp.emitter.on('request', () => {
			requests += 1
		})
		const handler = createMCPPostHandler(mcp, false)
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { [MCP_PROTOCOL_VERSION_HEADER]: '2099-01-01' },
				body: JSON.stringify(createJSONRPCRequest({ method: 'ping' })),
			}),
		)

		expect(response.status).toBe(400)
		expect(requests).toBe(0)
		expect(await response.json()).toEqual({
			jsonrpc: '2.0',
			id: 1,
			error: {
				code: -32022,
				message: "Unsupported MCP protocol version '2099-01-01'",
				data: {
					supported: ['2026-07-28', '2025-11-25', '2025-06-18'],
					requested: '2099-01-01',
				},
			},
		})
	})

	it('returns a parse error for malformed JSON', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), false)
		const response = await handler(
			new Request('http://localhost/mcp', { method: 'POST', body: '{ not json' }),
		)

		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({
			jsonrpc: '2.0',
			id: null,
			error: { code: -32700, message: 'Parse error' },
		})
	})

	it('returns an empty accepted response for a notification', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), false)
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { [MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18' },
				body: JSON.stringify(createJSONRPCNotification('notifications/initialized')),
			}),
		)

		expect(response.status).toBe(202)
		expect(await response.text()).toBe('')
	})

	it('frames a response as an event stream when negotiated', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), true)
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					accept: 'text/event-stream',
					[MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18',
				},
				body: JSON.stringify(createJSONRPCRequest({ method: 'ping' })),
			}),
		)
		const events = await collectSSE(response)

		expect(response.headers.get('x-accel-buffering')).toBe('no')
		expect(events).toHaveLength(1)
		const event = events[0]
		if (event === undefined) throw new Error('Expected one event-stream response')
		expect(JSON.parse(event.data)).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
	})

	it('accepts a headerless legacy initialize request', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), false)
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				body: JSON.stringify(createJSONRPCRequest()),
			}),
		)

		expect(response.status).toBe(200)
		expect((await response.json()).result.protocolVersion).toBe('2025-11-25')
	})

	it('rejects every other headerless request with -32020 and no data member', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), false)
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				body: JSON.stringify(createJSONRPCRequest({ method: 'tools/list' })),
			}),
		)
		const body = await response.json()

		expect(response.status).toBe(400)
		expect(body.error).toEqual({
			code: -32020,
			message: 'MCP request headers do not match the request body',
		})
		expect(body.error).not.toHaveProperty('data')
	})

	it('requires protocol and method headers on modern discovery, but not Mcp-Name', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), false)
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					[MCP_PROTOCOL_VERSION_HEADER]: MCP_PROTOCOL_VERSION,
					[MCP_METHOD_HEADER]: 'server/discover',
				},
				body: JSON.stringify(
					createJSONRPCRequest({
						method: 'server/discover',
						params: {
							_meta: {
								[MCP_META_VERSION]: MCP_PROTOCOL_VERSION,
								[MCP_META_CAPABILITIES]: {},
							},
						},
					}),
				),
			}),
		)

		expect(response.status).toBe(200)
	})

	it('requires Mcp-Name only on tools/call and matches it to params.name', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), false)
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					[MCP_PROTOCOL_VERSION_HEADER]: MCP_PROTOCOL_VERSION,
					[MCP_METHOD_HEADER]: 'tools/call',
					[MCP_NAME_HEADER]: 'add',
				},
				body: JSON.stringify(
					createJSONRPCRequest({
						method: 'tools/call',
						params: {
							name: 'add',
							arguments: {},
							_meta: {
								[MCP_META_VERSION]: MCP_PROTOCOL_VERSION,
								[MCP_META_CAPABILITIES]: {},
							},
						},
					}),
				),
			}),
		)

		expect(response.status).toBe(200)
	})

	it('returns -32020 when a required modern header disagrees with the body', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), false)
		const response = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					[MCP_PROTOCOL_VERSION_HEADER]: MCP_PROTOCOL_VERSION,
					[MCP_METHOD_HEADER]: 'tools/list',
				},
				body: JSON.stringify(
					createJSONRPCRequest({
						method: 'server/discover',
						params: {
							_meta: {
								[MCP_META_VERSION]: MCP_PROTOCOL_VERSION,
								[MCP_META_CAPABILITIES]: {},
							},
						},
					}),
				),
			}),
		)

		expect(response.status).toBe(400)
		expect((await response.json()).error).toEqual({
			code: -32020,
			message: 'MCP request headers do not match the request body',
		})
	})

	it('maps a modern unknown method to HTTP 404 while legacy remains HTTP 200', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), false)
		const params = {
			_meta: {
				[MCP_META_VERSION]: MCP_PROTOCOL_VERSION,
				[MCP_META_CAPABILITIES]: {},
			},
		}
		const modern = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: {
					[MCP_PROTOCOL_VERSION_HEADER]: MCP_PROTOCOL_VERSION,
					[MCP_METHOD_HEADER]: 'unknown',
				},
				body: JSON.stringify(createJSONRPCRequest({ method: 'unknown', params })),
			}),
		)
		const legacy = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { [MCP_PROTOCOL_VERSION_HEADER]: '2025-06-18' },
				body: JSON.stringify(createJSONRPCRequest({ method: 'unknown' })),
			}),
		)

		expect(modern.status).toBe(404)
		expect((await modern.json()).error.code).toBe(-32601)
		expect(legacy.status).toBe(200)
		expect((await legacy.json()).error.code).toBe(-32601)
	})

	it('allows no Origin and rejects every present origin outside the allowlist', async () => {
		const handler = createMCPPostHandler(createCalculatorServer(), false)
		const allowed = createMCPPostHandler(createCalculatorServer(), false, {
			origins: ['https://client.example'],
		})
		const delegated = createMCPPostHandler(createCalculatorServer(), false, { enabled: false })
		const body = JSON.stringify(createJSONRPCRequest())
		const absent = await handler(new Request('http://localhost/mcp', { method: 'POST', body }))
		const unlisted = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { origin: 'https://client.example' },
				body,
			}),
		)
		const malformed = await handler(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { origin: 'not an origin' },
				body,
			}),
		)
		const admitted = await allowed(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { origin: 'https://client.example' },
				body,
			}),
		)
		const delegatedResponse = await delegated(
			new Request('http://localhost/mcp', {
				method: 'POST',
				headers: { origin: 'https://unlisted.example' },
				body,
			}),
		)

		expect(absent.status).toBe(200)
		expect(unlisted.status).toBe(403)
		expect(malformed.status).toBe(403)
		expect(admitted.status).toBe(200)
		expect(delegatedResponse.status).toBe(200)
	})
})
