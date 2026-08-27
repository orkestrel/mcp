import type {
	JSONRPCId,
	JSONRPCErrorResponse,
	JSONRPCInvocation,
	JSONRPCNotification,
	JSONRPCRequest,
	JSONRPCResponse,
	JSONRPCResultResponse,
	MCPCallResult,
	MCPDiscoverResult,
	MCPElicitForm,
	MCPElicitParams,
	MCPElicitRequest,
	MCPElicitSchema,
	MCPElicitURL,
	MCPInputRequest,
	MCPInputRequestMap,
	MCPInputResult,
	MCPLegacyResult,
	MCPListResult,
	MCPResult,
	MCPToolDescriptor,
	MCPUnstampedCallResult,
	MCPSubscriptionResult,
} from '@src/core'
import * as core from '@src/core'
import {
	buildJSONRPCResult,
	computeMissingCapabilities,
	isMCPError,
	isMCPInputRequest,
	isAbsoluteURI,
	isBoundedJSON,
	isBoundedString,
	isElicitContent,
	isMCPElicitRequest,
	isMCPElicitForm,
	isMCPElicitURL,
	isMCPElicitFieldSchema,
	isMCPElicitResult,
	isMCPElicitSchema,
	isFormElicitationSupported,
	isInitializeRequest,
	isMCPInputRequestMap,
	isMCPInputResponse,
	isMCPInputResult,
	isJSONObject,
	isJSONRPCErrorResponse,
	isJSONRPCId,
	isJSONRPCInvocation,
	isJSONRPCMessage,
	isJSONRPCNotification,
	isJSONRPCRequest,
	isJSONRPCResponse,
	isJSONRPCResultResponse,
	isMCPAnnotations,
	isMCPBlobResource,
	isMCPCallResult,
	isMCPClientCapabilities,
	isMCPCompletion,
	isMCPCompletionParams,
	isMCPCompletionReference,
	isMCPCompletionResult,
	isMCPContent,
	isMCPIcon,
	isMCPIdentity,
	isMCPLegacyVersion,
	isMCPLegacyResult,
	isMCPLoggingLevel,
	isMCPMetaKey,
	isMCPMetaObject,
	isMCPModernVersion,
	isMCPProgress,
	isMCPPaginationParams,
	isMCPPrompt,
	isMCPPromptArgument,
	isMCPPromptGetResult,
	isMCPPromptMessage,
	isMCPPromptPage,
	isMCPResource,
	isMCPResourceContents,
	isMCPResourcePage,
	isMCPResourceTemplate,
	isMCPResourceTemplatePage,
	isMCPResult,
	isMCPResultMetaObject,
	isMCPRoot,
	isMCPRootResult,
	isMCPSampleResult,
	isMCPServerCapabilities,
	isMCPStringArguments,
	isJSONRPCError,
	isMCPNotificationMetaObject,
	isMCPTaskDetail,
	isMCPTaskDetailResult,
	isMCPTaskNotification,
	isMCPTaskResult,
	isMCPTaskStatus,
	isMCPTextResource,
	isMCPVersion,
	isModernRequest,
	isMCPSubscriptionFilter,
	isMCPSubscriptionResult,
	isRFC3339Date,
	isRFC3339DateTime,
	isStandardBase64,
	isTaskSupported,
	MCP_EXTENSION_TASKS,
	MCP_HEADER_MISMATCH,
	MCP_MISSING_CAPABILITY,
	MCP_META_CAPABILITIES,
	MCP_META_SERVER,
	MCP_META_SUBSCRIPTION,
	MCP_META_VERSION,
	MCP_UNSUPPORTED_VERSION,
	MCPError,
	SUPPORTED_MCP_VERSIONS,
	SUPPORTED_LEGACY_PROTOCOL_VERSIONS,
	SUPPORTED_MODERN_PROTOCOL_VERSIONS,
} from '@src/core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
	createHostileCorpus,
	createJSONRPCNotification,
	createJSONRPCRequest,
	createThrowingKeys,
	GUARD_KEY_NAMES,
} from '../../setup.js'

// The JSON-RPC 2.0 wire guards (total functions over an already-parsed
// `unknown`; adversarial input returns `false`, never throws). A request REQUIRES an
// `id` and a notification forbids one; a response carries EXACTLY ONE of result / error,
// and only the error arm may omit its `id`.

describe('bounded hostile values', () => {
	it('counts UTF-8 string bytes at the exact boundary', () => {
		expect(isBoundedString('€', 3)).toBe(true)
		expect(isBoundedString('€', 2)).toBe(false)
		expect(isBoundedString('😀', 4)).toBe(true)
		expect(isBoundedString('😀', 3)).toBe(false)
		expect(isBoundedString('\ud800', 3)).toBe(true)
	})

	it('bounds serialized JSON bytes, object keys, and depth', () => {
		const value = { ok: true }
		const bytes = JSON.stringify(value).length
		// Exact JSON rejects `undefined` and non-finite numbers instead of silently
		// normalizing domain values to a different wire value.
		expect(isBoundedJSON(undefined, { bytes: 0, depth: 0 })).toBe(false)
		expect(isBoundedJSON(Number.NaN, { bytes: 4, depth: 0 })).toBe(false)
		expect(isBoundedJSON(Number.POSITIVE_INFINITY, { bytes: 4, depth: 0 })).toBe(false)
		expect(isBoundedJSON(Number.NaN, { bytes: 3, depth: 0 })).toBe(false)
		expect(isBoundedJSON(value, { bytes, keys: 1, depth: 1 })).toBe(true)
		expect(isBoundedJSON(value, { bytes: bytes - 1, keys: 1, depth: 1 })).toBe(false)
		expect(isBoundedJSON('a\nb', { bytes: 6, depth: 0 })).toBe(true)
		expect(isBoundedJSON('a\nb', { bytes: 5, depth: 0 })).toBe(false)
		expect(isBoundedJSON('\ud800', { bytes: 8, depth: 0 })).toBe(true)
		expect(isBoundedJSON({ outer: { inner: true } }, { bytes: 64, keys: 1, depth: 2 })).toBe(false)

		let deep: unknown = null
		for (let depth = 0; depth < 33; depth += 1) deep = [deep]
		expect(isBoundedJSON(deep, { bytes: 128, depth: 32 })).toBe(false)
		expect(isBoundedJSON({}, { bytes: Number.NaN, depth: Number.NaN })).toBe(false)
	})

	it('rejects cycles while accepting hostile-looking own data keys', () => {
		const cycle: Record<string, unknown> = {}
		cycle['self'] = cycle
		const hostile = Object.create(null)
		hostile['__proto__'] = true
		hostile['constructor'] = { prototype: true }

		expect(isBoundedJSON(cycle, { bytes: 128, keys: 8, depth: 8 })).toBe(false)
		expect(isBoundedJSON(hostile, { bytes: 128, keys: 8, depth: 8 })).toBe(true)
	})

	it('rejects Map and Set regardless of insertion order', () => {
		for (const value of [
			new Map([
				['a', 1],
				['b', 2],
			]),
			new Map([
				['b', 2],
				['a', 1],
			]),
			new Set(['a', 'b']),
			new Set(['b', 'a']),
		]) {
			expect(isBoundedJSON(value, { bytes: 128, depth: 8 })).toBe(false)
		}
	})

	it('rejects non-exact primitive, record, and exotic populations', () => {
		const symbol = { ok: true }
		Object.defineProperty(symbol, Symbol('hidden'), { enumerable: true, value: true })
		const hidden = Object.defineProperty({}, 'value', { enumerable: false, value: true })
		const instance = new (class {
			readonly value = true
		})()

		for (const value of [{ value: undefined }, { value: BigInt(1) }, symbol, hidden, instance]) {
			expect(isBoundedJSON(value, { bytes: 128, keys: 8, depth: 8 })).toBe(false)
		}
	})

	it('contains accessors and hostile proxies without throwing', () => {
		const accessor = Object.defineProperty({}, 'value', {
			enumerable: true,
			get() {
				throw new Error('must not escape')
			},
		})
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()

		expect(isBoundedJSON(accessor, { bytes: 128, depth: 8 })).toBe(false)
		expect(isBoundedJSON(proxy, { bytes: 128, depth: 8 })).toBe(false)
	})

	it('rejects exhausted budgets before retrieving child descriptors', () => {
		let descriptors = 0
		const value = new Proxy(
			{ child: true },
			{
				getOwnPropertyDescriptor(target, property) {
					descriptors += 1
					return Reflect.getOwnPropertyDescriptor(target, property)
				},
			},
		)

		expect(isBoundedJSON(value, { bytes: 1, keys: 0, depth: 0 })).toBe(false)
		expect(descriptors).toBe(0)
	})

	it('counts array indices as keys and accepts a shared acyclic graph', () => {
		const shared = { ok: true }

		expect(isBoundedJSON([1, 2], { bytes: 5, keys: 2, depth: 1 })).toBe(true)
		expect(isBoundedJSON([1, 2], { bytes: 5, keys: 1, depth: 1 })).toBe(false)
		expect(isBoundedJSON({ left: shared, right: shared }, { bytes: 64, keys: 4, depth: 2 })).toBe(
			true,
		)
	})
})

describe('rich MCP content validators', () => {
	it('exposes total format and progress guards for their exact public contracts', () => {
		for (const value of ['', 'YQ==', 'YWI=', 'YWJj']) expect(isStandardBase64(value)).toBe(true)
		for (const value of ['$', 'A', 'AA-_', null]) expect(isStandardBase64(value)).toBe(false)
		for (const value of ['resource:', 'https://example.test', 'data:text/plain,x', 'urn:test:id']) {
			expect(isAbsoluteURI(value)).toBe(true)
		}
		for (const value of ['', 'relative', ' https://example.test', null]) {
			expect(isAbsoluteURI(value)).toBe(false)
		}
		expect(isMCPProgress({ progress: 1, total: 2, message: 'halfway' })).toBe(true)
		for (const value of [
			{ progress: Number.NaN },
			{ progress: 1, total: Number.POSITIVE_INFINITY },
			{ progress: 1, message: 7 },
			null,
		]) {
			expect(isMCPProgress(value)).toBe(false)
		}
	})

	it('accepts every exact dated-schema content block and complete array-valued output', () => {
		const content = [
			{
				type: 'text',
				text: 'hello',
				annotations: { audience: ['user'], lastModified: '2026-08-07T00:00:00Z' },
			},
			{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
			{ type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/mpeg' },
			{
				type: 'resource_link',
				name: 'guide',
				title: 'Guide',
				icons: [
					{ src: 'resource://icon', mimeType: 'image/png', sizes: ['16x16'], theme: 'light' },
				],
				uri: 'resource://guide',
				size: 42,
			},
			{ type: 'resource', resource: { uri: 'resource://text', text: 'body' } },
			{ type: 'resource', resource: { uri: 'resource://blob', blob: 'YmxvYg==' } },
		]

		expect(content.every((entry) => isMCPContent(entry))).toBe(true)
		expect(
			isMCPCallResult({
				resultType: 'complete',
				content,
				structuredContent: ['array', 1, true, null],
			}),
		).toBe(true)
	})

	it('rejects unstamped, non-JSON, and malformed rich results', () => {
		expect(isMCPCallResult({ content: [{ type: 'text', text: 'legacy' }] })).toBe(false)
		expect(
			isMCPCallResult({
				resultType: 'complete',
				content: [{ type: 'text', text: 'bad' }],
				structuredContent: Number.NaN,
			}),
		).toBe(false)
		expect(isMCPContent({ type: 'image', data: 'missing-mime' })).toBe(false)
		expect(
			isMCPContent({
				type: 'resource',
				resource: { uri: 'resource://both', text: 'x', blob: 'eA==' },
			}),
		).toBe(true)
		expect(isMCPContent({ type: 'text', text: 'bad', annotations: { priority: 2 } })).toBe(false)
		expect(isMCPContent({ type: 'text', text: 'bad', _meta: { value: Number.NaN } })).toBe(false)
		expect(isMCPContent({ type: 'text', text: 'bad', _meta: { 'bad key': true } })).toBe(false)
		expect(
			isMCPCallResult({ resultType: 'complete', content: [], _meta: { value: undefined } }),
		).toBe(false)

		const audience = new Array(1)
		expect(isMCPContent({ type: 'text', text: 'bad', annotations: { audience } })).toBe(false)
		const accessor = Object.defineProperty({}, 'type', {
			enumerable: true,
			get() {
				throw new Error('must not escape')
			},
		})
		expect(isMCPContent(accessor)).toBe(false)
	})

	it('enforces standard base64, absolute URI, and integer resource-size schema formats', () => {
		for (const data of ['$', 'A', 'AAA', 'AA=A', 'AA-_', 'AAAA=']) {
			expect(isMCPContent({ type: 'image', data, mimeType: 'image/png' })).toBe(false)
			expect(isMCPContent({ type: 'audio', data, mimeType: 'audio/mpeg' })).toBe(false)
			expect(
				isMCPContent({ type: 'resource', resource: { uri: 'resource:blob', blob: data } }),
			).toBe(false)
		}
		for (const uri of ['', 'relative/path', '://missing-scheme']) {
			expect(isMCPContent({ type: 'resource', resource: { uri, text: 'body' } })).toBe(false)
			expect(isMCPContent({ type: 'resource_link', name: 'link', uri })).toBe(false)
			expect(
				isMCPContent({
					type: 'resource_link',
					name: 'icon-link',
					uri: 'resource:link',
					icons: [{ src: uri }],
				}),
			).toBe(false)
		}
		expect(isMCPContent({ type: 'image', data: '', mimeType: 'image/png' })).toBe(true)
		expect(isMCPContent({ type: 'image', data: 'YQ==', mimeType: 'image/png' })).toBe(true)
		expect(isMCPContent({ type: 'image', data: 'YWI=', mimeType: 'image/png' })).toBe(true)
		expect(isMCPContent({ type: 'image', data: 'YWJj', mimeType: 'image/png' })).toBe(true)
		for (const uri of [
			'resource:',
			'https://example.test/path',
			'data:text/plain,x',
			'urn:test:id',
		]) {
			expect(isMCPContent({ type: 'resource', resource: { uri, text: 'body' } })).toBe(true)
		}
		expect(
			isMCPContent({ type: 'resource_link', name: 'fractional', uri: 'resource:item', size: 1.5 }),
		).toBe(false)
		expect(
			isMCPContent({ type: 'resource_link', name: 'negative', uri: 'resource:item', size: -1 }),
		).toBe(false)
	})

	it('keeps every rich-content leaf guard total over hostile values', () => {
		const accessor = Object.defineProperty({}, 'uri', {
			enumerable: true,
			get() {
				throw new Error('must not escape')
			},
		})
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()
		for (const value of [accessor, proxy]) {
			expect(isMCPAnnotations(value)).toBe(false)
			expect(isMCPIcon(value)).toBe(false)
			expect(isMCPTextResource(value)).toBe(false)
			expect(isMCPBlobResource(value)).toBe(false)
			expect(isMCPContent(value)).toBe(false)
			expect(isMCPCallResult(value)).toBe(false)
			expect(isMCPElicitForm(value)).toBe(false)
			expect(isMCPElicitURL(value)).toBe(false)
			expect(isMCPElicitResult(value)).toBe(false)
		}
		const requestAccessor = Object.defineProperty({}, 'method', {
			enumerable: true,
			get() {
				throw new Error('must not escape')
			},
		})
		expect(isMCPElicitRequest(requestAccessor)).toBe(false)
	})
})

describe('RFC 3986 absolute URI validation', () => {
	it('accepts hierarchical, non-hierarchical, IP-literal, percent-encoded, and empty components', () => {
		for (const value of [
			'urn:example:animal:ferret:nose',
			'mailto:user@example.test',
			'https://[2001:db8::1]/a%20b?x=1#part',
			'https://[::]/',
			'https://[::ffff:192.0.2.1]/',
			'https://[1:2:3:4:5:6:7:8]/',
			'https://[v1.fe80::a]/',
			'custom:',
			'custom:?',
			'custom:#',
			'file:///tmp/item',
			'http://192.0.2.1:8080/path',
			'http://',
			'custom://',
			'foo:///path',
			'foo://:80/path',
			'http://1.2.3/',
			'https://256.1.1.1/',
			'foo://01.2.3.4/',
		]) {
			expect(isAbsoluteURI(value)).toBe(true)
		}
	})

	it('rejects relative, whitespace, escapes, authorities, ports, and IP literals outside the RFC', () => {
		for (const value of [
			'relative/path',
			'https://example.test/a b',
			'https://example.test/%GG',
			'https://example.test:port/path',
			'https://[2001:db8:::1]/',
			'https://[:1::]/',
			'https://[1::2:]/',
			'https://[:1:2:3:4:5:6:7::]/',
			'https://[v.fe80]/',
			'https://user@@example.test/',
			'1scheme:value',
			'https://example.test/\u0000',
		]) {
			expect(isAbsoluteURI(value)).toBe(false)
		}
	})
})

describe('dated metadata, identity, and capability guards', () => {
	it('validates exact metadata key grammar and finite JSON values', () => {
		for (const key of ['', 'name', 'vendor.example/', 'vendor.example/name_value.part']) {
			expect(isMCPMetaKey(key)).toBe(true)
		}
		for (const key of ['-name', 'vendor-.example/name', 'vendor//name']) {
			expect(isMCPMetaKey(key)).toBe(false)
		}
		expect(isJSONObject({ nested: [1, true, null] })).toBe(true)
		expect(isJSONObject({ value: Number.NaN })).toBe(false)
		const hidden = Object.defineProperty({}, 'value', { enumerable: false, value: true })
		const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => true })
		expect(isJSONObject(hidden)).toBe(false)
		expect(isJSONObject(accessor)).toBe(false)
		expect(
			isMCPMetaObject({
				'': null,
				name: true,
				'vendor.example/': {},
				'vendor.example/name_value.part': [1, 'two'],
			}),
		).toBe(true)
		for (const value of [
			{ '-name': true },
			{ 'vendor-.example/name': true },
			{ 'vendor//name': true },
			{ 'vendor.example/name/extra': true },
			{ valid: Number.NaN },
			{ valid: undefined },
		]) {
			expect(isMCPMetaObject(value)).toBe(false)
		}
	})

	it('applies the reserved server identity only to result metadata populations', () => {
		const valid = {
			[MCP_META_SERVER]: { name: 'server', version: '1.0.0', extension: true },
			'vendor.example/trace': { id: 'trace-1' },
		}
		const invalid = { [MCP_META_SERVER]: 7 }

		expect(isMCPResultMetaObject(valid)).toBe(true)
		expect(isMCPResultMetaObject(invalid)).toBe(false)
		expect(isMCPMetaObject(invalid)).toBe(true)
		expect(isMCPCallResult({ resultType: 'complete', content: [], _meta: invalid })).toBe(false)
		expect(
			isMCPInputResult({
				resultType: 'input_required',
				requestState: 'opaque',
				_meta: invalid,
			}),
		).toBe(false)
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()
		expect(isMCPResultMetaObject(proxy)).toBe(false)
	})

	it('accepts only the dated logging-level literals', () => {
		for (const level of [
			'debug',
			'info',
			'notice',
			'warning',
			'error',
			'critical',
			'alert',
			'emergency',
		]) {
			expect(isMCPLoggingLevel(level)).toBe(true)
		}
		for (const level of ['warn', 'fatal', 1, undefined]) {
			expect(isMCPLoggingLevel(level)).toBe(false)
		}
	})

	it('validates complete identities and contains hostile identity values', () => {
		expect(
			isMCPIdentity({
				name: 'agent',
				version: '1.0.0',
				title: 'Agent',
				description: 'Operator agent',
				websiteUrl: 'https://example.test/about',
				icons: [{ src: 'data:image/png;base64,' }],
			}),
		).toBe(true)
		expect(isMCPIdentity({ name: 'agent', version: '1', websiteUrl: 'relative' })).toBe(false)
		expect(isMCPIcon({ src: 'resource:icon', sizes: ['16x16', 'any'], theme: 'dark' })).toBe(true)

		const accessor = Object.defineProperty({}, 'name', {
			enumerable: true,
			get() {
				throw new Error('must not escape')
			},
		})
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()
		expect(isMCPIdentity(accessor)).toBe(false)
		expect(isMCPIdentity(proxy)).toBe(false)
	})

	it('accepts exact open client capabilities and rejects malformed known declarations', () => {
		expect(
			isMCPClientCapabilities({
				custom: { enabled: true },
				experimental: { feature: { limit: 2 } },
				roots: {},
				sampling: { context: {}, tools: {}, extension: true },
				elicitation: {},
				extensions: { 'vendor.example/feature': { enabled: true } },
			}),
		).toBe(true)
		expect(isMCPClientCapabilities({ elicitation: { url: {}, future: true } })).toBe(true)
		for (const value of [
			{ custom: true },
			{ sampling: { context: true } },
			{ elicitation: { future: {} } },
			{ extensions: { feature: {} } },
			{ extensions: { 'vendor.example/feature': true } },
		]) {
			expect(isMCPClientCapabilities(value)).toBe(false)
		}
	})

	it('accepts exact open server capabilities and rejects malformed known declarations', () => {
		expect(
			isMCPServerCapabilities({
				custom: { enabled: true },
				logging: {},
				completions: {},
				prompts: { listChanged: true },
				resources: { subscribe: true, listChanged: false },
				tools: { listChanged: false },
				extensions: { 'vendor.example/feature': { enabled: true } },
			}),
		).toBe(true)
		for (const value of [
			{ custom: false },
			{ tools: { listChanged: 'yes' } },
			{ resources: { subscribe: 1 } },
			{ extensions: { feature: {} } },
			{ extensions: { 'vendor.example/feature': Number.NaN } },
		]) {
			expect(isMCPServerCapabilities(value)).toBe(false)
		}
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()
		expect(isMCPClientCapabilities(proxy)).toBe(false)
		expect(isMCPServerCapabilities(proxy)).toBe(false)
	})
})

describe('isJSONRPCId', () => {
	it('accepts a string id', () => {
		expect(isJSONRPCId('abc')).toBe(true)
	})

	it('accepts an empty string, which the dated schema does not forbid', () => {
		expect(isJSONRPCId('')).toBe(true)
	})

	it('accepts a finite integer id, including zero and a negative one', () => {
		expect(isJSONRPCId(1)).toBe(true)
		expect(isJSONRPCId(0)).toBe(true)
		expect(isJSONRPCId(-0)).toBe(true)
		expect(isJSONRPCId(-7)).toBe(true)
	})

	it('rejects an absent id, because absence is not an id', () => {
		expect(isJSONRPCId(undefined)).toBe(false)
	})

	it('rejects a null id, which MCP omits rather than sends', () => {
		expect(isJSONRPCId(null)).toBe(false)
	})

	it('rejects an object, an array, a boolean, and a non-integer number', () => {
		for (const value of [
			{},
			{ id: 1 },
			[],
			[1],
			true,
			false,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			expect(isJSONRPCId(value)).toBe(false)
		}
	})

	// Totality is "answers, never throws". The corpus deliberately contains legal ids
	// (`''`, `0`, `-0`) alongside hostile shapes, so the assertion here is that every one
	// gets a boolean answer — the membership assertions above are what pin which answer.
	it('answers every value in the shared adversarial corpus without throwing', () => {
		for (const value of createHostileCorpus()) {
			expect(typeof isJSONRPCId(value)).toBe('boolean')
		}
	})
})

describe('isMCPVersion', () => {
	it('accepts every supported revision and rejects removed or unknown revisions', () => {
		for (const version of SUPPORTED_MCP_VERSIONS) {
			expect(isMCPVersion(version)).toBe(true)
		}
		expect(isMCPVersion('2025-03-26')).toBe(false)
		expect(isMCPVersion('2024-11-05')).toBe(false)
	})

	it('keeps modern and legacy revision guards disjoint', () => {
		for (const version of SUPPORTED_MODERN_PROTOCOL_VERSIONS) {
			expect(isMCPModernVersion(version)).toBe(true)
			expect(isMCPLegacyVersion(version)).toBe(false)
		}
		for (const version of SUPPORTED_LEGACY_PROTOCOL_VERSIONS) {
			expect(isMCPLegacyVersion(version)).toBe(true)
			expect(isMCPModernVersion(version)).toBe(false)
		}
	})

	it('is total over non-string values', () => {
		for (const value of [undefined, null, 7, {}, [], true]) {
			expect(isMCPVersion(value)).toBe(false)
		}
	})
})

describe('isMCPSubscriptionFilter', () => {
	it('accepts empty, complete, and extension-bearing filters', () => {
		expect(isMCPSubscriptionFilter({})).toBe(true)
		expect(
			isMCPSubscriptionFilter({
				toolsListChanged: true,
				promptsListChanged: false,
				resourcesListChanged: true,
				resourceSubscriptions: ['resource://one'],
				taskIds: ['task-1', 'task-2'],
				extension: { future: true },
			}),
		).toBe(true)
		// The task family opts in exactly as the resource family does, and an empty request is a
		// caller asking for no task at all rather than for every task.
		expect(isMCPSubscriptionFilter({ taskIds: [] })).toBe(true)
		// Request order and duplicates are the caller's, and this guard normalizes neither.
		expect(isMCPSubscriptionFilter({ taskIds: ['b', 'a', 'b'] })).toBe(true)
	})

	it('rejects invalid recognized fields and remains total over hostile input', () => {
		for (const value of [
			{ toolsListChanged: 'yes' },
			{ promptsListChanged: 1 },
			{ resourcesListChanged: null },
			{ resourceSubscriptions: ['resource://one', 2] },
			// A malformed `taskIds` fails the whole filter rather than being dropped, so the listen
			// request carrying it is refused instead of quietly agreeing to a narrower subscription.
			{ taskIds: 'task-1' },
			{ taskIds: ['task-1', 7] },
			{ taskIds: [null] },
			{ taskIds: {} },
			null,
			[],
		]) {
			expect(isMCPSubscriptionFilter(value)).toBe(false)
		}
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()
		expect(isMCPSubscriptionFilter(proxy)).toBe(false)
	})
})

describe('isMCPSubscriptionResult', () => {
	it('accepts a complete result carrying a JSON-RPC subscription id', () => {
		expect(
			isMCPSubscriptionResult({
				resultType: 'complete',
				_meta: { 'io.modelcontextprotocol/subscriptionId': 'listen-1' },
			}),
		).toBe(true)
		expect(
			isMCPSubscriptionResult({
				resultType: 'complete',
				_meta: { 'io.modelcontextprotocol/subscriptionId': 0 },
				extension: true,
			}),
		).toBe(true)
	})

	it('rejects malformed terminals and remains total over hostile input', () => {
		for (const value of [
			{ resultType: 'task', _meta: { 'io.modelcontextprotocol/subscriptionId': 1 } },
			{ resultType: 'complete' },
			{ resultType: 'complete', _meta: {} },
			{ resultType: 'complete', _meta: { 'io.modelcontextprotocol/subscriptionId': null } },
			null,
			[],
		]) {
			expect(isMCPSubscriptionResult(value)).toBe(false)
		}
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()
		expect(isMCPSubscriptionResult(proxy)).toBe(false)
	})
})

describe('multi-round-trip validators', () => {
	it('recognizes implicit and explicit form capabilities but not URL-only support', () => {
		expect(isFormElicitationSupported({ elicitation: {} })).toBe(true)
		expect(isFormElicitationSupported({ elicitation: { form: {} } })).toBe(true)
		expect(isFormElicitationSupported({ elicitation: { form: {}, url: {} } })).toBe(true)
		expect(isFormElicitationSupported({ elicitation: { url: {} } })).toBe(false)
		expect(isFormElicitationSupported({ elicitation: { extension: {} } })).toBe(false)
		expect(isFormElicitationSupported({})).toBe(false)
	})

	it('names each capability a round needs and the client did not declare', () => {
		const form: MCPInputRequest = {
			method: 'elicitation/create',
			params: { message: 'Approve?', requestedSchema: { type: 'object', properties: {} } },
		}
		const url: MCPInputRequest = {
			method: 'elicitation/create',
			params: { mode: 'url', message: 'Authenticate', url: 'https://example.test' },
		}
		const mixed: MCPInputRequestMap = {
			approval: form,
			greeting: { method: 'sampling/createMessage', params: {} },
			workspace: { method: 'roots/list' },
		}

		expect(computeMissingCapabilities(mixed, {})).toEqual({
			elicitation: {},
			sampling: {},
			roots: {},
		})
		expect(
			computeMissingCapabilities(mixed, { elicitation: {}, sampling: {}, roots: {} }),
		).toBeUndefined()
		// Each kind reads its OWN declaration, so a client can be short of exactly one.
		expect(computeMissingCapabilities(mixed, { elicitation: {}, sampling: {} })).toEqual({
			roots: {},
		})
		expect(computeMissingCapabilities(mixed, { elicitation: {}, roots: {} })).toEqual({
			sampling: {},
		})
		// URL-only support authorizes a URL round and refuses a form one, and the reverse.
		expect(
			computeMissingCapabilities({ approval: url }, { elicitation: { url: {} } }),
		).toBeUndefined()
		expect(computeMissingCapabilities({ approval: form }, { elicitation: { url: {} } })).toEqual({
			elicitation: {},
		})
		expect(computeMissingCapabilities({ approval: url }, { elicitation: {} })).toEqual({
			elicitation: {},
		})
		// Total over hostile capability records, which read as declaring nothing.
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()

		expect(computeMissingCapabilities({ workspace: { method: 'roots/list' } }, proxy)).toEqual({
			roots: {},
		})
	})

	it('validates every restricted primitive elicitation schema family', () => {
		for (const schema of [
			{ type: 'boolean', default: true },
			{ type: 'number', minimum: 0, maximum: 5, default: 2 },
			{ type: 'integer', minimum: 5, maximum: 1, default: 1.5 },
			{ type: 'string', format: 'email', minLength: 3 },
			{ type: 'string', enum: ['yes', 'no'], default: 'yes' },
			{ type: 'string', enum: ['yes'], enumNames: ['Yes'] },
			{ type: 'string', oneOf: [{ const: 'yes', title: 'Yes' }] },
			{ type: 'array', items: { type: 'string', enum: ['one'] }, default: ['one'] },
			{ type: 'array', items: { anyOf: [{ const: 'one', title: 'One' }] } },
		]) {
			expect(isMCPElicitFieldSchema(schema)).toBe(true)
		}
		expect(isMCPElicitFieldSchema({ type: 'object' })).toBe(false)
		expect(isMCPElicitFieldSchema({ type: 'string', format: 'phone' })).toBe(false)
		expect(isMCPElicitFieldSchema({ type: 'number', minimum: Number.NaN })).toBe(false)
		expect(isMCPElicitFieldSchema({ type: 'integer', default: Number.POSITIVE_INFINITY })).toBe(
			false,
		)
		expect(isMCPElicitFieldSchema({ type: 'string', minLength: -1 })).toBe(false)
		expect(isMCPElicitFieldSchema({ type: 'string', maxLength: 1.5 })).toBe(false)
		expect(isMCPElicitFieldSchema({ type: 'string', enumNames: ['orphan'] })).toBe(false)
		expect(
			isMCPElicitFieldSchema({
				type: 'string',
				enum: ['one'],
				enumNames: ['One'],
				minLength: 1,
				format: 'email',
				extension: { enabled: true },
			}),
		).toBe(true)
		for (const schema of [
			{ type: 'string', enum: ['one', 2] },
			{ type: 'string', enum: ['one'], enumNames: ['One', 2] },
			{ type: 'string', oneOf: [{ const: 'one', title: 1 }] },
			{ type: 'array', items: { type: 'number', enum: ['one'] } },
			{ type: 'array', items: { enum: ['one'] } },
			{ type: 'array', items: { type: 'string', enum: ['one', 2] } },
			{ type: 'array', items: { anyOf: [{ const: 'one', title: 1 }] } },
		]) {
			expect(isMCPElicitFieldSchema(schema)).toBe(false)
		}
		expect(
			isMCPElicitFieldSchema({
				type: 'string',
				enum: ['one'],
				oneOf: [{ const: 'one', title: 'One' }],
				extension: true,
			}),
		).toBe(true)
		expect(
			isMCPElicitFieldSchema({
				type: 'array',
				items: {
					type: 'string',
					enum: ['one'],
					anyOf: [{ const: 'two', title: 'Two' }],
					extension: true,
				},
				default: ['outside'],
			}),
		).toBe(true)
		expect(isMCPElicitFieldSchema({ type: 'array', items: { type: 'string' } })).toBe(false)
		expect(isMCPElicitFieldSchema({ type: 'array', items: { anyOf: [{ const: 1 }] } })).toBe(false)
		expect(
			isMCPElicitFieldSchema({ type: 'array', minItems: -1, items: { type: 'string', enum: [] } }),
		).toBe(false)
	})

	it('validates both elicitation modes while retaining deprecated legal input union members', () => {
		expect(
			isMCPElicitRequest({
				method: 'elicitation/create',
				params: {
					message: 'Approve?',
					requestedSchema: {
						type: 'object',
						properties: { approved: { type: 'boolean' } },
						required: ['approved'],
					},
				},
			}),
		).toBe(true)
		expect(
			isMCPElicitRequest({
				method: 'elicitation/create',
				params: {
					message: 'Approve?',
					requestedSchema: {
						type: 'object',
						properties: { approved: { type: 'object' } },
					},
				},
			}),
		).toBe(false)
		expect(
			isMCPElicitRequest({
				method: 'elicitation/create',
				params: { mode: 'url', message: 'Authenticate', url: 'https://example.test' },
			}),
		).toBe(true)
		expect(
			isMCPElicitRequest({
				method: 'elicitation/create',
				params: { mode: 'url', message: 'Authenticate', url: 'relative' },
			}),
		).toBe(false)
		expect(
			isMCPInputRequestMap({
				sample: { method: 'sampling/createMessage', params: {} },
				roots: { method: 'roots/list' },
			}),
		).toBe(true)
	})

	it('accepts only keyed request maps and enforces input-required at-least-one-of', () => {
		const requests = {
			confirm: {
				method: 'elicitation/create',
				params: {
					mode: 'form',
					message: 'Approve?',
					requestedSchema: { type: 'object', properties: {} },
				},
			},
		}

		expect(isMCPInputRequestMap(requests)).toBe(true)
		expect(isMCPInputRequestMap([requests.confirm])).toBe(false)
		expect(isMCPInputResult({ resultType: 'input_required', inputRequests: requests })).toBe(true)
		expect(
			isMCPInputResult({
				resultType: 'input_required',
				inputRequests: requests,
				requestState: 'opaque',
			}),
		).toBe(true)
		expect(isMCPInputResult({ resultType: 'input_required', requestState: 'opaque' })).toBe(true)
		expect(isMCPInputResult({ resultType: 'input_required' })).toBe(false)
		expect(
			isMCPInputResult({ resultType: 'input_required', inputRequests: [requests.confirm] }),
		).toBe(false)
	})

	it('validates a roots listing and a sampling completion against their dated shapes', () => {
		expect(isMCPRoot({ uri: 'file:///workspace' })).toBe(true)
		expect(isMCPRoot({ uri: 'file:///workspace', name: 'workspace', _meta: {} })).toBe(true)
		expect(isMCPRoot({ uri: 'file:///workspace', name: 7 })).toBe(false)
		expect(isMCPRoot({ name: 'workspace' })).toBe(false)
		expect(isMCPRootResult({ roots: [] })).toBe(true)
		expect(isMCPRootResult({ roots: [{ uri: 'file:///a' }, { uri: 'file:///b' }] })).toBe(true)
		expect(isMCPRootResult({ roots: [{ uri: 'file:///a' }, { name: 'b' }] })).toBe(false)
		expect(isMCPRootResult({ roots: {} })).toBe(false)
		expect(isMCPRootResult({})).toBe(false)

		const sample = {
			role: 'assistant',
			content: { type: 'text', text: 'Paris' },
			model: 'test-model',
			stopReason: 'endTurn',
		}

		expect(isMCPSampleResult(sample)).toBe(true)
		expect(
			isMCPSampleResult({
				role: 'assistant',
				content: { type: 'text', text: 'Paris' },
				model: 'test-model',
			}),
		).toBe(true)
		// The schema names three stop reasons and permits any other a provider reports.
		expect(isMCPSampleResult({ ...sample, stopReason: 'providerSpecific' })).toBe(true)
		expect(isMCPSampleResult({ ...sample, role: 'system' })).toBe(false)
		expect(isMCPSampleResult({ ...sample, model: 7 })).toBe(false)
		expect(isMCPSampleResult({ ...sample, content: [{ type: 'text', text: 'Paris' }] })).toBe(false)
		// A resource block is legal MCP content and is NOT a legal sampling completion.
		expect(
			isMCPSampleResult({
				...sample,
				content: { type: 'resource_link', name: 'doc', uri: 'https://example.test/doc' },
			}),
		).toBe(false)
	})

	it('answers each input response against the exact request that was issued', () => {
		const form = {
			method: 'elicitation/create',
			params: {
				message: 'What is your name?',
				requestedSchema: {
					type: 'object',
					properties: { name: { type: 'string' } },
					required: ['name'],
				},
			},
		}
		const sampling = { method: 'sampling/createMessage', params: {} }
		const roots = { method: 'roots/list' }
		const accepted = { action: 'accept', content: { name: 'Ada' } }
		const completion = {
			role: 'assistant',
			content: { type: 'text', text: 'Ada' },
			model: 'test-model',
		}
		const listing = { roots: [{ uri: 'file:///workspace' }] }

		expect(isMCPInputResponse(accepted, form)).toBe(true)
		expect(isMCPInputResponse(completion, sampling)).toBe(true)
		expect(isMCPInputResponse(listing, roots)).toBe(true)
		// The kinds do not answer for one another, whatever their own shapes say.
		expect(isMCPInputResponse(accepted, sampling)).toBe(false)
		expect(isMCPInputResponse(listing, form)).toBe(false)
		expect(isMCPInputResponse(completion, roots)).toBe(false)
		// A form response is checked against the schema its own round issued.
		expect(isMCPInputResponse({ action: 'accept', content: { name: 7 } }, form)).toBe(false)
		expect(isMCPInputResponse({ action: 'accept', content: {} }, form)).toBe(false)
		expect(isMCPInputResponse({ action: 'decline' }, form)).toBe(true)
		// A URL-mode round issues no schema, so only the response shape is checked.
		const url = {
			method: 'elicitation/create',
			params: { mode: 'url', message: 'Authenticate', url: 'https://example.test' },
		}

		expect(isMCPInputResponse({ action: 'accept', content: { anything: 'kept' } }, url)).toBe(true)
		// An unrecognized question has no correct answer.
		expect(isMCPInputResponse(accepted, { method: 'tools/call' })).toBe(false)
		expect(isMCPInputResponse(accepted, undefined)).toBe(false)
	})

	it('validates elicitation result values and remains total over hostile input', () => {
		expect(
			isMCPElicitResult({
				action: 'accept',
				content: { approved: true, count: 2, tags: ['one', 'two'] },
			}),
		).toBe(true)
		expect(isMCPElicitResult({ action: 'decline' })).toBe(true)
		expect(isMCPElicitResult({ action: 'accept' })).toBe(true)
		expect(isMCPElicitResult({ action: 'decline', content: {} })).toBe(false)
		expect(isMCPElicitResult({ action: 'cancel', content: {} })).toBe(false)
		expect(isMCPElicitResult({ action: 'accept', content: { nested: {} } })).toBe(false)
		expect(isMCPElicitResult({ action: 'accept', content: { ratio: 0.5 } })).toBe(true)
		expect(isMCPElicitResult({ action: 'accept', content: { count: Number.NaN } })).toBe(false)
		expect(
			isMCPElicitResult({ action: 'accept', content: { count: Number.POSITIVE_INFINITY } }),
		).toBe(false)
		expect(isMCPElicitResult({ action: 'accept', content: { tags: ['one', 2] } })).toBe(false)
		expect(isMCPElicitResult({ action: 'unknown' })).toBe(false)

		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()
		expect(isFormElicitationSupported(proxy)).toBe(false)
		expect(isMCPInputRequestMap(proxy)).toBe(false)
		expect(isMCPInputResult(proxy)).toBe(false)
	})

	it('validates the issued object schema on its own, open to unrecognized annotations', () => {
		expect(isMCPElicitSchema({ type: 'object', properties: {} })).toBe(true)
		expect(
			isMCPElicitSchema({
				$schema: 'https://json-schema.org/draft/2020-12/schema',
				type: 'object',
				properties: { approved: { type: 'boolean' } },
				required: ['approved'],
				title: 'anything else is data',
			}),
		).toBe(true)
		expect(isMCPElicitSchema({ type: 'array', properties: {} })).toBe(false)
		expect(isMCPElicitSchema({ type: 'object' })).toBe(false)
		expect(isMCPElicitSchema({ type: 'object', properties: [] })).toBe(false)
		expect(isMCPElicitSchema({ type: 'object', properties: {}, required: 'approved' })).toBe(false)
		expect(isMCPElicitSchema({ type: 'object', properties: {}, required: [1] })).toBe(false)
		expect(isMCPElicitSchema({ type: 'object', properties: {}, $schema: 1 })).toBe(false)
		expect(isMCPElicitSchema({ type: 'object', properties: { bad: { type: 'object' } } })).toBe(
			false,
		)
		for (const value of createHostileCorpus()) {
			expect(isMCPElicitSchema(value)).toBe(false)
		}
	})
})

// `isElicitContent` is the guard that makes a bound schema an ENFORCED one. Its membership
// rule is "a JSON record whose every value is an MCPElicitValue, and whose DECLARED names
// additionally satisfy their field schema" — so the rows below draw from inside that rule
// (declared names, wrong in schema-specific ways) and from outside it (undeclared names,
// non-primitive values, and an unenforceable schema, which admits nothing at all).
describe('isElicitContent', () => {
	const schema: MCPElicitSchema = {
		type: 'object',
		properties: {
			approved: { type: 'boolean' },
			ratio: { type: 'number', minimum: 0, maximum: 1 },
			count: { type: 'integer', minimum: 1, maximum: 5 },
			label: { type: 'string', minLength: 2, maxLength: 4 },
			choice: { type: 'string', enum: ['alpha', 'beta'] },
			titled: { type: 'string', oneOf: [{ const: 'one', title: 'One' }] },
			home: { type: 'string', format: 'uri' },
			mail: { type: 'string', format: 'email' },
			day: { type: 'string', format: 'date' },
			moment: { type: 'string', format: 'date-time' },
			tags: {
				type: 'array',
				minItems: 1,
				maxItems: 2,
				items: { type: 'string', enum: ['a', 'b'] },
			},
			picks: { type: 'array', items: { anyOf: [{ const: 'x', title: 'X' }] } },
		},
		required: ['approved'],
	}

	it('accepts a complete legal response, and undeclared properties beside it', () => {
		expect(
			isElicitContent(
				{
					approved: true,
					ratio: 0.5,
					count: 3,
					label: 'abc',
					choice: 'beta',
					titled: 'one',
					home: 'https://example.test/path',
					mail: 'operator@example.test',
					day: '2026-08-07',
					moment: '2026-08-07T12:30:00Z',
					tags: ['a', 'b'],
					picks: ['x'],
					// Undeclared: the restricted schema is open, so this is data, not a violation.
					comment: 'anything the client wanted to add',
				},
				schema,
			),
		).toBe(true)
		expect(isElicitContent({ approved: false }, schema)).toBe(true)
		expect(isElicitContent({}, { type: 'object', properties: {} })).toBe(true)
	})

	it('refuses a required name, a wrong type, and every declared bound', () => {
		for (const content of [
			{},
			{ ratio: 0.5 },
			{ approved: 'yes' },
			{ approved: true, ratio: 2 },
			{ approved: true, ratio: -0.5 },
			{ approved: true, count: 2.5 },
			{ approved: true, count: 0 },
			{ approved: true, count: 6 },
			{ approved: true, label: 'a' },
			{ approved: true, label: 'abcde' },
			{ approved: true, choice: 'gamma' },
			{ approved: true, titled: 'two' },
			{ approved: true, home: 'not-absolute' },
			{ approved: true, mail: 'operator@localhost' },
			{ approved: true, day: '2026-13-07' },
			{ approved: true, moment: '2026-08-07 12:30:00' },
			// RFC 3339 §5.6 defines `date-mday` as 01-28/29/30/31 BASED ON the month and year,
			// so a syntactically well-formed triple that names no day on the calendar is not a
			// date. These are drawn from OUTSIDE the shape class the field regex already ranges
			// over, which is the only place a shape-only check can be wrong.
			{ approved: true, day: '2026-02-30' },
			{ approved: true, day: '2026-04-31' },
			{ approved: true, day: '2025-02-29' },
			{ approved: true, day: '2100-02-29' },
			{ approved: true, moment: '2026-02-30T00:00:00Z' },
			{ approved: true, moment: '2025-02-29T12:00:00+01:00' },
			{ approved: true, tags: [] },
			{ approved: true, tags: ['a', 'b', 'a'] },
			{ approved: true, tags: ['c'] },
			{ approved: true, picks: ['y'] },
			{ approved: true, count: 'three' },
			{ approved: true, tags: 'a' },
		]) {
			expect(isElicitContent(content, schema)).toBe(false)
		}
	})

	it('refuses a value no elicitation response may carry, declared or not', () => {
		expect(isElicitContent({ approved: true, nested: { deep: true } }, schema)).toBe(false)
		expect(isElicitContent({ approved: true, nothing: null }, schema)).toBe(false)
		expect(isElicitContent({ approved: true, mixed: ['one', 2] }, schema)).toBe(false)
		expect(isElicitContent({ approved: true, count: Number.NaN }, schema)).toBe(false)
	})

	// The population boundary, drawn from OUTSIDE the guard's membership rule: an
	// unenforceable schema admits nothing, because a schema that cannot be checked is never a
	// permissive one — the strictest failure mode is the only safe one here.
	it('admits nothing under an unenforceable schema and stays total over hostile input', () => {
		for (const value of createHostileCorpus()) {
			expect(isElicitContent({ approved: true }, value)).toBe(false)
			expect(isElicitContent(value, schema)).toBe(false)
		}
		expect(isElicitContent({ approved: true }, { type: 'object' })).toBe(false)
		expect(isElicitContent({ approved: true }, { type: 'object', properties: { a: 1 } })).toBe(
			false,
		)
	})
})

// The RFC 3339 format guards. The membership rule is "a well-formed spelling naming a
// day that exists", so the rows are drawn from BOTH sides of it: bad shapes (the class a
// regex already ranges over) and well-formed shapes naming impossible days (the class a
// shape-only check silently admits).
describe('isRFC3339Date', () => {
	it('accepts every real month length, including both leap-rule branches', () => {
		for (const value of [
			'2026-01-31',
			'2026-02-28',
			'2024-02-29',
			'2000-02-29',
			'2026-04-30',
			'2026-06-30',
			'2026-09-30',
			'2026-11-30',
			'2026-12-31',
			'0001-01-01',
		]) {
			expect(isRFC3339Date(value)).toBe(true)
		}
	})

	it('refuses a day the calendar does not have', () => {
		for (const value of ['2026-02-30', '2026-04-31', '2025-02-29', '2100-02-29', '2026-06-31']) {
			expect(isRFC3339Date(value)).toBe(false)
		}
	})

	it('refuses a malformed spelling and stays total over hostile input', () => {
		for (const value of ['2026-13-01', '2026-00-01', '2026-01-00', '2026-1-01', '2026/01/01', '']) {
			expect(isRFC3339Date(value)).toBe(false)
		}
		for (const value of createHostileCorpus()) {
			expect(isRFC3339Date(value)).toBe(false)
		}
	})
})

describe('isRFC3339DateTime', () => {
	it('accepts the offset forms, a fractional second, and a leap second', () => {
		for (const value of [
			'2026-08-07T12:30:00Z',
			'2026-08-07t12:30:00z',
			'2024-02-29T00:00:00+01:00',
			'2026-08-07T23:59:60Z',
			'2026-08-07T12:30:00.123456-05:30',
		]) {
			expect(isRFC3339DateTime(value)).toBe(true)
		}
	})

	it('refuses a day the calendar does not have', () => {
		for (const value of [
			'2026-02-30T00:00:00Z',
			'2025-02-29T12:00:00+01:00',
			'2026-04-31T00:00:00Z',
		]) {
			expect(isRFC3339DateTime(value)).toBe(false)
		}
	})

	// The spellings a `Date.parse` repair would have started ACCEPTING. Refusing them is as
	// much of the contract as refusing an impossible day, so they are asserted rather than
	// assumed to have survived.
	it('refuses a non-RFC-3339 spelling of a perfectly real instant', () => {
		for (const value of [
			'2026-01-31 10:00:00Z',
			'2026-01-31T10:00:00',
			'2026-01-31',
			'2026-01-31T24:00:00Z',
			'2026-01-31T10:00:00+24:00',
		]) {
			expect(isRFC3339DateTime(value)).toBe(false)
		}
		for (const value of createHostileCorpus()) {
			expect(isRFC3339DateTime(value)).toBe(false)
		}
	})
})

describe('isJSONRPCRequest', () => {
	it('accepts a request with a numeric id', () => {
		expect(isJSONRPCRequest({ jsonrpc: '2.0', method: 'ping', id: 1 })).toBe(true)
	})

	it('accepts a request with a string id', () => {
		expect(isJSONRPCRequest({ jsonrpc: '2.0', method: 'ping', id: 'abc' })).toBe(true)
	})

	it('rejects a notification, which is a distinct arm rather than an id-less request', () => {
		expect(isJSONRPCRequest({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(false)
	})

	it('accepts a request with a params record', () => {
		expect(
			isJSONRPCRequest({ jsonrpc: '2.0', method: 'tools/call', id: 1, params: { a: 1 } }),
		).toBe(true)
	})

	it('rejects a wrong jsonrpc version', () => {
		expect(isJSONRPCRequest({ jsonrpc: '1.0', method: 'ping', id: 1 })).toBe(false)
	})

	it('rejects a missing method', () => {
		expect(isJSONRPCRequest({ jsonrpc: '2.0', id: 1 })).toBe(false)
	})

	it('rejects a non-string method', () => {
		expect(isJSONRPCRequest({ jsonrpc: '2.0', method: 42, id: 1 })).toBe(false)
	})

	it('rejects a null id (valid only on a response)', () => {
		expect(isJSONRPCRequest({ jsonrpc: '2.0', method: 'ping', id: null })).toBe(false)
	})

	it('rejects a non-record params', () => {
		expect(isJSONRPCRequest({ jsonrpc: '2.0', method: 'ping', id: 1, params: [1, 2] })).toBe(false)
	})

	it('is total on adversarial input (null, primitives, arrays)', () => {
		for (const value of [null, undefined, 42, 'x', [], [1], true]) {
			expect(isJSONRPCRequest(value)).toBe(false)
		}
		const accessor = Object.defineProperty({}, 'jsonrpc', {
			enumerable: true,
			get() {
				throw new Error('must not escape')
			},
		})
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()
		expect(isJSONRPCRequest(accessor)).toBe(false)
		expect(isJSONRPCRequest(proxy)).toBe(false)
	})

	it('rejects accessor, hidden, and own-undefined request populations', () => {
		const accessor = Object.defineProperty({ jsonrpc: '2.0', id: 1 }, 'method', {
			enumerable: true,
			get: () => 'ping',
		})
		const hidden = Object.defineProperty({ jsonrpc: '2.0', id: 1 }, 'method', {
			enumerable: false,
			value: 'ping',
		})

		expect(isJSONRPCRequest(accessor)).toBe(false)
		expect(isJSONRPCRequest(hidden)).toBe(false)
		expect(isJSONRPCRequest({ jsonrpc: '2.0', method: 'ping', params: undefined })).toBe(false)
		expect(
			isJSONRPCRequest({
				jsonrpc: '2.0',
				method: 'ping',
				params: Object.defineProperty({}, 'hidden', { enumerable: false, value: true }),
			}),
		).toBe(false)
	})

	it('rejects fractional and non-finite numeric ids', () => {
		for (const id of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(isJSONRPCRequest({ jsonrpc: '2.0', method: 'ping', id })).toBe(false)
		}
	})
})

describe('isJSONRPCNotification', () => {
	it('accepts an id-less call, with and without params', () => {
		expect(isJSONRPCNotification({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(
			true,
		)
		expect(
			isJSONRPCNotification({ jsonrpc: '2.0', method: 'notifications/progress', params: { a: 1 } }),
		).toBe(true)
	})

	it('rejects a request, whatever the id is', () => {
		for (const id of ['abc', '', 0, -7, 1]) {
			expect(isJSONRPCNotification({ jsonrpc: '2.0', method: 'ping', id })).toBe(false)
		}
	})

	it('rejects an own id member even when its value is not a legal id', () => {
		expect(isJSONRPCNotification({ jsonrpc: '2.0', method: 'ping', id: null })).toBe(false)
	})

	it('rejects a wrong version, a non-string method, and a non-record params', () => {
		expect(isJSONRPCNotification({ jsonrpc: '1.0', method: 'ping' })).toBe(false)
		expect(isJSONRPCNotification({ jsonrpc: '2.0', method: 42 })).toBe(false)
		expect(isJSONRPCNotification({ jsonrpc: '2.0', method: 'ping', params: [1] })).toBe(false)
	})

	it('is total over the shared adversarial corpus', () => {
		for (const value of createHostileCorpus()) {
			expect(isJSONRPCNotification(value)).toBe(false)
		}
	})
})

// The membership rule of the invocation arms: `isJSONRPCRequest` needs an own `id` whose
// value `isJSONRPCId` accepts; `isJSONRPCNotification` needs NO own `id` member. Those
// rules cannot both hold, and the corpus below is drawn from OUTSIDE the record population
// they are stated over as well as from inside it, so the check is exercised where the
// guards are meant to answer and where they are meant to be silent.
describe('isJSONRPCRequest / isJSONRPCNotification — mutual exclusivity', () => {
	it('never answers true for both arms on any input', () => {
		const corpus: readonly unknown[] = [
			...createHostileCorpus(),
			{ jsonrpc: '2.0', method: 'ping', id: 1 },
			{ jsonrpc: '2.0', method: 'ping', id: '' },
			{ jsonrpc: '2.0', method: 'ping' },
			{ jsonrpc: '2.0', method: 'ping', id: null },
			{ jsonrpc: '2.0', method: 'ping', id: 1.5 },
			{ jsonrpc: '2.0', method: 'ping', params: { a: 1 } },
			{ jsonrpc: '2.0', id: 1 },
		]
		let overlaps = 0
		for (const value of corpus) {
			if (isJSONRPCRequest(value) && isJSONRPCNotification(value)) overlaps += 1
		}

		expect(overlaps).toBe(0)
		// The negative control that proves the counter can register an overlap at all: two
		// predicates that DO both hold, over the same corpus and the same loop.
		let control = 0
		for (const value of corpus) {
			if (isJSONRPCId(value) || value === undefined) control += 0
			else control += 1
		}
		expect(control).toBeGreaterThan(0)
	})

	it('classifies every valid invocation as exactly one arm', () => {
		const request = { jsonrpc: '2.0', method: 'ping', id: 1 }
		const notification = { jsonrpc: '2.0', method: 'notifications/initialized' }

		expect(isJSONRPCInvocation(request)).toBe(true)
		expect(isJSONRPCInvocation(notification)).toBe(true)
		expect(isJSONRPCRequest(request)).toBe(true)
		expect(isJSONRPCNotification(request)).toBe(false)
		expect(isJSONRPCNotification(notification)).toBe(true)
		expect(isJSONRPCRequest(notification)).toBe(false)
	})

	it('is total over the shared adversarial corpus', () => {
		for (const value of createHostileCorpus()) {
			expect(isJSONRPCInvocation(value)).toBe(false)
		}
	})
})

// The open modern result and the legacy arm are distinguished by ONE
// fact — whether `resultType` is there — and that is what keeps a concrete result's
// literal discriminant meaningful while the response arm stays open.
describe('isMCPResult / isMCPLegacyResult', () => {
	it('accepts any string resultType, including one this package does not know', () => {
		expect(isMCPResult({ resultType: 'complete' })).toBe(true)
		expect(isMCPResult({ resultType: 'input_required', requestState: 'opaque' })).toBe(true)
		expect(isMCPResult({ resultType: 'task', taskId: 't-1' })).toBe(true)
		expect(isMCPResult({ resultType: '' })).toBe(true)
	})

	it('rejects a missing or non-string resultType', () => {
		expect(isMCPResult({})).toBe(false)
		expect(isMCPResult({ resultType: 5 })).toBe(false)
		expect(isMCPResult({ resultType: null })).toBe(false)
	})

	it('rejects result metadata that is not exact result metadata', () => {
		expect(isMCPResult({ resultType: 'complete', _meta: { 'bad key': 1 } })).toBe(false)
		expect(
			isMCPResult({ resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': {} } }),
		).toBe(false)
		expect(
			isMCPResult({
				resultType: 'complete',
				_meta: { 'io.modelcontextprotocol/serverInfo': { name: 'a', version: '1' } },
			}),
		).toBe(true)
	})

	it('accepts the legacy arm exactly when no resultType is present', () => {
		expect(isMCPLegacyResult({})).toBe(true)
		expect(isMCPLegacyResult({ tools: [] })).toBe(true)
		expect(isMCPLegacyResult({ protocolVersion: '2025-06-18' })).toBe(true)
		expect(isMCPLegacyResult({ resultType: 'complete' })).toBe(false)
		expect(isMCPLegacyResult({ resultType: 5 })).toBe(false)
	})

	it('never answers true for both arms, and is total over the adversarial corpus', () => {
		const corpus: readonly unknown[] = [
			...createHostileCorpus(),
			{},
			{ tools: [] },
			{ resultType: 'complete' },
			{ resultType: 5 },
			{ resultType: 'complete', _meta: { 'bad key': 1 } },
		]
		let overlaps = 0
		for (const value of corpus) {
			if (isMCPResult(value) && isMCPLegacyResult(value)) overlaps += 1
		}

		expect(overlaps).toBe(0)
		// `isMCPLegacyResult` admits any exact-JSON record with no `resultType`, and some
		// corpus rows are exactly that, so totality here is "answers, never throws".
		for (const value of createHostileCorpus()) {
			expect(isMCPResult(value)).toBe(false)
			expect(typeof isMCPLegacyResult(value)).toBe('boolean')
		}
	})
})

// The membership rule of the response arms: the result arm needs an own `result` and NO
// own `error`; the error arm needs an own `error` and NO own `result`. Neither can hold
// with the other, and a both-arms envelope belongs to neither.
// A `expectTypeOf` assertion is erased at runtime, so what enforces it is `npm run check`;
// a runtime assertion beside it pins the same fact on real values.
describe('isJSONRPCResultResponse / isJSONRPCErrorResponse — mutual exclusivity', () => {
	it('requires an id on the result arm and permits its omission only on the error arm', () => {
		expectTypeOf<JSONRPCResultResponse['id']>().toEqualTypeOf<JSONRPCId>()
		expectTypeOf<JSONRPCErrorResponse['id']>().toEqualTypeOf<JSONRPCId | undefined>()
		expectTypeOf<JSONRPCResponse>().toEqualTypeOf<JSONRPCResultResponse | JSONRPCErrorResponse>()
	})

	it('forbids the opposite member on each arm', () => {
		expectTypeOf<JSONRPCResultResponse['error']>().toEqualTypeOf<undefined>()
		expectTypeOf<JSONRPCErrorResponse['result']>().toEqualTypeOf<undefined>()
		expectTypeOf<JSONRPCResultResponse>().not.toExtend<JSONRPCErrorResponse>()
		expectTypeOf<JSONRPCErrorResponse>().not.toExtend<JSONRPCResultResponse>()
	})

	it('never answers true for both arms on any input', () => {
		const corpus: readonly unknown[] = [
			...createHostileCorpus(),
			{ jsonrpc: '2.0', id: 1, result: { resultType: 'complete' } },
			{ jsonrpc: '2.0', id: 1, result: {} },
			{ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } },
			{ jsonrpc: '2.0', error: { code: -1, message: 'x' } },
			{ jsonrpc: '2.0', id: 1, result: {}, error: { code: -1, message: 'x' } },
			{ jsonrpc: '2.0', id: 1 },
			{ jsonrpc: '2.0', id: null, error: { code: -1, message: 'x' } },
		]
		let overlaps = 0
		for (const value of corpus) {
			if (isJSONRPCResultResponse(value) && isJSONRPCErrorResponse(value)) overlaps += 1
		}

		expect(overlaps).toBe(0)
	})

	it('requires an id on the result arm and permits its absence only on the error arm', () => {
		expect(isJSONRPCResultResponse({ jsonrpc: '2.0', result: {} })).toBe(false)
		expect(isJSONRPCErrorResponse({ jsonrpc: '2.0', error: { code: -1, message: 'x' } })).toBe(true)
		expect(
			isJSONRPCErrorResponse({ jsonrpc: '2.0', id: null, error: { code: -1, message: 'x' } }),
		).toBe(false)
	})

	it('rejects an invocation as either arm, and is total over the adversarial corpus', () => {
		expect(isJSONRPCResultResponse({ jsonrpc: '2.0', method: 'ping', id: 1 })).toBe(false)
		expect(isJSONRPCErrorResponse({ jsonrpc: '2.0', method: 'ping', id: 1 })).toBe(false)
		for (const value of createHostileCorpus()) {
			expect(isJSONRPCResultResponse(value)).toBe(false)
			expect(isJSONRPCErrorResponse(value)).toBe(false)
		}
	})
})

describe('isJSONRPCResponse', () => {
	it('accepts a success response with a result', () => {
		expect(isJSONRPCResponse({ jsonrpc: '2.0', id: 1, result: { ok: true } })).toBe(true)
	})

	it('rejects a null id and a non-object result, neither of which the arms permit', () => {
		expect(isJSONRPCResponse({ jsonrpc: '2.0', id: null, result: null })).toBe(false)
		expect(isJSONRPCResponse({ jsonrpc: '2.0', id: 1, result: null })).toBe(false)
		expect(isJSONRPCResponse({ jsonrpc: '2.0', id: 1, result: 5 })).toBe(false)
		expect(isJSONRPCResponse({ jsonrpc: '2.0', id: null, error: { code: -1, message: 'x' } })).toBe(
			false,
		)
	})

	it('accepts an error response whose unreadable id is omitted', () => {
		expect(isJSONRPCResponse({ jsonrpc: '2.0', error: { code: -32_700, message: 'Parse' } })).toBe(
			true,
		)
	})

	it('accepts an error response', () => {
		expect(
			isJSONRPCResponse({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Invalid' } }),
		).toBe(true)
	})

	it('rejects a response carrying BOTH result and error', () => {
		expect(
			isJSONRPCResponse({
				jsonrpc: '2.0',
				id: 1,
				result: {},
				error: { code: -1, message: 'x' },
			}),
		).toBe(false)
	})

	it('rejects a response carrying NEITHER result nor error', () => {
		expect(isJSONRPCResponse({ jsonrpc: '2.0', id: 1 })).toBe(false)
	})

	it('rejects an error object missing a numeric code', () => {
		expect(isJSONRPCResponse({ jsonrpc: '2.0', id: 1, error: { message: 'x' } })).toBe(false)
	})

	it('rejects a request (no id member, has method) as a response', () => {
		expect(isJSONRPCResponse({ jsonrpc: '2.0', method: 'ping' })).toBe(false)
	})

	it('is total on adversarial input', () => {
		for (const value of [null, undefined, 0, 'x', [], true]) {
			expect(isJSONRPCResponse(value)).toBe(false)
		}
		const accessor = Object.defineProperty({}, 'jsonrpc', {
			enumerable: true,
			get() {
				throw new Error('must not escape')
			},
		})
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()
		expect(isJSONRPCResponse(accessor)).toBe(false)
		expect(isJSONRPCResponse(proxy)).toBe(false)
	})

	it('rejects accessor and hidden response populations', () => {
		const accessor = Object.defineProperty({ jsonrpc: '2.0', id: 1 }, 'result', {
			enumerable: true,
			get: () => ({ ok: true }),
		})
		const hidden = Object.defineProperty({ jsonrpc: '2.0', id: 1 }, 'result', {
			enumerable: false,
			value: { ok: true },
		})

		expect(isJSONRPCResponse(accessor)).toBe(false)
		expect(isJSONRPCResponse(hidden)).toBe(false)
		expect(
			isJSONRPCResponse({
				jsonrpc: '2.0',
				id: 1,
				result: Object.defineProperty({}, 'hidden', { enumerable: false, value: true }),
			}),
		).toBe(false)
		expect(
			isJSONRPCResponse({
				jsonrpc: '2.0',
				id: 1,
				error: {
					code: -32_600,
					message: 'bad',
					data: Object.defineProperty({}, 'value', { enumerable: true, get: () => true }),
				},
			}),
		).toBe(false)
	})

	it('rejects fractional/non-finite ids and malformed error populations', () => {
		for (const id of [1.5, Number.NaN, Number.NEGATIVE_INFINITY]) {
			expect(isJSONRPCResponse({ jsonrpc: '2.0', id, result: {} })).toBe(false)
		}
		for (const code of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(
				isJSONRPCResponse({ jsonrpc: '2.0', id: 1, error: { code, message: 'invalid' } }),
			).toBe(false)
		}
		expect(isJSONRPCResponse({ jsonrpc: '2.0', id: 1, error: undefined })).toBe(false)
		expect(
			isJSONRPCResponse({
				jsonrpc: '2.0',
				id: 1,
				error: { code: -32_600, message: 'bad', data: undefined },
			}),
		).toBe(false)
		expect(isJSONRPCResponse({ jsonrpc: '2.0', id: 1, result: {}, error: undefined })).toBe(false)
		expect(
			isJSONRPCResponse({
				jsonrpc: '2.0',
				id: 1,
				error: { code: -32_600, message: 'bad', data: Number.NaN },
			}),
		).toBe(false)
	})
})

describe('isJSONRPCMessage', () => {
	it('accepts a request', () => {
		expect(isJSONRPCMessage({ jsonrpc: '2.0', method: 'ping', id: 1 })).toBe(true)
	})

	it('accepts a response', () => {
		expect(isJSONRPCMessage({ jsonrpc: '2.0', id: 1, result: {} })).toBe(true)
	})

	it('rejects a non-message record', () => {
		expect(isJSONRPCMessage({ hello: 'world' })).toBe(false)
	})
})

describe('isInitializeRequest', () => {
	it('accepts an initialize request', () => {
		expect(isInitializeRequest({ jsonrpc: '2.0', method: 'initialize', id: 1 })).toBe(true)
	})

	it('rejects another method', () => {
		expect(isInitializeRequest({ jsonrpc: '2.0', method: 'ping', id: 1 })).toBe(false)
	})

	it('rejects a non-request', () => {
		expect(isInitializeRequest({ jsonrpc: '2.0', id: 1, result: {} })).toBe(false)
	})
})

describe('isModernRequest', () => {
	it('routes a request with the reserved protocol-version key as modern', () => {
		expect(
			isModernRequest({
				jsonrpc: '2.0',
				method: 'tools/list',
				id: 1,
				params: {
					_meta: {
						[MCP_META_VERSION]: '2026-07-28',
						[MCP_META_CAPABILITIES]: {},
					},
				},
			}),
		).toBe(true)
	})

	it('routes on key presence even when the protocol-version value is not a string', () => {
		expect(
			isModernRequest({
				jsonrpc: '2.0',
				method: 'tools/list',
				id: 1,
				params: { _meta: { [MCP_META_VERSION]: 7 } },
			}),
		).toBe(true)
	})

	it('does not mistake unrelated legacy metadata for the modern discriminator', () => {
		expect(
			isModernRequest({
				jsonrpc: '2.0',
				method: 'tools/list',
				id: 1,
				params: { _meta: { progressToken: 'token' } },
			}),
		).toBe(false)
	})

	it('is total over hostile and malformed input', () => {
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()
		const hidden = {
			jsonrpc: '2.0',
			method: 'tools/list',
			id: 1,
			params: { _meta: { [MCP_META_VERSION]: '2026-07-28' } },
		}
		Object.defineProperty(hidden, 'extra', { value: true })

		for (const value of [proxy, hidden, null, [], { params: { _meta: {} } }]) {
			expect(isModernRequest(value)).toBe(false)
			expect(isJSONRPCRequest(value) && isModernRequest(value)).toBe(false)
		}
	})
})

describe('stable Tasks extension validators', () => {
	it('reads the extension declaration as presence under the extensions record', () => {
		expect(isTaskSupported({ extensions: { [MCP_EXTENSION_TASKS]: {} } })).toBe(true)
		// Re-ruled from `true`: the authority declares the capability EXACTLY empty
		// (`TasksExtensionCapability = Record<string, never>`), so a member under the key is a
		// peer declaring something this extension does not define, not a forward-compatible
		// option this package must tolerate.
		expect(isTaskSupported({ extensions: { [MCP_EXTENSION_TASKS]: { later: {} } } })).toBe(false)
		expect(isTaskSupported({ extensions: { [MCP_EXTENSION_TASKS]: { enabled: true } } })).toBe(
			false,
		)
		expect(isTaskSupported({ extensions: {} })).toBe(false)
		expect(isTaskSupported({ [MCP_EXTENSION_TASKS]: {} })).toBe(false)
		expect(isTaskSupported({ extensions: { 'io.modelcontextprotocol/task': {} } })).toBe(false)
		// A non-record value is a client speaking a different protocol, not a shorthand.
		expect(isTaskSupported({ extensions: { [MCP_EXTENSION_TASKS]: true } })).toBe(false)
		expect(isTaskSupported({ extensions: { [MCP_EXTENSION_TASKS]: null } })).toBe(false)
		expect(isTaskSupported({ elicitation: {} })).toBe(false)
		expect(isTaskSupported({})).toBe(false)
	})

	it('answers every value in the shared adversarial corpus without throwing', () => {
		for (const value of createHostileCorpus()) {
			expect(isTaskSupported(value)).toBe(false)
			expect(isMCPTaskResult(value)).toBe(false)
			expect(isMCPTaskStatus(value)).toBe(false)
			expect(isMCPTaskDetail(value)).toBe(false)
		}
	})

	it('accepts exactly the lifecycle states', () => {
		for (const status of ['working', 'input_required', 'completed', 'failed', 'cancelled']) {
			expect(isMCPTaskStatus(status)).toBe(true)
		}
		for (const status of ['done', 'Working', 'pending', '', 0, null]) {
			expect(isMCPTaskStatus(status)).toBe(false)
		}
	})

	// The runtime enforcement of a CONSUMER-supplied manager's declared return shape: its
	// types are a promise, and this is what stands between a manager that answers a numeric
	// `taskId` and a client that would receive one.
	it('validates a task-creation result and rejects every member defect', () => {
		const created = {
			resultType: 'task',
			taskId: 'task-1',
			status: 'working',
			createdAt: '1970-01-01T00:00:01.000Z',
			lastUpdatedAt: '1970-01-01T00:00:01.000Z',
			ttlMs: null,
		}

		expect(isMCPTaskResult(created)).toBe(true)
		// `null` means "no expiry" and is distinct from an absent field, so both are legal.
		expect(isMCPTaskResult({ ...created, ttlMs: 60_000 })).toBe(true)
		expect(isMCPTaskResult({ ...created, statusMessage: 'queued', pollIntervalMs: 2_500 })).toBe(
			true,
		)
		expect(isMCPTaskResult({ ...created, resultType: 'complete' })).toBe(false)
		expect(isMCPTaskResult({ ...created, taskId: 7 })).toBe(false)
		expect(isMCPTaskResult({ ...created, status: 'done' })).toBe(false)
		expect(isMCPTaskResult({ ...created, createdAt: 0 })).toBe(false)
		expect(isMCPTaskResult({ ...created, lastUpdatedAt: null })).toBe(false)
		expect(isMCPTaskResult({ ...created, ttlMs: 'forever' })).toBe(false)
		expect(isMCPTaskResult({ ...created, ttlMs: Number.NaN })).toBe(false)
		// The authority formats both durations `int`, so a fractional millisecond is a peer
		// speaking a shape the schema does not admit rather than a rounding the reader absorbs.
		expect(isMCPTaskResult({ ...created, ttlMs: 60_000.5 })).toBe(false)
		expect(isMCPTaskResult({ ...created, pollIntervalMs: 2_500.5 })).toBe(false)
		expect(isMCPTaskResult({ ...created, statusMessage: 7 })).toBe(false)
		expect(isMCPTaskResult({ ...created, pollIntervalMs: 'often' })).toBe(false)
		expect(isMCPTaskResult({ ...created, _meta: { [MCP_META_SERVER]: { name: 'a' } } })).toBe(false)
	})

	// The same enforcement on the READ side, where `status` selects what else the snapshot owes.
	// A manager whose TypeScript said `MCPTaskDetail` is still only promising.
	it('validates a task snapshot and enforces the payload its status owes', () => {
		const working = {
			taskId: 'task-1',
			status: 'working',
			createdAt: '1970-01-01T00:00:01.000Z',
			lastUpdatedAt: '1970-01-01T00:00:01.000Z',
			ttlMs: null,
		}

		expect(isMCPTaskDetail(working)).toBe(true)
		expect(isMCPTaskDetail({ ...working, status: 'cancelled' })).toBe(true)
		expect(isMCPTaskDetail({ ...working, ttlMs: 60_000, pollIntervalMs: 2_500 })).toBe(true)
		// A creation result is not a snapshot's shape, but the extra discriminator is data the
		// open contract carries rather than a defect.
		expect(isMCPTaskDetail({ ...working, resultType: 'task' })).toBe(true)
		expect(isMCPTaskDetail({ ...working, taskId: 7 })).toBe(false)
		expect(isMCPTaskDetail({ ...working, status: 'done' })).toBe(false)
		expect(isMCPTaskDetail({ ...working, ttlMs: Number.NaN })).toBe(false)
		expect(isMCPTaskDetail({ ...working, pollIntervalMs: 'often' })).toBe(false)
		// The `int` formats again, on the read side the manager answers through.
		expect(isMCPTaskDetail({ ...working, ttlMs: 60_000.5 })).toBe(false)
		expect(isMCPTaskDetail({ ...working, pollIntervalMs: 2_500.5 })).toBe(false)
		// `input_required` owes its requests, `completed` its result, `failed` its error.
		expect(isMCPTaskDetail({ ...working, status: 'input_required' })).toBe(false)
		expect(
			isMCPTaskDetail({
				...working,
				status: 'input_required',
				inputRequests: { approval: { method: 'roots/list' } },
			}),
		).toBe(true)
		expect(isMCPTaskDetail({ ...working, status: 'completed' })).toBe(false)
		expect(
			isMCPTaskDetail({ ...working, status: 'completed', result: { resultType: 'complete' } }),
		).toBe(true)
		// Re-ruled from `false`: the authority declares a completed task's `result` an OPEN object
		// (`result: { [key: string]: unknown }`) rather than a protocol result, so nothing inside it
		// is this guard's to enforce — a `_meta` the extension never constrained included.
		expect(
			isMCPTaskDetail({
				...working,
				status: 'completed',
				result: { resultType: 'complete', _meta: { 'not a legal key': 1 } },
			}),
		).toBe(true)
		// The same widening from the other side: an open object owes no discriminator, and a
		// non-object is still refused because the authority fixes `result` to an object.
		expect(isMCPTaskDetail({ ...working, status: 'completed', result: {} })).toBe(true)
		expect(
			isMCPTaskDetail({ ...working, status: 'completed', result: { pages: 3, done: true } }),
		).toBe(true)
		expect(isMCPTaskDetail({ ...working, status: 'completed', result: 'done' })).toBe(false)
		expect(isMCPTaskDetail({ ...working, status: 'completed', result: null })).toBe(false)
		expect(isMCPTaskDetail({ ...working, status: 'completed', result: [] })).toBe(false)
		expect(isMCPTaskDetail({ ...working, status: 'failed' })).toBe(false)
		expect(
			isMCPTaskDetail({ ...working, status: 'failed', error: { code: -32603, message: 'x' } }),
		).toBe(true)
		expect(
			isMCPTaskDetail({ ...working, status: 'failed', error: { code: -32603.5, message: 'x' } }),
		).toBe(false)
	})

	// The READ REPLY, which is not the snapshot. The schema stamps a `tasks/get` answer
	// `resultType: 'complete'`, so the two guards must disagree on exactly that member — a guard
	// that accepted an unstamped payload here would have collapsed the two shapes back together.
	it('separates the wire tasks/get answer from the manager’s own snapshot', () => {
		const detail = {
			taskId: 'task-1',
			status: 'working',
			createdAt: '1970-01-01T00:00:01.000Z',
			lastUpdatedAt: '1970-01-01T00:00:01.000Z',
			ttlMs: null,
		}
		const answered = { ...detail, resultType: 'complete' }

		expect(isMCPTaskDetailResult(answered)).toBe(true)
		expect(isMCPTaskDetail(answered)).toBe(true)
		// The disagreement, in the direction that matters: a manager's answer is not a reply.
		expect(isMCPTaskDetail(detail)).toBe(true)
		expect(isMCPTaskDetailResult(detail)).toBe(false)
		// `complete`, never `task` — that discriminator belongs to the creation answer.
		expect(isMCPTaskDetailResult({ ...detail, resultType: 'task' })).toBe(false)
		expect(isMCPTaskResult({ ...detail, resultType: 'task' })).toBe(true)
		// The payload still owes what its status owes, and the stamp does not excuse it.
		expect(isMCPTaskDetailResult({ ...answered, status: 'completed' })).toBe(false)
		expect(isMCPTaskDetailResult({ ...answered, status: 'completed', result: {} })).toBe(true)
		// Result metadata is checked when present, because a reply is a result.
		expect(
			isMCPTaskDetailResult({ ...answered, _meta: { [MCP_META_SERVER]: { name: 'peer' } } }),
		).toBe(false)
		expect(
			isMCPTaskDetailResult({
				...answered,
				_meta: { [MCP_META_SERVER]: { name: 'peer', version: '1.0.0' } },
			}),
		).toBe(true)
		for (const value of createHostileCorpus()) {
			expect(isMCPTaskDetailResult(value)).toBe(false)
		}
	})

	// The ADMISSION guard a consumer's producer frame passes through before a subscribed client
	// can ever see it. Both halves are load-bearing: the method literal alone admits any params,
	// and the params alone admit any method.
	it('admits a notifications/tasks frame whose params hold together as a snapshot', () => {
		const detail = {
			taskId: 'task-1',
			status: 'working',
			createdAt: '1970-01-01T00:00:01.000Z',
			lastUpdatedAt: '1970-01-01T00:00:01.000Z',
			ttlMs: null,
		}
		const frame = { jsonrpc: '2.0', method: 'notifications/tasks', params: detail }

		expect(isMCPTaskNotification(frame)).toBe(true)
		// Flat: every task field sits directly under `params`, and a wrapper is a different shape.
		expect(isMCPTaskNotification({ ...frame, params: { task: detail } })).toBe(false)
		expect(isMCPTaskNotification({ ...frame, method: 'notifications/task' })).toBe(false)
		expect(isMCPTaskNotification({ ...frame, method: 'notifications/resources/updated' })).toBe(
			false,
		)
		expect(isMCPTaskNotification({ ...frame, params: { taskId: 'task-1' } })).toBe(false)
		expect(isMCPTaskNotification({ ...frame, params: undefined })).toBe(false)
		// A request is not a notification, whatever its method says.
		expect(isMCPTaskNotification({ ...frame, id: 1 })).toBe(false)
		expect(isMCPTaskNotification({ ...frame, jsonrpc: '1.0' })).toBe(false)
		// `_meta` is the SERVER'S to write, so its absence is normal and its presence is only
		// checked for shape. A producer that stamps nothing is the ordinary case.
		expect(Object.hasOwn(frame.params, '_meta')).toBe(false)
		expect(isMCPTaskNotification({ ...frame, params: { ...detail, _meta: {} } })).toBe(true)
		expect(
			isMCPTaskNotification({
				...frame,
				params: { ...detail, _meta: { [MCP_META_SUBSCRIPTION]: 7 } },
			}),
		).toBe(true)
		expect(
			isMCPTaskNotification({
				...frame,
				params: { ...detail, _meta: { [MCP_META_SUBSCRIPTION]: null } },
			}),
		).toBe(false)
		expect(
			isMCPTaskNotification({ ...frame, params: { ...detail, _meta: { 'not a legal key': 1 } } }),
		).toBe(false)
		for (const value of createHostileCorpus()) {
			expect(isMCPTaskNotification(value)).toBe(false)
		}
	})

	// The stamp's own guard. The reserved key is OPTIONAL here and REQUIRED on a stream's
	// terminating result, so the two metadata guards must disagree on an empty record.
	it('accepts notification metadata with or without the reserved subscription stamp', () => {
		expect(isMCPNotificationMetaObject({})).toBe(true)
		expect(isMCPNotificationMetaObject({ [MCP_META_SUBSCRIPTION]: 7 })).toBe(true)
		expect(isMCPNotificationMetaObject({ [MCP_META_SUBSCRIPTION]: 'listen-1' })).toBe(true)
		expect(isMCPNotificationMetaObject({ [MCP_META_SUBSCRIPTION]: null })).toBe(false)
		expect(isMCPNotificationMetaObject({ [MCP_META_SUBSCRIPTION]: { id: 1 } })).toBe(false)
		expect(isMCPNotificationMetaObject({ 'not a legal key': 1 })).toBe(false)
		// An EMPTY record is legal metadata, so the shared corpus cannot be swept for `false` here
		// the way a guard demanding named members is: its empty and null-prototype rows are
		// genuine acceptances. Totality over that corpus is proven for every published guard by
		// the sweep later in this file; what this row owes is the non-object refusal.
		for (const value of [undefined, null, 0, '', 'null', true, [], () => undefined, new Map()]) {
			expect(isMCPNotificationMetaObject(value)).toBe(false)
		}
		// The disagreement with the stream's terminating result, where the same key is required.
		expect(isMCPSubscriptionResult({ resultType: 'complete', _meta: {} })).toBe(false)
	})
})

// The `error` OBJECT, extracted because a failed response and a `failed` task snapshot owe the
// same checks and had been writing them twice.
describe('isJSONRPCError', () => {
	it('accepts an integer code with a string message and any data payload', () => {
		expect(isJSONRPCError({ code: -32602, message: 'Invalid params' })).toBe(true)
		expect(isJSONRPCError({ code: 0, message: '', data: { any: ['shape'] } })).toBe(true)
		// `data` is declared `unknown`, so a non-JSON payload is legal here where an exact-JSON
		// guard would have refused it.
		expect(isJSONRPCError({ code: 1, message: 'x', data: () => undefined })).toBe(true)
	})

	it('refuses a non-integer code, a non-string message, and every hostile value', () => {
		expect(isJSONRPCError({ code: -32602.5, message: 'x' })).toBe(false)
		expect(isJSONRPCError({ code: Number.NaN, message: 'x' })).toBe(false)
		expect(isJSONRPCError({ code: '-32602', message: 'x' })).toBe(false)
		expect(isJSONRPCError({ code: -32602 })).toBe(false)
		expect(isJSONRPCError({ message: 'x' })).toBe(false)
		for (const value of createHostileCorpus()) expect(isJSONRPCError(value)).toBe(false)
	})

	it('agrees with the envelope guard that routes through it', () => {
		const error = { code: -32700, message: 'Parse error' }

		expect(isJSONRPCErrorResponse({ jsonrpc: '2.0', error })).toBe(isJSONRPCError(error))
		expect(isJSONRPCErrorResponse({ jsonrpc: '2.0', error: { code: 1.5, message: 'x' } })).toBe(
			false,
		)
	})
})

// A repaired claim is a NEW claim. `isJSONRPCError` was found non-total at the one door the
// corpus could reach, and re-verifying the fix where it was found would only prove the fix.
// So the claim is re-asked at EVERY published door, against the corpus AND against a throwing
// accessor keyed to each name any guard reads — the class the corpus structurally could not
// reach, which is how the defect survived a control that ran at it and passed.
const TOTALITY_SCHEMA: MCPElicitSchema = Object.freeze({
	type: 'object',
	properties: Object.freeze({}),
})

// The issued request `isMCPInputResponse` is measured against, for the same reason.
const TOTALITY_REQUEST: MCPInputRequest = Object.freeze({
	method: 'elicitation/create',
	params: Object.freeze({ message: 'Approve?', requestedSchema: TOTALITY_SCHEMA }),
})

// Every published guard as a unary call. The guards taking a second argument are given a
// real one, because a guard starved of its bound would be answering a different question.
const PUBLISHED_GUARDS: Readonly<Record<string, (value: unknown) => boolean>> = Object.freeze({
	isAbsoluteURI,
	isBoundedJSON: (value) => isBoundedJSON(value, { bytes: 4_096, keys: 64, depth: 16 }),
	isBoundedString: (value) => isBoundedString(value, 4_096),
	isElicitContent: (value) => isElicitContent(value, TOTALITY_SCHEMA),
	isFormElicitationSupported,
	isInitializeRequest,
	isJSONObject,
	isJSONRPCError,
	isJSONRPCErrorResponse,
	isJSONRPCId,
	isJSONRPCInvocation,
	isJSONRPCMessage,
	isJSONRPCNotification,
	isJSONRPCRequest,
	isJSONRPCResponse,
	isJSONRPCResultResponse,
	isMCPAnnotations,
	isMCPBlobResource,
	isMCPCallResult,
	isMCPClientCapabilities,
	isMCPCompletion,
	isMCPCompletionParams,
	isMCPCompletionReference,
	isMCPCompletionResult,
	isMCPContent,
	isMCPElicitFieldSchema,
	isMCPElicitForm,
	isMCPElicitRequest,
	isMCPElicitResult,
	isMCPElicitSchema,
	isMCPElicitURL,
	isMCPError,
	isMCPIcon,
	isMCPIdentity,
	isMCPInputRequest,
	isMCPInputRequestMap,
	isMCPInputResponse: (value) => isMCPInputResponse(value, TOTALITY_REQUEST),
	isMCPInputResult,
	isMCPLegacyVersion,
	isMCPLegacyResult,
	isMCPLoggingLevel,
	isMCPMetaKey,
	isMCPMetaObject,
	isMCPModernVersion,
	isMCPProgress,
	isMCPPaginationParams,
	isMCPPrompt,
	isMCPPromptArgument,
	isMCPPromptGetResult,
	isMCPPromptMessage,
	isMCPPromptPage,
	isMCPResource,
	isMCPResourceContents,
	isMCPResourcePage,
	isMCPResourceTemplate,
	isMCPResourceTemplatePage,
	isMCPResult,
	isMCPResultMetaObject,
	isMCPRoot,
	isMCPRootResult,
	isMCPSampleResult,
	isMCPServerCapabilities,
	isMCPStringArguments,
	isMCPSubscriptionFilter,
	isMCPSubscriptionResult,
	isMCPNotificationMetaObject,
	isMCPTaskDetail,
	isMCPTaskDetailResult,
	isMCPTaskNotification,
	isMCPTaskResult,
	isMCPTaskStatus,
	isMCPTextResource,
	isMCPVersion,
	isModernRequest,
	isRFC3339Date,
	isRFC3339DateTime,
	isStandardBase64,
	isTaskSupported,
})

// The sweep itself, so the guards and their control run the identical loop.
function sweepGuard(
	guard: (value: unknown) => boolean,
	battery: readonly unknown[],
): readonly number[] {
	const escaped: number[] = []
	for (const [index, value] of battery.entries()) {
		try {
			guard(value)
		} catch {
			escaped.push(index)
		}
	}
	return escaped
}

// The instrument's negative control, drawn from OUTSIDE the population it certifies: the exact
// shape `isJSONRPCError` shipped with — two named key reads and no boundary at all. The sweep
// must REPORT this, or a clean run over the published guards has measured nothing.
function readsKeysDirectly(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) return false
	return (
		typeof Reflect.get(value, 'code') === 'number' &&
		typeof Reflect.get(value, 'message') === 'string'
	)
}

describe('published guard totality — every door, not the one the defect arrived through', () => {
	// The sweep is worthless if it silently covers half the surface, so the population is
	// proven against the barrel before anything is read into the result.
	it('covers every guard the barrel publishes', () => {
		const published = Object.keys(core).filter((name) => name.startsWith('is'))

		expect(published.filter((name) => !Object.hasOwn(PUBLISHED_GUARDS, name))).toEqual([])
		expect(Object.keys(PUBLISHED_GUARDS).filter((name) => !published.includes(name))).toEqual([])
		expect(published.length).toBeGreaterThan(50)
	})

	it('reports the unbounded direct key read the published guards must not contain', () => {
		expect(sweepGuard(readsKeysDirectly, createThrowingKeys(GUARD_KEY_NAMES)).length).toBe(1)
		// The same battery, the same loop, the repaired guard: bounded where the control escapes.
		expect(sweepGuard(isJSONRPCError, createThrowingKeys(GUARD_KEY_NAMES))).toEqual([])
	})

	it('answers false rather than throwing for every hostile value and every throwing key', () => {
		const battery = [...createHostileCorpus(), ...createThrowingKeys(GUARD_KEY_NAMES)]
		const escaped: string[] = []
		for (const [name, guard] of Object.entries(PUBLISHED_GUARDS)) {
			for (const index of sweepGuard(guard, battery)) escaped.push(`${name}#${String(index)}`)
		}

		expect(battery.length).toBe(GUARD_KEY_NAMES.length + createHostileCorpus().length)
		expect(escaped).toEqual([])
	})
})
describe('MCPError', () => {
	it('preserves the remote message, numeric code, and structured context', () => {
		const error = new MCPError('Remote failure', -32042, { retry: false })

		expect(error).toBeInstanceOf(Error)
		expect(error.name).toBe('MCPError')
		expect(error.message).toBe('Remote failure')
		expect(error.code).toBe(-32042)
		expect(error.context).toEqual({ retry: false })
	})

	it('uses undefined context when the remote error carries no data', () => {
		expect(new MCPError('Missing', -32601).context).toBeUndefined()
	})

	it('represents HeaderMismatch without inventing a data payload', () => {
		const error = new MCPError('Header mismatch', MCP_HEADER_MISMATCH)

		expect(error.code).toBe(-32020)
		expect(error.context).toBeUndefined()
	})

	it('preserves MissingRequiredClientCapability data', () => {
		const context = { requiredCapabilities: { elicitation: { form: {} } } }
		const error = new MCPError(
			'Missing required client capability',
			MCP_MISSING_CAPABILITY,
			context,
		)

		expect(error.code).toBe(-32021)
		expect(error.context).toEqual(context)
	})

	it('preserves exact UnsupportedProtocolVersion negotiation data', () => {
		const context = {
			supported: ['2026-07-28', '2025-11-25', '2025-06-18'],
			requested: '2024-11-05',
		}
		const error = new MCPError('Unsupported protocol version', MCP_UNSUPPORTED_VERSION, context)

		expect(error.code).toBe(-32022)
		expect(error.context).toEqual(context)
	})
})

describe('isMCPError', () => {
	it('narrows only real MCPError instances', () => {
		const error = new MCPError('Remote failure', -32042)

		expect(isMCPError(error)).toBe(true)
		expect(isMCPError(new Error('Remote failure'))).toBe(false)
		expect(isMCPError({ name: 'MCPError', code: -32042, context: undefined })).toBe(false)
	})

	it('is total over hostile and primitive inputs', () => {
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()

		for (const value of [undefined, null, true, 0, '', Symbol('error'), proxy]) {
			expect(isMCPError(value)).toBe(false)
		}
	})
})

describe('the invocation arms', () => {
	it('requires an id on a request and forbids one on a notification', () => {
		expectTypeOf<JSONRPCRequest['id']>().toEqualTypeOf<JSONRPCId>()
		expectTypeOf<JSONRPCNotification['id']>().toEqualTypeOf<undefined>()
		expectTypeOf<JSONRPCInvocation>().toEqualTypeOf<JSONRPCRequest | JSONRPCNotification>()
	})

	it('keeps a request and a notification mutually unassignable', () => {
		expectTypeOf<JSONRPCRequest>().not.toExtend<JSONRPCNotification>()
		expectTypeOf<JSONRPCNotification>().not.toExtend<JSONRPCRequest>()
	})

	it('narrows the union on the id at runtime as well as in the type', () => {
		const invocation: JSONRPCInvocation = createJSONRPCRequest({ method: 'ping', id: 7 })
		const notification: JSONRPCInvocation = createJSONRPCNotification('notifications/initialized')

		expect(invocation.id).toBe(7)
		expect(notification.id).toBeUndefined()
		expect(Object.hasOwn(notification, 'id')).toBe(false)
	})
})

describe('the open MCPResult contract', () => {
	it('accepts an unknown protocol discriminator', () => {
		expectTypeOf<MCPResult['resultType']>().toEqualTypeOf<string>()

		expect(isMCPResult({ resultType: 'task', taskId: 't-1' })).toBe(true)
	})

	it('keeps every concrete result assignable without losing its literal', () => {
		expectTypeOf<MCPCallResult>().toExtend<MCPResult>()
		expectTypeOf<MCPCallResult['resultType']>().toEqualTypeOf<'complete'>()
		expectTypeOf<MCPDiscoverResult>().toExtend<MCPResult>()
		expectTypeOf<MCPDiscoverResult['resultType']>().toEqualTypeOf<'complete'>()
		expectTypeOf<MCPListResult>().toExtend<MCPResult>()
		expectTypeOf<MCPListResult['resultType']>().toEqualTypeOf<'complete'>()
		expectTypeOf<MCPSubscriptionResult>().toExtend<MCPResult>()
		expectTypeOf<MCPSubscriptionResult['resultType']>().toEqualTypeOf<'complete'>()
	})

	it('still narrows a known result to its literal through its own guard', () => {
		const result: MCPResult | MCPLegacyResult = {
			resultType: 'complete',
			content: [{ type: 'text', text: 'hi' }],
		}
		if (!isMCPCallResult(result)) throw new Error('expected a complete tool result')
		const discriminant: 'complete' = result.resultType

		expect(discriminant).toBe('complete')
		expect(result.content).toHaveLength(1)
	})
})

describe('the legacy result arm', () => {
	it('is disjoint from the modern contract in both directions', () => {
		expectTypeOf<MCPLegacyResult['resultType']>().toEqualTypeOf<undefined>()
		expectTypeOf<MCPLegacyResult>().not.toExtend<MCPResult>()
		expectTypeOf<MCPResult>().not.toExtend<MCPLegacyResult>()
	})

	it('carries the legacy branch payloads the modern contract would reject', () => {
		const ping = buildJSONRPCResult(1, {})
		const list = buildJSONRPCResult(2, { tools: [{ name: 'echo' }] })

		expect(isMCPLegacyResult(ping.result)).toBe(true)
		expect(isMCPResult(ping.result)).toBe(false)
		expect(isMCPLegacyResult(list.result)).toBe(true)
		expect(isMCPResult(list.result)).toBe(false)
	})

	it('is what the result arm accepts alongside the modern contract', () => {
		expectTypeOf<JSONRPCResultResponse['result']>().toEqualTypeOf<MCPResult | MCPLegacyResult>()
	})
})

describe('the modern result contracts', () => {
	it('requires every modern stamp on a tools/list result', () => {
		expectTypeOf<MCPListResult['ttlMs']>().toEqualTypeOf<number>()
		expectTypeOf<MCPListResult['cacheScope']>().toEqualTypeOf<'public' | 'private'>()
		expectTypeOf<MCPListResult['tools']>().toEqualTypeOf<readonly MCPToolDescriptor[]>()
		expectTypeOf<{ readonly tools: readonly MCPToolDescriptor[] }>().not.toExtend<MCPListResult>()
	})

	it('makes the modern stamp the only difference between the call results', () => {
		expectTypeOf<MCPCallResult>().toExtend<MCPUnstampedCallResult>()
		expectTypeOf<MCPUnstampedCallResult>().not.toExtend<MCPCallResult>()
		expectTypeOf<MCPUnstampedCallResult>().toExtend<MCPLegacyResult>()
	})

	it('keeps the input-required union enforcing at least one member', () => {
		expectTypeOf<MCPInputRequestMap>().toEqualTypeOf<Readonly<Record<string, MCPInputRequest>>>()
		expectTypeOf<MCPElicitRequest>().toExtend<MCPInputRequest>()
		expectTypeOf<MCPInputResult>().toExtend<MCPResult>()
		expectTypeOf<{ readonly resultType: 'input_required' }>().not.toExtend<MCPInputResult>()
	})

	it('keeps the elicitation parameters discriminated by mode', () => {
		expectTypeOf<MCPElicitParams>().toEqualTypeOf<MCPElicitForm | MCPElicitURL>()
		expectTypeOf<MCPElicitRequest['params']>().toEqualTypeOf<MCPElicitParams>()
		expectTypeOf<MCPElicitForm['mode']>().toEqualTypeOf<'form' | undefined>()
		expectTypeOf<MCPElicitURL['mode']>().toEqualTypeOf<'url'>()
	})
})

describe('MCP resource guards', () => {
	it('validates the shared page shapes and the text-xor-blob contents discriminator', () => {
		const resource = { uri: 'memory://resource/one', name: 'one' }
		const template = { uriTemplate: 'memory://resource/{name}', name: 'named' }

		expect(isMCPPaginationParams({ cursor: 'second' })).toBe(true)
		expect(isMCPPaginationParams({ cursor: 2 })).toBe(false)
		expect(isMCPResource(resource)).toBe(true)
		expect(isMCPResourceTemplate(template)).toBe(true)
		expect(isMCPResourcePage({ resources: [resource], nextCursor: 'second' })).toBe(true)
		expect(isMCPResourceTemplatePage({ resourceTemplates: [template] })).toBe(true)
		expect(isMCPResourceContents({ uri: 'memory://resource/one', text: 'one' })).toBe(true)
		expect(isMCPResourceContents({ uri: 'memory://resource/one', blob: 'b25l' })).toBe(true)
		expect(isMCPResourceContents({ uri: 'memory://resource/one', text: 'one', blob: 'b25l' })).toBe(
			false,
		)
	})
})

describe('MCP prompt guards', () => {
	it('validates descriptors, pages, rich messages, results, and completion parameters', () => {
		const argument = { name: 'person', title: 'Person', required: true }
		const prompt = { name: 'greet', arguments: [argument] }
		const message = { role: 'user', content: { type: 'text', text: 'Hello' } }

		expect(isMCPPromptArgument(argument)).toBe(true)
		expect(isMCPPrompt(prompt)).toBe(true)
		expect(isMCPPromptPage({ prompts: [prompt], nextCursor: 'second' })).toBe(true)
		expect(isMCPPromptMessage(message)).toBe(true)
		expect(isMCPPromptMessage({ ...message, role: 'system' })).toBe(false)
		expect(isMCPPromptGetResult({ resultType: 'complete', messages: [message] })).toBe(true)
		expect(
			isMCPCompletionParams({
				ref: { type: 'ref/resource', uri: 'memory://resource/{name}' },
				argument: { name: 'name', value: 'o' },
				context: { arguments: { extension: 'txt' } },
			}),
		).toBe(true)
	})
})
