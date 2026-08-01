import type { ToolManagerInterface, ToolResult } from '@orkestrel/tool'
import type {
	JSONRPCRequest,
	JSONRPCResponse,
	MCPCallResult,
	MCPClientInterface,
	MCPDiscoverResult,
	MCPIdentity,
	MCPServerInterface,
	MCPServerOptions,
	MCPStream,
	MCPTextStream,
	MCPToolDescriptor,
	MCPTransportInterface,
	SubscriptionFilter,
	SubscriptionsListenResult,
	SubscriptionsListenResultMetaObject,
} from './types.js'
import { isRecord } from '@orkestrel/contract'
import {
	DEFAULT_MCP_CACHE_TTL,
	MCP_LEGACY_VERSION,
	MCP_META_SERVER,
	MCP_META_SUBSCRIPTION,
	SUPPORTED_PROTOCOL_VERSIONS,
} from './constants.js'
import { inferEra } from './inferers.js'
import { parseJSONRPCMessage } from './parsers.js'
import { isMCPVersion } from './validators.js'

// Pure dispatch builders (AGENTS §5: the dispatch branches stay exported helpers,
// not hidden privates). Each turns a piece of MCP state into the JSON-RPC `result`
// payload (or a response envelope) the server returns — independently testable.

/**
 * Build a JSON-RPC success {@link JSONRPCResponse} — the `id` echoed, the method's
 * value as `result`.
 *
 * @param id - The request's id (`null` only for a parse / invalid-request error)
 * @param result - The method's return value
 * @returns The success response envelope
 */
export function buildJSONRPCResult(id: string | number | null, result: unknown): JSONRPCResponse {
	return { jsonrpc: '2.0', id, result }
}

/**
 * Build a JSON-RPC error {@link JSONRPCResponse} — the `id` echoed, the failure as
 * an `error` object.
 *
 * @param id - The request's id (`null` for a parse / invalid-request error)
 * @param code - One of the reserved JSON-RPC codes (see `./constants.js`)
 * @param message - A short human description of the failure
 * @param data - An OPTIONAL machine-readable payload (omitted from the envelope when absent)
 * @returns The error response envelope
 */
export function buildJSONRPCError(
	id: string | number | null,
	code: number,
	message: string,
	data?: unknown,
): JSONRPCResponse {
	return {
		jsonrpc: '2.0',
		id,
		error: data === undefined ? { code, message } : { code, message, data },
	}
}

/**
 * Map a {@link ToolManagerInterface}'s definitions to MCP `tools/list` descriptors
 * — renaming `parameters` to the wire's `inputSchema`.
 *
 * @remarks
 * Each {@link import('@orkestrel/tool').ToolDefinition} carries through its
 * `name` and (when present) `description`; its open JSON-Schema `parameters`
 * becomes `inputSchema`, defaulting to an empty object schema (`{ type: 'object' }`)
 * when a tool declares none (MCP requires an `inputSchema`).
 *
 * @param manager - The tool registry to describe
 * @returns One {@link MCPToolDescriptor} per registered tool, in registry order
 */
export function buildToolDescriptors(manager: ToolManagerInterface): readonly MCPToolDescriptor[] {
	return manager.definitions().map((definition) => {
		const descriptor: {
			name: string
			description?: string
			inputSchema: Readonly<Record<string, unknown>>
		} = {
			name: definition.name,
			inputSchema: definition.parameters ?? { type: 'object' },
		}
		if (definition.description !== undefined) descriptor.description = definition.description
		return descriptor
	})
}

/**
 * Map an executed tool's {@link ToolResult} to an MCP {@link MCPCallResult} — the
 * value (or error) as a `text` content block.
 *
 * @remarks
 * The {@link ToolManagerInterface} already isolates a thrown tool into a
 * `success: false` result (so the server adds NO try/catch around `execute`):
 * that branch builds an `isError: true` result carrying `result.error`, so the
 * model sees the failure as a tool result it can react to rather than a protocol
 * error; the `success: true` branch serializes `result.value` (via
 * `JSON.stringify`) into one `text` block.
 *
 * @param result - The tool's execution outcome
 * @returns The MCP tool-call result
 */
export function buildCallResult(result: ToolResult): MCPCallResult {
	if (!result.success) {
		return { content: [{ type: 'text', text: result.error }], isError: true }
	}
	// A content block must carry a string `text`; `JSON.stringify(undefined)` is the value
	// `undefined` (which serializes away), so a value-less result becomes an empty text block.
	const text = result.value === undefined ? '' : JSON.stringify(result.value)
	return { content: [{ type: 'text', text }] }
}

/**
 * Stamp a result with the modern complete-result discriminator and server
 * metadata, plus cache fields when the result is cacheable.
 *
 * @remarks
 * This is the single stamping site shared by modern result builders. Supplying
 * `ttl` adds both schema-coupled fields (`ttlMs` and `cacheScope`); omitting it
 * adds neither, which keeps `tools/call` distinct from cacheable results.
 *
 * @param result - The unstamped result payload
 * @param identity - The server identity carried under the reserved `_meta` key
 * @param ttl - Required freshness lifetime for a cacheable result; omit for a non-cacheable result
 * @param scope - The cache visibility, defaulting to `'private'` when `ttl` is supplied
 * @returns A copy of the payload with its modern stamps
 */
export function buildModernResult<T extends object>(
	result: T,
	identity: MCPIdentity,
	ttl: number,
	scope?: 'public' | 'private',
): T & {
	readonly resultType: 'complete'
	readonly _meta: Readonly<Record<string, unknown>>
	readonly ttlMs: number
	readonly cacheScope: 'public' | 'private'
}
export function buildModernResult<T extends object>(
	result: T,
	identity: MCPIdentity,
): T & {
	readonly resultType: 'complete'
	readonly _meta: Readonly<Record<string, unknown>>
}
export function buildModernResult<T extends object>(
	result: T,
	identity: MCPIdentity,
	ttl?: number,
	scope?: 'public' | 'private',
): T & {
	readonly resultType: 'complete'
	readonly _meta: Readonly<Record<string, unknown>>
	readonly ttlMs?: number
	readonly cacheScope?: 'public' | 'private'
} {
	const currentMetadata = isRecord(result) ? result['_meta'] : undefined
	const metadata = {
		...(isRecord(currentMetadata) ? currentMetadata : {}),
		[MCP_META_SERVER]: identity,
	}
	if (ttl === undefined) return { ...result, resultType: 'complete', _meta: metadata }
	return {
		...result,
		resultType: 'complete',
		ttlMs: ttl,
		cacheScope: scope ?? 'private',
		_meta: metadata,
	}
}

/**
 * Intersect a requested subscription filter with the notification families a server supports.
 *
 * @param requested - The notification families requested by the client
 * @param supported - The notification families the server can actually produce
 * @returns The exact subset the server will honour
 */
export function buildSubscriptionFilter(
	requested: SubscriptionFilter,
	supported: SubscriptionFilter,
): SubscriptionFilter {
	const toolsListChanged =
		requested.toolsListChanged === true && supported.toolsListChanged === true
	const promptsListChanged =
		requested.promptsListChanged === true && supported.promptsListChanged === true
	const resourcesListChanged =
		requested.resourcesListChanged === true && supported.resourcesListChanged === true
	const supportedResources = new Set(supported.resourceSubscriptions ?? [])
	const resourceSubscriptions = requested.resourceSubscriptions?.filter((uri) =>
		supportedResources.has(uri),
	)
	return {
		...(toolsListChanged ? { toolsListChanged: true } : {}),
		...(promptsListChanged ? { promptsListChanged: true } : {}),
		...(resourcesListChanged ? { resourcesListChanged: true } : {}),
		...(resourceSubscriptions !== undefined && resourceSubscriptions.length > 0
			? { resourceSubscriptions }
			: {}),
	}
}

/**
 * Determine whether a produced notification belongs to an honoured subscription filter.
 *
 * @param notification - The server notification offered by the configured producer
 * @param filter - The filter acknowledged to the client
 * @returns `true` when the notification belongs on this subscription stream
 */
export function matchesSubscriptionNotification(
	notification: JSONRPCRequest,
	filter: SubscriptionFilter,
): boolean {
	if (notification.method === 'notifications/tools/list_changed') {
		return filter.toolsListChanged === true
	}
	if (notification.method === 'notifications/prompts/list_changed') {
		return filter.promptsListChanged === true
	}
	if (notification.method === 'notifications/resources/list_changed') {
		return filter.resourcesListChanged === true
	}
	if (notification.method !== 'notifications/resources/updated') return false
	const uri = notification.params?.['uri']
	return typeof uri === 'string' && filter.resourceSubscriptions?.includes(uri) === true
}

/**
 * Stamp a subscription notification with the request id reserved for its held-open stream.
 *
 * @param notification - The notification to copy and stamp
 * @param id - The `subscriptions/listen` request id
 * @returns The stamped notification, preserving its other params and metadata
 */
export function stampSubscriptionNotification(
	notification: JSONRPCRequest,
	id: string | number,
): JSONRPCRequest {
	const metadata = notification.params?.['_meta']
	return {
		jsonrpc: notification.jsonrpc,
		method: notification.method,
		params: {
			...notification.params,
			_meta: {
				...(isRecord(metadata) ? metadata : {}),
				[MCP_META_SUBSCRIPTION]: id,
			},
		},
	}
}

/**
 * Build the first notification carrying a subscription id for a listen request.
 *
 * @param notifications - The exact notification filter the server will honour
 * @param id - The `subscriptions/listen` request id
 * @returns The stamped subscription acknowledgement notification
 */
export function buildSubscriptionAcknowledgement(
	notifications: SubscriptionFilter,
	id: string | number,
): JSONRPCRequest {
	return stampSubscriptionNotification(
		{
			jsonrpc: '2.0',
			method: 'notifications/subscriptions/acknowledged',
			params: { notifications },
		},
		id,
	)
}

/**
 * Build the terminating response for a subscription source that closes gracefully.
 *
 * @param id - The `subscriptions/listen` request id
 * @param identity - The server identity included by the modern result stamping site
 * @returns The complete modern result carrying the required subscription id metadata
 */
export function buildSubscriptionResult(
	id: string | number,
	identity: MCPIdentity,
): JSONRPCResponse {
	const metadata: SubscriptionsListenResultMetaObject = { [MCP_META_SUBSCRIPTION]: id }
	const result: SubscriptionsListenResult = buildModernResult({ _meta: metadata }, identity)
	return buildJSONRPCResult(id, result)
}

/**
 * Build the mandatory modern `server/discover` result.
 *
 * @param options - The server identity, instructions, and cache configuration
 * @returns The supported revisions, tools capability, and required modern cache stamps
 */
export function buildDiscoverResult(options: MCPServerOptions): MCPDiscoverResult {
	return buildModernResult(
		{
			supportedVersions: SUPPORTED_PROTOCOL_VERSIONS.filter(isMCPVersion),
			capabilities: { tools: {} },
			...(options.instructions === undefined ? {} : { instructions: options.instructions }),
		},
		options.identity,
		options.cache?.ttl ?? DEFAULT_MCP_CACHE_TTL,
		options.cache?.scope,
	)
}

/**
 * Build the MCP `initialize` result — the negotiated protocol version, the
 * advertised capabilities, and the server identity.
 *
 * @remarks
 * Version negotiation echoes the client's `requested` version when it is one of the
 * supported legacy revisions. A modern or unsupported request receives the newest
 * supported legacy revision; the client decides whether to continue.
 * `capabilities.tools` is an empty object — this server advertises the tools
 * capability with no sub-options (no list-changed notification yet).
 *
 * @param name - The server name (echoed in `serverInfo`)
 * @param version - The server version (echoed in `serverInfo`)
 * @param requested - The client's requested protocol version (negotiated when supported)
 * @returns The `initialize` result payload
 */
export function buildInitializeResult(
	name: string,
	version: string,
	requested?: string,
): Readonly<Record<string, unknown>> {
	const newestLegacy =
		SUPPORTED_PROTOCOL_VERSIONS.find((candidate) => inferEra(candidate) === 'legacy') ??
		MCP_LEGACY_VERSION
	const protocolVersion =
		isMCPVersion(requested) && inferEra(requested) === 'legacy' ? requested : newestLegacy
	return {
		protocolVersion,
		capabilities: { tools: {} },
		serverInfo: { name, version },
	}
}

// Held-open stream leaves — the two pure transformations that carry an
// {@link MCPStream} across the string boundary and onto a transport. Both consume the
// generator MANUALLY rather than with `for await`, because `for await` discards the
// `return` value and the terminating response IS that value.

/**
 * Serialize a typed {@link MCPStream} into its string mirror — each yielded
 * notification and the terminating response, already `JSON.stringify`d.
 *
 * @remarks
 * The string-boundary half of the held-open arm: `handle` returns this so a transport
 * writes each message with no second parse, exactly as it writes a unary reply string.
 * The terminating response arrives as the returned generator's OWN `return` value, so a
 * consumer distinguishes "one more notification" from "this is the answer" without a
 * sentinel.
 *
 * @param stream - The typed held-open result to serialize
 * @returns The same sequence with every message serialized to a string
 *
 * @example
 * ```ts
 * const text = serializeStream(stream)
 * for (let next = await text.next(); ; next = await text.next()) {
 * 	if (next.done === true) return next.value // the terminating response, serialized
 * 	log(next.value) // one serialized notification
 * }
 * ```
 */
export async function* serializeStream(stream: MCPStream): MCPTextStream {
	let next = await stream.next()
	while (!next.done) {
		yield JSON.stringify(next.value)
		next = await stream.next()
	}
	return JSON.stringify(next.value)
}

/**
 * Pump an {@link MCPTextStream} onto a transport — every notification in order, then the
 * terminating response.
 *
 * @remarks
 * The generator's `return` value is a message like any other on the wire: it is sent
 * LAST and closes the exchange. Sends are awaited one at a time so the transport
 * receives the sequence in the order the method produced it.
 *
 * @param stream - The serialized held-open result to write out
 * @param transport - The duplex channel to write each message to
 * @returns Resolves once the terminating response has been sent
 *
 * @example
 * ```ts
 * const answer = await server.handle(message)
 * if (typeof answer !== 'string') await sendStream(answer, transport)
 * ```
 */
export async function sendStream(
	stream: MCPTextStream,
	transport: MCPTransportInterface,
): Promise<void> {
	let next = await stream.next()
	while (!next.done) {
		await transport.send(next.value)
		next = await stream.next()
	}
	await transport.send(next.value)
}

// The environment-agnostic PORT binders — the keystone that lets an
// {@link MCPServerInterface} / {@link MCPClientInterface} run over ANY
// {@link MCPTransportInterface} (a Node stdio pair, a browser MessagePort, a Web
// Worker `self`) with no per-environment dispatch/correlation wiring duplicated at
// each face. Both are TOTAL: a `send` throw or rejection is caught and never
// escapes as an unhandled rejection.

/**
 * Pipe an {@link MCPTransportInterface} into an {@link MCPServerInterface} — every
 * inbound message runs through `server.handle`, and a defined reply is written back
 * via `transport.send`.
 *
 * @remarks
 * `server.handle` already turns a malformed message into a serialized `-32700` /
 * `-32600` reply and a notification into `undefined` (no reply), so this binder adds
 * no parsing of its own. A HELD-OPEN reply arrives as an
 * {@link import('./types.js').MCPTextStream} instead of a string: this is the one place
 * that pumps it, writing each notification in order and then the generator's returned
 * terminating response ({@link sendStream}). A `transport.send` throw or rejection —
 * mid-stream included — is caught and routed
 * to `server.emitter`'s `error` event (never rethrown, never an unhandled rejection);
 * a listener on that event that itself throws is swallowed (the end of the line —
 * the caller's own bug, never this binder's). The returned unbind DETACHES this
 * binder (further inbound messages and the transport's `closed` signal are ignored)
 * WITHOUT closing the transport — closing is the caller's decision.
 *
 * `listen`/`closed` are REPLACE semantics (§ port contract): the returned unbind
 * DETACHES by replacing this binder's own handlers with no-ops, so a subsequent
 * `bindServer` call on the SAME transport is never double-dispatched by a stale
 * subscription left behind — an unbind→rebind cycle yields exactly one reply per
 * request.
 *
 * @param server - The transport-agnostic server to dispatch inbound messages over
 * @param transport - The duplex channel to pipe the server over
 * @returns Detach this binder from the transport (does not close it)
 *
 * @example
 * ```ts
 * const unbind = bindServer(server, transport)
 * // ... later, detach without closing:
 * unbind()
 * ```
 */
export function bindServer(
	server: MCPServerInterface,
	transport: MCPTransportInterface,
): () => void {
	let active = true
	transport.listen(async (message) => {
		if (!active) return
		try {
			const answer = await server.handle(message)
			if (answer === undefined) return
			if (typeof answer === 'string') await transport.send(answer)
			else await sendStream(answer, transport)
		} catch (error) {
			try {
				server.emitter.emit('error', error)
			} catch {
				// A throwing `error` listener is the caller's own bug — the end of the line.
			}
		}
	})
	transport.closed(() => {
		active = false
	})
	return () => {
		active = false
		transport.listen(() => {})
		transport.closed(() => {})
	}
}

/**
 * Pipe an {@link MCPTransportInterface} into an {@link MCPClientInterface} — every
 * inbound message is decoded and delivered onto the client's OWN transport
 * (`client.transport.emitter`'s `message` / `close` events), resolving/rejecting the
 * client's correlated pending requests exactly as a direct reply would.
 *
 * @remarks
 * The client's outbound writes flow through `client.transport.send` — its existing,
 * unmodified request/response correlation — so `client` must have been constructed
 * with a {@link import('./types.js').ClientTransportInterface} that itself carries
 * the SAME `transport` (see {@link import('./factories.js').createDuplexClientTransport},
 * the additive factory that adapts an {@link MCPTransportInterface} into that shape);
 * this binder then completes the inbound half by decoding each message and pushing it
 * onto `client.transport.emitter` (an {@link import('@orkestrel/emitter').EmitterInterface}
 * exposes `emit`, so no client modification is needed). A malformed / non-JSON-RPC
 * inbound message is DROPPED (§14, total — never throws); a delivery fault is routed to
 * `client.transport.emitter`'s `error` event (never rethrown). The returned unbind
 * DETACHES this binder (further inbound messages and the transport's `closed` signal are
 * ignored) WITHOUT closing the transport.
 *
 * `listen`/`closed` are REPLACE semantics (§ port contract): the returned unbind
 * DETACHES by replacing this binder's own handlers with no-ops, so a subsequent
 * `bindClient` call on the SAME transport is never double-dispatched by a stale
 * subscription left behind — an unbind→rebind cycle delivers exactly one `message`
 * emit per inbound reply.
 *
 * @param client - The transport-agnostic client whose transport to deliver messages onto
 * @param transport - The duplex channel to pipe the client over
 * @returns Detach this binder from the transport (does not close it)
 *
 * @example
 * ```ts
 * const client = createMCPClient({ transport: createDuplexClientTransport(transport) })
 * const unbind = bindClient(client, transport)
 * await client.connect()
 * // ... later, detach without closing:
 * unbind()
 * ```
 */
export function bindClient(
	client: MCPClientInterface,
	transport: MCPTransportInterface,
): () => void {
	let active = true
	transport.listen((message) => {
		if (!active) return
		let parsed: unknown
		try {
			parsed = JSON.parse(message)
		} catch {
			return
		}
		const decoded = parseJSONRPCMessage(parsed)
		if (decoded === undefined) return
		try {
			client.transport.emitter.emit('message', decoded)
		} catch (error) {
			try {
				client.transport.emitter.emit('error', error)
			} catch {
				// A throwing `error` listener is the caller's own bug — the end of the line.
			}
		}
	})
	transport.closed(() => {
		if (!active) return
		active = false
		try {
			client.transport.emitter.emit('close')
		} catch {
			// A throwing `close` listener is the caller's own bug — the end of the line.
		}
	})
	return () => {
		active = false
		transport.listen(() => {})
		transport.closed(() => {})
	}
}
