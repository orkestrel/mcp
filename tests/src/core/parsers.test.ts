import {
	DEFAULT_MCP_LIMITS,
	isBoundedJSON,
	isJSONRPCMessage,
	isModernRequest,
	MCP_META_CAPABILITIES,
	MCP_META_CLIENT,
	MCP_META_VERSION,
	parseMCPInputState,
	parseJSONRPCMessage,
	parseRequestContext,
	serializeJSON,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import { buildNestedRecord } from '../../setup.js'

// parseJSONRPCMessage narrows an already-parsed value to a JSONRPCMessage or
// undefined (AGENTS §14 — total; the raw-string JSON.parse happens in
// MCPServer.handle). Its sound partner is the COMPOSITE isJSONRPCMessage(v) &&
// isBoundedJSON(v, limits): every defined result satisfies the guard, and every
// composite-valid input is admitted. The guard alone carries no size or depth bound, so
// guard-valid-but-unbounded values are rejected here by design, and a defined result is
// an owned canonical snapshot rather than the input reference.

// One complete protected payload, serialized the way a continuation port hands it back.
// `overrides` names only what a row is changing; an `undefined` override REMOVES the member,
// because `JSON.stringify` drops it — which is how a "missing binding" row is written.
function protectedPayload(overrides: Readonly<Record<string, unknown>> = {}): string {
	return JSON.stringify({
		principal: 'operator-1',
		expiry: 1_000,
		id: 7,
		version: '2026-07-28',
		method: 'tools/call',
		key: 'confirm',
		name: 'reply',
		digest: 'abc',
		schema: { type: 'object', properties: { approved: { type: 'boolean' } } },
		...overrides,
	})
}

describe('parseJSONRPCMessage', () => {
	it('returns an owned frozen request', () => {
		const request = { jsonrpc: '2.0', method: 'ping', id: 1 }
		const parsed = parseJSONRPCMessage(request)

		expect(parsed).toEqual(request)
		expect(parsed).not.toBe(request)
		expect(Object.isFrozen(parsed)).toBe(true)
	})

	it('returns an owned frozen response', () => {
		const response = { jsonrpc: '2.0', id: 1, result: {} }
		const parsed = parseJSONRPCMessage(response)

		expect(parsed).toEqual(response)
		expect(parsed).not.toBe(response)
		expect(Object.isFrozen(parsed)).toBe(true)
	})

	it('returns undefined for a non-message record', () => {
		expect(parseJSONRPCMessage({ method: 'ping' })).toBeUndefined()
	})

	it('returns undefined for adversarial input', () => {
		for (const value of [null, undefined, 42, 'x', [1, 2], true]) {
			expect(parseJSONRPCMessage(value)).toBeUndefined()
		}
	})

	it('rejects a guard-valid message nested deeper than the default depth bound', () => {
		const deep = { jsonrpc: '2.0', method: 'ping', id: 1, params: buildNestedRecord(40) }

		expect(isJSONRPCMessage(deep)).toBe(true)
		expect(parseJSONRPCMessage(deep)).toBeUndefined()
	})

	it('rejects a guard-valid message whose canonical text exceeds the byte bound', () => {
		const large = { jsonrpc: '2.0', method: 'ping', id: 1, params: { big: 'x'.repeat(64) } }

		expect(isJSONRPCMessage(large)).toBe(true)
		expect(parseJSONRPCMessage(large, { bytes: 32, depth: 8 })).toBeUndefined()
		// The same value under a wider byte bound is admitted — so the rejection above is the
		// bound doing its work, not the shape, and `limits` is genuinely threaded through.
		expect(parseJSONRPCMessage(large, { bytes: 4_096, depth: 8 })).toEqual(large)
	})

	it('is sound with the composite guard over one corpus', () => {
		const limits = { bytes: DEFAULT_MCP_LIMITS.content, depth: DEFAULT_MCP_LIMITS.depth }
		const samples: readonly unknown[] = [
			{ jsonrpc: '2.0', method: 'ping', id: 1 },
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			{ jsonrpc: '2.0', id: 1, result: {} },
			{ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } },
			{ jsonrpc: '2.0', method: 'ping', id: 1, params: undefined },
			{ jsonrpc: '2.0', method: 'ping', id: Number.NaN },
			{ not: 'a message' },
			null,
			[1, 2],
		]
		const parsed = samples.map((value) => parseJSONRPCMessage(value, limits))
		// Half 1 — every defined result satisfies isJSONRPCMessage.
		const unsound = parsed.filter((result) => result !== undefined && !isJSONRPCMessage(result))
		// Half 2 — every input satisfying the COMPOSITE is admitted rather than rejected.
		// Both violator lists are collected and asserted unconditionally (no conditional expect).
		const rejected = samples.filter(
			(value, index) =>
				isJSONRPCMessage(value) && isBoundedJSON(value, limits) && parsed[index] === undefined,
		)

		expect(unsound).toEqual([])
		expect(rejected).toEqual([])
	})

	it('rejects a guard-valid value drawn from outside the admitted population', () => {
		const limits = { bytes: DEFAULT_MCP_LIMITS.content, depth: DEFAULT_MCP_LIMITS.depth }
		const outside = { jsonrpc: '2.0', method: 'ping', id: 1, params: buildNestedRecord(40) }

		// The negative control for the corpus above. That corpus contains no guard-valid value
		// the bounds reject, so it can prove the parser discriminates AMONG the values it admits
		// and nothing about the population boundary itself. This value sits outside it: exact
		// enough for the guard, depth-excessive for the composite. The block reads TWO bounds —
		// isBoundedJSON takes the local `limits`, while parseJSONRPCMessage takes none and reads
		// DEFAULT_MCP_LIMITS through the parser's own default — so widening either reddens the
		// assertion that reads it. The threshold is asserted below rather than described: for a
		// message whose `params` is buildNestedRecord(N) it is N + 2 — the builder's own threshold
		// is N + 1, and the enclosing message level supplies the other — so 41 still rejects and 42
		// admits. The guard assertion
		// reads neither bound — validators.ts never imports DEFAULT_MCP_LIMITS — so it stays green
		// under every bound mutation, which is what makes this value guard-valid and out of bounds
		// at once. A non-finite depth makes serializeJSON fail closed, leaving every assertion in
		// this block green.
		expect(isJSONRPCMessage(outside)).toBe(true)
		expect(isBoundedJSON(outside, limits)).toBe(false)
		expect(parseJSONRPCMessage(outside)).toBeUndefined()
		expect(isBoundedJSON(outside, { bytes: DEFAULT_MCP_LIMITS.content, depth: 41 })).toBe(false)
		expect(isBoundedJSON(outside, { bytes: DEFAULT_MCP_LIMITS.content, depth: 42 })).toBe(true)
	})

	it('rejects a guard-valid message whose canonical text exceeds the DEFAULT byte bound', () => {
		const defaults = { bytes: DEFAULT_MCP_LIMITS.content, depth: DEFAULT_MCP_LIMITS.depth }
		const oversized = {
			jsonrpc: '2.0',
			method: 'ping',
			id: 1,
			params: { big: 'x'.repeat(DEFAULT_MCP_LIMITS.content) },
		}

		// The byte sibling of the depth control above, and the only place anywhere that puts the
		// parser's DEFAULT byte bound under control: every other byte assertion supplies explicit
		// limits, so raising the default alone left all of them green while eleven of thirteen
		// call sites silently lost their size bound. This value sits inside the default depth
		// bound and outside the default byte bound. Unlike the depth control above — whose payload
		// is a literal — this payload is derived from DEFAULT_MCP_LIMITS.content, so it is
		// invariant to that constant's VALUE in both directions: what turns it red is decoupling
		// the parser's own default `bytes` upward from content. A shape change to
		// DEFAULT_MCP_LIMITS is caught by `check`, not here.
		// serializeJSON abandons its per-character loop the moment the running count exceeds the
		// limit, so this is one linear pass rather than a quadratic one.
		expect(isJSONRPCMessage(oversized)).toBe(true)
		expect(isBoundedJSON(oversized, defaults)).toBe(false)
		expect(parseJSONRPCMessage(oversized)).toBeUndefined()
	})

	it('rebuilds a canonical snapshot: sorted serialization, JavaScript key order, -0 as 0', () => {
		const limits = { bytes: DEFAULT_MCP_LIMITS.content, depth: DEFAULT_MCP_LIMITS.depth }
		const request = { method: 'ping', jsonrpc: '2.0', id: 1 }
		const parsed = parseJSONRPCMessage(request)
		const zero = parseJSONRPCMessage({ jsonrpc: '2.0', method: 'ping', id: -0 })
		const numeric = { jsonrpc: '2.0', method: 'ping', id: 1, params: { '10': 1, '9': 2 } }
		const rebuilt = parseJSONRPCMessage(numeric)

		expect(parsed).not.toBe(request)
		// Asserted through the serialized text so key ORDER is observable without a
		// narrowing that would need an assertion.
		expect(JSON.stringify(parsed)).toBe('{"id":1,"jsonrpc":"2.0","method":"ping"}')
		expect(zero !== undefined && 'method' in zero && Object.is(zero.id, 0)).toBe(true)
		// Integer-like keys are the population the two assertions above cannot reach. The
		// canonical TEXT sorts '10' before '9' lexicographically, but JSON.parse rebuilds an
		// object whose own keys enumerate in ascending numeric order, so the nested `params`
		// re-stringifies as {"9":2,"10":1} while its canonical bytes are {"10":1,"9":2}. The
		// divergence is confined to records with integer-like keys: the top level here is
		// unaffected, and the assertion above shows a whole message re-stringifying to its
		// canonical bytes. A caller who needs canonical bytes takes them from serializeJSON
		// rather than re-stringifying this result.
		expect(serializeJSON(numeric, limits)).toBe(
			'{"id":1,"jsonrpc":"2.0","method":"ping","params":{"10":1,"9":2}}',
		)
		expect(JSON.stringify(rebuilt)).toBe(
			'{"id":1,"jsonrpc":"2.0","method":"ping","params":{"9":2,"10":1}}',
		)
	})
})

describe('parseRequestContext', () => {
	it('projects the required metadata and optional client identity', () => {
		const request = {
			jsonrpc: '2.0',
			method: 'tools/call',
			id: 1,
			params: {
				_meta: {
					[MCP_META_VERSION]: '2026-07-28',
					[MCP_META_CAPABILITIES]: { elicitation: {} },
					[MCP_META_CLIENT]: { name: 'agent', version: '1.0.0' },
				},
			},
		}

		expect(parseRequestContext(request)).toEqual({
			version: '2026-07-28',
			capabilities: { elicitation: {} },
			identity: { name: 'agent', version: '1.0.0' },
		})
	})

	it('accepts complete metadata, capability, identity, logging, and progress shapes', () => {
		const request = {
			jsonrpc: '2.0',
			method: 'tools/call',
			id: 1,
			params: {
				_meta: {
					[MCP_META_VERSION]: '2026-07-28',
					[MCP_META_CAPABILITIES]: {
						custom: { enabled: true },
						elicitation: { form: {}, future: true },
						extensions: { 'vendor.example/feature': { enabled: true } },
					},
					[MCP_META_CLIENT]: {
						name: 'agent',
						version: '1.0.0',
						title: 'Agent',
						description: 'Operator agent',
						websiteUrl: 'https://example.test',
						icons: [{ src: 'resource:icon' }],
					},
					'io.modelcontextprotocol/logLevel': 'warning',
					progressToken: 7,
					'vendor.example/trace': { id: 'trace-1' },
				},
			},
		}

		expect(parseRequestContext(request)).toEqual({
			version: '2026-07-28',
			capabilities: request.params['_meta'][MCP_META_CAPABILITIES],
			identity: request.params['_meta'][MCP_META_CLIENT],
		})
	})

	it('owns the projected context independently of later request mutation', () => {
		const capabilities = { custom: { enabled: true } }
		const request = {
			jsonrpc: '2.0',
			method: 'tools/list',
			id: 1,
			params: {
				_meta: {
					[MCP_META_VERSION]: '2026-07-28',
					[MCP_META_CAPABILITIES]: capabilities,
				},
			},
		}

		const context = parseRequestContext(request)
		capabilities.custom.enabled = false

		expect(context?.capabilities).toEqual({ custom: { enabled: true } })
		expect(Object.isFrozen(context?.capabilities)).toBe(true)
		expect(Object.isFrozen(context)).toBe(true)
	})

	it('accepts a string unsupported revision so the caller can return -32022', () => {
		const request = {
			jsonrpc: '2.0',
			method: 'tools/list',
			id: 1,
			params: {
				_meta: {
					[MCP_META_VERSION]: '2024-11-05',
					[MCP_META_CAPABILITIES]: {},
				},
			},
		}

		expect(parseRequestContext(request)).toEqual({
			version: '2024-11-05',
			capabilities: {},
		})
	})

	it('enforces defined output implies modern routing', () => {
		const requests: readonly unknown[] = [
			{
				jsonrpc: '2.0',
				method: 'tools/list',
				id: 1,
				params: {
					_meta: {
						[MCP_META_VERSION]: '2026-07-28',
						[MCP_META_CAPABILITIES]: {},
					},
				},
			},
			{ jsonrpc: '2.0', method: 'tools/list', id: 2 },
			null,
		]
		const unsound = requests.filter((request) => {
			const context = parseRequestContext(request)
			return context !== undefined && !isModernRequest(request)
		})

		expect(unsound).toEqual([])
	})

	it('maps guard-positive malformed required metadata to the -32602 parse failure', () => {
		const malformed: readonly unknown[] = [
			{
				jsonrpc: '2.0',
				method: 'tools/list',
				id: 1,
				params: {
					_meta: { [MCP_META_VERSION]: 7, [MCP_META_CAPABILITIES]: {} },
				},
			},
			{
				jsonrpc: '2.0',
				method: 'tools/list',
				id: 2,
				params: { _meta: { [MCP_META_VERSION]: '2026-07-28' } },
			},
			{
				jsonrpc: '2.0',
				method: 'tools/list',
				id: 3,
				params: {
					_meta: {
						[MCP_META_VERSION]: '2026-07-28',
						[MCP_META_CAPABILITIES]: {},
						[MCP_META_CLIENT]: { name: 'agent', version: 7 },
					},
				},
			},
		]

		expect(malformed.every(isModernRequest)).toBe(true)
		expect(malformed.map((request) => parseRequestContext(request))).toEqual([
			undefined,
			undefined,
			undefined,
		])
	})

	it('rejects malformed complete metadata and known capability fields', () => {
		const metadata: readonly Readonly<Record<string, unknown>>[] = [
			{
				[MCP_META_VERSION]: '2026-07-28',
				[MCP_META_CAPABILITIES]: { custom: true },
			},
			{
				[MCP_META_VERSION]: '2026-07-28',
				[MCP_META_CAPABILITIES]: { elicitation: { future: {} } },
			},
			{
				[MCP_META_VERSION]: '2026-07-28',
				[MCP_META_CAPABILITIES]: {},
				[MCP_META_CLIENT]: { name: 'agent', version: '1', websiteUrl: 'relative' },
			},
			{
				[MCP_META_VERSION]: '2026-07-28',
				[MCP_META_CAPABILITIES]: {},
				'io.modelcontextprotocol/logLevel': 'warn',
			},
			{
				[MCP_META_VERSION]: '2026-07-28',
				[MCP_META_CAPABILITIES]: {},
				progressToken: 1.5,
			},
			{
				[MCP_META_VERSION]: '2026-07-28',
				[MCP_META_CAPABILITIES]: {},
				'bad key': true,
			},
			{
				[MCP_META_VERSION]: '2026-07-28',
				[MCP_META_CAPABILITIES]: {},
				'vendor.example/value': Number.NaN,
			},
		]
		const requests = metadata.map((_meta, index) => ({
			jsonrpc: '2.0',
			method: 'tools/list',
			id: index,
			params: { _meta },
		}))

		expect(requests.map(isModernRequest)).toEqual([true, true, true, true, true, true, false])
		expect(requests.map((request) => parseRequestContext(request))).toEqual(
			requests.map(() => undefined),
		)
	})

	it('is total over hostile input', () => {
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()

		expect(parseRequestContext(proxy)).toBeUndefined()
		const metadata = Object.defineProperty({}, MCP_META_VERSION, {
			enumerable: true,
			get() {
				throw new Error('must not escape')
			},
		})
		expect(
			parseRequestContext({
				jsonrpc: '2.0',
				method: 'tools/list',
				params: { _meta: metadata },
			}),
		).toBeUndefined()
	})
})

describe('parseMCPInputState', () => {
	it('parses every replay-binding field, the issued schema, and optional consumer state', () => {
		expect(parseMCPInputState(protectedPayload({ state: { operation: 'run-42' } }))).toEqual({
			principal: 'operator-1',
			expiry: 1_000,
			id: 7,
			version: '2026-07-28',
			method: 'tools/call',
			key: 'confirm',
			name: 'reply',
			digest: 'abc',
			schema: { type: 'object', properties: { approved: { type: 'boolean' } } },
			state: { operation: 'run-42' },
		})
	})

	// Every row is a COMPLETE payload with exactly one binding removed or mistyped, so each
	// isolates the binding it names. A row that simply omitted several would pass for want of
	// a member nobody was testing, and the schema row below is exactly where that would bite:
	// a payload with no schema has nothing to enforce an accepted response against.
	it('rejects malformed JSON and every missing or mistyped binding', () => {
		const invalid: readonly unknown[] = [
			'not-json',
			null,
			protectedPayload({ principal: undefined }),
			protectedPayload({ principal: '' }),
			protectedPayload({ expiry: '1' }),
			protectedPayload({ id: null }),
			protectedPayload({ version: 2 }),
			protectedPayload({ method: 2 }),
			protectedPayload({ key: 2 }),
			protectedPayload({ name: 2 }),
			protectedPayload({ digest: 2 }),
			protectedPayload({ schema: undefined }),
			protectedPayload({ schema: 'object' }),
			protectedPayload({ schema: { type: 'object' } }),
			protectedPayload({ schema: { type: 'object', properties: { bad: { type: 'object' } } } }),
		]

		expect(invalid.map((value) => parseMCPInputState(value))).toEqual(invalid.map(() => undefined))
	})

	// The positive control for the rows above: the same builder with nothing removed parses,
	// so a row's `undefined` reports on the binding it mistyped rather than on the builder.
	it('parses the complete payload the rejection rows are built from', () => {
		expect(parseMCPInputState(protectedPayload())).toMatchObject({ key: 'confirm' })
	})

	it('rejects fractional and non-finite protected request ids', () => {
		for (const id of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(parseMCPInputState(protectedPayload({ id }))).toBeUndefined()
		}
	})
})
