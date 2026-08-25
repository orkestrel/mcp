import {
	createMCPLegacy,
	createMCPClient,
	JSONRPC_METHOD_NOT_FOUND,
	MCP_LEGACY_VERSION,
	MCP_META_CAPABILITIES,
	MCP_META_VERSION,
	MCP_MODERN_VERSION,
	MCP_PROTOCOL_VERSION,
	MCP_UNSUPPORTED_VERSION,
	SUPPORTED_PROTOCOL_VERSIONS,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	createCalculatorServer,
	createJSONRPCRequest,
	createLoopbackTransport,
	modernRequest,
} from '../../setup.js'

describe('MCP revision boundary', () => {
	it('advertises only the modern revision from a bare server', async () => {
		const server = createCalculatorServer()
		const response = await server.dispatch(modernRequest('server/discover'))

		expect(response).toMatchObject({
			result: { supportedVersions: [MCP_MODERN_VERSION] },
		})
	})

	it('rejects every non-modern stamped revision with modern-scoped retry data', async () => {
		const server = createCalculatorServer()
		// The trailing, leading, and prefixed variants of the modern revision are the strict
		// guard's own boundary: nothing between the parser and `isMCPModernVersion` trims or
		// normalizes a stamp, so each is refused and echoed back exactly as it arrived.
		for (const version of [
			MCP_PROTOCOL_VERSION,
			MCP_LEGACY_VERSION,
			'2099-01-01',
			`${MCP_MODERN_VERSION} `,
			` ${MCP_MODERN_VERSION}`,
			`x${MCP_MODERN_VERSION}`,
		]) {
			const response = await server.dispatch(
				createJSONRPCRequest({
					method: 'tools/list',
					params: {
						_meta: {
							[MCP_META_VERSION]: version,
							[MCP_META_CAPABILITIES]: {},
						},
					},
				}),
			)

			expect(response).toMatchObject({
				error: {
					code: MCP_UNSUPPORTED_VERSION,
					data: { supported: [MCP_MODERN_VERSION], requested: version },
				},
			})
		}
	})

	it('serves legacy initialize and ping only through createMCPLegacy', async () => {
		const bare = createCalculatorServer()
		const legacy = createMCPLegacy(bare)

		expect(
			await legacy.dispatch(
				createJSONRPCRequest({
					method: 'initialize',
					params: { protocolVersion: MCP_LEGACY_VERSION },
				}),
			),
		).toMatchObject({ result: { protocolVersion: MCP_LEGACY_VERSION } })
		expect(await legacy.dispatch(createJSONRPCRequest({ method: 'ping' }))).toEqual({
			jsonrpc: '2.0',
			id: 1,
			result: {},
		})

		for (const method of ['initialize', 'ping']) {
			expect(await bare.dispatch(createJSONRPCRequest({ method }))).toMatchObject({
				error: { code: JSONRPC_METHOD_NOT_FOUND },
			})
		}
		expect(await bare.dispatch(modernRequest('ping'))).toMatchObject({
			error: { code: JSONRPC_METHOD_NOT_FOUND },
		})
	})

	it('keeps client requests modern after negotiating with a bare server', async () => {
		const server = createCalculatorServer()
		const client = createMCPClient({ transport: createLoopbackTransport(server) })

		await client.connect()

		expect(client.version).toBe(MCP_MODERN_VERSION)
		expect((await client.discover()).supportedVersions).toEqual([MCP_MODERN_VERSION])
		expect((await client.tools()).map((tool) => tool.name)).toEqual(['add', 'boom'])
		expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual([MCP_MODERN_VERSION])
	})
})
