import type {
	JSONRPCId,
	JSONRPCInvocation,
	JSONRPCNotification,
	JSONRPCRequest,
	JSONRPCResponse,
	MCPCallResult,
	MCPMethodOptions,
	MCPElicitSchema,
	MCPInputContext,
	MCPInputRound,
	MCPProgress,
	MCPProgressInterface,
	MCPServerEventMap,
	MCPStream,
	MCPSubscriptionFilter,
	MCPSubscriptionHandler,
	MCPTaskContext,
	MCPTaskDetail,
	MCPTextStream,
} from '@src/core'
import type { EmitterErrorHandler } from '@orkestrel/emitter'
import type { ToolManagerEventMap, ToolSuccess } from '@orkestrel/tool'
import {
	MCPFixtureCell,
	MemoryContinuation,
	MemoryPromptManager,
	MemoryCompletion,
	createRound,
	buildMixedCall,
	createServerProgress,
	createHeldMethod,
	drainStream,
	drainText,
	readStreamAnswer,
	readTextAnswer,
	createServerTools,
	createTestServer,
	readUnaryAnswer,
	readResultRecord,
	readStreamFault,
	readTextFault,
	buildModernCall,
	createFaultServer,
	createHandlerFaultServer,
	createSourceFaultServer,
	createIdleStream,
	createIdleSource,
	createModernFaults,
	createLegacyFaults,
	createInputProbe,
	buildFormCall,
	readInputRound,
	createSilentSource,
	readSealedState,
	buildTaskCall,
	buildTaskRequest,
	readCreatedTask,
	createTaskFixtureServer,
	createFixedTasks,
	createMutableTasks,
	createDeferredTasks,
	createGuessableTasks,
	readAbsentTask,
	createWatchedTasks,
	MCP_EVENTS,
	APPROVAL_FORM,
	MIXED_ROUND,
	MIXED_ANSWERS,
	FORM_METADATA,
	APPROVAL_SCHEMA,
	TASK_CAPABILITIES,
	TASK_METADATA,
	TASK_METHODS,
	createFaultContinuation,
	createStartFaultTasks,
	createStubbornTasks,
	createReadFaultTasks,
	createRecordedTasks,
	declineAsyncTask,
} from '../../setup.js'
import {
	bindClient,
	bindServer,
	createDuplexClientTransport,
	createMCPClient,
	buildJSONRPCResult,
	createMCPLegacy,
	createMCPServer,
	DEFAULT_MCP_CACHE_TTL,
	DEFAULT_MCP_LIMITS,
	EMPTY_MCP_ARGUMENTS,
	JSONRPC_INVALID_PARAMS,
	JSONRPC_INVALID_REQUEST,
	JSONRPC_METHOD_NOT_FOUND,
	JSONRPC_PARSE_ERROR,
	JSONRPC_INTERNAL_ERROR,
	JSONRPC_SERVER_ERROR,
	isJSONRPCErrorResponse,
	isMCPCompletionResult,
	isMCPInputResult,
	isMCPError,
	parseMCPInputState,
	MCP_EXTENSION_TASKS,
	MCP_META_CAPABILITIES,
	MCP_META_SERVER,
	MCP_META_SUBSCRIPTION,
	MCP_META_VERSION,
	MCP_HANDSHAKE_VERSION,
	MCP_MISSING_CAPABILITY,
	MCP_UNSUPPORTED_VERSION,
	MCPTextStreamController,
	SUPPORTED_MODERN_PROTOCOL_VERSIONS,
} from '@src/core'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createTool, createToolManager } from '@orkestrel/tool'
import {
	captureError,
	createRecorder,
	createRecorders,
	waitForAbort,
	waitForDelay,
} from '@orkestrel/test'
import {
	createAbortTools,
	createManualClock,
	createRegistrySubscription,
	createProducerScript,
	REGISTRY_CHANGES,
	createMemoryTransport,
	buildNestedRecord,
	createJSONRPCNotification,
	createJSONRPCRequest,
	createHostilePeer,
	createSubscriptionRequest,
	isMCPMethodHandler,
	MODERN_METADATA,
	MemoryResourceManager,
	modernRequest,
	TestTaskManager,
} from '../../setup.js'

// MCPServer is the transport-agnostic JSON-RPC 2.0 dispatch core that exposes a live
// ToolManager over MCP (a REAL ToolManager with real Tools, no mocks; no
// HTTP, no live model). Covers dispatch + handle for initialize (version negotiation,
// capabilities, serverInfo), ping, tools/list (parameters → inputSchema), tools/call
// (value round-trip, the isError tool mapping, missing-name → -32602), notifications
// (no id → no response; notifications/initialized), unknown method → -32601, handle's
// malformed-JSON → -32700 and non-request → -32600, plus the request event +
// observer-throw safety — and the modern METHOD SEAM: the built-ins registered on
// the same registry every dispatch resolves from, per-request options reaching a handler,
// and the held-open stream arm crossing both the typed and the string boundary.

// The one continuation fixture: a real integrity port over an in-process map, plus the
// observations an MRTR proof needs from it — the exact canonical payloads it was asked to
// seal, with a callback that lets a test advance its injected clock during sealing.

// The question every proof that does not care WHAT was asked asks.

// One round carrying a single form elicitation under `approval`. The key belongs to the
// CONSUMER now, so it is fixed here and read back by name rather than discovered from a round.

// One round of all three kinds at once — the shape the protocol permits and the mechanism
// could not express while it minted one key and issued one form.

// The client's answers to that round, one legal shape per kind.

// A `tools/call` from a client that declared every kind `MIXED_ROUND` asks for.

// A REAL held-open modern method (a genuine async generator, not a fake):
// two progress notifications, then the terminating response as the generator's `return`.

// The registered handler for it — an `MCPMethodHandler` whose answer is the stream arm. It
// narrows nothing: the seam carries the request arm, so `request.id` is always there.

// Drain a typed held-open answer into its yielded notifications and its terminating
// response — kept APART, because the terminating value is a `return`, not a `yield`, and
// that distinction is the contract under test.

// The string-boundary mirror of `drainStream`.

// Narrow a dispatch answer to its HELD-OPEN arm — the mirror of `responseOf`. The arm is
// the CONTROLLED contract, because dispatch wraps whatever a method produced.

// Narrow a `handle` answer to its held-open arm (a string is the unary arm).

// A real ToolManager seeded with deterministic stub tools: `echo` returns its args
// verbatim, `sum` adds two numbers (with a declared inputSchema), and `boom` throws
// (so the manager isolates the throw into a result error → an MCP isError result).

// Narrow a dispatch answer to its UNARY arm. `dispatch` now answers either a response or
// a held-open MCPStream; every method exercised below is unary, so a stream here is a
// defect and fails loudly rather than passing silently.

// Narrow a dispatch response to its `result` as a record (the MCP result payloads are
// always records) — a guard standing in for an assertion, no `as`.

// Real registry events drive the stream. The release proof retains independent recorders,
// so listener membership distinguishes the server's cleanup from a cleared emitter.
describe('MCPServer — registry notifications', () => {
	it('advances the consumer producer only on demand', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const writer = source.writable.getWriter()
		const resolved = createRecorder<readonly [number]>()
		const fixture = await createRegistrySubscription({
			notifications: { promptsListChanged: true },
			producer: () => source.readable,
		})
		const writes: Array<Promise<void>> = []
		try {
			await fixture.stream.next()
			for (const [index] of Array.from({ length: 32 }).entries()) {
				writes.push(
					writer
						.write({
							jsonrpc: '2.0',
							method: 'notifications/prompts/list_changed',
							params: { index },
						})
						.then(() => resolved.handler(index)),
				)
			}
			await waitForDelay(100)
			expect(resolved.calls).toEqual([[0]])
			for (const [index] of Array.from({ length: 32 }).entries()) {
				expect(await fixture.stream.next()).toMatchObject({
					done: false,
					value: { method: 'notifications/prompts/list_changed', params: { index } },
				})
			}
			await Promise.all(writes)
			expect(resolved.count).toBe(32)
			await writer.close()
		} finally {
			fixture.close()
			await writer.abort().catch(() => undefined)
			await Promise.allSettled(writes)
		}
	})

	it("releases the consumer producer with the stream's abort reason", async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const writer = source.writable.getWriter()
		const fixture = await createRegistrySubscription({
			notifications: { promptsListChanged: true },
			producer: () => source.readable,
		})
		const writes: Array<Promise<void>> = []
		try {
			await fixture.stream.next()
			for (const [index] of Array.from({ length: 3 }).entries()) {
				const write = writer.write({
					jsonrpc: '2.0',
					method: 'notifications/prompts/list_changed',
					params: { index },
				})
				writes.push(write)
				void write.catch(() => undefined)
			}
			// The parked write is the producer owner's view of the release: nothing reads the
			// stream, so this write is still outstanding when the request aborts, and what it
			// rejects with is whatever the server cancelled the source with.
			const parked = writer.write({
				jsonrpc: '2.0',
				method: 'notifications/prompts/list_changed',
				params: { index: 3 },
			})
			writes.push(parked)
			const settled = createRecorder<readonly [unknown]>()
			void parked.then(settled.handler, settled.handler)
			await waitForDelay(10)
			expect(settled.count).toBe(0)
			const reason = new Error('subscription released')
			fixture.controller.abort(reason)
			await expect(parked).rejects.toBe(reason)
		} finally {
			fixture.close()
			await writer.abort().catch(() => undefined)
			await Promise.allSettled(writes)
		}
	})

	it.each([new Error('private producer detail'), undefined])(
		'delivers the queued frame before the failure terminal whatever the producer threw (%s)',
		async (error) => {
			const fixture = await createRegistrySubscription({
				notifications: { promptsListChanged: true },
				producer: createProducerScript({
					frames: [{ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' }],
					failure: { error },
				}),
			})
			try {
				await fixture.stream.next()
				expect(await fixture.stream.next()).toMatchObject({
					done: false,
					value: { method: 'notifications/prompts/list_changed' },
				})
				expect(await fixture.stream.next()).toEqual({
					done: true,
					value: {
						jsonrpc: '2.0',
						id: 'registry',
						error: { code: JSONRPC_INTERNAL_ERROR, message: 'Server error' },
					},
				})
			} finally {
				fixture.close()
			}
		},
	)

	it.each([undefined, new Error('private producer detail')])(
		'ignores registry changes after the stream closed on a producer failure (%s)',
		async (error) => {
			const failures = createRecorder<Parameters<EmitterErrorHandler>>()
			const registry = createToolManager({ error: failures.handler })
			const mcp = createMCPServer({
				identity: { name: 'failed', version: '1' },
				tools: registry,
				subscription: {
					notifications: { promptsListChanged: true },
					producer: createProducerScript({ frames: [], failure: { error } }),
				},
			})
			const records = createRecorders<MCPServerEventMap, 'error'>(mcp.emitter, ['error'])
			const stream = await mcp.dispatch(
				createSubscriptionRequest('failed', { toolsListChanged: true, promptsListChanged: true }),
			)
			if (!(Symbol.asyncIterator in stream)) throw new Error('Expected a subscription stream')
			try {
				expect(await stream.next()).toMatchObject({
					done: false,
					value: { params: { notifications: { toolsListChanged: true } } },
				})
				await waitForDelay(10)
				expect(() => registry.clear()).not.toThrow()
				expect(failures.calls).toEqual([])
				expect(await stream.next()).toEqual({
					done: true,
					value: {
						jsonrpc: '2.0',
						id: 'failed',
						error: { code: JSONRPC_INTERNAL_ERROR, message: 'Server error' },
					},
				})
				expect(records.error.calls).toEqual([[error]])
			} finally {
				stream.stop()
				registry.destroy()
			}
		},
	)

	it('delivers queued notifications before a normal producer close', async () => {
		const mcp = createMCPServer({
			identity: { name: 'closing', version: '1' },
			tools: createToolManager(),
			subscription: {
				notifications: { promptsListChanged: true },
				producer: createProducerScript({
					frames: [{ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' }],
				}),
			},
		})
		const stream = await mcp.dispatch(
			createSubscriptionRequest('close', { promptsListChanged: true }),
		)
		if (!(Symbol.asyncIterator in stream)) throw new Error('Expected a subscription stream')
		try {
			await stream.next()
			await waitForDelay(10)
			expect(await stream.next()).toMatchObject({
				done: false,
				value: { method: 'notifications/prompts/list_changed' },
			})
			expect(await stream.next()).toMatchObject({
				done: true,
				value: { result: { resultType: 'complete' } },
			})
		} finally {
			stream.stop()
		}
	})

	it('coalesces registry changes while the last frame is unread', async () => {
		const fixture = await createRegistrySubscription()
		try {
			await fixture.stream.next()
			Array.from({ length: 32 }).forEach(() => {
				fixture.tools.add(createTool({ name: 'changing', execute: () => 'changed' }))
				fixture.tools.clear()
			})
			expect(await fixture.stream.next()).toMatchObject({
				done: false,
				value: { method: 'notifications/tools/list_changed' },
			})
			const delivered = createRecorder()
			const next = fixture.stream.next()
			void next.then(delivered.handler, () => undefined)
			await waitForDelay(10)
			expect(delivered.count).toBe(0)
			fixture.tools.clear()
			expect(await next).toMatchObject({
				done: false,
				value: { method: 'notifications/tools/list_changed' },
			})
			expect(delivered.count).toBe(1)
		} finally {
			fixture.close()
		}
	})

	it('acknowledges a tools subscription on a destroyed registry and produces nothing', async () => {
		const fixture = await createRegistrySubscription()
		fixture.tools.destroy()
		try {
			expect(await fixture.stream.next()).toMatchObject({
				done: false,
				value: { params: { notifications: { toolsListChanged: true } } },
			})
			expect(fixture.tools.emitter.count()).toBe(0)
			const delivered = createRecorder()
			const next = fixture.stream.next()
			void next.then(delivered.handler, () => undefined)
			await waitForDelay(10)
			expect(delivered.count).toBe(0)
			const reason = new Error('destroyed registry ended')
			fixture.controller.abort(reason)
			await expect(next).rejects.toBe(reason)
		} finally {
			fixture.close()
		}
	})

	it.each(REGISTRY_CHANGES.map(({ title, change }) => [title, change] as const))(
		'pushes tools/list_changed when the registry %s',
		async (_title, change) => {
			const fixture = await createRegistrySubscription()
			try {
				await fixture.stream.next()
				change(fixture.tools)
				expect(await fixture.stream.next()).toMatchObject({
					done: false,
					value: {
						method: 'notifications/tools/list_changed',
						params: { _meta: { [MCP_META_SUBSCRIPTION]: 'registry' } },
					},
				})
			} finally {
				fixture.close()
			}
		},
	)

	it('releases the registry subscription when the stream signal aborts', async () => {
		const fixture = await createRegistrySubscription()
		const records = createRecorders<ToolManagerEventMap, 'add' | 'remove' | 'clear'>(
			fixture.tools.emitter,
			['add', 'remove', 'clear'],
		)
		try {
			await fixture.stream.next()
			expect(fixture.tools.emitter.count('add')).toBe(2)
			expect(fixture.tools.emitter.count('remove')).toBe(2)
			expect(fixture.tools.emitter.count('clear')).toBe(2)
			const pending = fixture.stream.next()
			const reason = new Error('subscription ended')
			fixture.controller.abort(reason)
			await expect(pending).rejects.toBe(reason)
			expect(fixture.tools.emitter.count('add')).toBe(1)
			expect(fixture.tools.emitter.count('remove')).toBe(1)
			expect(fixture.tools.emitter.count('clear')).toBe(1)
			fixture.tools.clear()
			expect(records.clear.count).toBe(1)
		} finally {
			fixture.close()
		}
	})

	it('pumps a consumer producer beside the built-in tools family', async () => {
		const filters = createRecorder<readonly [MCPSubscriptionFilter]>()
		const fixture = await createRegistrySubscription({
			notifications: { promptsListChanged: true },
			producer: createProducerScript({
				filters,
				frames: [
					{ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' },
					{ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { foreign: true } },
				],
			}),
		})
		try {
			expect(await fixture.stream.next()).toMatchObject({
				value: { params: { notifications: { toolsListChanged: true, promptsListChanged: true } } },
			})
			expect(await fixture.stream.next()).toMatchObject({
				value: { method: 'notifications/prompts/list_changed' },
			})
			fixture.tools.clear()
			expect(await fixture.stream.next()).toEqual({
				done: false,
				value: {
					jsonrpc: '2.0',
					method: 'notifications/tools/list_changed',
					params: { _meta: { [MCP_META_SUBSCRIPTION]: 'registry' } },
				},
			})
			expect(filters.calls).toEqual([[{ toolsListChanged: true, promptsListChanged: true }]])
		} finally {
			fixture.close()
		}
	})

	it('refuses a consumer filter that claims the tools family or is malformed', () => {
		// Bypass the literal types to prove the runtime refusal a JavaScript caller reaches.
		const refusal =
			'The consumer filter must be a valid filter that omits tools changes, because the server produces that family from its registry'
		const claimed = captureError(() =>
			createMCPServer({
				identity: { name: 'invalid', version: '1' },
				tools: createToolManager(),
				subscription: {
					notifications: { ...Object.fromEntries([['toolsListChanged', true]]) },
					producer: createProducerScript({ frames: [] }),
				},
			}),
		)
		const malformed = captureError(() =>
			createMCPServer({
				identity: { name: 'malformed', version: '1' },
				tools: createToolManager(),
				subscription: {
					notifications: { ...Object.fromEntries([['promptsListChanged', 'yes']]) },
					producer: createProducerScript({ frames: [] }),
				},
			}),
		)
		expect(isMCPError(claimed)).toBe(true)
		expect(claimed).toMatchObject({ code: JSONRPC_INVALID_PARAMS, message: refusal })
		expect(isMCPError(malformed)).toBe(true)
		expect(malformed).toMatchObject({ code: JSONRPC_INVALID_PARAMS, message: refusal })
	})

	it('advertises tools.listChanged', async () => {
		const mcp = createMCPServer({
			identity: { name: 'discovery', version: '1' },
			tools: createToolManager(),
		})
		expect(await mcp.dispatch(modernRequest('server/discover'))).toMatchObject({
			result: { capabilities: { tools: { listChanged: true } } },
		})
	})

	it('delivers the final clear from registry destruction and waits for the stream signal', async () => {
		const fixture = await createRegistrySubscription()
		try {
			await fixture.stream.next()
			fixture.tools.destroy()
			expect(await fixture.stream.next()).toMatchObject({
				done: false,
				value: { method: 'notifications/tools/list_changed' },
			})
			expect(fixture.tools.emitter.destroyed).toBe(true)
			expect(fixture.tools.emitter.count()).toBe(0)
			fixture.tools.add(createTool({ name: 'silent', execute: () => 'silent' }))
			const pending = fixture.stream.next()
			const reason = new Error('destroyed registry stream ended')
			fixture.controller.abort(reason)
			await expect(pending).rejects.toBe(reason)
		} finally {
			fixture.close()
		}
	})

	it('delivers tools changes while the consumer producer is parked and releases on stop', async () => {
		const signals = createRecorder<readonly [AbortSignal]>()
		const fixture = await createRegistrySubscription({
			notifications: { promptsListChanged: true },
			producer: createProducerScript({
				signals,
				frames: [{ jsonrpc: '2.0', method: 'notifications/prompts/list_changed' }],
				park: true,
			}),
		})
		try {
			await fixture.stream.next()
			expect(await fixture.stream.next()).toMatchObject({
				value: { method: 'notifications/prompts/list_changed' },
			})
			fixture.tools.clear()
			expect(await fixture.stream.next()).toMatchObject({
				done: false,
				value: { method: 'notifications/tools/list_changed' },
			})
			fixture.tools.clear()
			expect(await fixture.stream.next()).toMatchObject({
				done: false,
				value: { method: 'notifications/tools/list_changed' },
			})
			fixture.stream.stop()
			expect(signals.calls[0]?.[0].aborted).toBe(true)
			expect(fixture.tools.emitter.count()).toBe(0)
		} finally {
			fixture.close()
		}
	})
})

describe('MCPServer — hostile-input and live-resource limits over the wire', () => {
	it('publishes frozen secure defaults sized for ordinary MCP traffic', () => {
		expect(DEFAULT_MCP_LIMITS).toEqual({
			message: 1_048_576,
			metadata: 16_384,
			keys: 64,
			state: 16_384,
			content: 4_194_304,
			subscriptions: 128,
			depth: 32,
		})
		expect(Object.isFrozen(DEFAULT_MCP_LIMITS)).toBe(true)
	})

	it('rejects an oversized valid wire message as -32700 before parsing it', async () => {
		const mcp = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: createServerTools(),
			limit: { message: 32 },
		})
		const peer = createHostilePeer(mcp)

		await peer.send('{"jsonrpc":"2.0","method":"ping","id":1}')

		expect(peer.response()?.error?.code).toBe(JSONRPC_PARSE_ERROR)
		peer.close()
	})

	it('applies metadata bounds to translated requests and rejects byte and key overflow', async () => {
		const absentServer = createMCPLegacy(
			createMCPServer({
				identity: { name: 'bounded', version: '1.0.0' },
				tools: createServerTools(),
				limit: { metadata: 0 },
			}),
		)
		const absentMessage = await absentServer.dispatch(
			createJSONRPCRequest({ method: 'tools/list' }),
		)
		const absent = readUnaryAnswer(absentMessage)
		expect(absent?.error?.code).toBe(JSONRPC_INVALID_PARAMS)

		const sizeServer = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: createServerTools(),
			limit: { metadata: 180 },
		})
		const sizePeer = createHostilePeer(sizeServer)
		await sizePeer.send(
			JSON.stringify(
				createJSONRPCRequest({
					method: 'tools/list',
					params: {
						_meta: {
							...MODERN_METADATA,
							padding: 'x'.repeat(200),
						},
					},
				}),
			),
		)
		expect(sizePeer.response()?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		sizePeer.close()

		const keyServer = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: createServerTools(),
			limit: { metadata: 1_024, keys: 2 },
		})
		const keyPeer = createHostilePeer(keyServer)
		await keyPeer.send(
			JSON.stringify(
				createJSONRPCRequest({
					method: 'tools/list',
					params: { _meta: { ...MODERN_METADATA, extension: true } },
				}),
			),
		)
		expect(keyPeer.response()?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		keyPeer.close()
	})

	it('rejects prototype-pollution metadata sent by a real peer', async () => {
		const mcp = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: createServerTools(),
		})
		const peer = createHostilePeer(mcp)
		await peer.send(
			'{"jsonrpc":"2.0","method":"tools/list","id":1,"params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"__proto__":true}}}',
		)

		expect(peer.response()?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		peer.close()
	})

	it('accepts absent requestState and bounds it before verification and after signing', async () => {
		const absent = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: createServerTools(),
			limit: { state: 0 },
			input: {
				continuation: new MemoryContinuation(),
				ttl: 60_000,
				principal: () => 'user-1',
				selector: () => undefined,
			},
		})
		const absentResponse = readUnaryAnswer(
			await absent.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: { name: 'echo', _meta: MODERN_METADATA },
				}),
			),
		)
		expect(readResultRecord(absentResponse)['resultType']).toBe('complete')

		const incoming = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: createServerTools(),
			limit: { state: 64 },
			input: {
				continuation: new MemoryContinuation(),
				ttl: 60_000,
				principal: () => 'user-1',
				selector: () => undefined,
			},
		})
		const incomingPeer = createHostilePeer(incoming)
		await incomingPeer.send(
			JSON.stringify(
				createJSONRPCRequest({
					method: 'tools/call',
					params: {
						name: 'echo',
						inputResponses: {},
						requestState: 'x'.repeat(65),
						_meta: MODERN_METADATA,
					},
				}),
			),
		)
		expect(incomingPeer.response()?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		incomingPeer.close()

		const outgoing = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: createServerTools(),
			limit: { state: 256 },
			input: {
				continuation: new MemoryContinuation(),
				ttl: 60_000,
				principal: () => 'user-1',
				selector: () => createRound(APPROVAL_FORM, 'x'.repeat(512)),
			},
		})
		const outgoingPeer = createHostilePeer(outgoing)
		await outgoingPeer.send(
			JSON.stringify(
				createJSONRPCRequest({
					method: 'tools/call',
					params: {
						name: 'echo',
						arguments: {},
						_meta: {
							[MCP_META_VERSION]: '2026-07-28',
							[MCP_META_CAPABILITIES]: { elicitation: {} },
						},
					},
				}),
			),
		)
		expect(outgoingPeer.response()?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		outgoingPeer.close()

		const signed = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: createServerTools(),
			limit: { state: 150 },
			input: {
				continuation: new MemoryContinuation(),
				ttl: 60_000,
				principal: () => 'user-1',
				selector: () => createRound(),
			},
		})
		const signedPeer = createHostilePeer(signed)
		await signedPeer.send(
			JSON.stringify(
				createJSONRPCRequest({
					method: 'tools/call',
					params: {
						name: 'echo',
						_meta: {
							[MCP_META_VERSION]: '2026-07-28',
							[MCP_META_CAPABILITIES]: { elicitation: {} },
						},
					},
				}),
			),
		)
		expect(signedPeer.response()?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		signedPeer.close()
	})

	it('routes oversized legacy tool content through the modern -32603 pipeline', async () => {
		const manager = createToolManager()
		manager.add(createTool({ name: 'large', execute: () => 'x'.repeat(32) }))
		const mcp = createMCPLegacy(
			createMCPServer({
				identity: { name: 'bounded', version: '1.0.0' },
				tools: manager,
				limit: { content: 16 },
			}),
		)
		const answer = await mcp.dispatch(
			createJSONRPCRequest({ method: 'tools/call', params: { name: 'large' } }),
		)
		if (Symbol.asyncIterator in answer) throw new Error('Legacy tools/call held open')

		expect(answer.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
	})

	it('admits only the configured number of live subscription streams and releases on close', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const writer = source.writable.getWriter()
		const mcp = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: createServerTools(),
			limit: { subscriptions: 1 },
			subscription: {
				notifications: { promptsListChanged: true },
				producer: () => source.readable,
			},
		})
		const peer = createHostilePeer(mcp)
		const params = {
			notifications: { promptsListChanged: true },
			_meta: MODERN_METADATA,
		}

		await peer.send(
			JSON.stringify(createJSONRPCRequest({ method: 'subscriptions/listen', id: 'first', params })),
		)
		await peer.send(
			JSON.stringify(
				createJSONRPCRequest({ method: 'subscriptions/listen', id: 'second', params }),
			),
		)

		expect(peer.response()?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(peer.responses().some((message) => 'method' in message)).toBe(true)
		await writer.close()
		await waitForDelay()
		peer.clear()
		await peer.send(
			JSON.stringify(createJSONRPCRequest({ method: 'subscriptions/listen', id: 'third', params })),
		)
		expect(peer.responses().some((message) => 'method' in message)).toBe(true)
		peer.close()
	})
})

describe('MCPServer — published limits', () => {
	it('publishes every resolved bound, with the defaults for each omitted leaf', () => {
		const mcp = createTestServer()

		expect(mcp.limit).toEqual(DEFAULT_MCP_LIMITS)
	})

	it('publishes the configured value and sanitizes a hostile one back to its default', () => {
		const mcp = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: createServerTools(),
			limit: { message: 4096, subscriptions: Number.NaN },
		})

		expect(mcp.limit.message).toBe(4096)
		expect(mcp.limit.subscriptions).toBe(DEFAULT_MCP_LIMITS.subscriptions)
	})

	// Published state that a consumer could move under a check that already ran would be a
	// bound in name only, so the object is frozen rather than merely typed readonly.
	it('is frozen, so a bound cannot be moved out from under the checks that read it', () => {
		const mcp = createTestServer()

		expect(Object.isFrozen(mcp.limit)).toBe(true)
		expect(mcp.limit).toBe(mcp.limit)
	})
})

// The subscription CLOSURE claim, pinned as a conformance claim rather than left implied.
// The cancellation page and the subscriptions page of the dated revision disagree about how a
// server ends a `subscriptions/listen` exchange: the cancellation page says it MUST send `notifications/cancelled` naming the
// listen request, while the subscriptions page it cites as its authority says the createTestServer
// `SHOULD` send the empty `subscriptions/listen` RESULT and attributes the notification to the
// client alone. The schema carries no subscription-specific variant, so it corroborates
// neither. This server implements the page that owns the mechanism, and this test is what
// keeps a later reader from "fixing" it toward the other one.
describe('MCPServer — graceful subscription closure', () => {
	it('ends a gracefully closed subscription with the empty result, correlated by the listen id', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const writer = source.writable.getWriter()
		const mcp = createTestServer(undefined, {
			notifications: { promptsListChanged: true },
			producer: () => source.readable,
		})
		const stream = readStreamAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'subscriptions/listen',
					id: 'listen-close',
					params: { notifications: { promptsListChanged: true }, _meta: MODERN_METADATA },
				}),
			),
		)
		const acknowledgement = await stream.next()
		if (acknowledgement.done) throw new Error('expected a subscription acknowledgement')

		await writer.close()
		const [messages, terminal] = await drainStream(stream)

		expect(terminal).toEqual({
			jsonrpc: '2.0',
			id: 'listen-close',
			result: {
				resultType: 'complete',
				_meta: {
					[MCP_META_SUBSCRIPTION]: 'listen-close',
					[MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' },
				},
			},
		})
		// And NOT the notification the cancellation page asks for: the mechanism is the result.
		expect(
			[acknowledgement.value, ...messages].filter(
				(message) => message.method === 'notifications/cancelled',
			),
		).toEqual([])
	})
})

describe('MCPServer — identity', () => {
	it('exposes the name and version from options', () => {
		const mcp = createTestServer()

		expect(mcp.identity.name).toBe('test-server')
		expect(mcp.identity.version).toBe('1.2.3')
	})
})

describe('MCPServer — modern-and-legacy dispatch', () => {
	it('answers a legacy initialize on the bare modern server as an unregistered method', async () => {
		const mcp = createMCPServer({
			identity: { name: 'modern-server', version: '2.0.0' },
			tools: createServerTools(),
		})
		const response = readUnaryAnswer(
			await mcp.dispatch(createJSONRPCRequest({ method: 'initialize' })),
		)

		expect(response?.error).toEqual({
			code: JSONRPC_METHOD_NOT_FOUND,
			message: 'Method not found: initialize',
		})
		expect(await mcp.handle('{"jsonrpc":"2.0","method":"initialize","id":2}')).toBe(
			'{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"Method not found: initialize"}}',
		)
	})

	it('names the absent protocol version on a registered modern method', async () => {
		const mcp = createMCPServer({
			identity: { name: 'modern-server', version: '2.0.0' },
			tools: createServerTools(),
		})
		const response = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'tools/list',
					params: { _meta: { [MCP_META_CAPABILITIES]: {} } },
				}),
			),
		)

		expect(response?.error).toEqual({
			code: JSONRPC_INVALID_PARAMS,
			message: 'Invalid params: request declares no protocol version',
		})
	})

	it('keeps the legacy method responses byte-identical and unstamped', async () => {
		const mcp = createTestServer()

		expect(await mcp.handle('{"jsonrpc":"2.0","method":"initialize","id":1}')).toBe(
			'{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"test-server","version":"1.2.3"}}}',
		)
		expect(await mcp.handle('{"jsonrpc":"2.0","method":"ping","id":2}')).toBe(
			'{"jsonrpc":"2.0","id":2,"result":{}}',
		)
		expect(await mcp.handle('{"jsonrpc":"2.0","method":"tools/list","id":3}')).toBe(
			'{"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"echo","inputSchema":{"type":"object"}},{"name":"sum","inputSchema":{"type":"object","properties":{"a":{"type":"number"},"b":{"type":"number"}}},"description":"Add two numbers"},{"name":"boom","inputSchema":{"type":"object"}}]}}',
		)
		expect(
			await mcp.handle(
				'{"jsonrpc":"2.0","method":"tools/call","id":4,"params":{"name":"sum","arguments":{"a":2,"b":5}}}',
			),
		).toBe(
			'{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"7"}],"structuredContent":7}}',
		)
	})

	it('rejects malformed modern metadata with -32602', async () => {
		const response = readUnaryAnswer(
			await createTestServer().dispatch(
				createJSONRPCRequest({
					method: 'tools/list',
					params: { _meta: { [MCP_META_VERSION]: '2026-07-28' } },
				}),
			),
		)

		expect(response?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(response?.error?.message).toBe('Invalid params: malformed modern request metadata')
	})

	it('treats a present non-string version as modern and rejects it with -32602', async () => {
		const mcp = createTestServer()
		const events = createRecorders<MCPServerEventMap, (typeof MCP_EVENTS)[number]>(
			mcp.emitter,
			MCP_EVENTS,
		)
		const response = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'tools/list',
					params: {
						_meta: {
							[MCP_META_VERSION]: 7,
							[MCP_META_CAPABILITIES]: {},
						},
					},
				}),
			),
		)

		expect(response?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(events.request.calls).toEqual([['tools/list', 1, 'modern']])
	})

	it('rejects an unsupported modern version with -32022 and exact retry data', async () => {
		const response = readUnaryAnswer(
			await createTestServer().dispatch(
				createJSONRPCRequest({
					method: 'tools/list',
					params: {
						_meta: {
							[MCP_META_VERSION]: '2099-01-01',
							[MCP_META_CAPABILITIES]: {},
						},
					},
				}),
			),
		)

		expect(response?.error?.code).toBe(MCP_UNSUPPORTED_VERSION)
		expect(response?.error?.data).toEqual({
			supported: SUPPORTED_MODERN_PROTOCOL_VERSIONS,
			requested: '2099-01-01',
		})
	})

	it('returns a stamped cacheable server/discover result', async () => {
		const identity = { name: 'modern-server', version: '2.0.0' }
		const mcp = createMCPServer({
			identity,
			tools: createServerTools(),
			instructions: 'Use the available tools.',
			cache: { ttl: 123, scope: 'public' },
		})
		const response = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'server/discover',
					params: { _meta: MODERN_METADATA },
				}),
			),
		)

		expect(response?.result).toEqual({
			supportedVersions: SUPPORTED_MODERN_PROTOCOL_VERSIONS,
			capabilities: { tools: { listChanged: true } },
			instructions: 'Use the available tools.',
			resultType: 'complete',
			ttlMs: 123,
			cacheScope: 'public',
			_meta: { [MCP_META_SERVER]: identity },
		})
	})

	it('returns a stamped cacheable modern tools/list result', async () => {
		const response = readUnaryAnswer(
			await createTestServer().dispatch(
				createJSONRPCRequest({
					method: 'tools/list',
					params: { _meta: MODERN_METADATA },
				}),
			),
		)
		const result = readResultRecord(response)

		expect(result['resultType']).toBe('complete')
		expect(result['ttlMs']).toBe(DEFAULT_MCP_CACHE_TTL)
		expect(result['cacheScope']).toBe('private')
		expect(result['_meta']).toEqual({
			[MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' },
		})
		expect(result['tools']).toHaveLength(3)
	})

	it('returns a stamped non-cacheable modern tools/call result', async () => {
		const response = readUnaryAnswer(
			await createTestServer().dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: {
						name: 'sum',
						arguments: { a: 2, b: 5 },
						_meta: MODERN_METADATA,
					},
				}),
			),
		)
		const result = readResultRecord(response)

		expect(result['content']).toEqual([{ type: 'text', text: '7' }])
		expect(result['structuredContent']).toBe(7)
		expect(result['resultType']).toBe('complete')
		expect(result['_meta']).toEqual({
			[MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' },
		})
		expect(result['ttlMs']).toBeUndefined()
		expect(result['cacheScope']).toBeUndefined()
	})

	it('keeps a value-less modern tools/call result valid and omits structured content', async () => {
		const manager = createToolManager()
		manager.add(createTool({ name: 'noop', execute: () => undefined }))
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: manager,
			limit: { content: 512 },
		})
		const response = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: { name: 'noop', _meta: MODERN_METADATA },
				}),
			),
		)
		const result = readResultRecord(response)

		expect(result['content']).toEqual([{ type: 'text', text: '' }])
		expect(result['resultType']).toBe('complete')
		expect(Object.hasOwn(result, 'structuredContent')).toBe(false)
		expect(Object.hasOwn(result, 'ttlMs')).toBe(false)
	})

	it.each(['initialize', 'does/not/exist'])(
		'returns -32601 for modern method %s',
		async (method) => {
			const response = readUnaryAnswer(
				await createTestServer().dispatch(
					createJSONRPCRequest({ method, params: { _meta: MODERN_METADATA } }),
				),
			)

			expect(response?.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
		},
	)

	it('refuses modern ping because the modern revision removed it', async () => {
		const response = readUnaryAnswer(await createTestServer().dispatch(modernRequest('ping')))

		expect(response?.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
	})

	it('returns no response for a modern notification after emitting its era', async () => {
		const mcp = createTestServer()
		const events = createRecorders<MCPServerEventMap, (typeof MCP_EVENTS)[number]>(
			mcp.emitter,
			MCP_EVENTS,
		)
		const response = readUnaryAnswer(
			await mcp.dispatch({
				jsonrpc: '2.0',
				method: 'tools/list',
				params: { _meta: MODERN_METADATA },
			}),
		)

		expect(response).toBeUndefined()
		expect(events.request.calls).toEqual([['tools/list', undefined, 'modern']])
	})
})

describe('MCPServer — W01 modern execution and progress', () => {
	it('rejects every present non-record modern arguments value before policy or execution', async () => {
		const selections = new MCPFixtureCell(0)
		const executions = new MCPFixtureCell(0)
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			execution: () => {
				executions.value += 1
				return { resultType: 'complete', content: [{ type: 'text', text: 'unexpected' }] }
			},
			input: {
				continuation: new MemoryContinuation(),
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: () => {
					selections.value += 1
					return undefined
				},
			},
		})

		for (const argumentsValue of [null, [], 'invalid', 1]) {
			const answer = readUnaryAnswer(
				await mcp.dispatch(
					createJSONRPCRequest({
						method: 'tools/call',
						params: {
							name: 'echo',
							arguments: argumentsValue,
							_meta: MODERN_METADATA,
						},
					}),
				),
			)
			expect(answer?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		}
		expect(selections.value).toBe(0)
		expect(executions.value).toBe(0)
	})

	it('returns an explicitly produced complete rich result without guessing through ToolManager', async () => {
		const manager = createToolManager()
		manager.add(createTool({ name: 'rich', execute: () => ({ type: 'text', text: 'domain' }) }))
		const rich: MCPCallResult = {
			resultType: 'complete',
			content: [
				{ type: 'text', text: 'hello', annotations: { audience: ['assistant'], priority: 1 } },
				{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
				{ type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/mpeg' },
				{
					type: 'resource_link',
					name: 'guide',
					title: 'Guide',
					icons: [{ src: 'data:image/png;base64,aWNvbg==', sizes: ['16x16'], theme: 'dark' }],
					uri: 'resource://guide',
					description: 'The guide',
					mimeType: 'text/markdown',
					size: 12,
				},
				{
					type: 'resource',
					resource: { uri: 'resource://embedded', mimeType: 'text/plain', text: 'embedded' },
				},
			],
			structuredContent: ['array', 1, true, null],
		}
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: manager,
			execution: ({ request, call, tools: received, signal, progress: reporter }) => {
				expect(request.method).toBe('tools/call')
				expect(call.name).toBe('rich')
				expect(received).toBe(manager)
				expect(signal.aborted).toBe(false)
				expect(reporter).toBeUndefined()
				return rich
			},
		})

		const response = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: { name: 'rich', _meta: MODERN_METADATA },
				}),
			),
		)

		expect(response?.result).toEqual(rich)
	})

	it('contains rejected execution and malformed runtime executor results as detail-free errors', async () => {
		const valid: MCPCallResult = {
			resultType: 'complete',
			content: [{ type: 'text', text: 'valid target' }],
		}
		const rejected = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			execution: async () => {
				throw new Error('provider detail must not escape')
			},
		})
		const rejectedAnswer = readUnaryAnswer(
			await rejected.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: { name: 'echo', _meta: MODERN_METADATA },
				}),
			),
		)
		expect(rejectedAnswer?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(rejectedAnswer?.error?.message).not.toContain('provider detail')

		for (const runtime of [null, 7, { success: true }]) {
			const execution = new Proxy(() => valid, { apply: () => runtime })
			const mcp = createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: createServerTools(),
				execution,
			})
			const answer = readUnaryAnswer(
				await mcp.dispatch(
					createJSONRPCRequest({
						method: 'tools/call',
						params: { name: 'echo', _meta: MODERN_METADATA },
					}),
				),
			)
			expect(answer?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		}
	})

	it('keeps modern Tool text and structured content on one owned observation', async () => {
		const valueReads = new MCPFixtureCell(0)
		const target: ToolSuccess = { id: 'call', name: 'probe', success: true, value: { count: 1 } }
		const result = new Proxy(target, {
			getOwnPropertyDescriptor(source, property) {
				const descriptor = Reflect.getOwnPropertyDescriptor(source, property)
				if (property !== 'value' || descriptor === undefined) return descriptor
				valueReads.value += 1
				return {
					...descriptor,
					value: { count: valueReads.value },
				}
			},
		})
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			execution: () => result,
		})

		const answer = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: { name: 'probe', _meta: MODERN_METADATA },
				}),
			),
		)
		const payload = readResultRecord(answer)

		expect(payload['content']).toEqual([{ type: 'text', text: '{"count":1}' }])
		expect(payload['structuredContent']).toEqual({ count: 1 })
		expect(valueReads.value).toBe(1)
	})

	it('returns an owned explicit MCP result and bounds produced content before stamping', async () => {
		const structured = { status: 'first' }
		const explicit: MCPCallResult = {
			resultType: 'complete',
			content: [{ type: 'text', text: 'owned' }],
			structuredContent: structured,
		}
		const owned = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			execution: () => explicit,
		})
		const answer = readUnaryAnswer(
			await owned.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: { name: 'probe', _meta: MODERN_METADATA },
				}),
			),
		)
		structured.status = 'changed'

		expect(answer?.result).toEqual({
			resultType: 'complete',
			content: [{ type: 'text', text: 'owned' }],
			structuredContent: { status: 'first' },
		})
		expect(Object.isFrozen(answer?.result)).toBe(true)

		const bounded = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			limit: { content: 100 },
			execution: () => ({ id: 'call', name: 'probe', success: true, value: 1 }),
		})
		const boundedAnswer = readUnaryAnswer(
			await bounded.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: { name: 'probe', _meta: MODERN_METADATA },
				}),
			),
		)
		expect(boundedAnswer?.result).toEqual({
			resultType: 'complete',
			content: [{ type: 'text', text: '1' }],
			structuredContent: 1,
			_meta: { [MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' } },
		})
	})

	it('refuses non-finite results uniformly through the modern pipeline', async () => {
		const manager = createToolManager()
		manager.add(
			createTool({
				name: 'nonfinite',
				execute: () => ({
					top: Number.NaN,
					nested: [Number.POSITIVE_INFINITY, { value: Number.NEGATIVE_INFINITY }],
				}),
			}),
		)
		const modernServer = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: manager,
		})
		const mcp = createMCPLegacy(modernServer)

		expect(
			await mcp.handle(
				'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nonfinite"}}',
			),
		).toBe(
			'{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"Server execution returned an invalid tool result"}}',
		)
		const modern = readUnaryAnswer(
			await modernServer.dispatch(
				createJSONRPCRequest({
					id: 2,
					method: 'tools/call',
					params: { name: 'nonfinite', _meta: MODERN_METADATA },
				}),
			),
		)
		expect(modern?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
	})

	it('keeps the collapsed pipeline bounded and inert over hostile tool values', async () => {
		const getterCalls = new MCPFixtureCell(0)
		const cycle: Record<string, unknown> = {}
		cycle['self'] = cycle
		const accessor = Object.defineProperty({}, 'value', {
			enumerable: true,
			get() {
				getterCalls.value += 1
				return Number.NaN
			},
		})
		const manager = createToolManager()
		manager.add(createTool({ name: 'cycle', execute: () => cycle }))
		manager.add(createTool({ name: 'accessor', execute: () => accessor }))
		const mcp = createMCPLegacy(
			createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: manager,
			}),
		)

		for (const name of ['cycle', 'accessor']) {
			const answerMessage = await mcp.dispatch(
				createJSONRPCRequest({ method: 'tools/call', params: { name } }),
			)
			const answer = readUnaryAnswer(answerMessage)
			expect(answer?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		}
		expect(getterCalls.value).toBe(0)
	})

	it('yields backpressured progress on the original call stream before its terminal result', async () => {
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			execution: async ({ progress: reporter }) => {
				if (reporter === undefined) throw new Error('expected progress reporter')
				await reporter.report({ progress: 1, total: 2, message: 'halfway' })
				return { resultType: 'complete', content: [{ type: 'text', text: 'done' }] }
			},
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				id: 'progress-call',
				method: 'tools/call',
				params: {
					name: 'echo',
					_meta: { ...MODERN_METADATA, progressToken: 'opaque-progress' },
				},
			}),
		)
		if (answer === undefined || !('next' in answer)) throw new Error('expected progress stream')

		const [notifications, terminal] = await drainStream(answer)

		expect(notifications).toEqual([
			{
				jsonrpc: '2.0',
				method: 'notifications/progress',
				params: {
					progressToken: 'opaque-progress',
					progress: 1,
					total: 2,
					message: 'halfway',
				},
			},
		])
		expect(terminal.result).toEqual({
			resultType: 'complete',
			content: [{ type: 'text', text: 'done' }],
		})
	})

	it('keeps the normal ToolManager path unary and executes it exactly once despite a token', async () => {
		const executions = new MCPFixtureCell(0)
		const manager = createToolManager()
		manager.add(
			createTool({
				name: 'once',
				execute: () => {
					executions.value += 1
					return executions.value
				},
			}),
		)
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: manager,
		})

		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'tools/call',
				params: {
					name: 'once',
					_meta: { ...MODERN_METADATA, progressToken: 7 },
				},
			}),
		)

		expect(readUnaryAnswer(answer)?.result).toMatchObject({ structuredContent: 1 })
		expect(executions.value).toBe(1)
	})

	it('rejects a repeated progress value explicitly', async () => {
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			execution: async ({ progress: reporter }) => {
				if (reporter === undefined) throw new Error('expected progress reporter')
				await reporter.report({ progress: 1 })
				await reporter.report({ progress: 1 })
				return { resultType: 'complete', content: [{ type: 'text', text: 'unreachable' }] }
			},
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				id: 'strict-progress',
				method: 'tools/call',
				params: {
					name: 'echo',
					_meta: { ...MODERN_METADATA, progressToken: 'strict' },
				},
			}),
		)
		if (answer === undefined || !('next' in answer)) throw new Error('expected progress stream')

		const [notifications, terminal] = await drainStream(answer)
		expect(notifications).toMatchObject([{ method: 'notifications/progress' }])
		expect(terminal.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
	})

	it('rejects invalid and oversized progress before yielding it', async () => {
		const invalid = new Proxy<MCPProgress>(
			{ progress: 1, message: 'valid' },
			{
				getOwnPropertyDescriptor(target, property) {
					if (property !== 'message') return Reflect.getOwnPropertyDescriptor(target, property)
					return { configurable: true, enumerable: true, value: 7, writable: true }
				},
			},
		)
		const scenarios: ReadonlyArray<readonly [MCPProgress, number]> = [
			[invalid, 128],
			[{ progress: 1, message: 'x'.repeat(64) }, 32],
		]
		for (const [payload, content] of scenarios) {
			const mcp = createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: createServerTools(),
				limit: { content },
				execution: async ({ progress: reporter }) => {
					if (reporter === undefined) throw new Error('expected progress reporter')
					await reporter.report(payload)
					return { resultType: 'complete', content: [{ type: 'text', text: 'unexpected' }] }
				},
			})
			const answer = readStreamAnswer(
				await mcp.dispatch(
					createJSONRPCRequest({
						method: 'tools/call',
						params: {
							name: 'echo',
							_meta: { ...MODERN_METADATA, progressToken: 'bounded' },
						},
					}),
				),
			)
			const [notifications, terminal] = await drainStream(answer)
			expect(notifications).toEqual([])
			expect(terminal.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		}
	})

	it('rejects a fractional progress token before tool execution', async () => {
		const executions = new MCPFixtureCell(0)
		const reporter = new MCPFixtureCell<MCPProgressInterface | undefined>(undefined)
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			execution: ({ progress: progressReporter }) => {
				executions.value += 1
				reporter.value = progressReporter
				return { resultType: 'complete', content: [{ type: 'text', text: 'done' }] }
			},
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'tools/call',
				params: {
					name: 'echo',
					_meta: { ...MODERN_METADATA, progressToken: 1.5 },
				},
			}),
		)

		expect(readUnaryAnswer(answer)?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(reporter.value).toBeUndefined()
		expect(executions.value).toBe(0)
	})

	it('completes one explicit valid-token execution that reports no progress', async () => {
		const executions = new MCPFixtureCell(0)
		const reporter = new MCPFixtureCell<MCPProgressInterface | undefined>(undefined)
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			execution: ({ progress: progressReporter }) => {
				executions.value += 1
				reporter.value = progressReporter
				return { resultType: 'complete', content: [{ type: 'text', text: 'done' }] }
			},
		})
		const answer = readStreamAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: {
						name: 'echo',
						_meta: { ...MODERN_METADATA, progressToken: 2 },
					},
				}),
			),
		)
		const [notifications, terminal] = await drainStream(answer)

		expect(notifications).toEqual([])
		expect(terminal.result).toMatchObject({ resultType: 'complete' })
		expect(reporter.value).toBeDefined()
		expect(executions.value).toBe(1)
	})

	it('settles an active progress stream and stops reports on external abort', async () => {
		const controller = new AbortController()
		const reporter = new MCPFixtureCell<MCPProgressInterface | undefined>(undefined)
		const signal = new MCPFixtureCell<AbortSignal | undefined>(undefined)
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			execution: ({ progress: progressReporter, signal: received }) => {
				reporter.value = progressReporter
				signal.value = received
				return new Promise(() => undefined)
			},
		})
		const answer = readStreamAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: {
						name: 'echo',
						_meta: { ...MODERN_METADATA, progressToken: 'abort' },
					},
				}),
				{ signal: controller.signal },
			),
		)
		const pending = answer.next()
		await waitForDelay()
		controller.abort(new Error('request aborted'))
		if (reporter.value === undefined) throw new Error('expected captured reporter')
		const late = reporter.value.report({ progress: 1 })

		await expect(pending).rejects.toThrow('request aborted')
		await expect(late).rejects.toThrow('Progress reporter is stopped')
		expect(signal.value?.aborted).toBe(true)
	})

	// A request whose caller has already gone runs NOTHING: the controlled stream refuses its
	// first read, so the produced generator never starts and the executor is never invoked.
	// That is stronger than the old behaviour, which executed and then discarded the result.
	it('settles a pre-aborted progress stream without executing or answering', async () => {
		const controller = new AbortController()
		controller.abort(new Error('request aborted'))
		const executions = new MCPFixtureCell(0)
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			execution: () => {
				executions.value += 1
				return { resultType: 'complete', content: [{ type: 'text', text: 'unexpected' }] }
			},
		})
		const answer = readStreamAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: {
						name: 'echo',
						_meta: { ...MODERN_METADATA, progressToken: 'pre-abort' },
					},
				}),
				{ signal: controller.signal },
			),
		)

		await expect(answer.next()).rejects.toThrow('request aborted')
		expect(executions.value).toBe(0)
	})

	it('aborts execution and rejects late reports when the response generator returns', async () => {
		const seen: { signal?: AbortSignal; reporter?: MCPProgressInterface } = {}
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			execution: async ({ signal, progress: reporter }) => {
				if (reporter === undefined) throw new Error('expected progress reporter')
				seen.signal = signal
				seen.reporter = reporter
				await reporter.report({ progress: 1 })
				await waitForAbort(signal)
				return { resultType: 'complete', content: [{ type: 'text', text: 'aborted' }] }
			},
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				id: 'returned-progress',
				method: 'tools/call',
				params: {
					name: 'echo',
					_meta: { ...MODERN_METADATA, progressToken: 'returned' },
				},
			}),
		)
		if (answer === undefined || !('next' in answer)) throw new Error('expected progress stream')
		await answer.next()
		await answer.return(buildJSONRPCResult('returned-progress', {}))
		if (seen.reporter === undefined) throw new Error('expected captured reporter')

		expect(seen.signal?.aborted).toBe(true)
		await expect(seen.reporter.report({ progress: 2 })).rejects.toThrow(
			'Progress reporter is stopped',
		)
	})
})

describe('MCPServer — multi-round-trip input', () => {
	it('passes the in-scope dispatch options to the principal handler', async () => {
		const seen: MCPMethodOptions[] = []
		const caller = Object.freeze({ subject: 'principal-user' })
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			input: {
				continuation: new MemoryContinuation(),
				ttl: 1_000,
				principal: (_request, options) => {
					seen.push(options)
					return 'operator-1'
				},
				selector: () => createRound(),
			},
		})

		await mcp.dispatch(
			createJSONRPCRequest({
				id: 'principal-options',
				method: 'tools/call',
				params: {
					name: 'echo',
					_meta: {
						[MCP_META_VERSION]: '2026-07-28',
						[MCP_META_CAPABILITIES]: { elicitation: {} },
					},
				},
			}),
			{ caller },
		)

		expect(seen).toHaveLength(1)
		expect(seen[0]?.caller).toBe(caller)
		expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
	})

	// Both halves of the continuation port's failure taxonomy are the PROVIDER's contract, not
	// the client's: a port that throws and a port that opens onto a value outside the state
	// bound each answer detail-free `-32603`, because the client never authored either
	// outcome and cannot act on being told it was at fault. The client-side arm — a carrier
	// the port cannot recover — is `-32602`, and lives in the W02-B taxonomy row.
	it('contains continuation open rejection and an out-of-bound opened value', async () => {
		const sealed = new MCPFixtureCell('')
		const mode = new MCPFixtureCell<'reject' | 'oversize'>('reject')
		const continuation = createFaultContinuation(sealed, mode)
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			limit: { state: 512 },
			input: {
				continuation,
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: (context) => (context.responses === undefined ? createRound() : undefined),
			},
		})
		const params = {
			name: 'echo',
			_meta: {
				[MCP_META_VERSION]: '2026-07-28',
				[MCP_META_CAPABILITIES]: { elicitation: {} },
			},
		}
		const firstMessage = await mcp.dispatch(
			createJSONRPCRequest({ id: 40, method: 'tools/call', params }),
		)
		const first = readUnaryAnswer(firstMessage)
		if (!isMCPInputResult(first?.result)) throw new Error('expected input_required')
		expect(parseMCPInputState(sealed.value)).toMatchObject({ id: 40, expiry: expect.any(Number) })
		expect(sealed.value).not.toContain('"expires"')
		expect(sealed.value).not.toContain('"origin"')
		const key = Object.keys(first.result.inputRequests ?? {})[0]
		if (key === undefined) throw new Error('expected an input request key')
		const retry = {
			...params,
			requestState: 'carrier',
			inputResponses: { [key]: { action: 'accept' } },
		}

		const rejectedMessage = await mcp.dispatch(
			createJSONRPCRequest({ id: 41, method: 'tools/call', params: retry }),
		)
		const rejected = readUnaryAnswer(rejectedMessage)
		expect(rejected?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(rejected?.error?.message).not.toContain('continuation provider detail')

		mode.value = 'oversize'
		const oversizedMessage = await mcp.dispatch(
			createJSONRPCRequest({ id: 42, method: 'tools/call', params: retry }),
		)
		const oversized = readUnaryAnswer(oversizedMessage)
		expect(oversized?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(oversized?.error?.message).toBe('Server error')
	})

	it('contains rejected input hooks and rejects invalid resolved policy values', async () => {
		const base = {
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
		}
		const cases = [
			{
				server: createMCPServer({
					...base,
					input: {
						continuation: new MemoryContinuation(),
						ttl: 1_000,
						principal: () => 'operator-1',
						selector: async () => {
							throw new Error('selector provider detail')
						},
					},
				}),
				code: JSONRPC_INTERNAL_ERROR,
			},
			{
				server: createMCPServer({
					...base,
					input: {
						continuation: new MemoryContinuation(),
						ttl: 1_000,
						principal: async () => {
							throw new Error('principal provider detail')
						},
						selector: () => createRound(),
					},
				}),
				code: JSONRPC_INTERNAL_ERROR,
			},
			{
				server: createMCPServer({
					...base,
					input: {
						continuation: {
							async seal() {
								throw new Error('seal provider detail')
							},
							async open() {
								return undefined
							},
						},
						ttl: 1_000,
						principal: () => 'operator-1',
						selector: () => createRound(),
					},
				}),
				code: JSONRPC_INTERNAL_ERROR,
			},
			{
				server: createMCPServer({
					...base,
					input: {
						continuation: new MemoryContinuation(),
						ttl: 1_000,
						principal: () => 'operator-1',
						selector: new Proxy(() => createRound(), { apply: () => 7 }),
					},
				}),
				code: JSONRPC_INVALID_PARAMS,
			},
			{
				server: createMCPServer({
					...base,
					input: {
						continuation: new MemoryContinuation(),
						ttl: 1_000,
						principal: new Proxy(() => 'operator-1', { apply: () => 7 }),
						selector: () => createRound(),
					},
				}),
				code: JSONRPC_INVALID_PARAMS,
			},
			{
				server: createMCPServer({
					...base,
					input: {
						continuation: {
							async seal() {
								return ''
							},
							async open() {
								return undefined
							},
						},
						ttl: 1_000,
						principal: () => 'operator-1',
						selector: () => createRound(),
					},
				}),
				code: JSONRPC_INVALID_PARAMS,
			},
		]
		const request = createJSONRPCRequest({
			id: 43,
			method: 'tools/call',
			params: {
				name: 'echo',
				_meta: {
					[MCP_META_VERSION]: '2026-07-28',
					[MCP_META_CAPABILITIES]: { elicitation: {} },
				},
			},
		})

		for (const scenario of cases) {
			const answer = readUnaryAnswer(await scenario.server.dispatch(request))
			expect(answer?.error?.code).toBe(scenario.code)
			expect(answer?.error?.message).not.toContain('provider detail')
		}
	})

	it('returns the consumer’s keyed round and resumes under a new id from top-level echo fields', async () => {
		const seen: MCPInputContext[] = []
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			input: {
				continuation: new MemoryContinuation(),
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: (context) => {
					seen.push(context)
					return context.responses === undefined
						? createRound(
								{
									message: 'Approve the reply?',
									requestedSchema: {
										type: 'object',
										properties: { approved: { type: 'boolean' } },
										required: ['approved'],
									},
								},
								'run-42',
							)
						: undefined
				},
			},
		})
		const first = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 'origin-1',
					method: 'tools/call',
					params: {
						name: 'echo',
						arguments: { value: 7 },
						_meta: {
							[MCP_META_VERSION]: '2026-07-28',
							[MCP_META_CAPABILITIES]: { elicitation: {} },
						},
					},
				}),
			),
		)
		if (!isMCPInputResult(first?.result)) {
			throw new Error('expected an input-required result')
		}
		const keys = Object.keys(first.result.inputRequests ?? {})
		const key = keys[0]
		const requestState = first.result.requestState
		if (key === undefined || requestState === undefined) {
			throw new Error('expected the consumer’s key and protected request state')
		}

		// The key travels verbatim from the round the selector composed, and the request travels
		// with it unstamped: the consumer decides the wire, including whether `mode` appears.
		expect(keys).toEqual(['approval'])
		expect(Array.isArray(first.result.inputRequests)).toBe(false)
		expect(first.result.inputRequests?.[key]).toEqual({
			method: 'elicitation/create',
			params: {
				message: 'Approve the reply?',
				requestedSchema: {
					type: 'object',
					properties: { approved: { type: 'boolean' } },
					required: ['approved'],
				},
			},
		})
		expect(typeof requestState).toBe('string')

		const retryParams = {
			name: 'echo',
			arguments: { value: 7 },
			inputResponses: { [key]: { action: 'accept', content: { approved: true } } },
			requestState,
			_meta: {
				[MCP_META_VERSION]: '2026-07-28',
				[MCP_META_CAPABILITIES]: { elicitation: {} },
			},
		}
		const retry = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({ id: 'retry-2', method: 'tools/call', params: retryParams }),
			),
		)

		expect(retry?.result).toEqual({
			content: [{ type: 'text', text: '{"value":7}' }],
			structuredContent: { value: 7 },
			resultType: 'complete',
			_meta: { [MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' } },
		})
		expect(retryParams.requestState).toBe(requestState)
		expect(retryParams).toHaveProperty('inputResponses')
		expect(retryParams.arguments).toEqual({ value: 7 })
		expect(seen).toHaveLength(2)
		expect(seen[1]?.responses).toEqual({
			approval: { action: 'accept', content: { approved: true } },
		})
		expect(seen[1]?.state).toBe('run-42')
		expect(seen[1]?.arguments).toEqual({ value: 7 })
	})

	it('issues one round of several kinds under the consumer’s own keys', async () => {
		const seen: MCPInputContext[] = []
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			input: {
				continuation: new MemoryContinuation(),
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: (context) => {
					seen.push(context)
					return context.responses === undefined ? { requests: MIXED_ROUND } : undefined
				},
			},
		})
		const first = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({ id: 'mixed-1', method: 'tools/call', params: buildMixedCall() }),
			),
		)
		if (!isMCPInputResult(first?.result)) throw new Error('expected an input-required result')
		const requestState = first.result.requestState
		if (requestState === undefined) throw new Error('expected protected request state')

		expect(first.result.inputRequests).toEqual(MIXED_ROUND)

		const retry = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 'mixed-2',
					method: 'tools/call',
					params: { ...buildMixedCall(), requestState, inputResponses: MIXED_ANSWERS },
				}),
			),
		)

		expect(readResultRecord(retry)['resultType']).toBe('complete')
		expect(seen[1]?.responses).toEqual(MIXED_ANSWERS)
	})

	it.each([
		['no declaration at all', {}, { elicitation: {}, roots: {}, sampling: {} }],
		[
			'URL-only elicitation',
			{ elicitation: { url: {} }, sampling: {}, roots: {} },
			{ elicitation: {} },
		],
		['every kind but roots', { elicitation: {}, sampling: {} }, { roots: {} }],
	])('refuses a round the client cannot answer with %s', async (_, capabilities, required) => {
		const executions = new MCPFixtureCell(0)
		const manager = createToolManager()
		manager.add(
			createTool({
				name: 'echo',
				execute: () => {
					executions.value += 1
					return 'ran'
				},
			}),
		)
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: manager,
			input: {
				continuation: new MemoryContinuation(),
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: () => ({ requests: MIXED_ROUND }),
			},
		})
		const response = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: {
						name: 'echo',
						_meta: {
							[MCP_META_VERSION]: '2026-07-28',
							[MCP_META_CAPABILITIES]: capabilities,
						},
					},
				}),
			),
		)

		expect(response?.error).toEqual({
			code: MCP_MISSING_CAPABILITY,
			message: 'Server requires a client capability this request did not declare',
			data: { requiredCapabilities: required },
		})
		expect(executions.value).toBe(0)
	})

	it('rejects mutated state, a reused id, and an omitted response without running the tool', async () => {
		const executions = new MCPFixtureCell(0)
		const manager = createToolManager()
		manager.add(
			createTool({
				name: 'count',
				execute: () => {
					executions.value += 1
					return executions.value
				},
			}),
		)
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: manager,
			input: {
				continuation: new MemoryContinuation(),
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: (context) => (context.responses === undefined ? createRound() : undefined),
			},
		})
		const params = {
			name: 'count',
			_meta: {
				[MCP_META_VERSION]: '2026-07-28',
				[MCP_META_CAPABILITIES]: { elicitation: {} },
			},
		}
		const firstMessage = await mcp.dispatch(
			createJSONRPCRequest({ id: 11, method: 'tools/call', params }),
		)
		const first = readUnaryAnswer(firstMessage)
		if (!isMCPInputResult(first?.result)) throw new Error('expected input_required')
		const key = Object.keys(first.result.inputRequests ?? {})[0]
		const token = first.result.requestState
		if (key === undefined || token === undefined) throw new Error('missing input state')
		const response = { [key]: { action: 'accept' } }
		const mutated = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`

		const mutatedAnswer = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 12,
					method: 'tools/call',
					params: { ...params, inputResponses: response, requestState: mutated },
				}),
			),
		)
		const reusedAnswer = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 11,
					method: 'tools/call',
					params: { ...params, inputResponses: response, requestState: token },
				}),
			),
		)
		const omittedAnswer = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 13,
					method: 'tools/call',
					params: { ...params, requestState: token },
				}),
			),
		)
		const changedArguments = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 14,
					method: 'tools/call',
					params: {
						...params,
						arguments: { changed: true },
						inputResponses: response,
						requestState: token,
					},
				}),
			),
		)
		const changedName = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 15,
					method: 'tools/call',
					params: {
						...params,
						name: 'other',
						inputResponses: response,
						requestState: token,
					},
				}),
			),
		)
		const changedVersion = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 16,
					method: 'tools/call',
					params: {
						...params,
						inputResponses: response,
						requestState: token,
						_meta: {
							[MCP_META_VERSION]: '2025-11-25',
							[MCP_META_CAPABILITIES]: { elicitation: {} },
						},
					},
				}),
			),
		)
		const changedMethod = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 17,
					method: 'resources/read',
					params: { ...params, inputResponses: response, requestState: token },
				}),
			),
		)
		const changedKey = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 18,
					method: 'tools/call',
					params: {
						...params,
						inputResponses: { wrong: { action: 'accept' } },
						requestState: token,
					},
				}),
			),
		)

		expect(mutatedAnswer?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(reusedAnswer?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(omittedAnswer?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(changedArguments?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(changedName?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(changedVersion?.error?.code).toBe(MCP_UNSUPPORTED_VERSION)
		// A carrier on another method is no longer refused by core for being on another
		// method: continuation semantics belong to whoever registered that method, and this
		// server has registered nothing under `resources/read`, so the answer is `-32601`.
		// The state's `method` binding still exists and is still checked; what changed is that
		// only a registered handler can reach the point where it would matter.
		expect(changedMethod?.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
		expect(changedKey?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(executions.value).toBe(0)
	})

	it('binds principal and a real short TTL inside the protected payload', async () => {
		const principal = new MCPFixtureCell('operator-1')
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			input: {
				continuation: new MemoryContinuation(),
				ttl: 15,
				principal: () => principal.value,
				selector: (context) => (context.responses === undefined ? createRound() : undefined),
			},
		})
		const params = {
			name: 'echo',
			_meta: {
				[MCP_META_VERSION]: '2026-07-28',
				[MCP_META_CAPABILITIES]: { elicitation: {} },
			},
		}
		const firstMessage = await mcp.dispatch(
			createJSONRPCRequest({ id: 20, method: 'tools/call', params }),
		)
		const first = readUnaryAnswer(firstMessage)
		if (!isMCPInputResult(first?.result)) throw new Error('expected input_required')
		const key = Object.keys(first.result.inputRequests ?? {})[0]
		const token = first.result.requestState
		if (key === undefined || token === undefined) throw new Error('missing input state')
		const responses = { [key]: { action: 'accept' } }

		principal.value = 'operator-2'
		const wrongPrincipal = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 21,
					method: 'tools/call',
					params: { ...params, inputResponses: responses, requestState: token },
				}),
			),
		)
		principal.value = 'operator-1'
		await waitForDelay(30)
		const expired = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 22,
					method: 'tools/call',
					params: { ...params, inputResponses: responses, requestState: token },
				}),
			),
		)

		expect(wrongPrincipal?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(expired?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
	})

	it('reaches modern input policy and refuses its result at the legacy revision boundary', async () => {
		const selections = new MCPFixtureCell(0)
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			input: {
				continuation: new MemoryContinuation(),
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: () => {
					selections.value += 1
					return createRound()
				},
			},
		})
		const legacy = createMCPLegacy(mcp)

		expect(readUnaryAnswer(await mcp.dispatch(modernRequest('prompts/get')))?.error?.code).toBe(
			JSONRPC_METHOD_NOT_FOUND,
		)
		expect(readUnaryAnswer(await mcp.dispatch(modernRequest('resources/read')))?.error?.code).toBe(
			JSONRPC_METHOD_NOT_FOUND,
		)
		expect(readUnaryAnswer(await mcp.dispatch(modernRequest('tools/list')))?.result).toMatchObject({
			resultType: 'complete',
		})
		expect(
			await legacy.handle(
				'{"jsonrpc":"2.0","method":"tools/call","id":4,"params":{"name":"sum","arguments":{"a":2,"b":5}}}',
			),
		).toBe(
			'{"jsonrpc":"2.0","id":4,"error":{"code":-32000,"message":"Legacy protocol 2025-11-25 cannot represent an input-required result"}}',
		)
		expect(selections.value).toBe(1)
	})
})

describe('MCPServer — the modern method seam', () => {
	it('owns a direct dispatch request before routing and handler observation', async () => {
		const target: JSONRPCRequest = {
			jsonrpc: '2.0',
			method: 'tools/list',
			id: 71,
			params: { _meta: MODERN_METADATA },
		}
		const request = new Proxy(target, {
			get(source, property) {
				if (property === 'method') return 'server/discover'
				return Reflect.get(source, property)
			},
		})
		const answer = readUnaryAnswer(
			await createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: createServerTools(),
			}).dispatch(request),
		)

		expect(answer?.result).toMatchObject({
			resultType: 'complete',
			tools: expect.any(Array),
		})
	})
	it('registers the built-in modern methods on the registry it dispatches from', () => {
		const mcp = createTestServer()

		expect(mcp.methods.method('ping')).toBeUndefined()
		expect(mcp.methods.method('server/discover')).toBeTypeOf('function')
		expect(mcp.methods.method('tools/list')).toBeTypeOf('function')
		expect(mcp.methods.method('tools/call')).toBeTypeOf('function')
		expect(mcp.methods.method('subscriptions/listen')).toBeTypeOf('function')
	})

	// THE LOAD-BEARING PROOF that -32601 is decided by the registry and not by a
	// hard-coded arm list: the SAME method flips from unknown to answered purely by
	// registering it, with no other change.
	it('turns a -32601 method into an answered one by registering it', async () => {
		const mcp = createTestServer()
		const before = readUnaryAnswer(await mcp.dispatch(modernRequest('demo/probe')))
		mcp.methods.add('demo/probe', async (request) =>
			buildJSONRPCResult(request.id, { probed: true }),
		)
		const after = readUnaryAnswer(await mcp.dispatch(modernRequest('demo/probe')))

		expect(before?.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
		expect(before?.error?.message).toContain('demo/probe')
		expect(after?.result).toEqual({ probed: true })
	})

	// THE LOAD-BEARING PROOF that the built-ins are dispatched THROUGH the seam rather
	// than ahead of it: replacing one changes what dispatch answers. A surviving
	// hard-coded arm would win and this would still return the real tool list.
	it('replaces a built-in modern method when one is registered over it', async () => {
		const mcp = createTestServer()
		mcp.methods.add('tools/list', async (request) => buildJSONRPCResult(request.id, { tools: [] }))
		const response = readUnaryAnswer(await mcp.dispatch(modernRequest('tools/list')))

		expect(response?.result).toEqual({ tools: [] })
	})

	it('routes a translated legacy method through a replaced modern method', async () => {
		const mcp = createTestServer()
		mcp.methods.add('tools/list', async (request) =>
			buildJSONRPCResult(request.id, { resultType: 'complete', tools: [] }),
		)

		expect(await mcp.handle('{"jsonrpc":"2.0","method":"tools/list","id":3}')).toBe(
			'{"jsonrpc":"2.0","id":3,"result":{"tools":[]}}',
		)
	})

	it('never reaches a registered method when the modern metadata is unsupported', async () => {
		const mcp = createTestServer()
		const seen: JSONRPCInvocation[] = []
		mcp.methods.add('demo/probe', async (request) => {
			seen.push(request)
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
		})
		const response = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'demo/probe',
					params: {
						_meta: { [MCP_META_VERSION]: '2099-01-01', [MCP_META_CAPABILITIES]: {} },
					},
				}),
			),
		)

		expect(response?.error?.code).toBe(MCP_UNSUPPORTED_VERSION)
		expect(seen).toEqual([])
	})

	it('never reaches a registered method for a legacy request of the same name', async () => {
		const mcp = createTestServer()
		const seen: JSONRPCInvocation[] = []
		mcp.methods.add('demo/probe', async (request) => {
			seen.push(request)
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
		})
		const responseMessage = await mcp.dispatch(
			createJSONRPCRequest({ method: 'demo/probe', id: 4 }),
		)
		const response = readUnaryAnswer(responseMessage)

		expect(response?.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
		expect(seen).toEqual([])
	})

	// A dispatched method never sees an absent signal. A caller with none to offer
	// still leaves the handler holding a real, never-aborting one, so no handler downstream
	// has to case on absence.
	it('resolves a signal for every handler even when the caller supplied none', async () => {
		const mcp = createTestServer()
		const seen: MCPMethodOptions[] = []
		mcp.methods.add('demo/probe', async (request, options) => {
			seen.push(options)
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
		})
		await mcp.dispatch(modernRequest('demo/probe'))

		expect(seen).toHaveLength(1)
		expect(Object.keys(seen[0] ?? {})).toEqual(['signal'])
		expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
		expect(seen[0]?.signal.aborted).toBe(false)
		expect(seen[0]?.caller).toBeUndefined()
	})

	it('passes direct dispatch caller context to the registered handler', async () => {
		const mcp = createTestServer()
		const caller = Object.freeze({ subject: 'dispatch-user' })
		const seen: unknown[] = []
		mcp.methods.add('demo/probe', async (request, options) => {
			seen.push(options.caller)
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
		})
		await mcp.dispatch(modernRequest('demo/probe'), { caller })

		expect(seen).toEqual([caller])
	})

	it('passes direct handle caller context to the registered handler', async () => {
		const mcp = createTestServer()
		const caller = Object.freeze({ subject: 'handle-user' })
		const seen: unknown[] = []
		mcp.methods.add('demo/probe', async (request, options) => {
			seen.push(options.caller)
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
		})
		await mcp.handle(JSON.stringify(modernRequest('demo/probe')), { caller })

		expect(seen).toEqual([caller])
	})

	// The handler's signal is the request's LIFETIME, not the caller's signal by identity:
	// it composes the caller's abort with the one dispatch fires when the answer ends. What
	// a producer needs is exactly that composition, so identity is the wrong assertion here
	// and the caller's abort still reaching the handler is the right one.
	it('composes the caller’s abort signal into the handler’s lifetime through dispatch', async () => {
		const mcp = createTestServer()
		const controller = new AbortController()
		const seen: MCPMethodOptions[] = []
		mcp.methods.add('demo/probe', async (request, options) => {
			seen.push(options)
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
		})
		await mcp.dispatch(modernRequest('demo/probe'), { signal: controller.signal })

		expect(seen[0]?.signal).not.toBe(controller.signal)
		expect(seen[0]?.signal.aborted).toBe(false)
		controller.abort()
		expect(seen[0]?.signal.aborted).toBe(true)
	})

	it('composes the caller’s abort signal into the handler’s lifetime through handle', async () => {
		const mcp = createTestServer()
		const controller = new AbortController()
		const seen: MCPMethodOptions[] = []
		mcp.methods.add('demo/probe', async (request, options) => {
			seen.push(options)
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
		})
		await mcp.handle(JSON.stringify(modernRequest('demo/probe')), { signal: controller.signal })
		controller.abort()

		expect(seen[0]?.signal.aborted).toBe(true)
	})

	it('aborts the handler’s lifetime once the stream it produced has closed', async () => {
		const mcp = createTestServer()
		const seen: MCPMethodOptions[] = []
		mcp.methods.add('demo/stream', async (request, options) => {
			seen.push(options)
			return createServerProgress(request.id)
		})
		const stream = readStreamAnswer(await mcp.dispatch(modernRequest('demo/stream', 12)))

		expect(seen[0]?.signal.aborted).toBe(false)
		await drainStream(stream)

		expect(seen[0]?.signal.aborted).toBe(true)
	})

	it('returns a handler’s held-open stream from dispatch, terminating with its response', async () => {
		const mcp = createTestServer()
		mcp.methods.add('demo/stream', createHeldMethod)
		const [messages, response] = await drainStream(
			readStreamAnswer(await mcp.dispatch(modernRequest('demo/stream', 11))),
		)

		expect(messages).toEqual([
			{ jsonrpc: '2.0', method: 'notifications/progress', params: { step: 1 } },
			{ jsonrpc: '2.0', method: 'notifications/progress', params: { step: 2 } },
		])
		// Each yielded message is a NOTIFICATION — a request with no id.
		expect(messages.every((message) => message.id === undefined)).toBe(true)
		expect(response).toEqual({ jsonrpc: '2.0', id: 11, result: { done: true } })
	})

	it('mirrors a held-open answer as a serialized stream through handle', async () => {
		const mcp = createTestServer()
		mcp.methods.add('demo/stream', createHeldMethod)
		const answer = readTextAnswer(
			await mcp.handle(JSON.stringify(modernRequest('demo/stream', 12))),
		)
		const [messages, response] = await drainText(answer)

		// The string boundary hands back the controlled entity itself, so a transport holding
		// only the serialized arm still has `stop()` to end what it is writing.
		expect(answer).toBeInstanceOf(MCPTextStreamController)
		expect(messages).toEqual([
			'{"jsonrpc":"2.0","method":"notifications/progress","params":{"step":1}}',
			'{"jsonrpc":"2.0","method":"notifications/progress","params":{"step":2}}',
		])
		expect(response).toBe('{"jsonrpc":"2.0","id":12,"result":{"done":true}}')
	})

	it('answers nothing for a held-open method dispatched as a notification', async () => {
		const mcp = createTestServer()
		mcp.methods.add('demo/stream', createHeldMethod)

		expect(
			await mcp.dispatch(createJSONRPCNotification('demo/stream', { _meta: MODERN_METADATA })),
		).toBeUndefined()
	})

	// The seam now says a registered method ANSWERS, and the registry is open — so the
	// one consumer this server cannot assume was typechecked is the one that must not be able
	// to break it. Before this containment, `dispatch(request)` resolved `undefined` against an
	// overload promising a response, and a transport with nothing to write held the peer until
	// its own deadline expired. The handler here reaches the registry the way a JavaScript
	// consumer's does: through the ONE fact a runtime registration can check.
	it('contains a registered handler that answers nothing for a request', async () => {
		const mcp = createTestServer()
		const events = createRecorders<MCPServerEventMap, 'error'>(mcp.emitter, ['error'])
		const untyped: unknown = declineAsyncTask
		if (!isMCPMethodHandler(untyped)) throw new Error('expected a callable handler')
		mcp.methods.add('demo/silent', untyped)

		const response = readUnaryAnswer(await mcp.dispatch(modernRequest('demo/silent')))

		expect(response?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		// Detail-free on the wire, legible on the channel built for it — the same split every
		// other contained fault takes, reported exactly once.
		expect(response?.error?.message).toBe('Server error')
		expect(events.error.count).toBe(1)
		expect(events.error.calls[0]?.[0]).toBeInstanceOf(Error)
		// The operator's own failure would also end in a `-32603` — dispatch's catch is right
		// there — so the code alone cannot tell a DESIGNED containment from a TypeError raised
		// one line later while narrowing an absent answer. The diagnosis names the offending
		// method; a stray TypeError cannot.
		expect(String(events.error.calls[0]?.[0])).toContain('demo/silent')
	})

	it('contains the same handler through the string boundary', async () => {
		const mcp = createTestServer()
		const events = createRecorders<MCPServerEventMap, 'error'>(mcp.emitter, ['error'])
		const untyped: unknown = declineAsyncTask
		if (!isMCPMethodHandler(untyped)) throw new Error('expected a callable handler')
		mcp.methods.add('demo/silent', untyped)

		const answer = await mcp.handle(JSON.stringify(modernRequest('demo/silent')))

		// A repaired claim is re-asked at every door that reaches the rule. `handle` returns
		// `undefined` for a NOTIFICATION, so a defect here would be indistinguishable from
		// ordinary silence at exactly the boundary a transport reads.
		expect(typeof answer).toBe('string')
		expect(answer).toContain(String(JSONRPC_INTERNAL_ERROR))
		expect(events.error.count).toBe(1)
	})

	// The control, drawn from OUTSIDE the population the narrowing changed. Every registration
	// the narrowing touched is a BUILT-IN; this handler is a consumer's, added through the
	// public `methods.add` after construction, and it must still never be invoked for a
	// notification. If the notification short-circuit were what the deleted ternaries had been
	// standing in for, this is where it would show.
	it('never invokes a consumer-registered handler for a notification', async () => {
		const mcp = createTestServer()
		const seen: JSONRPCRequest[] = []
		mcp.methods.add('demo/probe', async (request) => {
			seen.push(request)
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
		})

		expect(
			await mcp.dispatch(createJSONRPCNotification('demo/probe', { _meta: MODERN_METADATA })),
		).toBeUndefined()
		expect(
			await mcp.handle(
				JSON.stringify(createJSONRPCNotification('demo/probe', { _meta: MODERN_METADATA })),
			),
		).toBeUndefined()
		expect(seen).toEqual([])

		// The instrument proves it can see an invocation before the zero above is read.
		await mcp.dispatch(modernRequest('demo/probe'))
		expect(seen).toHaveLength(1)
	})
})

describe('MCPServer — modern subscriptions/listen', () => {
	it('acknowledges the honoured subset, stamps every delivery, and closes with the same id', async () => {
		const controller = new AbortController()
		const notifications: unknown[] = []
		const options: MCPMethodOptions[] = []
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const writer = source.writable.getWriter()
		const mcp = createTestServer(undefined, {
			notifications: {
				promptsListChanged: true,
				resourceSubscriptions: ['resource://kept'],
			},
			producer(filter, dispatch) {
				notifications.push(filter)
				options.push(dispatch)
				return source.readable
			},
		})
		const stream = readStreamAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'subscriptions/listen',
					id: 'listen-7',
					params: {
						notifications: {
							promptsListChanged: true,
							resourcesListChanged: true,
							resourceSubscriptions: ['resource://ignored', 'resource://kept'],
						},
						_meta: MODERN_METADATA,
					},
				}),
				{ signal: controller.signal },
			),
		)
		const acknowledgement = await stream.next()
		if (acknowledgement.done) throw new Error('expected a subscription acknowledgement')
		expect(notifications).toEqual([
			{ promptsListChanged: true, resourceSubscriptions: ['resource://kept'] },
		])
		const drained = drainStream(stream)
		await writer.write({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' })
		await writer.write({
			jsonrpc: '2.0',
			method: 'notifications/prompts/list_changed',
			params: { _meta: { producer: true } },
		})
		await writer.write({
			jsonrpc: '2.0',
			method: 'notifications/resources/updated',
			params: { uri: 'resource://ignored' },
		})
		await writer.write({
			jsonrpc: '2.0',
			method: 'notifications/resources/updated',
			params: { uri: 'resource://kept', _meta: { [MCP_META_SUBSCRIPTION]: 'wrong' } },
		})
		await writer.close()
		const [messages, response] = await drained

		expect(acknowledgement.value).toEqual({
			jsonrpc: '2.0',
			method: 'notifications/subscriptions/acknowledged',
			params: {
				notifications: {
					promptsListChanged: true,
					resourceSubscriptions: ['resource://kept'],
				},
				_meta: { [MCP_META_SUBSCRIPTION]: 'listen-7' },
			},
		})
		expect(messages).toEqual([
			{
				jsonrpc: '2.0',
				method: 'notifications/prompts/list_changed',
				params: {
					_meta: { producer: true, [MCP_META_SUBSCRIPTION]: 'listen-7' },
				},
			},
			{
				jsonrpc: '2.0',
				method: 'notifications/resources/updated',
				params: {
					uri: 'resource://kept',
					_meta: { [MCP_META_SUBSCRIPTION]: 'listen-7' },
				},
			},
		])
		expect(notifications).toEqual([
			{ promptsListChanged: true, resourceSubscriptions: ['resource://kept'] },
		])
		// The producer receives the request's LIFETIME rather than the caller's signal by
		// identity: an aborting caller still reaches it, and so does the stream's own close.
		expect(options[0]?.signal.aborted).toBe(true)
		expect(controller.signal.aborted).toBe(false)
		expect(response).toEqual({
			jsonrpc: '2.0',
			id: 'listen-7',
			result: {
				resultType: 'complete',
				_meta: {
					[MCP_META_SUBSCRIPTION]: 'listen-7',
					[MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' },
				},
			},
		})
	})

	it('rejects a missing notification filter and keeps the legacy method frozen', async () => {
		const mcp = createTestServer()
		const invalid = readUnaryAnswer(await mcp.dispatch(modernRequest('subscriptions/listen')))
		const legacyMessage = await mcp.dispatch(
			createJSONRPCRequest({ method: 'subscriptions/listen', id: 7 }),
		)
		const legacy = readUnaryAnswer(legacyMessage)

		expect(invalid?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(legacy?.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
	})
})

describe('MCPServer — initialize', () => {
	it('returns the default protocol version, the tools capability, and serverInfo', async () => {
		const response = readUnaryAnswer(await createTestServer().dispatch(createJSONRPCRequest()))
		const result = readResultRecord(response)

		expect(response?.id).toBe(1)
		expect(result['protocolVersion']).toBe(MCP_HANDSHAKE_VERSION)
		expect(result['capabilities']).toEqual({ tools: {} })
		expect(result['serverInfo']).toEqual({ name: 'test-server', version: '1.2.3' })
	})

	it('falls back when the requested protocol version requires unsupported batching', async () => {
		const response = readUnaryAnswer(
			await createTestServer().dispatch(
				createJSONRPCRequest({ params: { protocolVersion: '2025-03-26' } }),
			),
		)

		expect(readResultRecord(response)['protocolVersion']).toBe(MCP_HANDSHAKE_VERSION)
	})

	it('falls back to the default for an unsupported requested version', async () => {
		const response = readUnaryAnswer(
			await createTestServer().dispatch(
				createJSONRPCRequest({ params: { protocolVersion: '1999-01-01' } }),
			),
		)

		expect(readResultRecord(response)['protocolVersion']).toBe(MCP_HANDSHAKE_VERSION)
	})

	it('ignores a non-string requested version (falls back to the default)', async () => {
		const responseMessage = await createTestServer().dispatch(
			createJSONRPCRequest({ params: { protocolVersion: 42 } }),
		)
		const response = readUnaryAnswer(responseMessage)

		expect(readResultRecord(response)['protocolVersion']).toBe(MCP_HANDSHAKE_VERSION)
	})
})

describe('MCPServer — ping', () => {
	it('returns an empty result', async () => {
		const responseMessage = await createTestServer().dispatch(
			createJSONRPCRequest({ method: 'ping', id: 7 }),
		)
		const response = readUnaryAnswer(responseMessage)

		expect(response?.id).toBe(7)
		expect(response?.result).toEqual({})
	})
})

describe('MCPServer — tools/list', () => {
	it('lists the registered tools with inputSchema mapped from parameters', async () => {
		const responseMessage = await createTestServer().dispatch(
			createJSONRPCRequest({ method: 'tools/list', id: 2 }),
		)
		const response = readUnaryAnswer(responseMessage)
		const list = readResultRecord(response)['tools']

		expect(list).toEqual([
			{ name: 'echo', inputSchema: { type: 'object' } },
			{
				name: 'sum',
				description: 'Add two numbers',
				inputSchema: {
					type: 'object',
					properties: { a: { type: 'number' }, b: { type: 'number' } },
				},
			},
			{ name: 'boom', inputSchema: { type: 'object' } },
		])
	})

	it('keeps tools/list in deterministic registry order', async () => {
		const mcp = createTestServer()
		const first = readUnaryAnswer(
			await mcp.dispatch(createJSONRPCRequest({ method: 'tools/list', id: 20 })),
		)
		const second = readUnaryAnswer(
			await mcp.dispatch(createJSONRPCRequest({ method: 'tools/list', id: 21 })),
		)

		expect(readResultRecord(second)['tools']).toEqual(readResultRecord(first)['tools'])
	})

	it('lists an empty tool set for an empty registry', async () => {
		const mcp = createMCPLegacy(
			createMCPServer({
				identity: { name: 'empty', version: '0.0.0' },
				tools: createToolManager(),
			}),
		)
		const response = readUnaryAnswer(
			await mcp.dispatch(createJSONRPCRequest({ method: 'tools/list' })),
		)

		expect(readResultRecord(response)['tools']).toEqual([])
	})
})

describe('MCPServer — tools/call', () => {
	it('aborts default tool execution on a duplex cancellation and keeps the connection usable', async () => {
		const probe = createAbortTools()
		const serverSide = createMemoryTransport()
		const clientSide = createMemoryTransport()
		serverSide.connect(clientSide)
		clientSide.connect(serverSide)
		const cancellationServer = createMCPServer({
			identity: { name: 'abort', version: '1' },
			tools: probe.tools,
		})
		const unbindServer = bindServer(cancellationServer, serverSide)
		const client = createMCPClient({ transport: createDuplexClientTransport(clientSide) })
		const unbindClient = bindClient(client, clientSide)
		const controller = new AbortController()
		try {
			await client.connect()
			const pending = client.call('wait', {}, { signal: controller.signal })
			const rejected = pending.catch((error: unknown) => error)
			const signal = await probe.entered
			expect(signal.aborted).toBe(false)
			controller.abort()
			expect(await rejected).toMatchObject({ message: expect.stringMatching(/aborted/) })
			expect(signal.aborted).toBe(true)
			await probe.aborted
			expect(await client.call('echo', { value: 'still connected' })).toEqual({
				resultType: 'complete',
				value: 'still connected',
			})
		} finally {
			probe.release()
			controller.abort()
			await client.disconnect()
			unbindClient()
			unbindServer()
		}
	})

	it('passes caller identity to a custom execution handler separately from the call envelope', async () => {
		const caller = Object.freeze({ subject: 'operator' })
		const seen: unknown[] = []
		const identityTools = createToolManager()
		identityTools.add(
			createTool({
				name: 'identity',
				execute: (_args, context) => {
					expect(Object.hasOwn(context, 'caller')).toBe(context.caller !== undefined)
					return context.caller ?? 'absent'
				},
			}),
		)
		const identityServer = createMCPServer({
			identity: { name: 'identity', version: '1' },
			tools: identityTools,
			execution: (context) => {
				seen.push(context.caller)
				expect(Object.hasOwn(context, 'caller')).toBe(context.caller !== undefined)
				expect(Object.hasOwn(context.call, 'caller')).toBe(false)
				return context.tools.execute(context.call, {
					signal: context.signal,
					...(context.caller === undefined ? {} : { caller: context.caller }),
				})
			},
		})
		const response = readUnaryAnswer(
			await identityServer.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					id: 'identity',
					params: { name: 'identity', _meta: MODERN_METADATA },
				}),
				{ caller },
			),
		)
		expect(seen).toEqual([caller])
		expect(readResultRecord(response)['structuredContent']).toEqual(caller)
		const absent = readUnaryAnswer(
			await identityServer.dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					params: { name: 'identity', _meta: MODERN_METADATA },
				}),
			),
		)
		expect(seen).toEqual([caller, undefined])
		expect(readResultRecord(absent)['structuredContent']).toBe('absent')
	})

	it('advertises titles and mapped annotation hints on tools/list', async () => {
		const metadataTools = createToolManager()
		metadataTools.add(
			createTool({
				name: 'inspect',
				title: 'Inspect record',
				annotations: { pure: true, consequential: false, untrusted: true },
				execute: () => 1,
			}),
		)
		const metadataServer = createMCPServer({
			identity: { name: 'metadata', version: '1' },
			tools: metadataTools,
		})
		const response = readUnaryAnswer(await metadataServer.dispatch(modernRequest('tools/list')))
		expect(readResultRecord(response)['tools']).toEqual([
			{
				name: 'inspect',
				title: 'Inspect record',
				inputSchema: { type: 'object' },
				annotations: { readOnlyHint: true, destructiveHint: false },
			},
		])
	})

	it('omits annotations on tools/list when a tool only declares untrusted', async () => {
		const metadataTools = createToolManager()
		metadataTools.add(
			createTool({ name: 'inspect', annotations: { untrusted: true }, execute: () => 1 }),
		)
		const metadataServer = createMCPServer({
			identity: { name: 'metadata', version: '1' },
			tools: metadataTools,
		})
		const response = readUnaryAnswer(await metadataServer.dispatch(modernRequest('tools/list')))
		expect(readResultRecord(response)['tools']).toEqual([
			{ name: 'inspect', inputSchema: { type: 'object' } },
		])
	})

	it('forwards caller context to real tool bodies in both eras and preserves absence', async () => {
		const observed: unknown[] = []
		const manager = createToolManager()
		manager.add(
			createTool({
				name: 'caller',
				execute: (_args, context) => {
					observed.push(context.caller)
					return context.caller === undefined ? 'absent' : context.caller
				},
			}),
		)
		const mcp = createMCPServer({
			identity: { name: 'caller-server', version: '1.0.0' },
			tools: manager,
		})
		const caller = Object.freeze({ subject: 'tool-user' })
		const legacyRequest = createJSONRPCRequest({
			method: 'tools/call',
			id: 'legacy-caller',
			params: { name: 'caller' },
		})
		const modern = createJSONRPCRequest({
			method: 'tools/call',
			id: 'modern-caller',
			params: { name: 'caller', _meta: MODERN_METADATA },
		})

		await mcp.dispatch(modern, { caller })
		const legacy = createMCPLegacy(mcp)
		await legacy.dispatch(legacyRequest, { caller })
		await mcp.dispatch(modern)
		await legacy.dispatch(legacyRequest)

		expect(observed).toEqual([caller, caller, undefined, undefined])
	})

	it('executes a tool and carries its value as structured content and JSON text', async () => {
		const response = readUnaryAnswer(
			await createTestServer().dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					id: 3,
					params: { name: 'sum', arguments: { a: 2, b: 5 } },
				}),
			),
		)
		const result = readResultRecord(response)

		expect(result['content']).toEqual([{ type: 'text', text: '7' }])
		expect(result['structuredContent']).toBe(7)
		expect(result['isError']).toBeUndefined()
	})

	it('round-trips a structured value unchanged alongside serialized JSON', async () => {
		const response = readUnaryAnswer(
			await createTestServer().dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					id: 3,
					params: { name: 'echo', arguments: { hello: 'world', n: 1 } },
				}),
			),
		)

		const result = readResultRecord(response)

		expect(result['content']).toEqual([
			{ type: 'text', text: JSON.stringify({ hello: 'world', n: 1 }) },
		])
		expect(result['structuredContent']).toEqual({ hello: 'world', n: 1 })
	})

	it('defaults arguments to an empty record when omitted', async () => {
		const response = readUnaryAnswer(
			await createTestServer().dispatch(
				createJSONRPCRequest({ method: 'tools/call', id: 3, params: { name: 'echo' } }),
			),
		)

		expect(readResultRecord(response)['content']).toEqual([{ type: 'text', text: '{}' }])
	})

	it('maps an erroring tool to an isError result carrying the error text', async () => {
		const response = readUnaryAnswer(
			await createTestServer().dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					id: 4,
					params: { name: 'boom', arguments: {} },
				}),
			),
		)
		const result = readResultRecord(response)

		expect(result['isError']).toBe(true)
		expect(result['content']).toEqual([{ type: 'text', text: 'tool exploded' }])
	})

	it('maps an unknown tool name to an isError result (the manager not-found error)', async () => {
		const response = readUnaryAnswer(
			await createTestServer().dispatch(
				createJSONRPCRequest({
					method: 'tools/call',
					id: 4,
					params: { name: 'missing', arguments: {} },
				}),
			),
		)
		const result = readResultRecord(response)

		expect(result['isError']).toBe(true)
		expect(result['content']).toEqual([{ type: 'text', text: 'tool not found: missing' }])
	})

	it('rejects a missing tool name with -32602 invalid params', async () => {
		const response = readUnaryAnswer(
			await createTestServer().dispatch(
				createJSONRPCRequest({ method: 'tools/call', id: 5, params: {} }),
			),
		)

		expect(response?.result).toBeUndefined()
		expect(response?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
	})

	it('rejects a non-string tool name with -32602 invalid params', async () => {
		const response = readUnaryAnswer(
			await createTestServer().dispatch(
				createJSONRPCRequest({ method: 'tools/call', id: 5, params: { name: 42 } }),
			),
		)

		expect(response?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
	})
})

describe('MCPServer — notifications & unknown methods', () => {
	it('returns no response for a request without an id (a notification)', async () => {
		const response = readUnaryAnswer(
			await createTestServer().dispatch(createJSONRPCNotification('ping')),
		)

		expect(response).toBeUndefined()
	})

	it('returns no response for notifications/initialized', async () => {
		const responseMessage = await createTestServer().dispatch(
			createJSONRPCNotification('notifications/initialized'),
		)
		const response = readUnaryAnswer(responseMessage)

		expect(response).toBeUndefined()
	})

	it('returns -32601 for an unknown method', async () => {
		const responseMessage = await createTestServer().dispatch(
			createJSONRPCRequest({ method: 'does/not/exist', id: 9 }),
		)
		const response = readUnaryAnswer(responseMessage)

		expect(response?.id).toBe(9)
		expect(response?.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
		expect(response?.error?.message).toContain('does/not/exist')
	})

	it('returns no response for an unknown-method notification (no id)', async () => {
		const responseMessage = await createTestServer().dispatch(
			createJSONRPCNotification('does/not/exist'),
		)
		const response = readUnaryAnswer(responseMessage)

		expect(response).toBeUndefined()
	})
})

describe('MCPServer — handle (string boundary)', () => {
	it('parses, dispatches, and serializes a request to a response string', async () => {
		const reply = await createTestServer().handle('{"jsonrpc":"2.0","method":"ping","id":1}')

		expect(reply).toBe(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
	})

	it('round-trips a tools/call over the string boundary', async () => {
		const reply = await createTestServer().handle(
			'{"jsonrpc":"2.0","method":"tools/call","id":2,"params":{"name":"sum","arguments":{"a":3,"b":4}}}',
		)

		expect(reply).toBe(
			JSON.stringify({
				jsonrpc: '2.0',
				id: 2,
				result: {
					content: [{ type: 'text', text: '7' }],
					structuredContent: 7,
				},
			}),
		)
	})

	// An unreadable id is OMITTED from the envelope, never sent as `null`.
	it('returns a -32700 parse-error response that omits the id it could not read', async () => {
		const reply = await createTestServer().handle('{ not json )')

		expect(reply).toBe(
			JSON.stringify({
				jsonrpc: '2.0',
				error: { code: JSONRPC_PARSE_ERROR, message: 'Parse error' },
			}),
		)
		expect(reply).not.toContain('"id"')
	})

	it('returns a -32600 invalid-request response that omits the id it could not read', async () => {
		const reply = await createTestServer().handle('{"jsonrpc":"2.0","id":1,"result":{}}')

		expect(reply).toBe(
			JSON.stringify({
				jsonrpc: '2.0',
				error: { code: JSONRPC_INVALID_REQUEST, message: 'Invalid Request' },
			}),
		)
		expect(reply).not.toContain('"id"')
	})

	it('returns a -32600 invalid-request response for a parsed value that is not a message', async () => {
		const reply = await createTestServer().handle('[1, 2, 3]')

		expect(reply).toContain(String(JSONRPC_INVALID_REQUEST))
	})

	it('returns undefined (no reply) for a notification string', async () => {
		const reply = await createTestServer().handle(
			'{"jsonrpc":"2.0","method":"notifications/initialized"}',
		)

		expect(reply).toBeUndefined()
	})
})

describe('MCPServer — request event', () => {
	it('fires request with the method and id at the top of dispatch', async () => {
		const mcp = createTestServer()
		const events = createRecorders<MCPServerEventMap, (typeof MCP_EVENTS)[number]>(
			mcp.emitter,
			MCP_EVENTS,
		)
		await mcp.dispatch(modernRequest('server/discover', 1))
		await mcp.dispatch(modernRequest('tools/list', 2))

		expect(events.request.calls).toEqual([
			['server/discover', 1, 'modern'],
			['tools/list', 2, 'modern'],
		])
	})

	it('fires request with no id for a notification, which has none to report', async () => {
		const mcp = createTestServer()
		const events = createRecorders<MCPServerEventMap, (typeof MCP_EVENTS)[number]>(
			mcp.emitter,
			MCP_EVENTS,
		)
		await mcp.dispatch(createJSONRPCNotification('notifications/initialized'))

		expect(events.request.calls).toEqual([])
	})

	it('fires request through handle as well (parse → dispatch path)', async () => {
		const mcp = createTestServer()
		const events = createRecorders<MCPServerEventMap, (typeof MCP_EVENTS)[number]>(
			mcp.emitter,
			MCP_EVENTS,
		)
		await mcp.handle(JSON.stringify(modernRequest('tools/list', 3)))

		expect(events.request.calls).toEqual([['tools/list', 3, 'modern']])
	})

	it('EMIT SAFETY: a throwing request listener cannot corrupt the dispatch, and routes to the error handler', async () => {
		const errors = createRecorder<readonly [error: unknown, event: string]>()
		const mcp = createTestServer(errors.handler)
		mcp.emitter.on('request', () => {
			throw new Error('request observer blew up')
		})

		// THE LOAD-BEARING ASSERTION: the dispatch still produces its response.
		const response = readUnaryAnswer(await mcp.dispatch(modernRequest('tools/list')))

		expect(response?.result).toMatchObject({ resultType: 'complete', tools: expect.any(Array) })
		// The error handler received (error, event) — note the arg order.
		expect(errors.calls).toEqual([[expect.any(Error), 'request']])
	})

	it('EMIT SAFETY: a throwing error handler neither escapes nor recurses', async () => {
		const errors = createRecorder<readonly [error: unknown, event: string]>()
		const mcp = createTestServer((error, event) => {
			errors.handler(error, event)
			throw new Error('error handler blew up too')
		})
		mcp.emitter.on('request', () => {
			throw new Error('request listener blew up')
		})

		// The dispatch STILL produces a response — neither throw escaped.
		const response = readUnaryAnswer(await mcp.dispatch(modernRequest('tools/list')))

		expect(response?.result).toMatchObject({ resultType: 'complete', tools: expect.any(Array) })
		// Fired exactly once (its own throw was swallowed, not re-entered — no recursion).
		expect(errors.count).toBe(1)
		expect(errors.calls[0]?.[1]).toBe('request')
	})
})

// W02-A — egress. The modern wire retires `-32000`: every internal fault a modern request
// can provoke answers `-32603` and reports its caught value on the server's `error` event,
// while the legacy branch keeps `-32000` untouched. The sweeps below are written against
// the INVARIANT rather than against line numbers, because a migration proved one
// site at a time is a migration that has not been proved.

// One modern fault scenario: the server that produces it and the request that provokes it.

// Reduce any dispatch answer to the error code it finally carries — draining a held-open
// answer to its terminal, because a stream's fault IS its return value.

// The string-boundary mirror: `handle` and `dispatch` are different code paths, so every
// sweep runs through both rather than assuming the second mirrors the first.

// A real execution handler, so the malformed-result scenario proxies a genuine one rather
// than inventing a callable that never had the right shape.

// A consumer's own held-open method that parks and never produces anything — the producer
// a wrapping seam has to survive, since nothing about it will ever settle on its own.

// The subscription mirror of `parking`: a producer suspended inside its OWN await before it
// ever reaches a `yield`. A generator parked here answers neither `return()` nor `throw()`,
// because both queue behind the `next()` it has not settled — which is exactly the steady
// state of a real subscription with no notification pending.

// Every distinct modern fault the server contains, in one population. A fault absent from
// this list is a site the sweep never visited, so the list is the sweep's own membership
// rule and is stated where a reader meets it.
//
// Membership was measured by line-scoped mutation rather than assumed: each modern
// `-32603` emission was flipped to `-32000` on its own, and every one of them fails a
// scenario below — except the type-narrowing floor in `#normalize`, which is unreachable at
// runtime and says so where it lives. A sweep that visits most sites and cannot name the
// one it missed is a sweep that does not know what it covers.

// The positive control the sweeps above cannot do without. An assertion that `-32000` is
// ABSENT passes as loudly when the branch that would emit it never ran, so the same
// assertion is aimed at the legacy branch, where it must find `-32000` every time.

describe('MCPServer — W02-A: the modern internal-error code', () => {
	it('answers every modern fault -32603 and none -32000, through dispatch', async () => {
		const scenarios = createModernFaults()
		const codes: Array<number | undefined> = []
		for (const scenario of scenarios) {
			codes.push(await readStreamFault(await scenario.server.dispatch(scenario.request)))
		}

		expect(codes).toEqual(scenarios.map(() => JSONRPC_INTERNAL_ERROR))
		expect(codes).not.toContain(JSONRPC_SERVER_ERROR)
	})

	it('answers every modern fault -32603 and none -32000, through handle', async () => {
		const scenarios = createModernFaults()
		const codes: Array<number | undefined> = []
		for (const scenario of scenarios) {
			codes.push(
				await readTextFault(await scenario.server.handle(JSON.stringify(scenario.request))),
			)
		}

		expect(codes).toEqual(scenarios.map(() => JSONRPC_INTERNAL_ERROR))
		expect(codes).not.toContain(JSONRPC_SERVER_ERROR)
	})

	// The translated door runs the identical normalization and error-code pipeline.
	it('answers collapsed legacy tool faults -32603 through dispatch and handle', async () => {
		const scenarios = createLegacyFaults()
		const dispatched: Array<number | undefined> = []
		const handled: Array<number | undefined> = []
		for (const scenario of scenarios) {
			dispatched.push(await readStreamFault(await scenario.server.dispatch(scenario.request)))
			handled.push(
				await readTextFault(await scenario.server.handle(JSON.stringify(scenario.request))),
			)
		}

		expect(dispatched).toEqual(scenarios.map(() => JSONRPC_INTERNAL_ERROR))
		expect(handled).toEqual(scenarios.map(() => JSONRPC_INTERNAL_ERROR))
		expect(dispatched).not.toContain(JSONRPC_SERVER_ERROR)
	})

	it('publishes the modern code beside the retained legacy one', () => {
		expect(JSONRPC_INTERNAL_ERROR).toBe(-32603)
		expect(JSONRPC_SERVER_ERROR).toBe(-32000)
	})
})

describe('MCPServer — W02-A: the broadened error event', () => {
	it('reports a contained registered-handler throw exactly once and answers detail-free', async () => {
		const mcp = createHandlerFaultServer()
		const faults = createRecorders<MCPServerEventMap, 'error'>(mcp.emitter, ['error'])

		const response = readUnaryAnswer(await mcp.dispatch(modernRequest('demo/boom')))

		expect(response?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(JSON.stringify(response)).not.toContain('handler detail')
		expect(faults.error.count).toBe(1)
		expect(faults.error.calls[0]?.[0]).toBeInstanceOf(Error)
	})

	// NEGATIVE CONTROL for the containment claim: one unique string, asserted ABSENT from
	// the serialized answer and PRESENT on the observation channel. An assertion that only
	// read the code would pass as well with the whole thrown value on the wire.
	it('carries the caught value to the observer and never to the wire', async () => {
		const detail = 'unique-detail-8f3a2c'
		const thrown = new Error(detail)
		const mcp = createFaultServer(() => {
			throw thrown
		})
		const faults = createRecorders<MCPServerEventMap, 'error'>(mcp.emitter, ['error'])

		const serialized = await mcp.handle(JSON.stringify(buildModernCall({ name: 'echo' })))

		expect(typeof serialized).toBe('string')
		expect(String(serialized)).not.toContain(detail)
		expect(String(serialized)).toContain(String(JSONRPC_INTERNAL_ERROR))
		expect(faults.error.calls).toEqual([[thrown]])
	})

	it('reports a contained subscription-source throw once, as one detail-free terminal', async () => {
		const mcp = createSourceFaultServer()
		const faults = createRecorders<MCPServerEventMap, 'error'>(mcp.emitter, ['error'])
		const stream = readStreamAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'subscriptions/listen',
					id: 'source-fault',
					params: { notifications: { promptsListChanged: true }, _meta: MODERN_METADATA },
				}),
			),
		)

		const [messages, terminal] = await drainStream(stream)

		expect(messages).toHaveLength(1)
		expect(terminal.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(JSON.stringify(terminal)).not.toContain('subscription source detail')
		expect(faults.error.count).toBe(1)
	})

	it('reports nothing for a request that simply completes', async () => {
		const mcp = createTestServer()
		const faults = createRecorders<MCPServerEventMap, 'error'>(mcp.emitter, ['error'])

		await mcp.dispatch(modernRequest('tools/list'))

		expect(faults.error.count).toBe(0)
	})
})

describe('MCPServer — W02-A: subscription capacity and containment', () => {
	it('refuses a subscription beyond capacity with -32603 and releases the slot on close', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const writer = source.writable.getWriter()
		const mcp = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: createServerTools(),
			limit: { subscriptions: 1 },
			subscription: {
				notifications: { promptsListChanged: true },
				producer: () => source.readable,
			},
		})
		const params = { notifications: { promptsListChanged: true }, _meta: MODERN_METADATA }
		const first = readStreamAnswer(
			await mcp.dispatch(createJSONRPCRequest({ method: 'subscriptions/listen', id: 'a', params })),
		)
		await first.next()
		const second = readStreamAnswer(
			await mcp.dispatch(createJSONRPCRequest({ method: 'subscriptions/listen', id: 'b', params })),
		)

		const refused = await second.next()
		if (refused.done !== true) throw new Error('expected the refusal as the terminal')
		expect(refused.value.error?.code).toBe(JSONRPC_INTERNAL_ERROR)

		await writer.close()
		const [, terminal] = await drainStream(first)
		expect(terminal.error).toBeUndefined()
		const third = readStreamAnswer(
			await mcp.dispatch(createJSONRPCRequest({ method: 'subscriptions/listen', id: 'c', params })),
		)
		expect((await third.next()).done).toBe(false)
		await third.return(buildJSONRPCResult('c', { resultType: 'complete' }))
	})

	it('owns a produced notification before matching and stamping it', async () => {
		const reads = new MCPFixtureCell(0)
		const params = new Proxy(
			{ uri: 'resource://kept' },
			{
				get(target, property, receiver) {
					if (property !== 'uri') return Reflect.get(target, property, receiver)
					reads.value += 1
					return reads.value === 1 ? 'resource://kept' : 'resource://leaked'
				},
				getOwnPropertyDescriptor(target, property) {
					const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
					if (property !== 'uri' || descriptor === undefined) return descriptor
					reads.value += 1
					return {
						...descriptor,
						value: reads.value === 1 ? 'resource://kept' : 'resource://leaked',
					}
				},
			},
		)
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const writer = source.writable.getWriter()
		const mcp = createTestServer(undefined, {
			notifications: { resourceSubscriptions: ['resource://kept'] },
			producer: () => source.readable,
		})
		const stream = readStreamAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'subscriptions/listen',
					id: 'own-1',
					params: {
						notifications: { resourceSubscriptions: ['resource://kept'] },
						_meta: MODERN_METADATA,
					},
				}),
			),
		)
		await stream.next()
		const drained = drainStream(stream)
		await writer.write({ jsonrpc: '2.0', method: 'notifications/resources/updated', params })
		await writer.close()
		const [messages] = await drained

		// The matcher admitted `resource://kept`; nothing else may be what the client sees.
		for (const message of messages) {
			expect(message.params?.['uri']).toBe('resource://kept')
		}
	})

	it('drops a produced notification carrying a value that is not exact JSON', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const writer = source.writable.getWriter()
		const mcp = createTestServer(undefined, {
			notifications: { resourceSubscriptions: ['resource://kept'] },
			producer: () => source.readable,
		})
		const stream = readStreamAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'subscriptions/listen',
					id: 'own-2',
					params: {
						notifications: { resourceSubscriptions: ['resource://kept'] },
						_meta: MODERN_METADATA,
					},
				}),
			),
		)
		await stream.next()
		const drained = drainStream(stream)
		await writer.write({
			jsonrpc: '2.0',
			method: 'notifications/resources/updated',
			params: { uri: 'resource://kept', leak: () => 'not JSON' },
		})
		await writer.close()
		const [messages, terminal] = await drained

		expect(messages).toEqual([])
		expect(terminal.error).toBeUndefined()
	})

	// The steady state of every live subscription: the producer is suspended inside its OWN
	// await, so nothing a consumer does can resume it — not `throw()`, not `return()`, both of
	// which an async generator queues behind the unanswered `next()`. A capacity slot returned
	// only by code that runs after that resumption is a slot that is never returned, and the
	// ordinary client disconnect is what triggers it.
	it('returns the capacity slot when a caller abandons a producer parked on its own source', async () => {
		const controller = new AbortController()
		const mcp = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: createServerTools(),
			limit: { subscriptions: 1 },
			subscription: {
				notifications: { promptsListChanged: true },
				producer: () => createIdleSource(),
			},
		})
		const params = { notifications: { promptsListChanged: true }, _meta: MODERN_METADATA }
		const abandoned = readStreamAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({ method: 'subscriptions/listen', id: 'parked-a', params }),
				{ signal: controller.signal },
			),
		)
		await abandoned.next()
		const stuck = abandoned.next()
		await waitForDelay()
		controller.abort(new Error('client went away'))
		await expect(stuck).rejects.toThrow('client went away')
		await waitForDelay()

		const admitted = readStreamAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({ method: 'subscriptions/listen', id: 'parked-b', params }),
			),
		)
		const first = await admitted.next()

		expect(first.done).toBe(false)
		admitted.stop()
	})

	// The same leak reached through the OTHER closure: an owner ending the exchange with
	// `stop()` rather than the caller aborting. Both run `MCPStreamController.#release`, so
	// both must return the slot, and a repair proved at one door is a hypothesis at the next.
	it('returns the capacity slot when an owner stops a subscription parked on its source', async () => {
		const mcp = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: createServerTools(),
			limit: { subscriptions: 1 },
			subscription: {
				notifications: { promptsListChanged: true },
				producer: () => createIdleSource(),
			},
		})
		const params = { notifications: { promptsListChanged: true }, _meta: MODERN_METADATA }
		const stopped = readStreamAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({ method: 'subscriptions/listen', id: 'stopped-a', params }),
			),
		)
		await stopped.next()
		const stuck = stopped.next()
		await waitForDelay()
		stopped.stop()
		await expect(stuck).rejects.toBeInstanceOf(DOMException)
		await waitForDelay()

		const admitted = readStreamAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({ method: 'subscriptions/listen', id: 'stopped-b', params }),
			),
		)
		const first = await admitted.next()

		expect(first.done).toBe(false)
		admitted.stop()
	})

	// The negative control the proofs above cannot do without: the same instrument aimed
	// at a server whose capacity is genuinely spent must REFUSE, or a passing admission proves
	// only that the limit was never enforced.
	it('still refuses a second subscription while the first is genuinely live', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const mcp = createMCPServer({
			identity: { name: 'bounded', version: '1.0.0' },
			tools: createServerTools(),
			limit: { subscriptions: 1 },
			subscription: {
				notifications: { promptsListChanged: true },
				producer: () => source.readable,
			},
		})
		const params = { notifications: { promptsListChanged: true }, _meta: MODERN_METADATA }
		const live = readStreamAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({ method: 'subscriptions/listen', id: 'live-a', params }),
			),
		)
		await live.next()
		const refused = readStreamAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({ method: 'subscriptions/listen', id: 'live-b', params }),
			),
		)

		const answer = await refused.next()
		if (answer.done !== true) throw new Error('expected the refusal as the terminal')
		expect(answer.value.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		live.stop()
	})

	it('produces no terminal for a subscription its caller aborted', async () => {
		const controller = new AbortController()
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const mcp = createTestServer(undefined, {
			notifications: { promptsListChanged: true },
			producer: () => source.readable,
		})
		const stream = readStreamAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'subscriptions/listen',
					id: 'aborted',
					params: { notifications: { promptsListChanged: true }, _meta: MODERN_METADATA },
				}),
				{ signal: controller.signal },
			),
		)
		await stream.next()
		const parked = stream.next()
		await waitForDelay()
		controller.abort(new Error('caller went away'))

		await expect(parked).rejects.toThrow('caller went away')
	})
})

describe('MCPServer — W02-A: what the egress boundary keeps doing', () => {
	// Nothing answers a notification, whatever its method — including the one the dated
	// revision reserves for cancellation, which this package recognizes nowhere and must
	// therefore treat as an ordinary unanswered call rather than a special case.
	it('answers no notification, through dispatch or handle', async () => {
		const mcp = createTestServer()
		mcp.methods.add('demo/stream', createHeldMethod)
		const methods = [
			'server/discover',
			'tools/list',
			'tools/call',
			'subscriptions/listen',
			'demo/stream',
			'notifications/initialized',
			'notifications/cancelled',
			'does/not/exist',
		]
		const dispatched: unknown[] = []
		const handled: unknown[] = []
		for (const method of methods) {
			const notification = createJSONRPCNotification(method, { _meta: MODERN_METADATA })
			dispatched.push(await mcp.dispatch(notification))
			handled.push(await mcp.handle(JSON.stringify(notification)))
		}

		expect(dispatched).toEqual(methods.map(() => undefined))
		expect(handled).toEqual(methods.map(() => undefined))
	})

	// Those vectors under the migrated codes: a provider's output is reached through
	// property access that can be revoked or can answer differently each time, and neither
	// escapes the boundary as a throw or as a second reading.
	it('contains a revoked and a drifting executor result as one detail-free -32603', async () => {
		const revocable = Proxy.revocable<Record<string, unknown>>(
			{ id: 'call', name: 'probe', success: true, value: 1 },
			{},
		)
		revocable.revoke()
		const reads = new MCPFixtureCell(0)
		const drifting = new Proxy(
			{ id: 'call', name: 'probe', success: true, value: 1 },
			{
				getOwnPropertyDescriptor(target, property) {
					const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
					if (property !== 'value' || descriptor === undefined) return descriptor
					reads.value += 1
					return { ...descriptor, value: reads.value }
				},
			},
		)
		for (const result of [revocable.proxy, drifting]) {
			const mcp = createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: createServerTools(),
				execution: () => {
					throw result
				},
			})
			const answer = readUnaryAnswer(await mcp.dispatch(buildModernCall({ name: 'probe' })))

			expect(answer?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
			expect(answer?.error?.message).toBe('Server error')
		}
	})

	// At the seam a consumer owns: a REGISTERED handler's own generator is controlled
	// too, so a producer that never settles cannot hold the answer open forever.
	it('controls a consumer’s own generator, so stopping it settles against a parked producer', async () => {
		const mcp = createTestServer()
		mcp.methods.add('demo/parked', async () => createIdleStream())
		const stream = readStreamAnswer(await mcp.dispatch(modernRequest('demo/parked', 'parked-1')))
		const reading = stream.next().catch((error: unknown) => error)
		await waitForDelay()

		stream.stop()

		expect(await reading).toBeInstanceOf(DOMException)
	})
})

// W02-B — ingress: admission, binding, and re-entry. Everything below is about what the
// server ADMITS and what it BINDS, as against W02-A's egress, which is about what leaves.
//
// Ordering is proved by NEGATIVE CALL COUNTERS, never by response codes. A refusal answers
// the same code whether the provider ran before it or after it, so a code assertion cannot
// separate "rejected after calling the principal resolver" from "rejected before calling
// it" — only a count can, and that separation is the whole claim of those controls.

// The modern metadata of a client that DOES declare form elicitation, so the capability gate
// is open and the ordering proofs measure something other than the gate.

// A schema with one required boolean and one bounded integer beside it — enough shape that
// an accepted response can be wrong in a way only the ISSUED schema knows about.

// One MRTR server wired for observation: every provider call keeps what it saw, the
// continuation port keeps every payload it was asked to protect, and the tool records the
// arguments it actually ran with. Real providers and a real ToolManager throughout.

// A modern `tools/call` carrying form-capable metadata; `params` names only what varies.

// Narrow one produced round to the values a client must echo back, plus what was issued.

// A subscription source that ends the moment it is opened — the acknowledgement and the
// terminal with nothing between them, for a scenario whose claim is about what the producer
// RECEIVED rather than about what it produced.

// Parse the nth payload the server sealed — the protected state exactly as it wrote it.

describe('MCPServer — W02-B: admission and the owned argument record', () => {
	// The sleeper: two argument-less calls share ONE frozen record, so a tool that
	// writes to its own `arguments` now fails — wire-visible as a tool failure with no
	// protocol change to point at.
	it('shares one frozen empty argument record, and a tool writing to it fails', async () => {
		const seen: unknown[] = []
		const manager = createToolManager()
		manager.add(
			createTool({
				name: 'observe',
				execute: (args) => {
					seen.push(args)
					return 1
				},
			}),
		)
		manager.add(
			createTool({
				name: 'mutate',
				execute: (args) => {
					const writable: Record<string, unknown> = args
					writable['injected'] = true
					return 2
				},
			}),
		)
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: manager,
		})

		await mcp.dispatch(buildModernCall({ name: 'observe' }, 'absent-1'))
		await mcp.dispatch(buildModernCall({ name: 'observe' }, 'absent-2'))
		const mutated = readUnaryAnswer(
			await mcp.dispatch(buildModernCall({ name: 'mutate' }, 'absent-3')),
		)

		expect(seen).toHaveLength(2)
		expect(seen[0]).toBe(EMPTY_MCP_ARGUMENTS)
		expect(seen[0]).toBe(seen[1])
		expect(Object.isFrozen(EMPTY_MCP_ARGUMENTS)).toBe(true)
		expect(Object.getPrototypeOf(EMPTY_MCP_ARGUMENTS)).toBe(null)
		expect(readResultRecord(mutated)['isError']).toBe(true)
	})

	// ONE argument reference reaches the digest, the selector, the canonical
	// call, and the executor. Identity is the claim — a resnapshot anywhere would hand the
	// selector a different object from the one the tool runs with.
	it('carries one argument reference through digest, selector, call, and execution', async () => {
		const calls: Array<Readonly<Record<string, unknown>>> = []
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			execution: (context) => {
				calls.push(context.call.arguments)
				return { id: context.call.id, name: context.call.name, success: true, value: 1 }
			},
			input: {
				continuation: new MemoryContinuation(),
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: (context) => {
					calls.push(context.arguments)
					return undefined
				},
			},
		})

		await mcp.dispatch(buildFormCall('identity-1', { arguments: { value: 7 } }))

		expect(calls).toHaveLength(2)
		expect(calls[0]).toBe(calls[1])
		expect(calls[0]).toEqual({ value: 7 })
		expect(Object.isFrozen(calls[0])).toBe(true)
	})

	// The clone is taken before any observer or await, so a caller mutating its own
	// request object while a provider is parked changes nothing the server later reads.
	it('owns the dispatched request before any observer, so deferred mutation changes nothing', async () => {
		const observed: Array<readonly [string, JSONRPCId | undefined, string]> = []
		const params: Record<string, unknown> = {
			name: 'echo',
			arguments: { value: 'original' },
			_meta: { ...FORM_METADATA },
		}
		const request: JSONRPCRequest = { jsonrpc: '2.0', method: 'tools/call', id: 'own-1', params }
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			on: {
				request: (method, id, era) => {
					observed.push([method, id, era])
					params['name'] = 'boom'
				},
			},
			input: {
				continuation: new MemoryContinuation(),
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: async () => {
					// Mutating the caller's own object mid-flight, at a real await point.
					params['arguments'] = { value: 'mutated' }
					await waitForDelay()
					return undefined
				},
			},
		})

		const answer = readUnaryAnswer(await mcp.dispatch(request))

		expect(observed).toEqual([['tools/call', 'own-1', 'modern']])
		expect(readResultRecord(answer)['structuredContent']).toEqual({ value: 'original' })
	})

	// Both directions: the `request` event fires ahead of the `_meta` bound check, so
	// an observer sees a call the bound check is about to refuse exactly as it sees one that
	// passes. Only SCALARS escape — method, id, era, nothing read out of the request graph.
	it('fires request before the _meta bound check, in both directions, carrying only scalars', async () => {
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			limit: { metadata: 256 },
		})
		const events = createRecorders<MCPServerEventMap, (typeof MCP_EVENTS)[number]>(
			mcp.emitter,
			MCP_EVENTS,
		)

		const refused = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 'bound-1',
					method: 'tools/list',
					params: { _meta: { ...MODERN_METADATA, padding: 'x'.repeat(512) } },
				}),
			),
		)
		const admitted = readUnaryAnswer(await mcp.dispatch(modernRequest('tools/list', 'bound-2')))

		expect(refused?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(admitted?.result).toMatchObject({ resultType: 'complete' })
		expect(events.request.calls).toEqual([
			['tools/list', 'bound-1', 'modern'],
			['tools/list', 'bound-2', 'modern'],
		])
		for (const call of events.request.calls) {
			for (const value of call) {
				expect(['string', 'number', 'undefined']).toContain(typeof value)
			}
		}
	})

	// `caller` is consumer-asserted and never verified, so it is carried by IDENTITY —
	// a revoked proxy reaches the handler intact precisely because nothing read it.
	it('carries a revoked-proxy caller to a handler by identity', async () => {
		const revocable = Proxy.revocable<Record<string, unknown>>({ subject: 'agent' }, {})
		revocable.revoke()
		const seen: unknown[] = []
		const mcp = createTestServer()
		mcp.methods.add('demo/caller', async (request, options) => {
			seen.push(options.caller)
			return buildJSONRPCResult(request.id, {})
		})

		await mcp.dispatch(modernRequest('demo/caller', 'caller-1'), { caller: revocable.proxy })

		expect(seen).toHaveLength(1)
		expect(seen[0]).toBe(revocable.proxy)
	})

	// `__proto__`, `constructor`, and `prototype` are legal own JSON keys. Bounding
	// first and owning second makes them inert DATA rather than a pollution vector — at both
	// doors, because `dispatch` and `handle` are different code paths.
	it('treats hostile own keys as inert data at both doors', async () => {
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
		})
		const hostile = {
			jsonrpc: '2.0',
			method: 'tools/call',
			id: 'hostile-1',
			params: {
				name: 'echo',
				arguments: { __proto__: { polluted: true }, constructor: 'c', prototype: 'p' },
				_meta: MODERN_METADATA,
			},
		}
		const wire = JSON.stringify(hostile)

		const dispatched = readUnaryAnswer(await mcp.dispatch(createJSONRPCRequest(JSON.parse(wire))))
		const handled = await mcp.handle(wire)

		expect(readResultRecord(dispatched)['structuredContent']).toEqual({
			constructor: 'c',
			prototype: 'p',
		})
		expect(typeof handled).toBe('string')
		expect(Object.prototype).not.toHaveProperty('polluted')
		expect({}).not.toHaveProperty('polluted')
	})
})

describe('MCPServer — W02-B: MRTR ordering, binding, and re-entry', () => {
	// The selector may run before the capability is known to be needed — only a
	// selector that ASKS for input makes the client's form capability relevant. Once it has
	// asked, the capability is checked BEFORE the principal resolver, and the counter is the
	// proof: a `-32021` says nothing about whether the resolver already ran.
	it('checks the form capability before the principal resolver is reached', async () => {
		const probe = createInputProbe()

		const refused = readUnaryAnswer(
			await probe.server.dispatch(
				createJSONRPCRequest({
					id: 'order-1',
					method: 'tools/call',
					params: {
						name: 'echo',
						_meta: { [MCP_META_VERSION]: '2026-07-28', [MCP_META_CAPABILITIES]: {} },
					},
				}),
			),
		)

		expect(refused?.error?.code).toBe(MCP_MISSING_CAPABILITY)
		expect(probe.selections).toHaveLength(1)
		expect(probe.principals).toHaveLength(0)
		expect(probe.continuation.sealed).toHaveLength(0)
	})

	// A declaration that PARSES and excludes every kind, and a `_meta` that does not parse at
	// all, are different failures and earn different codes. A legacy-projected call is the
	// first: it arrives with a stamped empty declaration, so it is gated. An unparsable
	// `_meta` is the second, on the first-round door and the retry door alike — the same
	// `-32602` the ingress gives it, in the same words, so one condition has one answer.
	it('separates an empty declaration from an unparsable one, at both MRTR doors', async () => {
		const probe = createInputProbe()
		const gated = readUnaryAnswer(
			await probe.server.dispatch(
				createJSONRPCRequest({
					id: 'reading-1',
					method: 'tools/call',
					params: {
						name: 'echo',
						_meta: { [MCP_META_VERSION]: '2026-07-28', [MCP_META_CAPABILITIES]: {} },
					},
				}),
			),
		)
		const first = readUnaryAnswer(
			await probe.server.dispatch(
				createJSONRPCRequest({
					id: 'reading-2',
					method: 'tools/call',
					params: {
						name: 'echo',
						_meta: { [MCP_META_VERSION]: '2026-07-28', [MCP_META_CAPABILITIES]: 'not a record' },
					},
				}),
			),
		)
		const continued = createInputProbe()
		const issued = readUnaryAnswer(await continued.server.dispatch(buildFormCall('reading-3')))
		const round = readInputRound(issued)
		const retry = readUnaryAnswer(
			await continued.server.dispatch(
				createJSONRPCRequest({
					id: 'reading-4',
					method: 'tools/call',
					params: {
						name: 'echo',
						requestState: round.requestState,
						inputResponses: { [round.key]: { action: 'accept' } },
						_meta: { [MCP_META_VERSION]: '2026-07-28', [MCP_META_CAPABILITIES]: 'not a record' },
					},
				}),
			),
		)

		expect(gated?.error?.code).toBe(MCP_MISSING_CAPABILITY)
		expect(first?.error).toEqual({
			code: JSONRPC_INVALID_PARAMS,
			message: 'Invalid params: malformed modern request metadata',
		})
		expect(retry?.error).toEqual({
			code: JSONRPC_INVALID_PARAMS,
			message: 'Invalid params: malformed modern request metadata',
		})
		// Neither unparsable call reached the policy at all, so neither cost a selector run:
		// the gated call is the only selection on the first probe, and the issued round is the
		// only one on the second.
		expect(probe.selections).toHaveLength(1)
		expect(continued.selections).toHaveLength(1)
	})

	// This server seals a carrier on every round it issues, so the pair stays required on the
	// retry it accepts: answers with no carrier answer a round this server never sent. The
	// CLIENT half of SEP-2322's stateless arm is `MCPCallOptions.input.state`, which is
	// optional because a different peer may issue a round with no state to return.
	it('refuses a retry carrying answers with no state, and one carrying state with no answers', async () => {
		const probe = createInputProbe()
		const issued = readUnaryAnswer(await probe.server.dispatch(buildFormCall('pairing-1')))
		const round = readInputRound(issued)
		const stateless = readUnaryAnswer(
			await probe.server.dispatch(
				buildFormCall('pairing-2', {
					inputResponses: { [round.key]: { action: 'accept' } },
				}),
			),
		)
		const answerless = readUnaryAnswer(
			await probe.server.dispatch(buildFormCall('pairing-3', { requestState: round.requestState })),
		)

		expect(stateless?.error).toEqual({
			code: JSONRPC_INVALID_PARAMS,
			message: 'Invalid params: `inputResponses` and `requestState` are required together',
		})
		expect(answerless?.error).toEqual({
			code: JSONRPC_INVALID_PARAMS,
			message: 'Invalid params: `inputResponses` and `requestState` are required together',
		})
		expect(probe.executions).toHaveLength(0)
	})

	// The selector's output is owned and frozen the moment it is produced, so a
	// provider that mutates what it returned changes neither what the client is asked nor
	// what the sealed state binds.
	it('owns the selector’s round and schema immediately', async () => {
		const continuation = new MemoryContinuation()
		const schema: MCPElicitSchema = {
			type: 'object',
			properties: { approved: { type: 'boolean' } },
		}
		const selected: MCPInputRound = createRound(
			{ message: 'Approve?', requestedSchema: schema },
			{
				round: 1,
			},
		)
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			input: {
				continuation,
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: () => selected,
			},
		})

		const first = readUnaryAnswer(await mcp.dispatch(buildFormCall('own-schema-1')))
		// Deferred mutation of the very objects the selector handed back — a provider is free
		// to keep and rewrite what it returned, and nothing the server issued may follow.
		Reflect.set(schema, 'properties', { approved: { type: 'string' } })
		Reflect.set(selected, 'state', { round: 99 })
		const round = readInputRound(first)
		const state = parseMCPInputState(continuation.sealed[0])

		expect(round.issued).toEqual({
			method: 'elicitation/create',
			params: {
				message: 'Approve?',
				requestedSchema: { type: 'object', properties: { approved: { type: 'boolean' } } },
			},
		})
		expect(state?.requests).toEqual({
			approval: {
				method: 'elicitation/create',
				params: {
					message: 'Approve?',
					requestedSchema: { type: 'object', properties: { approved: { type: 'boolean' } } },
				},
			},
		})
		expect(state?.state).toEqual({ round: 1 })
	})

	// The carried state and its verification together, because neither is worth anything alone: the state carries the
	// EXACT issued schema, and the accepted response is checked against THAT schema rather
	// than against the shape of a response in general.
	it('binds the issued schema into protected state and enforces it on the accepted response', async () => {
		const probe = createInputProbe({ schema: APPROVAL_SCHEMA })
		const first = readUnaryAnswer(await probe.server.dispatch(buildFormCall('schema-1')))
		const round = readInputRound(first)
		const state = readSealedState(probe, 0)
		const answers: Array<JSONRPCResponse | undefined> = []
		const contents: ReadonlyArray<Readonly<Record<string, unknown>>> = [
			{ approved: true, count: 2.5 },
			{ approved: true, count: 9 },
			{ count: 2 },
			{ approved: 'yes' },
		]

		for (const [index, content] of contents.entries()) {
			answers.push(
				readUnaryAnswer(
					await probe.server.dispatch(
						buildFormCall(`schema-refused-${index}`, {
							requestState: round.requestState,
							inputResponses: { [round.key]: { action: 'accept', content } },
						}),
					),
				),
			)
		}
		const accepted = readUnaryAnswer(
			await probe.server.dispatch(
				buildFormCall('schema-accepted', {
					requestState: round.requestState,
					inputResponses: {
						[round.key]: { action: 'accept', content: { approved: true, count: 2, extra: 'kept' } },
					},
				}),
			),
		)

		expect(state.requests[round.key]).toEqual({
			method: 'elicitation/create',
			params: { message: 'Approve round 1?', requestedSchema: APPROVAL_SCHEMA },
		})
		expect(answers.map((answer) => answer?.error?.code)).toEqual([
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
		])
		expect(accepted?.result).toMatchObject({ resultType: 'complete' })
		expect(probe.executions).toHaveLength(1)
	})

	// The capability gate is about what the server SENDS, so it measures the round and stands
	// ahead of the seal wherever a round is issued — and on a FIRST round ahead of the principal
	// resolver too, so a client whose round this server may not send costs no principal lookup.
	it('checks the capability before the principal resolver and the seal on a first round', async () => {
		const probe = createInputProbe()

		const refused = readUnaryAnswer(
			await probe.server.dispatch(
				createJSONRPCRequest({
					id: 'first-cap-1',
					method: 'tools/call',
					params: {
						name: 'echo',
						_meta: { [MCP_META_VERSION]: '2026-07-28', [MCP_META_CAPABILITIES]: {} },
					},
				}),
			),
		)

		expect(refused?.error?.code).toBe(MCP_MISSING_CAPABILITY)
		expect(probe.principals).toHaveLength(0)
		expect(probe.continuation.sealed).toHaveLength(0)
		expect(probe.executions).toHaveLength(0)
	})

	// The other half of the same rule: a RETRY answers a round this server already gated, so
	// what the gate measures there is the NEXT round. A retry the selector answers with
	// `undefined` sends nothing, so it runs the tool however the client's declaration narrowed.
	it('gates the next round rather than the answered one on a retry', async () => {
		const probe = createInputProbe()
		const first = readUnaryAnswer(await probe.server.dispatch(buildFormCall('retry-cap-1')))
		const round = readInputRound(first)

		const answered = readUnaryAnswer(
			await probe.server.dispatch(
				createJSONRPCRequest({
					id: 'retry-cap-2',
					method: 'tools/call',
					params: {
						name: 'echo',
						requestState: round.requestState,
						inputResponses: { [round.key]: { action: 'accept' } },
						_meta: { [MCP_META_VERSION]: '2026-07-28', [MCP_META_CAPABILITIES]: {} },
					},
				}),
			),
		)

		expect(answered?.result).toMatchObject({ resultType: 'complete' })
		expect(probe.executions).toHaveLength(1)
	})

	// Distinct failures at the continuation port, distinct answers: a
	// carrier the port cannot recover is the CLIENT's invalid state (`-32602`); a port that
	// opens successfully onto a payload this server never authored is the PROVIDER's contract
	// failure (`-32603`, detail-free, reported once on `error`).
	it('separates an unrecoverable carrier from a malformed opened payload', async () => {
		const probe = createInputProbe()
		const faults = createRecorders<MCPServerEventMap, 'error'>(probe.server.emitter, ['error'])
		const first = readUnaryAnswer(await probe.server.dispatch(buildFormCall('taxonomy-1')))
		const round = readInputRound(first)

		const unrecoverable = readUnaryAnswer(
			await probe.server.dispatch(
				buildFormCall('taxonomy-2', {
					requestState: 'not-a-carrier',
					inputResponses: { [round.key]: { action: 'accept' } },
				}),
			),
		)
		probe.continuation.corrupt('{"principal":"operator-1"}')
		const malformed = readUnaryAnswer(
			await probe.server.dispatch(
				buildFormCall('taxonomy-3', {
					requestState: round.requestState,
					inputResponses: { [round.key]: { action: 'accept' } },
				}),
			),
		)

		expect(unrecoverable?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(malformed?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(malformed?.error?.message).toBe('Server error')
		expect(faults.error.count).toBe(1)
	})

	// Every structural binding is verified before the principal resolver runs. The
	// counter is the claim — a structurally invalid retry answers `-32602` either way.
	it('verifies every structural binding before resolving the principal', async () => {
		const probe = createInputProbe()
		const first = readUnaryAnswer(await probe.server.dispatch(buildFormCall('structure-1')))
		const round = readInputRound(first)
		const principals = probe.principals.length
		const refusals: Array<number | undefined> = []
		const retries: ReadonlyArray<readonly [JSONRPCId, Readonly<Record<string, unknown>>]> = [
			['structure-2', { arguments: { changed: true } }],
			['structure-3', { inputResponses: { unrelated: { action: 'accept' } } }],
			['structure-1', {}],
			['structure-4', { name: 'other' }],
		]

		for (const [id, overrides] of retries) {
			refusals.push(
				readUnaryAnswer(
					await probe.server.dispatch(
						buildFormCall(id, {
							requestState: round.requestState,
							inputResponses: { [round.key]: { action: 'accept' } },
							...overrides,
						}),
					),
				)?.error?.code,
			)
		}

		expect(refusals).toEqual([
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
		])
		expect(probe.principals).toHaveLength(principals)
		expect(probe.executions).toHaveLength(0)
	})

	// Over three rounds. The ORIGINAL id stays bound while the round and its expiry are
	// re-minted each time — two rounds cannot tell these apart, because round 2
	// binds round 1's id under either rule. Round 3 is where sealing the CURRENT id starts
	// binding round 2's id instead of round 1's.
	it('binds the original id across three rounds while re-minting the round and its expiry', async () => {
		const probe = createInputProbe({ rounds: 2, schema: APPROVAL_SCHEMA })

		const first = readUnaryAnswer(await probe.server.dispatch(buildFormCall('origin-1')))
		const round1 = readInputRound(first)
		const second = readUnaryAnswer(
			await probe.server.dispatch(
				buildFormCall('round-2', {
					requestState: round1.requestState,
					inputResponses: { [round1.key]: { action: 'accept', content: { approved: true } } },
				}),
			),
		)
		const round2 = readInputRound(second)
		const third = readUnaryAnswer(
			await probe.server.dispatch(
				buildFormCall('round-3', {
					requestState: round2.requestState,
					inputResponses: { [round2.key]: { action: 'accept', content: { approved: false } } },
				}),
			),
		)
		const one = readSealedState(probe, 0)
		const two = readSealedState(probe, 1)

		expect(probe.continuation.sealed).toHaveLength(2)
		expect(one.id).toBe('origin-1')
		expect(two.id).toBe('origin-1')
		expect(two.requests).not.toEqual(one.requests)
		expect(two.requests[round2.key]).toEqual({
			method: 'elicitation/create',
			params: { message: 'Approve round 2?', requestedSchema: APPROVAL_SCHEMA },
		})
		expect(two.expiry).toBeGreaterThanOrEqual(one.expiry)
		expect(two.principal).toBe(one.principal)
		expect(two.version).toBe(one.version)
		expect(two.method).toBe(one.method)
		expect(two.name).toBe(one.name)
		expect(two.digest).toBe(one.digest)
		expect(two.state).toEqual({ round: 2 })
		expect(third?.result).toMatchObject({ resultType: 'complete' })
		expect(probe.executions).toHaveLength(1)
	})

	// Extra response keys are IGNORED — the server assigned exactly one key and cares
	// about exactly that one. Omitting the issued key remains a refusal.
	it('ignores extra inputResponses keys and still requires the issued one', async () => {
		const probe = createInputProbe()
		const first = readUnaryAnswer(await probe.server.dispatch(buildFormCall('extra-1')))
		const round = readInputRound(first)

		const extra = readUnaryAnswer(
			await probe.server.dispatch(
				buildFormCall('extra-2', {
					requestState: round.requestState,
					inputResponses: {
						[round.key]: { action: 'accept' },
						unrelated: { action: 'decline' },
						alsoUnrelated: 'not even a response',
					},
				}),
			),
		)
		const omitted = readUnaryAnswer(
			await probe.server.dispatch(
				buildFormCall('extra-3', {
					requestState: round.requestState,
					inputResponses: { unrelated: { action: 'decline' } },
				}),
			),
		)

		expect(extra?.result).toMatchObject({ resultType: 'complete' })
		expect(omitted?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(probe.executions).toHaveLength(1)
	})

	it('refuses an expired continuation before retry selection', async () => {
		const clock = createManualClock(2 * Date.now())
		const probe = createInputProbe({ ttl: 20, clock: clock.now })
		const round = readInputRound(
			readUnaryAnswer(await probe.server.dispatch(buildFormCall('admission-1'))),
		)
		clock.advance(20)

		const retry = readUnaryAnswer(
			await probe.server.dispatch(
				buildFormCall('admission-2', {
					requestState: round.requestState,
					inputResponses: { [round.key]: { action: 'accept' } },
				}),
			),
		)

		expect(retry?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(probe.selections).toHaveLength(1)
		expect(probe.executions).toHaveLength(0)
	})

	it('refuses a continuation that expires before resealing reaches the provider', async () => {
		const clock = createManualClock(2 * Date.now())
		const probe = createInputProbe({
			rounds: 2,
			ttl: 4,
			// A ticking source lets the prior window lapse between selection and sealing.
			clock: () => {
				clock.advance(1)
				return clock.now()
			},
		})
		const round = readInputRound(
			readUnaryAnswer(await probe.server.dispatch(buildFormCall('preseal-1'))),
		)

		const retry = readUnaryAnswer(
			await probe.server.dispatch(
				buildFormCall('preseal-2', {
					requestState: round.requestState,
					inputResponses: { [round.key]: { action: 'accept' } },
				}),
			),
		)

		expect(retry?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(probe.selections).toHaveLength(2)
		expect(probe.continuation.sealed).toHaveLength(1)
		expect(probe.executions).toHaveLength(0)
	})

	// Expiry is rechecked after the selector's await — the LAST provider await
	// before execution — so a continuation that lapsed while the selector was parked never
	// reaches the tool.
	it('rechecks expiry after the selector’s await, so an expired continuation never executes', async () => {
		const clock = createManualClock(2 * Date.now())
		const probe = createInputProbe({
			ttl: 20,
			clock: clock.now,
			selector: (context) => {
				if (context.responses !== undefined) clock.advance(21)
			},
		})
		const first = readUnaryAnswer(await probe.server.dispatch(buildFormCall('expiry-1')))
		const round = readInputRound(first)

		const late = readUnaryAnswer(
			await probe.server.dispatch(
				buildFormCall('expiry-2', {
					requestState: round.requestState,
					inputResponses: { [round.key]: { action: 'accept' } },
				}),
			),
		)

		expect(late?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(probe.selections).toHaveLength(2)
		expect(probe.executions).toHaveLength(0)
	})

	// The other half of that claim: a further round reseals, and the PRIOR window is rechecked after
	// that seal — a port that took longer than the window it was extending must not hand back
	// a round built on a continuation that has already lapsed.
	it('rechecks the prior expiry after the seal await', async () => {
		const clock = createManualClock(2 * Date.now())
		const probe = createInputProbe({
			rounds: 2,
			ttl: 25,
			clock: clock.now,
			seal: (count) => {
				if (count === 2) clock.advance(16)
			},
		})
		const first = readUnaryAnswer(await probe.server.dispatch(buildFormCall('reseal-1')))
		const round = readInputRound(first)
		clock.advance(10)

		const second = readUnaryAnswer(
			await probe.server.dispatch(
				buildFormCall('reseal-2', {
					requestState: round.requestState,
					inputResponses: { [round.key]: { action: 'accept' } },
				}),
			),
		)

		expect(second?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(isMCPInputResult(second?.result)).toBe(false)
		expect(probe.continuation.sealed).toHaveLength(2)
	})

	// A FIRST round has no retry to refuse. When the port takes longer to protect the state
	// than the state was good for, the round is dead on arrival either way — but a caller who
	// has sent one request and been told its state "could not be verified for this retry" is
	// being pointed at a round it never made, and will go looking for a carrier it never had.
	it('tells a first-round caller its state expired rather than naming a retry', async () => {
		const clock = createManualClock(2 * Date.now())
		const probe = createInputProbe({ ttl: 20, clock: clock.now, seal: () => clock.advance(21) })

		const first = readUnaryAnswer(await probe.server.dispatch(buildFormCall('unissued-1')))

		expect(first?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(first?.error?.message).toBe(
			'Invalid params: request state expired before it could be issued',
		)
		expect(isMCPInputResult(first?.result)).toBe(false)
	})

	// Its counterpart, and the reason the branch is a branch: a caller that DID send a retry
	// still gets the retry wording, so the split names the round the caller is actually in.
	it('still names the retry when a further round reseals past the prior window', async () => {
		const clock = createManualClock(2 * Date.now())
		const probe = createInputProbe({
			rounds: 2,
			ttl: 25,
			clock: clock.now,
			seal: (count) => {
				if (count === 2) clock.advance(16)
			},
		})
		const first = readUnaryAnswer(await probe.server.dispatch(buildFormCall('named-1')))
		const round = readInputRound(first)
		clock.advance(10)

		const second = readUnaryAnswer(
			await probe.server.dispatch(
				buildFormCall('named-2', {
					requestState: round.requestState,
					inputResponses: { [round.key]: { action: 'accept' } },
				}),
			),
		)

		expect(second?.error?.message).toBe(
			'Invalid params: request state could not be verified for this retry',
		)
		expect(probe.continuation.sealed).toHaveLength(2)
	})

	// The NEGATIVE CONTROL for a rule this package deliberately does NOT have. There
	// is no consume-once, no session binding, no timer, and no replay store: the same
	// protected state answers twice under two fresh ids. If single use is ever introduced —
	// as an accident or as a design change — this is the row that fires.
	it('introduces no consume-once: one protected state answers twice under fresh ids', async () => {
		const probe = createInputProbe()
		const first = readUnaryAnswer(await probe.server.dispatch(buildFormCall('replay-1')))
		const round = readInputRound(first)

		const once = readUnaryAnswer(
			await probe.server.dispatch(
				buildFormCall('replay-2', {
					requestState: round.requestState,
					inputResponses: { [round.key]: { action: 'accept' } },
				}),
			),
		)
		const twice = readUnaryAnswer(
			await probe.server.dispatch(
				buildFormCall('replay-3', {
					requestState: round.requestState,
					inputResponses: { [round.key]: { action: 'accept' } },
				}),
			),
		)

		expect(once?.result).toMatchObject({ resultType: 'complete' })
		expect(twice?.result).toMatchObject({ resultType: 'complete' })
		expect(probe.executions).toHaveLength(2)
	})

	// A throwing selector or principal resolver is contained — one detail-free
	// `-32603` on the wire, the caught value on `error`, exactly once.
	it('contains a throwing selector and principal as one detail-free -32603 reported once', async () => {
		for (const failing of ['selector', 'principal'] as const) {
			const mcp = createMCPServer({
				identity: { name: 'test-server', version: '1.2.3' },
				tools: createServerTools(),
				input: {
					continuation: new MemoryContinuation(),
					ttl: 1_000,
					principal: () => {
						if (failing === 'principal') throw new Error(`${failing} provider detail`)
						return 'operator-1'
					},
					selector: () => {
						if (failing === 'selector') throw new Error(`${failing} provider detail`)
						return createRound()
					},
				},
			})
			const faults = createRecorders<MCPServerEventMap, 'error'>(mcp.emitter, ['error'])

			const answer = readUnaryAnswer(await mcp.dispatch(buildFormCall(`contained-${failing}`)))

			expect(answer?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
			expect(JSON.stringify(answer)).not.toContain('provider detail')
			expect(faults.error.count).toBe(1)
		}
	})

	// `input_required` is produced by the built-in `tools/call` and by nothing else,
	// even under an input policy that would ask on every call it reached.
	it('produces input_required from the built-in tools/call alone', async () => {
		const probe = createInputProbe()
		const answers = [
			readUnaryAnswer(await probe.server.dispatch(modernRequest('server/discover', 'only-1'))),
			readUnaryAnswer(await probe.server.dispatch(modernRequest('tools/list', 'only-2'))),
		]

		for (const answer of answers) {
			expect(isMCPInputResult(answer?.result)).toBe(false)
		}
		expect(probe.selections).toHaveLength(0)
	})
})

describe('MCPServer — W02-B: custom carriers and the resolved-option seam', () => {
	// The blanket non-tool rejection is gone, so a REGISTERED `prompts/get`
	// receives its continuation carrier as an owned frozen record and owns its own
	// continuation semantics. The negative half is a call COUNTER, not a response code:
	// a carrier core refuses at the door never reaches the handler at all.
	it('delivers an owned carrier to a registered prompts/get and refuses malformed ones first', async () => {
		const seen: JSONRPCInvocation[] = []
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			limit: { metadata: 512 },
		})
		mcp.methods.add('prompts/get', async (request) => {
			seen.push(request)
			return buildJSONRPCResult(request.id, { resultType: 'complete' })
		})
		const malformed = [
			// `_meta` beyond the configured bound — refused before the registry is consulted.
			createJSONRPCRequest({
				id: 'carrier-2',
				method: 'prompts/get',
				params: { requestState: 'x', _meta: { ...MODERN_METADATA, padding: 'y'.repeat(2048) } },
			}),
			// Nested past the depth bound — refused at the dispatch door.
			createJSONRPCRequest({
				id: 'carrier-3',
				method: 'prompts/get',
				params: { requestState: buildNestedRecord(64), _meta: MODERN_METADATA },
			}),
			// A carrier that is not JSON at all.
			createJSONRPCRequest({
				id: 'carrier-4',
				method: 'prompts/get',
				params: { requestState: () => 'nope', _meta: MODERN_METADATA },
			}),
			// An unsupported revision — refused before the registry is consulted.
			createJSONRPCRequest({
				id: 'carrier-5',
				method: 'prompts/get',
				params: {
					requestState: 'x',
					_meta: { [MCP_META_VERSION]: '1999-01-01', [MCP_META_CAPABILITIES]: {} },
				},
			}),
		]
		const refusals: Array<number | undefined> = []

		const answered = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 'carrier-1',
					method: 'prompts/get',
					params: {
						name: 'greeting',
						requestState: 'opaque-carrier',
						inputResponses: { key: { action: 'accept' } },
						_meta: MODERN_METADATA,
					},
				}),
			),
		)
		const delivered = seen[0]
		for (const request of malformed) {
			refusals.push(readUnaryAnswer(await mcp.dispatch(request))?.error?.code)
		}

		expect(answered?.result).toEqual({ resultType: 'complete' })
		expect(delivered?.params).toEqual({
			name: 'greeting',
			requestState: 'opaque-carrier',
			inputResponses: { key: { action: 'accept' } },
			_meta: MODERN_METADATA,
		})
		expect(Object.isFrozen(delivered?.params)).toBe(true)
		expect(refusals).toEqual([
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_REQUEST,
			JSONRPC_INVALID_REQUEST,
			MCP_UNSUPPORTED_VERSION,
		])
		// The counter is the claim: not one malformed carrier reached the handler.
		expect(seen).toHaveLength(1)
	})

	// Separate claims, deliberately kept apart because one instrument cannot carry them together.
	// The arity check guards the PARAMETER at the registration seam: a member binds the resolved
	// options only where it spends them. `server/discover` and `tools/list` are live registry
	// reads with no await, so they have no cancellation point to spend a signal on and take the
	// request alone; `tools/call` and `subscriptions/listen` take both. `MCPMethodHandler`
	// declares both parameters and admits a handler taking fewer, so the seam stays one contract
	// either way. The arity says nothing about what a member then does with the value —
	// substituting a different options object survives it — which is why the resolved VALUE is
	// proved separately, at the built-ins that own provider hooks, caller identity and signal
	// together.
	it('resolves options into every built-in registration', async () => {
		const listened: MCPMethodOptions[] = []
		const probe = createInputProbe()
		const caller = Object.freeze({ subject: 'options-user' })
		const controller = new AbortController()
		const mcp = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			subscription: {
				notifications: {},
				producer: (_notifications, options) => {
					listened.push(options)
					return createSilentSource()
				},
			},
		})
		const arities = ['server/discover', 'tools/list', 'tools/call', 'subscriptions/listen'].map(
			(name) => mcp.methods.method(name)?.length,
		)

		await probe.server.dispatch(buildFormCall('propagate-1'), { caller, signal: controller.signal })
		const stream = readStreamAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 'propagate-2',
					method: 'subscriptions/listen',
					params: { notifications: {}, _meta: MODERN_METADATA },
				}),
				{ caller, signal: controller.signal },
			),
		)
		await drainStream(stream)

		expect(arities).toEqual([1, 1, 2, 2])
		expect(probe.principals).toHaveLength(1)
		expect(probe.principals[0]?.caller).toBe(caller)
		expect(probe.principals[0]?.signal).toBeInstanceOf(AbortSignal)
		expect(listened).toHaveLength(1)
		expect(listened[0]?.caller).toBe(caller)
		expect(listened[0]?.signal).toBeInstanceOf(AbortSignal)
	})
})

// ── W03-A: the stable Tasks extension ────────────────────────────────────────
//
// The extension puts the whole task lifecycle on the CONSUMER's side of a port, so what
// is under test here is a decision and an answer: does this server defer, and does it
// report what the manager created without adding anything of its own. Every control is
// drawn from outside the population its claim describes — the other method family for the
// capability gate, a connect-time declaration for the per-request rule, and a manager that
// binds the request's signal for the lifetime hazard.

// A modern `tools/call` whose client DECLARES the tasks extension on the request itself,
// which is the only place the extension recognizes a declaration.

// One `tasks/*` request from a client that DECLARED the extension on the request itself.

// Create one task through the deferral seam and answer the handle the client received —
// the only way a `taskId` legitimately reaches a client, so every lifecycle test below
// starts where a real one does.

// A manager that answers one fixed creation and nothing else — the inert stub for the
// scenarios about what MCP does with what a manager returned.

describe('MCPServer — W03-A: the stable Tasks extension', () => {
	it('defers a declared call and answers the manager task as a flat modern result', async () => {
		const tasks = new TestTaskManager()
		const mcp = createTaskFixtureServer({ tasks, deferral: () => 'operation-1' })

		const answer = readResultRecord(
			readUnaryAnswer(
				await mcp.dispatch(buildTaskCall({ name: 'echo', arguments: { a: 1 } }, 'defer-1')),
			),
		)

		expect(answer['resultType']).toBe('task')
		expect(answer['status']).toBe('working')
		expect(answer['ttlMs']).toBeNull()
		expect(answer['taskId']).toBe(tasks.details[0]?.taskId)
		expect(answer['createdAt']).toBe('1970-01-01T00:00:01.000Z')
		expect(answer['lastUpdatedAt']).toBe('1970-01-01T00:00:01.000Z')
		expect(answer['_meta']).toEqual({
			[MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' },
		})
		// FLAT, not `{ task: ... }`, and carrying no terminal payload for a task with no outcome.
		expect(Object.hasOwn(answer, 'task')).toBe(false)
		expect(Object.hasOwn(answer, 'result')).toBe(false)
		expect(Object.hasOwn(answer, 'content')).toBe(false)
	})

	// The `-32003` control, drawn from the OTHER method family: the same undeclared client
	// that would be refused on `tasks/get` must get an ordinary answer here, because deferral
	// is server-decided and this client never asked for one.
	it('refuses a deployment-selected task when the request lacks the capability', async () => {
		const tasks = new TestTaskManager()
		const deferrals: MCPTaskContext[] = []
		const mcp = createTaskFixtureServer({
			tasks,
			deferral: (context) => {
				deferrals.push(context)
				return 'operation-1'
			},
		})

		const answerResponse = await mcp.dispatch(
			buildModernCall({ name: 'echo', arguments: { a: 1 } }, 'plain-1'),
		)
		const answer = readUnaryAnswer(answerResponse)?.error

		expect(answer?.code).toBe(MCP_MISSING_CAPABILITY)
		expect(deferrals).toHaveLength(1)
		expect(tasks.starts).toHaveLength(0)
	})

	// The per-request control: the exact shape a session-oriented implementation would
	// wrongly accept — the capability declared during `initialize` and absent from the call.
	it('does not reuse a capability declared at connect time for a later request', async () => {
		const tasks = new TestTaskManager()
		const mcp = createTaskFixtureServer({ tasks, deferral: () => 'operation-1' })

		await mcp.dispatch(
			createJSONRPCRequest({
				id: 'connect-1',
				method: 'initialize',
				params: { protocolVersion: '2025-11-25', capabilities: TASK_CAPABILITIES },
			}),
		)
		const answerResponse = await mcp.dispatch(buildModernCall({ name: 'echo' }, 'connect-2'))
		const answer = readUnaryAnswer(answerResponse)?.error

		expect(answer?.code).toBe(MCP_MISSING_CAPABILITY)
		expect(tasks.starts).toHaveLength(0)
	})

	it('runs the call inline when the deferral policy declines', async () => {
		const tasks = new TestTaskManager()
		const mcp = createTaskFixtureServer({ tasks, deferral: () => undefined })

		const answer = readResultRecord(
			readUnaryAnswer(
				await mcp.dispatch(buildTaskCall({ name: 'echo', arguments: { a: 1 } }, 'decline-1')),
			),
		)

		expect(answer['resultType']).toBe('complete')
		expect(answer['structuredContent']).toEqual({ a: 1 })
		expect(tasks.starts).toHaveLength(0)
	})

	// MCP's OWN behaviour, outside the manager population every other dedup claim is about:
	// whatever the policy minted travels to the manager unchanged, twice.
	it('forwards a repeated operation key to the manager unchanged', async () => {
		const tasks = new TestTaskManager()
		const mcp = createTaskFixtureServer({ tasks, deferral: () => ' Operation/One ' })

		const first = readResultRecord(
			readUnaryAnswer(await mcp.dispatch(buildTaskCall({ name: 'echo' }, 'reuse-1'))),
		)
		const second = readResultRecord(
			readUnaryAnswer(await mcp.dispatch(buildTaskCall({ name: 'echo' }, 'reuse-2'))),
		)

		expect(tasks.starts.map((entry) => entry[0])).toEqual([' Operation/One ', ' Operation/One '])
		expect(second['taskId']).toBe(first['taskId'])
		expect(tasks.details).toHaveLength(1)
	})

	// Precedence, first half: a call still asking its operator a question has not been decided
	// yet, so the input mechanism resolves before the task decision is ever reached.
	it('resolves the multi-round input mechanism before it considers a task', async () => {
		const tasks = new TestTaskManager()
		const deferrals: MCPTaskContext[] = []
		const mcp = createTaskFixtureServer(
			{
				tasks,
				deferral: (context) => {
					deferrals.push(context)
					return 'operation-1'
				},
			},
			{
				input: {
					continuation: new MemoryContinuation(),
					ttl: 1_000,
					principal: () => 'operator-1',
					selector: () => createRound(),
				},
			},
		)

		const answer = readResultRecord(
			readUnaryAnswer(
				await mcp.dispatch(
					createJSONRPCRequest({
						id: 'precedence-1',
						method: 'tools/call',
						params: {
							name: 'echo',
							_meta: {
								[MCP_META_VERSION]: '2026-07-28',
								[MCP_META_CAPABILITIES]: { elicitation: {}, ...TASK_CAPABILITIES },
							},
						},
					}),
				),
			),
		)

		expect(answer['resultType']).toBe('input_required')
		expect(deferrals).toHaveLength(0)
		expect(tasks.starts).toHaveLength(0)
	})

	// Precedence, second half: a deferred call has no request-scoped stream left to report
	// progress on, so the task answer replaces the progress stream rather than racing it.
	it('answers a unary task instead of opening a progress stream', async () => {
		const tasks = new TestTaskManager()
		const reported: MCPProgressInterface[] = []
		const mcp = createTaskFixtureServer(
			{ tasks, deferral: () => 'operation-1' },
			{
				execution: (context) => {
					if (context.progress !== undefined) reported.push(context.progress)
					return { id: context.call.id, name: context.call.name, success: true, value: 'inline' }
				},
			},
		)

		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				id: 'progress-1',
				method: 'tools/call',
				params: { name: 'echo', _meta: { ...TASK_METADATA, progressToken: 'token-1' } },
			}),
		)

		expect(answer !== undefined && Symbol.asyncIterator in answer).toBe(false)
		expect(readResultRecord(readUnaryAnswer(answer))['resultType']).toBe('task')
		expect(reported).toHaveLength(0)
	})

	// The port's shape, asserted structurally: `MCPTaskContext` carries no cancellation
	// signal, and the accompanying options carry the request's.
	it('supplies the call in hand with no cancellation signal of its own', async () => {
		const tasks = new TestTaskManager()
		const deferrals: MCPTaskContext[] = []
		const mcp = createTaskFixtureServer({
			tasks,
			deferral: (context) => {
				deferrals.push(context)
				return 'operation-1'
			},
		})
		const call = buildTaskCall({ name: 'sum', arguments: { a: 2, b: 3 } }, 'context-1')

		await mcp.dispatch(call, { caller: 'asserted' })

		const context = deferrals[0]
		if (context === undefined) throw new Error('expected the deferral policy to be consulted')
		expect(Object.keys(context).sort()).toEqual(['call', 'request', 'tools'])
		expect(Object.hasOwn(context, 'signal')).toBe(false)
		expect(context.request).toEqual(call)
		expect(context.call).toEqual({
			id: 'context-1',
			name: 'sum',
			arguments: { a: 2, b: 3 },
		})
		expect(tasks.starts[0]?.[1]).toBe(context)
		expect(tasks.starts[0]?.[2].signal).toBeInstanceOf(AbortSignal)
		expect(tasks.starts[0]?.[2].caller).toBe('asserted')
	})

	// THE FIXTURE PAIR the port's TSDoc obligation closes on. The managers differ in one
	// flag and are driven identically, including the abort every transport performs the
	// instant the answer is written. A `completed` in the first case would mean the hazard
	// the TSDoc names does not exist and the paragraph must be deleted.
	it('loses the task when the manager binds the request signal to the work', async () => {
		const tasks = new TestTaskManager({ bind: true, work: 30 })
		const mcp = createTaskFixtureServer({ tasks, deferral: () => 'operation-1' })
		const lifetime = new AbortController()

		const answer = readResultRecord(
			readUnaryAnswer(
				await mcp.dispatch(buildTaskCall({ name: 'echo' }, 'bound-1'), { signal: lifetime.signal }),
			),
		)
		// Exactly what `createMCPHandler` does: the request's signal ends with the response.
		lifetime.abort()
		await tasks.settle()

		const detail = await tasks.task(String(answer['taskId']))
		// The answer was a perfectly good task handle — which is what makes the loss silent.
		expect(answer['resultType']).toBe('task')
		expect(answer['status']).toBe('working')
		expect(detail?.status).toBe('cancelled')
	})

	it('keeps the task when the manager gives the work a lifetime it owns', async () => {
		const tasks = new TestTaskManager({ bind: false, work: 30 })
		const mcp = createTaskFixtureServer({ tasks, deferral: () => 'operation-1' })
		const lifetime = new AbortController()

		const answer = readResultRecord(
			readUnaryAnswer(
				await mcp.dispatch(buildTaskCall({ name: 'echo' }, 'unbound-1'), {
					signal: lifetime.signal,
				}),
			),
		)
		lifetime.abort()
		await tasks.settle()

		const detail = await tasks.task(String(answer['taskId']))
		expect(answer['resultType']).toBe('task')
		expect(answer['status']).toBe('working')
		expect(detail?.status).toBe('completed')
	})

	// The `-32603` control, drawn from the arm it must not be confused with: a manager that
	// reports a non-`working` status is answering SUCCESSFULLY, so the client learns the
	// status from the result rather than from a protocol error.
	it('answers a successful task result for a task the manager started as input_required', async () => {
		const tasks = new TestTaskManager({ asking: true })
		const mcp = createTaskFixtureServer({ tasks, deferral: () => 'operation-1' })

		const response = readUnaryAnswer(
			await mcp.dispatch(buildTaskCall({ name: 'echo' }, 'asking-1')),
		)
		const answer = readResultRecord(response)

		expect(response?.error).toBeUndefined()
		expect(answer['resultType']).toBe('task')
		expect(answer['status']).toBe('input_required')
		// The requests the task published stay on the TASK, not on this creation answer.
		expect(Object.hasOwn(answer, 'inputRequests')).toBe(false)
	})

	it('contains a deferral policy throw as a detail-free internal error', async () => {
		const tasks = new TestTaskManager()
		const mcp = createTaskFixtureServer({
			tasks,
			deferral: () => {
				throw new Error('deferral policy detail')
			},
		})
		const faults: unknown[] = []
		mcp.emitter.on('error', (error) => void faults.push(error))

		const response = readUnaryAnswer(await mcp.dispatch(buildTaskCall({ name: 'echo' }, 'throw-1')))

		expect(response?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(JSON.stringify(response)).not.toContain('deferral policy detail')
		expect(faults).toHaveLength(1)
	})

	it('contains a manager start throw as a detail-free internal error', async () => {
		const failing = createStartFaultTasks()
		const mcp = createTaskFixtureServer({ tasks: failing, deferral: () => 'operation-1' })
		const faults: unknown[] = []
		mcp.emitter.on('error', (error) => void faults.push(error))

		const response = readUnaryAnswer(await mcp.dispatch(buildTaskCall({ name: 'echo' }, 'throw-2')))

		expect(response?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(JSON.stringify(response)).not.toContain('manager start detail')
		expect(faults).toHaveLength(1)
	})

	it('refuses a task the manager returned outside the content bound', async () => {
		const oversized = createFixedTasks({
			taskId: 'task-1',
			status: 'working',
			statusMessage: 'x'.repeat(4_096),
			createdAt: '1970-01-01T00:00:01.000Z',
			lastUpdatedAt: '1970-01-01T00:00:01.000Z',
			ttlMs: null,
		})
		const mcp = createTaskFixtureServer(
			{ tasks: oversized, deferral: () => 'operation-1' },
			{ limit: { content: 512 } },
		)

		const response = readUnaryAnswer(
			await mcp.dispatch(buildTaskCall({ name: 'echo' }, 'oversize-1')),
		)

		expect(response?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(response?.error?.message).toBe('Server execution returned an invalid or oversized task')
	})

	// Every optional member is carried only when the manager produced one — an absent
	// `statusMessage` must not become a `null`, and an absent `pollIntervalMs` must not
	// become a number this server invented.
	it('carries the manager optional members exactly as it produced them', async () => {
		const hinted = createFixedTasks({
			taskId: 'task-2',
			status: 'working',
			statusMessage: 'queued behind two others',
			createdAt: '1970-01-01T00:00:01.000Z',
			lastUpdatedAt: '1970-01-01T00:00:02.000Z',
			ttlMs: 60_000,
			pollIntervalMs: 2_500,
		})
		const mcp = createTaskFixtureServer({ tasks: hinted, deferral: () => 'operation-1' })

		const hintedAnswer = readResultRecord(
			readUnaryAnswer(await mcp.dispatch(buildTaskCall({ name: 'echo' }, 'optional-1'))),
		)
		const bare = readResultRecord(
			readUnaryAnswer(
				await createTaskFixtureServer({
					tasks: new TestTaskManager(),
					deferral: () => 'operation-1',
				}).dispatch(buildTaskCall({ name: 'echo' }, 'optional-2')),
			),
		)

		expect(hintedAnswer['statusMessage']).toBe('queued behind two others')
		expect(hintedAnswer['pollIntervalMs']).toBe(2_500)
		expect(hintedAnswer['ttlMs']).toBe(60_000)
		expect(Object.hasOwn(bare, 'statusMessage')).toBe(false)
		expect(Object.hasOwn(bare, 'pollIntervalMs')).toBe(false)
	})

	// `undefined` is the policy saying "run this inline", and it is the ONLY spelling of that.
	// An empty key cannot identify an operation, so a manager asked to deduplicate on one would
	// collapse every deferred call onto a single task — a faulty policy the consumer has to
	// hear about, not a second spelling of absence quietly routed down the inline path.
	it('refuses an empty deferral key rather than silently running the call inline', async () => {
		const tasks = new TestTaskManager()
		const inline = createTaskFixtureServer({
			tasks: new TestTaskManager(),
			deferral: () => undefined,
		})
		const faulty = createTaskFixtureServer({ tasks, deferral: () => '' })

		const declined = readResultRecord(
			readUnaryAnswer(await inline.dispatch(buildTaskCall({ name: 'echo' }, 'empty-1'))),
		)
		const refused = readUnaryAnswer(
			await faulty.dispatch(buildTaskCall({ name: 'echo' }, 'empty-2')),
		)

		// The control, drawn from the answer an empty key must NOT be confused with.
		expect(declined['resultType']).toBe('complete')
		expect(refused?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(refused?.error?.message).toBe('Server execution returned an invalid task key')
		expect(tasks.starts).toHaveLength(0)
	})

	// The legacy wire carries no capability metadata at all, so it can never declare the
	// extension — the era boundary keeps the whole mechanism off the old wire.
	it('refuses a selected task at the legacy revision boundary', async () => {
		const tasks = new TestTaskManager()
		const mcp = createMCPLegacy(createTaskFixtureServer({ tasks, deferral: () => 'operation-1' }))

		const answer = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 'legacy-1',
					method: 'tools/call',
					params: { name: 'echo', arguments: { a: 1 } },
				}),
			),
		)

		expect(answer?.error?.code).toBe(JSONRPC_SERVER_ERROR)
		expect(tasks.starts).toHaveLength(0)
	})

	it('advertises the extension through discovery only when it is configured', async () => {
		const configured = createTaskFixtureServer({
			tasks: new TestTaskManager(),
			deferral: () => undefined,
		})

		const advertised = readResultRecord(
			readUnaryAnswer(await configured.dispatch(modernRequest('server/discover', 'discover-1'))),
		)
		const plain = readResultRecord(
			readUnaryAnswer(
				await createTestServer().dispatch(modernRequest('server/discover', 'discover-2')),
			),
		)

		expect(advertised['capabilities']).toEqual({
			tools: { listChanged: true },
			extensions: { [MCP_EXTENSION_TASKS]: {} },
		})
		// Byte-identical to the answer this server gave before the extension existed.
		expect(plain['capabilities']).toEqual({ tools: { listChanged: true } })
	})

	// The real claim: an opt-in extension that is not opted into changes nothing. The
	// CONFIGURED half is the control drawn from outside the unconfigured population — without
	// it, a registration that never happened at all would pass this test unremarked.
	it('leaves an unconfigured server answering exactly what it answered before', async () => {
		const mcp = createTestServer()
		const configured = createTaskFixtureServer({
			tasks: new TestTaskManager(),
			deferral: () => undefined,
		})

		const called = readResultRecord(
			readUnaryAnswer(
				await mcp.dispatch(buildModernCall({ name: 'echo', arguments: { a: 1 } }, 'inert-1')),
			),
		)
		const missing = await Promise.all(
			TASK_METHODS.map(
				async (method) =>
					readUnaryAnswer(await mcp.dispatch(modernRequest(method, 'inert-2')))?.error?.code,
			),
		)
		const registered = await Promise.all(
			TASK_METHODS.map(
				async (method) =>
					readUnaryAnswer(await configured.dispatch(modernRequest(method, 'inert-3')))?.error?.code,
			),
		)

		expect(called['resultType']).toBe('complete')
		expect(called['structuredContent']).toEqual({ a: 1 })
		expect(Object.hasOwn(called, 'taskId')).toBe(false)
		expect(missing).toEqual([
			JSONRPC_METHOD_NOT_FOUND,
			JSONRPC_METHOD_NOT_FOUND,
			JSONRPC_METHOD_NOT_FOUND,
		])
		// Registered, and therefore refusing for a REASON rather than for absence: this client
		// declared no extension, so every one of them answers the capability code.
		expect(registered).toEqual([
			MCP_MISSING_CAPABILITY,
			MCP_MISSING_CAPABILITY,
			MCP_MISSING_CAPABILITY,
		])
	})
})

// ── W03-B: the durable task lifecycle ────────────────────────────────────────
//
// Unary methods over a port this package cannot see inside. What is under test is
// therefore never the task's behaviour — it is the REFUSAL TAXONOMY, and the faithfulness of
// what crosses the seam in each direction. Every control is drawn from outside the population
// its claim describes: `ttlMs: null` for a purge rule written against finite numbers, a
// `failed` task for the code that must not become `-32603`, a second read for the cache this
// server does not hold, and the other method family for the capability gate.

// A manager whose store is a map the test rewrites between reads — the instrument for terminal
// immutability, which is a claim about MCP holding NO cache rather than about a manager
// behaving. `start` answers whatever was seeded under the key it was given.

// A manager that resolves `start` BEFORE its write lands — outside the persists-then-resolves
// population entirely rather than a slower member of it.

// A manager that mints the handle FROM the key and deduplicates on the bare key —
// obligations `start`'s TSDoc states and this package cannot enforce, violated together
// because one fixture demonstrates both consequences.

describe('MCPServer — W03-B: reading one durable task', () => {
	it('answers a task snapshot as a complete result, never a task result', async () => {
		const tasks = new TestTaskManager({ asking: true })
		const mcp = createTaskFixtureServer({ tasks, deferral: () => 'operation-1' })
		const taskId = await readCreatedTask(mcp)

		const answer = readResultRecord(
			readUnaryAnswer(await mcp.dispatch(buildTaskRequest('tasks/get', { taskId }, 'get-1'))),
		)

		// `complete`, not `task`. Only CREATION announces a task; reading one is an ordinary
		// completed call whose payload happens to be a task — and reasoning by symmetry from
		// `MCPTaskResult` would have got this wrong on every method.
		expect(answer['resultType']).toBe('complete')
		expect(answer['taskId']).toBe(taskId)
		expect(answer['status']).toBe('input_required')
		expect(answer['createdAt']).toBe('1970-01-01T00:00:01.000Z')
		expect(answer['ttlMs']).toBeNull()
		expect(answer['_meta']).toEqual({
			[MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' },
		})
	})

	it('carries each status payload the detail union declares', async () => {
		const details = new Map<string, MCPTaskDetail>([
			[
				'done',
				{
					taskId: 'done',
					status: 'completed',
					createdAt: 'a',
					lastUpdatedAt: 'b',
					ttlMs: null,
					result: { resultType: 'complete', content: [{ type: 'text', text: 'ok' }] },
				},
			],
			[
				'broke',
				{
					taskId: 'broke',
					status: 'failed',
					createdAt: 'a',
					lastUpdatedAt: 'b',
					ttlMs: null,
					error: { code: -32000, message: 'the tool never ran' },
				},
			],
			[
				'stopped',
				{ taskId: 'stopped', status: 'cancelled', createdAt: 'a', lastUpdatedAt: 'b', ttlMs: null },
			],
		])
		const mcp = createTaskFixtureServer({
			tasks: createMutableTasks(details),
			deferral: () => undefined,
		})

		const answers = await Promise.all(
			[...details.keys()].map(async (taskId) =>
				readResultRecord(
					readUnaryAnswer(await mcp.dispatch(buildTaskRequest('tasks/get', { taskId }, taskId))),
				),
			),
		)

		expect(answers[0]?.['result']).toEqual({
			resultType: 'complete',
			content: [{ type: 'text', text: 'ok' }],
		})
		expect(answers[1]?.['error']).toEqual({ code: -32000, message: 'the tool never ran' })
		expect(Object.hasOwn(answers[2] ?? {}, 'result')).toBe(false)
		expect(Object.hasOwn(answers[2] ?? {}, 'error')).toBe(false)
		expect(answers.map((answer) => answer['resultType'])).toEqual([
			'complete',
			'complete',
			'complete',
		])
	})

	// THE SHARP CONTROL. Never-existed, purged, and unauthorized are different facts in
	// different stores, and the wire must not be able to tell them apart. Byte equality of
	// the whole serialized envelope is the assertion, not equality of the code: a differing
	// message is exactly the enumeration oracle a bearer `taskId` cannot afford.
	it('answers never-existed, purged, and unauthorized with one byte-identical refusal', async () => {
		const purged = new TestTaskManager({ ttl: 60_000 })
		const guarded = new TestTaskManager({ owner: 'owner-1' })
		const absent = createTaskFixtureServer({
			tasks: new TestTaskManager(),
			deferral: () => 'operation-1',
		})
		const expiring = createTaskFixtureServer({ tasks: purged, deferral: () => 'operation-1' })
		const owned = createTaskFixtureServer({ tasks: guarded, deferral: () => 'operation-1' })
		const expired = await readCreatedTask(expiring, 'purge-seed')
		const theirs = await readCreatedTask(owned, 'owner-seed')
		purged.purge()

		const responses = await Promise.all([
			absent.dispatch(buildTaskRequest('tasks/get', { taskId: 'never-minted' }, 'same-id')),
			expiring.dispatch(buildTaskRequest('tasks/get', { taskId: expired }, 'same-id')),
			owned.dispatch(buildTaskRequest('tasks/get', { taskId: theirs }, 'same-id'), {
				caller: 'someone-else',
			}),
		])
		const wire = responses.map((response) => JSON.stringify(readUnaryAnswer(response)))

		expect(new Set(wire).size).toBe(1)
		expect(readUnaryAnswer(responses[0])?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		// The last store really did hold that task — this is indistinguishability, not
		// managers that all happened to be empty.
		expect(
			await guarded.task(theirs, { signal: AbortSignal.abort(), caller: 'owner-1' }),
		).toBeDefined()
		expect(purged.details).toHaveLength(0)
	})

	// The TTL control, drawn from outside the finite-number population the purge rule is written
	// against: `null` is the extension's spelling for "no expiry", not a zero-length one.
	it('keeps reading a task whose ttlMs is null through a purge that removes the rest', async () => {
		const tasks = new TestTaskManager()
		const mcp = createTaskFixtureServer({ tasks, deferral: () => 'operation-1' })
		const taskId = await readCreatedTask(mcp, 'eternal-seed')

		tasks.purge()
		const answer = readResultRecord(
			readUnaryAnswer(await mcp.dispatch(buildTaskRequest('tasks/get', { taskId }, 'eternal-1'))),
		)

		expect(answer['ttlMs']).toBeNull()
		expect(answer['taskId']).toBe(taskId)
	})

	it('refuses an absent, non-string, empty, or over-bound taskId with invalid params', async () => {
		const mcp = createTaskFixtureServer(
			{ tasks: new TestTaskManager(), deferral: () => undefined },
			{ limit: { state: 32 } },
		)

		const refusals = await Promise.all(
			[{}, { taskId: 7 }, { taskId: '' }, { taskId: 'x'.repeat(64) }].map(async (params) => {
				const response = await mcp.dispatch(buildTaskRequest('tasks/get', params, 'bad-1'))
				return readUnaryAnswer(response)?.error
			}),
		)

		expect(refusals.map((error) => error?.code)).toEqual([
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
		])
		expect(new Set(refusals.map((error) => error?.message))).toEqual(
			new Set(['Invalid params: a bounded string `taskId` is required']),
		)
	})

	// The manager's answer is PROVEN before it reaches the wire, exactly as the creation answer
	// is: a declared return type is a promise, and the manager is the untrusted half.
	it('refuses a snapshot the manager returned malformed or outside the content bound', async () => {
		const oversized = new Map<string, MCPTaskDetail>([
			[
				'big',
				{
					taskId: 'big',
					status: 'working',
					statusMessage: 'x'.repeat(4_096),
					createdAt: 'a',
					lastUpdatedAt: 'b',
					ttlMs: null,
				},
			],
		])
		// Off-contract in a way TypeScript accepts and the wire cannot: a FRACTIONAL `ttlMs`, where
		// the declared type says `number | null` and the schema formats the field `int`. That is
		// exactly the class of defect a declared type cannot catch.
		const malformed = new Map<string, MCPTaskDetail>([
			[
				'lying',
				{
					taskId: 'lying',
					status: 'completed',
					createdAt: 'a',
					lastUpdatedAt: 'b',
					ttlMs: 1_000.5,
					result: { resultType: 'complete' },
				},
			],
		])
		const bounded = createTaskFixtureServer(
			{ tasks: createMutableTasks(oversized), deferral: () => undefined },
			{ limit: { content: 512 } },
		)
		const lying = createTaskFixtureServer({
			tasks: createMutableTasks(malformed),
			deferral: () => undefined,
		})

		const largeMessage = await bounded.dispatch(
			buildTaskRequest('tasks/get', { taskId: 'big' }, 'big-1'),
		)
		const large = readUnaryAnswer(largeMessage)
		const badMessage = await lying.dispatch(
			buildTaskRequest('tasks/get', { taskId: 'lying' }, 'lie-1'),
		)
		const bad = readUnaryAnswer(badMessage)

		expect(large?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(large?.error?.message).toBe('Server execution returned an invalid or oversized task')
		expect(bad?.error?.code).toBe(JSONRPC_INTERNAL_ERROR)
		expect(bad?.error?.message).toBe('Server execution returned an invalid or oversized task')
	})

	// The `-32603` control, drawn from the arm it must not be confused with: a `failed` task is a
	// SUCCESSFUL read of a task that failed, so the client learns the failure from the payload.
	it('answers a complete result for a failed task rather than an internal error', async () => {
		const details = new Map<string, MCPTaskDetail>([
			[
				'broke',
				{
					taskId: 'broke',
					status: 'failed',
					createdAt: 'a',
					lastUpdatedAt: 'b',
					ttlMs: null,
					error: { code: -32603, message: 'the deferred call could not run' },
				},
			],
		])
		const mcp = createTaskFixtureServer({
			tasks: createMutableTasks(details),
			deferral: () => undefined,
		})

		const responseMessage = await mcp.dispatch(
			buildTaskRequest('tasks/get', { taskId: 'broke' }, 'fail-1'),
		)
		const response = readUnaryAnswer(responseMessage)

		expect(response?.error).toBeUndefined()
		expect(readResultRecord(response)['resultType']).toBe('complete')
		expect(readResultRecord(response)['status']).toBe('failed')
	})

	// Terminal immutability is the MANAGER's obligation, so what is provable here is the
	// consequence of MCP holding no cache: a manager that mutates a terminal task has BOTH of its
	// snapshots reported faithfully. An instrument that "passed" by caching the first read would
	// be indistinguishable from a correct one without this second read.
	it('reports a mutated terminal task faithfully both times, holding no snapshot of its own', async () => {
		const details = new Map<string, MCPTaskDetail>([
			[
				'settled',
				{
					taskId: 'settled',
					status: 'completed',
					createdAt: 'a',
					lastUpdatedAt: 'b',
					ttlMs: null,
					result: { resultType: 'complete', content: [{ type: 'text', text: 'first' }] },
				},
			],
		])
		const mcp = createTaskFixtureServer({
			tasks: createMutableTasks(details),
			deferral: () => undefined,
		})

		const before = readResultRecord(
			readUnaryAnswer(
				await mcp.dispatch(buildTaskRequest('tasks/get', { taskId: 'settled' }, 'mutate-1')),
			),
		)
		details.set('settled', {
			taskId: 'settled',
			status: 'cancelled',
			createdAt: 'a',
			lastUpdatedAt: 'c',
			ttlMs: null,
		})
		const after = readResultRecord(
			readUnaryAnswer(
				await mcp.dispatch(buildTaskRequest('tasks/get', { taskId: 'settled' }, 'mutate-2')),
			),
		)

		expect(before['status']).toBe('completed')
		expect(after['status']).toBe('cancelled')
		expect(Object.hasOwn(after, 'result')).toBe(false)
	})

	it('carries ttlMs and pollIntervalMs through unchanged and invents neither', async () => {
		const details = new Map<string, MCPTaskDetail>([
			[
				'hinted',
				{
					taskId: 'hinted',
					status: 'working',
					createdAt: 'a',
					lastUpdatedAt: 'b',
					ttlMs: 30_000,
					pollIntervalMs: 2_500,
				},
			],
			[
				'bare',
				{ taskId: 'bare', status: 'working', createdAt: 'a', lastUpdatedAt: 'b', ttlMs: null },
			],
		])
		const mcp = createTaskFixtureServer({
			tasks: createMutableTasks(details),
			deferral: () => undefined,
		})

		const hinted = readResultRecord(
			readUnaryAnswer(
				await mcp.dispatch(buildTaskRequest('tasks/get', { taskId: 'hinted' }, 'hint-1')),
			),
		)
		const bare = readResultRecord(
			readUnaryAnswer(
				await mcp.dispatch(buildTaskRequest('tasks/get', { taskId: 'bare' }, 'hint-2')),
			),
		)

		expect(hinted['ttlMs']).toBe(30_000)
		expect(hinted['pollIntervalMs']).toBe(2_500)
		expect(bare['ttlMs']).toBeNull()
		expect(Object.hasOwn(bare, 'pollIntervalMs')).toBe(false)
	})
})

// The `null` a foreign implementation of the port answers an unknown `taskId` with.
// `MCPTaskManagerInterface.task` declares `undefined`, so this is the one value TypeScript
// cannot put behind that signature and every other language that implements this published
// contract reaches for daily — installed through `Reflect` for exactly that reason, because
// the port's threat model is that a manager's declared types are a promise, not a proof.

// A manager that RECORDS every `update` and `abort` it is asked to perform, over whatever
// `task` read the scenario supplies. Both write methods answer `void`, so what was invoked
// is the only observable that says whether the probe decided before authorizing anything.

describe('MCPServer — W03-B: answering and stopping one durable task', () => {
	it('forwards every input response verbatim and answers an empty complete result', async () => {
		const forwarded: Array<Readonly<Record<string, unknown>>> = []
		const tasks = new TestTaskManager({ asking: true })
		const mcp = createTaskFixtureServer({
			tasks: {
				start: (key, context, options) => tasks.start(key, context, options),
				task: (id, options) => tasks.task(id, options),
				update: (id, responses, options) => {
					forwarded.push(responses)
					return tasks.update(id, responses, options)
				},
				abort: (id, options) => tasks.abort(id, options),
			},
			deferral: () => 'operation-1',
		})
		const taskId = await readCreatedTask(mcp, 'update-seed')

		const answer = readResultRecord(
			readUnaryAnswer(
				await mcp.dispatch(
					buildTaskRequest(
						'tasks/update',
						// One key the task published, one it never did, and one that is nobody's:
						// MCP holds none of the task's keys, so each travels and the manager
						// does the ignoring.
						{ taskId, inputResponses: { approval: { action: 'accept' }, unrelated: 1, '': null } },
						'update-1',
					),
				),
			),
		)

		expect(forwarded).toEqual([{ approval: { action: 'accept' }, unrelated: 1, '': null }])
		expect(answer).toEqual({
			resultType: 'complete',
			_meta: { [MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' } },
		})
		// The provider ignored the keys it did not know, and the task moved on the one it did.
		expect((await tasks.task(taskId))?.status).toBe('working')
	})

	// A second update naming a key the task has already answered is likewise the manager's to
	// ignore: MCP forwards it and reports success, because "already satisfied" is a fact only
	// the task holds.
	it('forwards an already-satisfied key again and still answers success', async () => {
		const tasks = new TestTaskManager({ asking: true })
		const mcp = createTaskFixtureServer({ tasks, deferral: () => 'operation-1' })
		const taskId = await readCreatedTask(mcp, 'repeat-seed')
		const responses = { taskId, inputResponses: { approval: { action: 'accept' } } }

		const first = readUnaryAnswer(
			await mcp.dispatch(buildTaskRequest('tasks/update', responses, 'repeat-1')),
		)
		const secondMessage = await mcp.dispatch(
			buildTaskRequest('tasks/update', responses, 'repeat-2'),
		)
		const second = readUnaryAnswer(secondMessage)

		expect(first?.error).toBeUndefined()
		expect(second?.error).toBeUndefined()
		expect(readResultRecord(second)['resultType']).toBe('complete')
	})

	it('refuses an update whose inputResponses are absent or not an object', async () => {
		const tasks = new TestTaskManager({ asking: true })
		const mcp = createTaskFixtureServer({ tasks, deferral: () => 'operation-1' })
		const taskId = await readCreatedTask(mcp, 'shape-seed')

		const refusals = await Promise.all(
			[{ taskId }, { taskId, inputResponses: 'yes' }, { taskId, inputResponses: 1 }].map(
				async (params) => {
					const response = await mcp.dispatch(buildTaskRequest('tasks/update', params, 'shape-1'))
					return readUnaryAnswer(response)?.error
				},
			),
		)

		expect(refusals.map((error) => error?.code)).toEqual([
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
		])
		expect(new Set(refusals.map((error) => error?.message))).toEqual(
			new Set(['Invalid params: an `inputResponses` object is required']),
		)
	})

	// Cancellation is ADVISORY. A manager that ignores the ask and reaches `completed` is
	// non-compliant with the extension's intent and perfectly legal on this wire, so the
	// acknowledgement must not claim the task stopped — and it carries no status at all.
	it('acknowledges a cancellation the manager ignores, asserting nothing about the outcome', async () => {
		const details = new Map<string, MCPTaskDetail>([
			[
				'stubborn',
				{ taskId: 'stubborn', status: 'working', createdAt: 'a', lastUpdatedAt: 'b', ttlMs: null },
			],
		])
		const asks: string[] = []
		const stubborn = createStubbornTasks(details, asks)
		const mcp = createTaskFixtureServer({ tasks: stubborn, deferral: () => undefined })

		const answer = readResultRecord(
			readUnaryAnswer(
				await mcp.dispatch(buildTaskRequest('tasks/cancel', { taskId: 'stubborn' }, 'stop-1')),
			),
		)
		const after = readResultRecord(
			readUnaryAnswer(
				await mcp.dispatch(buildTaskRequest('tasks/get', { taskId: 'stubborn' }, 'stop-2')),
			),
		)

		expect(asks).toEqual(['stubborn'])
		expect(answer).toEqual({
			resultType: 'complete',
			_meta: { [MCP_META_SERVER]: { name: 'test-server', version: '1.2.3' } },
		})
		// The acknowledgement said the ASK was accepted; the task says what actually happened.
		expect(after['status']).toBe('completed')
		expect(Object.hasOwn(answer, 'status')).toBe(false)
	})

	it('stops a cooperating task and reports the cancelled snapshot afterwards', async () => {
		const tasks = new TestTaskManager({ work: 200 })
		const mcp = createTaskFixtureServer({ tasks, deferral: () => 'operation-1' })
		const taskId = await readCreatedTask(mcp, 'cancel-seed')

		await mcp.dispatch(buildTaskRequest('tasks/cancel', { taskId }, 'cancel-1'))
		await tasks.settle()
		const after = readResultRecord(
			readUnaryAnswer(await mcp.dispatch(buildTaskRequest('tasks/get', { taskId }, 'cancel-2'))),
		)

		expect(after['status']).toBe('cancelled')
	})

	// `update` and `abort` both answer `void`, so neither can report an unknown task and neither
	// can be where authorization is decided. The read that precedes them is, and its refusal is
	// the one `tasks/get` answers — byte-identical across every method.
	it('refuses an update and a cancellation of an unresolved task identically to a read', async () => {
		const guarded = new TestTaskManager({ owner: 'owner-1' })
		const mcp = createTaskFixtureServer({ tasks: guarded, deferral: () => 'operation-1' })
		const theirs = await readCreatedTask(mcp, 'reject-seed')

		const refusals = await Promise.all(
			TASK_METHODS.map(async (method) =>
				readUnaryAnswer(
					await mcp.dispatch(
						buildTaskRequest(method, { taskId: theirs, inputResponses: {} }, 'same-id'),
						{ caller: 'someone-else' },
					),
				),
			),
		)

		expect(new Set(refusals.map((response) => JSON.stringify(response))).size).toBe(1)
		expect(refusals[0]?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(refusals[0]?.error?.message).toBe(
			'Invalid params: no task is available for that `taskId`',
		)
	})

	// The same probe, attacked. A read the void-returning methods ACCEPT is a write they
	// AUTHORIZED, so the probe has to be as strong as the one `tasks/get` runs rather than a
	// bare `=== undefined`. Both vectors sit outside the `undefined` this port declares and
	// inside what an implementation of it can really answer: `null`, which is what JavaScript
	// spells "no such task" with and what TypeScript here cannot; and a snapshot the manager
	// returned off-contract, which a declared return type accepts and the union does not.
	it('refuses an update and a cancellation it could not prove, invoking neither', async () => {
		const invoked: string[] = []
		const foreign = createWatchedTasks(() => Promise.resolve(undefined), invoked)
		Reflect.set(foreign, 'task', readAbsentTask)
		const lying = createWatchedTasks(
			() =>
				Promise.resolve({
					taskId: 'lying',
					status: 'completed',
					createdAt: 'a',
					lastUpdatedAt: 'b',
					// Off-contract in a way TypeScript accepts and the published union does not:
					// a fractional `ttlMs`, where the schema formats the field `int`.
					ttlMs: 1_000.5,
					result: { resultType: 'complete' },
				}),
			invoked,
		)
		const ghosted = createTaskFixtureServer({ tasks: foreign, deferral: () => undefined })
		const unproven = createTaskFixtureServer({ tasks: lying, deferral: () => undefined })

		const refusals = await Promise.all([
			ghosted.dispatch(
				buildTaskRequest('tasks/update', { taskId: 'x', inputResponses: {} }, 'same'),
			),
			ghosted.dispatch(buildTaskRequest('tasks/cancel', { taskId: 'x' }, 'same')),
			unproven.dispatch(
				buildTaskRequest('tasks/update', { taskId: 'x', inputResponses: {} }, 'same'),
			),
			unproven.dispatch(buildTaskRequest('tasks/cancel', { taskId: 'x' }, 'same')),
		])

		expect(invoked).toEqual([])
		expect(
			new Set(refusals.map((response) => JSON.stringify(readUnaryAnswer(response)))).size,
		).toBe(1)
		expect(readUnaryAnswer(refusals[0])?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(readUnaryAnswer(refusals[0])?.error?.message).toBe(
			'Invalid params: no task is available for that `taskId`',
		)
	})
})

describe('MCPServer — W03-B: the capability gate on every tasks method', () => {
	// The `-32021` payload, and the reason there is ONE code rather than a separate one: the
	// elicitation refusal and this one are instances of the same condition, told apart by their data.
	it('refuses a non-declaring client with the generic capability code and the tasks payload', async () => {
		const mcp = createTaskFixtureServer({ tasks: new TestTaskManager(), deferral: () => undefined })

		const refusals = await Promise.all(
			TASK_METHODS.map(
				async (method) =>
					readUnaryAnswer(await mcp.dispatch(modernRequest(method, 'undeclared-1')))?.error,
			),
		)

		expect(refusals.map((error) => error?.code)).toEqual([
			MCP_MISSING_CAPABILITY,
			MCP_MISSING_CAPABILITY,
			MCP_MISSING_CAPABILITY,
		])
		expect(refusals[0]?.data).toEqual({
			requiredCapabilities: { extensions: { [MCP_EXTENSION_TASKS]: {} } },
		})
		expect(new Set(refusals.map((error) => JSON.stringify(error))).size).toBe(1)
	})

	// The same code, a different payload — which is the whole of how a client tells the
	// instances apart, and the reason a separate numeral would have described one fact twice.
	it('distinguishes the elicitation instance from the tasks instance by payload alone', async () => {
		const elicited = createMCPServer({
			identity: { name: 'test-server', version: '1.2.3' },
			tools: createServerTools(),
			input: {
				continuation: new MemoryContinuation(),
				ttl: 1_000,
				principal: () => 'operator-1',
				selector: () => createRound(),
			},
		})
		const deferred = createTaskFixtureServer({
			tasks: new TestTaskManager(),
			deferral: () => undefined,
		})

		const forInputResponse = await elicited.dispatch(
			buildModernCall({ name: 'echo' }, 'instance-1'),
		)
		const forInput = readUnaryAnswer(forInputResponse)?.error
		const forTasksResponse = await deferred.dispatch(modernRequest('tasks/get', 'instance-2'))
		const forTasks = readUnaryAnswer(forTasksResponse)?.error

		expect(forInput?.code).toBe(forTasks?.code)
		expect(forInput?.code).toBe(MCP_MISSING_CAPABILITY)
		expect(forInput?.data).toEqual({ requiredCapabilities: { elicitation: {} } })
		expect(forTasks?.data).toEqual({
			requiredCapabilities: { extensions: { [MCP_EXTENSION_TASKS]: {} } },
		})
	})

	// The control drawn from the OTHER method family: the same undeclared client that is refused
	// above gets an ordinary `complete` from `tools/call`, because deferral is server-decided and
	// this client never asked for one. Same omission, opposite outcome.
	it('refuses that same undeclared client when deployment policy selects a task', async () => {
		const tasks = new TestTaskManager()
		const mcp = createTaskFixtureServer({ tasks, deferral: () => 'operation-1' })

		const refusedResponse = await mcp.dispatch(modernRequest('tasks/get', 'contrast-1'))
		const refused = readUnaryAnswer(refusedResponse)?.error
		const calledResponse = await mcp.dispatch(
			buildModernCall({ name: 'echo', arguments: { a: 1 } }, 'contrast-2'),
		)
		const called = readUnaryAnswer(calledResponse)?.error

		expect(refused?.code).toBe(MCP_MISSING_CAPABILITY)
		expect(called?.code).toBe(MCP_MISSING_CAPABILITY)
		expect(tasks.starts).toHaveLength(0)
	})

	// The per-request control: the exact shape a session-oriented implementation would wrongly
	// accept — declared once at connect time and absent from the `tasks/*` request itself.
	it('ignores a capability declared at connect time but not on the tasks request', async () => {
		const tasks = new TestTaskManager()
		const mcp = createTaskFixtureServer({ tasks, deferral: () => 'operation-1' })
		const taskId = await readCreatedTask(mcp, 'session-seed')

		await mcp.dispatch(
			createJSONRPCRequest({
				id: 'session-1',
				method: 'initialize',
				params: { protocolVersion: '2025-11-25', capabilities: TASK_CAPABILITIES },
			}),
		)
		const response = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 'session-2',
					method: 'tasks/get',
					params: { taskId, _meta: MODERN_METADATA },
				}),
			),
		)

		expect(response?.error?.code).toBe(MCP_MISSING_CAPABILITY)
	})

	// The capability precedes the parameters, because the extension binds the refusal to the
	// METHOD: a client that never declared it is refused before its `taskId` is read at all, so
	// a request that is BOTH undeclared and malformed answers the capability code.
	it('refuses a non-declaring client before it inspects the parameters', async () => {
		const mcp = createTaskFixtureServer({ tasks: new TestTaskManager(), deferral: () => undefined })

		const response = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 'order-1',
					method: 'tasks/get',
					params: { taskId: 7, _meta: MODERN_METADATA },
				}),
			),
		)

		expect(response?.error?.code).toBe(MCP_MISSING_CAPABILITY)
	})
})

describe('MCPServer — W03-B: the contract obligations MCP cannot enforce', () => {
	// Durability before return, violated: `start` resolves before the write lands, so the
	// `taskId` this server handed out is not yet retrievable. MCP's own half of the rule —
	// awaiting `start` before it builds the answer — is intact and is not enough on its own.
	it('hands out a taskId a prompt read cannot find when the manager resolves before it persists', async () => {
		const mcp = createTaskFixtureServer({
			tasks: createDeferredTasks(),
			deferral: () => 'operation-1',
		})

		const taskId = await readCreatedTask(mcp, 'durable-1')
		const prompt = readUnaryAnswer(
			await mcp.dispatch(buildTaskRequest('tasks/get', { taskId }, 'durable-2')),
		)
		await waitForDelay(40)
		const later = readUnaryAnswer(
			await mcp.dispatch(buildTaskRequest('tasks/get', { taskId }, 'durable-3')),
		)

		expect(taskId).toBe('task-late')
		expect(prompt?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		// The same handle works once the write lands, which is what makes the window silent.
		expect(readResultRecord(later)['taskId']).toBe('task-late')
	})

	// Entropy and principal scoping, violated together: a handle derived from the key is a handle
	// a stranger can GUESS, and a key that is not scoped to its principal hands a second
	// principal the first's task without any guessing at all.
	it('lets a second principal reach the first principal task when the manager derives the handle from the key', async () => {
		const mcp = createTaskFixtureServer({
			tasks: createGuessableTasks(),
			deferral: () => 'shared-operation',
		})

		const mine = readResultRecord(
			readUnaryAnswer(
				await mcp.dispatch(buildTaskCall({ name: 'echo' }, 'principal-1'), {
					caller: 'principal-one',
				}),
			),
		)
		const theirs = readResultRecord(
			readUnaryAnswer(
				await mcp.dispatch(buildTaskCall({ name: 'echo' }, 'principal-2'), {
					caller: 'principal-two',
				}),
			),
		)
		const guessed = readResultRecord(
			readUnaryAnswer(
				await mcp.dispatch(
					buildTaskRequest('tasks/get', { taskId: 'shared-operation' }, 'principal-3'),
					{
						caller: 'a-stranger',
					},
				),
			),
		)

		// Two principals, one key, ONE task — the cross-principal channel the obligation names.
		expect(theirs['taskId']).toBe(mine['taskId'])
		// And the handle was never a secret to begin with.
		expect(guessed['taskId']).toBe('shared-operation')
	})

	// The corrected manager, driven identically: an opaque handle no caller can predict, and a
	// store that answers `undefined` to a caller the task does not belong to.
	it('keeps a second principal out when the manager mints an opaque handle and scopes it', async () => {
		const tasks = new TestTaskManager({ owner: 'principal-one' })
		const mcp = createTaskFixtureServer({ tasks, deferral: () => 'shared-operation' })

		const mine = readResultRecord(
			readUnaryAnswer(
				await mcp.dispatch(buildTaskCall({ name: 'echo' }, 'scoped-1'), {
					caller: 'principal-one',
				}),
			),
		)
		const guessed = readUnaryAnswer(
			await mcp.dispatch(
				buildTaskRequest('tasks/get', { taskId: 'shared-operation' }, 'scoped-2'),
				{ caller: 'principal-two' },
			),
		)
		const theirs = readUnaryAnswer(
			await mcp.dispatch(
				buildTaskRequest('tasks/get', { taskId: String(mine['taskId']) }, 'scoped-2'),
				{ caller: 'principal-two' },
			),
		)

		expect(String(mine['taskId'])).not.toBe('shared-operation')
		expect(guessed?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		// A guessed handle and a real one this caller may not read are the same answer on the wire.
		expect(JSON.stringify(theirs)).toBe(JSON.stringify(guessed))
	})

	it('contains a manager throw on every tasks method as a detail-free internal error', async () => {
		const failing = createReadFaultTasks()
		const mcp = createTaskFixtureServer({ tasks: failing, deferral: () => undefined })
		const faults: unknown[] = []
		mcp.emitter.on('error', (error) => void faults.push(error))

		const responses = await Promise.all(
			TASK_METHODS.map(async (method) =>
				readUnaryAnswer(
					await mcp.dispatch(
						buildTaskRequest(method, { taskId: 'task-1', inputResponses: {} }, method),
					),
				),
			),
		)

		expect(responses.map((response) => response?.error?.code)).toEqual([
			JSONRPC_INTERNAL_ERROR,
			JSONRPC_INTERNAL_ERROR,
			JSONRPC_INTERNAL_ERROR,
		])
		expect(JSON.stringify(responses)).not.toContain('manager read detail')
		expect(faults).toHaveLength(3)
	})

	// The per-request options every port method receives are the request's own, including the
	// asserted caller a deployment authorizes against — this package has no principal to offer.
	it('hands every tasks method the resolved per-request options', async () => {
		const seen: MCPMethodOptions[] = []
		const tasks = new TestTaskManager({ asking: true })
		const recording = createRecordedTasks(tasks, seen)
		const mcp = createTaskFixtureServer({ tasks: recording, deferral: () => 'operation-1' })
		const taskId = await readCreatedTask(mcp, 'options-seed')

		await mcp.dispatch(buildTaskRequest('tasks/get', { taskId }, 'options-1'), {
			caller: 'asserted',
		})
		await mcp.dispatch(
			buildTaskRequest('tasks/update', { taskId, inputResponses: {} }, 'options-2'),
			{ caller: 'asserted' },
		)
		await mcp.dispatch(buildTaskRequest('tasks/cancel', { taskId }, 'options-3'), {
			caller: 'asserted',
		})

		// One read per method plus the update and the abort themselves.
		expect(seen).toHaveLength(5)
		expect(seen.every((options) => options.caller === 'asserted')).toBe(true)
		expect(seen.every((options) => options.signal instanceof AbortSignal)).toBe(true)
	})

	// A notification is answered by nothing, whatever its method — the registrations carry
	// the same narrowing every other built-in does rather than a second dispatch rule.
	it('answers a tasks notification with nothing at all', async () => {
		const tasks = new TestTaskManager()
		const mcp = createTaskFixtureServer({ tasks, deferral: () => 'operation-1' })

		const answers = await Promise.all(
			TASK_METHODS.map(async (method) =>
				mcp.dispatch(createJSONRPCNotification(method, { taskId: 'x', _meta: TASK_METADATA })),
			),
		)

		expect(answers).toEqual([undefined, undefined, undefined])
	})
})

// The junction of the two families: a `subscriptions/listen` request naming task identifiers.
// The AGREED SET is decided once, at acknowledgement, by reading the consumer's durable store —
// and it is the same set the delivery matcher is handed, so an acknowledgement that names an
// identifier is a promise the stream keeps and an omission is a promise never made.
describe('MCPServer — W03-B: the tasks family on a subscriptions/listen stream', () => {
	// The oracle risk INVERTED: the invariant is not that a caller learns nothing, it is that an
	// omission never says WHICH refusal produced it. The port collapses never-existed, purged,
	// and not-yours into one `undefined`, so the acknowledgement must collapse them too.
	it('omits an identifier the store refuses, with nothing that says which refusal it was', async () => {
		const purged = new TestTaskManager({ ttl: 60_000 })
		purged.seed('task-ghost')
		purged.purge()
		const guarded = new TestTaskManager({ owner: 'owner-1' })
		guarded.seed('task-ghost')
		const request = createSubscriptionRequest('listen-omit', { taskIds: ['task-ghost'] })
		const acknowledgements: string[] = []
		const terminals: string[] = []
		const errors: boolean[] = []

		for (const tasks of [new TestTaskManager(), purged, guarded]) {
			const closed = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
			await closed.writable.close()
			const mcp = createTaskFixtureServer(
				{ tasks, deferral: () => undefined },
				{ subscription: { notifications: {}, producer: () => closed.readable } },
			)
			const [messages, response] = await drainStream(
				readStreamAnswer(await mcp.dispatch(request, { caller: 'owner-2' })),
			)
			acknowledgements.push(JSON.stringify(messages))
			terminals.push(JSON.stringify(response))
			errors.push(isJSONRPCErrorResponse(response))
		}

		// The never-existed, the purged, and the unauthorized read produce the SAME bytes, so a
		// caller holding all three acknowledgements can separate none of them.
		expect(new Set(acknowledgements).size).toBe(1)
		expect(JSON.parse(acknowledgements[0] ?? 'null')).toEqual([
			{
				jsonrpc: '2.0',
				method: 'notifications/subscriptions/acknowledged',
				params: { notifications: {}, _meta: { [MCP_META_SUBSCRIPTION]: 'listen-omit' } },
			},
		])
		// And nothing else distinguishes them: no error arm, and one identical terminal.
		expect(errors).toEqual([false, false, false])
		expect(new Set(terminals).size).toBe(1)
		// The omission came from a REFUSED READ rather than from a member nobody looked at.
		expect(purged.reads.calls).toEqual([['task-ghost']])
		expect(guarded.reads.calls).toEqual([['task-ghost']])
	})

	it('acknowledges the resolved identifiers in request order with duplicates intact', async () => {
		const tasks = new TestTaskManager()
		tasks.seed('task-b')
		tasks.seed('task-a')
		const closed = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		await closed.writable.close()
		const mcp = createTaskFixtureServer(
			{ tasks, deferral: () => undefined },
			{ subscription: { notifications: {}, producer: () => closed.readable } },
		)

		const [messages] = await drainStream(
			readStreamAnswer(
				await mcp.dispatch(
					createSubscriptionRequest('listen-order', {
						taskIds: ['task-b', 'task-gone', 'task-a', 'task-b'],
					}),
				),
			),
		)

		// Request order survives, the duplicate survives as a duplicate, and only the identifier
		// the store refused is gone.
		expect(messages[0]?.params?.['notifications']).toEqual({
			taskIds: ['task-b', 'task-a', 'task-b'],
		})
		// One read per requested entry, in request order: the resolution deduplicates nothing
		// either, so a normalization added anywhere in the path reddens here.
		expect(tasks.reads.calls).toEqual([['task-b'], ['task-gone'], ['task-a'], ['task-b']])
	})

	// The DERIVED support fact, from both sides. Neither half alone can honour the member, and
	// no third flag records the conclusion — so each half's absence is proven separately.
	it('omits the member entirely when the server cannot push tasks', async () => {
		const tasks = new TestTaskManager()
		tasks.seed('task-a')
		const closed = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		await closed.writable.close()
		// A producer with no manager: nothing can authorize an identifier.
		const unmanaged = createTestServer(undefined, {
			notifications: {},
			producer: () => closed.readable,
		})
		// A manager with no producer: nothing can carry a transition.
		const unproduced = createTaskFixtureServer({ tasks, deferral: () => undefined })
		const request = createSubscriptionRequest('listen-off', { taskIds: ['task-a'] })

		const [fromUnmanaged] = await drainStream(readStreamAnswer(await unmanaged.dispatch(request)))
		const [fromUnproduced] = await drainStream(readStreamAnswer(await unproduced.dispatch(request)))

		expect(fromUnmanaged[0]?.params?.['notifications']).toEqual({})
		expect(fromUnproduced[0]?.params?.['notifications']).toEqual({})
		// A server that cannot push tasks reads no store at all, so the omission is not a
		// resolution that happened to refuse everything.
		expect(tasks.reads.count).toBe(0)
	})

	// The tripwire for the fixed-agreed-set lifetime. A future edit that re-resolves identifiers
	// at delivery puts the durable store on the hot path of every frame, and this is what sees it.
	it('delivers an agreed identifier with no store read at delivery time', async () => {
		const tasks = new TestTaskManager()
		tasks.seed('task-live')
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const writer = source.writable.getWriter()
		const mcp = createTaskFixtureServer(
			{ tasks, deferral: () => undefined },
			{ subscription: { notifications: {}, producer: () => source.readable } },
		)
		const stream = readStreamAnswer(
			await mcp.dispatch(createSubscriptionRequest('listen-live', { taskIds: ['task-live'] })),
		)

		const acknowledgement = await stream.next()
		if (acknowledgement.done) throw new Error('expected a subscription acknowledgement')
		// THE POSITIVE CONTROL. Acknowledgement resolves the identifier, so a counter that could
		// not see a store read would read zero here and the silence below would mean nothing.
		const resolved = tasks.reads.count
		const drained = drainStream(stream)
		for (const at of ['1970-01-01T00:00:02.000Z', '1970-01-01T00:00:03.000Z']) {
			await writer.write({
				jsonrpc: '2.0',
				method: 'notifications/tasks',
				params: {
					taskId: 'task-live',
					status: 'working',
					createdAt: '1970-01-01T00:00:01.000Z',
					lastUpdatedAt: at,
					ttlMs: null,
				},
			})
		}
		await writer.close()
		const [messages] = await drained

		expect(resolved).toBe(1)
		expect(acknowledgement.value.params?.['notifications']).toEqual({ taskIds: ['task-live'] })
		expect(
			messages.map((frame) => [frame.params?.['lastUpdatedAt'], frame.params?.['_meta']]),
		).toEqual([
			['1970-01-01T00:00:02.000Z', { [MCP_META_SUBSCRIPTION]: 'listen-live' }],
			['1970-01-01T00:00:03.000Z', { [MCP_META_SUBSCRIPTION]: 'listen-live' }],
		])
		// Delivering two frames read the store exactly as often as delivering none did.
		expect(tasks.reads.count).toBe(resolved)
	})

	it('refuses a malformed taskIds member as invalid params before reading the store', async () => {
		const tasks = new TestTaskManager()
		const closed = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		await closed.writable.close()
		const mcp = createTaskFixtureServer(
			{ tasks, deferral: () => undefined },
			{ subscription: { notifications: {}, producer: () => closed.readable } },
		)

		const refusals = await Promise.all(
			[{ taskIds: 'task-a' }, { taskIds: ['task-a', 7] }, { taskIds: {} }].map(
				async (notifications) =>
					readUnaryAnswer(
						await mcp.dispatch(
							createJSONRPCRequest({
								method: 'subscriptions/listen',
								id: 'listen-bad',
								params: { notifications, _meta: MODERN_METADATA },
							}),
						),
					)?.error?.code,
			),
		)

		expect(refusals).toEqual([
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
			JSONRPC_INVALID_PARAMS,
		])
		// A refused request never reaches the resolution, so a malformed array is not a probe.
		expect(tasks.reads.count).toBe(0)
	})
})

describe('the held-open stream contract', () => {
	it('yields notifications, returns a response, and accepts nothing', () => {
		expectTypeOf<MCPStream>().toEqualTypeOf<
			AsyncGenerator<JSONRPCNotification, JSONRPCResponse, unknown>
		>()
		expectTypeOf<MCPTextStream>().toEqualTypeOf<AsyncGenerator<string, string, unknown>>()
	})

	it('binds a subscription producer to the same notification yield type', () => {
		expectTypeOf<Awaited<ReturnType<MCPSubscriptionHandler>>>().toEqualTypeOf<
			AsyncIterable<JSONRPCNotification>
		>()
	})
})

describe('MCP resources/list', () => {
	it('forwards the opaque cursor and stamps each resource page', async () => {
		const resources = new MemoryResourceManager()
		const mcp = createMCPServer({
			identity: { name: 'resources', version: '1.0.0' },
			tools: createToolManager(),
			resources,
			cache: { ttl: 500, scope: 'public' },
		})
		const first = await mcp.dispatch(
			createJSONRPCRequest({ method: 'resources/list', params: { _meta: MODERN_METADATA } }),
		)
		const second = await mcp.dispatch(
			createJSONRPCRequest({
				id: 2,
				method: 'resources/list',
				params: { cursor: 'second', _meta: MODERN_METADATA },
			}),
		)

		expect(first).toMatchObject({
			result: {
				resultType: 'complete',
				ttlMs: 500,
				cacheScope: 'public',
				resources: [{ uri: 'memory://resource/one', name: 'one' }],
				nextCursor: 'second',
			},
		})
		expect(second).toMatchObject({
			result: {
				resultType: 'complete',
				resources: [{ uri: 'memory://resource/two', name: 'two' }],
			},
		})
		expect(resources.cursors).toEqual([undefined, 'second'])
	})

	it('omits nextCursor when the manager page capacity exceeds its remaining item count', async () => {
		const mcp = createMCPServer({
			identity: { name: 'resources', version: '1.0.0' },
			tools: createToolManager(),
			resources: new MemoryResourceManager(),
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'resources/list',
				params: { cursor: 'second', _meta: MODERN_METADATA },
			}),
		)

		expect(answer).not.toHaveProperty('result.nextCursor')
	})
})

describe('MCP resources/read', () => {
	it('reads a concrete URI from an in-memory registry and forwards method options', async () => {
		const resources = new MemoryResourceManager()
		const caller = { principal: 'reader' }
		const mcp = createMCPServer({
			identity: { name: 'resources', version: '1.0.0' },
			tools: createToolManager(),
			resources,
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'resources/read',
				params: { uri: 'memory://resource/one', _meta: MODERN_METADATA },
			}),
			{ caller },
		)

		expect(answer).toMatchObject({
			result: {
				resultType: 'complete',
				contents: [{ uri: 'memory://resource/one', text: 'one' }],
			},
		})
		expect(resources.reads).toEqual([{ uri: 'memory://resource/one' }])
		expect(resources.options[0]?.caller).toBe(caller)
	})

	it('uses -32602 when the resource manager returns undefined', async () => {
		const resources = new MemoryResourceManager()
		const mcp = createMCPServer({
			identity: { name: 'resources', version: '1.0.0' },
			tools: createToolManager(),
			resources,
		})
		const found = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'resources/read',
					params: { uri: 'memory://resource/two', _meta: MODERN_METADATA },
				}),
			),
		)
		const missing = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 2,
					method: 'resources/read',
					params: { uri: 'memory://resource/missing', _meta: MODERN_METADATA },
				}),
			),
		)
		if (found === undefined || missing === undefined) throw new Error('expected resource responses')

		expect(found.error).toBeUndefined()
		expect(missing.error?.code).toBe(JSONRPC_INVALID_PARAMS)
	})

	it('forwards inputResponses and requestState to the resource manager', async () => {
		const resources = new MemoryResourceManager()
		const mcp = createMCPServer({
			identity: { name: 'resources', version: '1.0.0' },
			tools: createToolManager(),
			resources,
		})
		await mcp.dispatch(
			createJSONRPCRequest({
				method: 'resources/read',
				params: {
					uri: 'memory://resource/one',
					inputResponses: { approval: { action: 'accept', content: { approved: true } } },
					requestState: 'opaque',
					_meta: MODERN_METADATA,
				},
			}),
		)

		expect(resources.reads).toEqual([
			{
				uri: 'memory://resource/one',
				inputResponses: { approval: { action: 'accept', content: { approved: true } } },
				requestState: 'opaque',
			},
		])
	})

	it('may answer input_required without changing its result discriminator', async () => {
		const mcp = createMCPServer({
			identity: { name: 'resources', version: '1.0.0' },
			tools: createToolManager(),
			resources: new MemoryResourceManager(),
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'resources/read',
				params: { uri: 'memory://resource/input', _meta: MODERN_METADATA },
			}),
		)

		expect(answer).toMatchObject({
			result: {
				resultType: 'input_required',
				requestState: 'resource-state',
				_meta: {
					'io.modelcontextprotocol/serverInfo': { name: 'resources', version: '1.0.0' },
				},
			},
		})
		expect(answer).not.toHaveProperty('result.ttlMs')
	})

	// The capability rule binds every ISSUER, not one method. A round a manager authored
	// leaves as this server's wire, so it meets the same gate a `tools/call` round meets —
	// and it meets it BEFORE the stamp, so a round the client may not receive is never sent.
	it('refuses a manager round the client did not declare the capability for', async () => {
		const resources = new MemoryResourceManager()
		const mcp = createMCPServer({
			identity: { name: 'resources', version: '1.0.0' },
			tools: createToolManager(),
			resources,
		})
		const refused = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'resources/read',
					params: { uri: 'memory://resource/round', _meta: MODERN_METADATA },
				}),
			),
		)
		const allowed = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 2,
					method: 'resources/read',
					params: {
						uri: 'memory://resource/round',
						_meta: {
							[MCP_META_VERSION]: '2026-07-28',
							[MCP_META_CAPABILITIES]: { roots: {} },
						},
					},
				}),
			),
		)

		expect(refused?.error).toEqual({
			code: MCP_MISSING_CAPABILITY,
			message: 'Server requires a client capability this request did not declare',
			data: { requiredCapabilities: { roots: {} } },
		})
		expect(refused?.result).toBeUndefined()
		expect(allowed?.result).toMatchObject({
			resultType: 'input_required',
			inputRequests: { workspace: { method: 'roots/list' } },
			requestState: 'resource-state',
		})
	})
})

describe('MCP resources/templates/list', () => {
	it('projects the manager-owned RFC 6570 template without expanding it', async () => {
		const mcp = createMCPServer({
			identity: { name: 'resources', version: '1.0.0' },
			tools: createToolManager(),
			resources: new MemoryResourceManager(),
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'resources/templates/list',
				params: { _meta: MODERN_METADATA },
			}),
		)

		expect(answer).toMatchObject({
			result: {
				resultType: 'complete',
				resourceTemplates: [{ uriTemplate: 'memory://resource/{name}', name: 'named' }],
			},
		})
	})
})

describe('MCP resource capability and registration', () => {
	it('advertises and registers resources only when the resource manager is configured', async () => {
		const plain = createMCPServer({
			identity: { name: 'plain', version: '1.0.0' },
			tools: createToolManager(),
		})
		const configured = createMCPServer({
			identity: { name: 'configured', version: '1.0.0' },
			tools: createToolManager(),
			resources: new MemoryResourceManager(),
			subscription: {
				notifications: {
					resourcesListChanged: true,
					resourceSubscriptions: ['memory://resource/one'],
				},
				producer: () => new TransformStream<JSONRPCNotification, JSONRPCNotification>().readable,
			},
		})
		const discovery = await configured.dispatch(
			createJSONRPCRequest({ method: 'server/discover', params: { _meta: MODERN_METADATA } }),
		)

		expect(discovery).toMatchObject({
			result: { capabilities: { resources: { subscribe: true, listChanged: true } } },
		})
		expect(configured.methods.method('resources/list')).toBeTypeOf('function')
		expect(configured.methods.method('resources/read')).toBeTypeOf('function')
		expect(configured.methods.method('resources/templates/list')).toBeTypeOf('function')
		expect(plain.methods.method('resources/list')).toBeUndefined()
		expect(plain.methods.method('resources/read')).toBeUndefined()
		expect(plain.methods.method('resources/templates/list')).toBeUndefined()
	})

	it('keeps prompts/list gated while resources/list succeeds', async () => {
		const mcp = createMCPServer({
			identity: { name: 'resources', version: '1.0.0' },
			tools: createToolManager(),
			resources: new MemoryResourceManager(),
		})
		const listed = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'resources/list',
					params: { _meta: MODERN_METADATA },
				}),
			),
		)
		const prompts = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 2,
					method: 'prompts/list',
					params: { _meta: MODERN_METADATA },
				}),
			),
		)
		if (listed === undefined || prompts === undefined)
			throw new Error('expected resource responses')

		expect(listed.error).toBeUndefined()
		expect(prompts.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
	})
})

describe('MCP resource notifications', () => {
	it('routes only opted-in resource updates and list changes', async () => {
		const source = new TransformStream<JSONRPCNotification, JSONRPCNotification>()
		const mcp = createMCPServer({
			identity: { name: 'resources', version: '1.0.0' },
			tools: createToolManager(),
			resources: new MemoryResourceManager(),
			subscription: {
				notifications: {
					resourcesListChanged: true,
					resourceSubscriptions: ['memory://resource/one'],
				},
				producer: () => source.readable,
			},
		})
		const stream = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'subscriptions/listen',
				params: {
					notifications: {
						resourcesListChanged: true,
						resourceSubscriptions: ['memory://resource/one', 'memory://resource/two'],
					},
					_meta: MODERN_METADATA,
				},
			}),
		)
		if (!(Symbol.asyncIterator in stream)) throw new Error('expected a resource subscription')
		await stream.next()
		const writer = source.writable.getWriter()
		const updatedResult = stream.next()
		await writer.write({
			jsonrpc: '2.0',
			method: 'notifications/resources/updated',
			params: { uri: 'memory://resource/two' },
		})
		await writer.write({
			jsonrpc: '2.0',
			method: 'notifications/resources/updated',
			params: { uri: 'memory://resource/one' },
		})
		const updated = await updatedResult
		const changedResult = stream.next()
		await writer.write({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' })
		const changed = await changedResult
		await writer.close()

		expect(updated.value).toMatchObject({
			method: 'notifications/resources/updated',
			params: { uri: 'memory://resource/one' },
		})
		expect(changed.value).toMatchObject({ method: 'notifications/resources/list_changed' })
	})
})

describe('MCP prompts/list', () => {
	it('forwards the shared opaque cursor and stamps each prompt page', async () => {
		const prompts = new MemoryPromptManager()
		const mcp = createMCPServer({
			identity: { name: 'prompts', version: '1.0.0' },
			tools: createToolManager(),
			prompts,
			cache: { ttl: 750, scope: 'public' },
		})
		const first = await mcp.dispatch(
			createJSONRPCRequest({ method: 'prompts/list', params: { _meta: MODERN_METADATA } }),
		)
		const second = await mcp.dispatch(
			createJSONRPCRequest({
				id: 2,
				method: 'prompts/list',
				params: { cursor: 'second', _meta: MODERN_METADATA },
			}),
		)

		expect(first).toMatchObject({
			result: {
				resultType: 'complete',
				ttlMs: 750,
				cacheScope: 'public',
				prompts: [{ name: 'greet', arguments: [{ name: 'person', required: true }] }],
				nextCursor: 'second',
			},
		})
		expect(second).toMatchObject({
			result: { resultType: 'complete', prompts: [{ name: 'summarize' }] },
		})
		expect(prompts.cursors).toEqual([undefined, 'second'])
	})

	it('omits nextCursor when page capacity exceeds the remaining prompt count', async () => {
		const mcp = createMCPServer({
			identity: { name: 'prompts', version: '1.0.0' },
			tools: createToolManager(),
			prompts: new MemoryPromptManager(),
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'prompts/list',
				params: { cursor: 'second', _meta: MODERN_METADATA },
			}),
		)

		expect(answer).not.toHaveProperty('result.nextCursor')
	})
})

describe('MCP prompts/get', () => {
	it('resolves string arguments to rich prompt messages and forwards method options', async () => {
		const prompts = new MemoryPromptManager()
		const caller = { principal: 'reader' }
		const mcp = createMCPServer({
			identity: { name: 'prompts', version: '1.0.0' },
			tools: createToolManager(),
			prompts,
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'prompts/get',
				params: {
					name: 'greet',
					arguments: { person: 'Ada' },
					inputResponses: { approval: { action: 'accept' } },
					requestState: 'opaque',
					_meta: MODERN_METADATA,
				},
			}),
			{ caller },
		)

		expect(answer).toMatchObject({
			result: {
				resultType: 'complete',
				description: 'A rendered greeting',
				messages: [
					{ role: 'user', content: { type: 'text', text: 'Hello Ada' } },
					{ role: 'assistant', content: { type: 'resource' } },
				],
			},
		})
		expect(answer).not.toHaveProperty('result.ttlMs')
		expect(answer).not.toHaveProperty('result.cacheScope')
		expect(prompts.requests).toEqual([
			{
				name: 'greet',
				arguments: { person: 'Ada' },
				inputResponses: { approval: { action: 'accept' } },
				requestState: 'opaque',
			},
		])
		expect(prompts.options[0]?.caller).toBe(caller)
	})

	it('may answer input_required without adding prompt cache fields', async () => {
		const mcp = createMCPServer({
			identity: { name: 'prompts', version: '1.0.0' },
			tools: createToolManager(),
			prompts: new MemoryPromptManager(),
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'prompts/get',
				params: { name: 'input', _meta: MODERN_METADATA },
			}),
		)

		expect(answer).toMatchObject({
			result: {
				resultType: 'input_required',
				requestState: 'prompt-state',
				_meta: {
					'io.modelcontextprotocol/serverInfo': { name: 'prompts', version: '1.0.0' },
				},
			},
		})
		expect(answer).not.toHaveProperty('result.ttlMs')
	})

	// The same rule on the other port. A carrier-only result asks nothing and is stamped
	// whatever the client declared, because there is no round to measure.
	it('refuses a manager round the client did not declare the capability for', async () => {
		const mcp = createMCPServer({
			identity: { name: 'prompts', version: '1.0.0' },
			tools: createToolManager(),
			prompts: new MemoryPromptManager(),
		})
		const refused = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'prompts/get',
					params: { name: 'round', _meta: MODERN_METADATA },
				}),
			),
		)
		const allowed = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 2,
					method: 'prompts/get',
					params: {
						name: 'round',
						_meta: {
							[MCP_META_VERSION]: '2026-07-28',
							[MCP_META_CAPABILITIES]: { sampling: {} },
						},
					},
				}),
			),
		)

		expect(refused?.error).toEqual({
			code: MCP_MISSING_CAPABILITY,
			message: 'Server requires a client capability this request did not declare',
			data: { requiredCapabilities: { sampling: {} } },
		})
		expect(refused?.result).toBeUndefined()
		expect(allowed?.result).toMatchObject({
			resultType: 'input_required',
			inputRequests: { context: { method: 'sampling/createMessage', params: {} } },
			requestState: 'prompt-state',
		})
	})

	it('accepts a string, refuses a non-string before lookup, and maps a missing prompt', async () => {
		const prompts = new MemoryPromptManager()
		const mcp = createMCPServer({
			identity: { name: 'prompts', version: '1.0.0' },
			tools: createToolManager(),
			prompts,
		})
		const valid = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					method: 'prompts/get',
					params: { name: 'greet', arguments: { person: 'Grace' }, _meta: MODERN_METADATA },
				}),
			),
		)
		const invalid = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 2,
					method: 'prompts/get',
					params: { name: 'greet', arguments: { person: 42 }, _meta: MODERN_METADATA },
				}),
			),
		)
		const missing = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 3,
					method: 'prompts/get',
					params: { name: 'missing', arguments: { person: 'Ada' }, _meta: MODERN_METADATA },
				}),
			),
		)
		if (valid === undefined || invalid === undefined || missing === undefined) {
			throw new Error('expected prompt responses')
		}

		expect(valid.error).toBeUndefined()
		expect(invalid.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(missing.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(prompts.requests).toEqual([
			{ name: 'greet', arguments: { person: 'Grace' } },
			{ name: 'missing', arguments: { person: 'Ada' } },
		])
	})
})

describe('MCP completion/complete', () => {
	it('discriminates prompt and resource references and refuses a missing reference', async () => {
		const completion = new MemoryCompletion()
		const mcp = createMCPServer({
			identity: { name: 'completion', version: '1.0.0' },
			tools: createToolManager(),
			completion,
		})
		const prompt = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'completion/complete',
				params: {
					ref: { type: 'ref/prompt', name: 'greet' },
					argument: { name: 'person', value: 'A' },
					_meta: MODERN_METADATA,
				},
			}),
		)
		const resource = await mcp.dispatch(
			createJSONRPCRequest({
				id: 2,
				method: 'completion/complete',
				params: {
					ref: { type: 'ref/resource', uri: 'memory://resource/{name}' },
					argument: { name: 'name', value: 'o' },
					_meta: MODERN_METADATA,
				},
			}),
		)
		const missing = readUnaryAnswer(
			await mcp.dispatch(
				createJSONRPCRequest({
					id: 3,
					method: 'completion/complete',
					params: {
						ref: { type: 'ref/prompt', name: 'missing' },
						argument: { name: 'person', value: '' },
						_meta: MODERN_METADATA,
					},
				}),
			),
		)
		if (missing === undefined) throw new Error('expected a completion response')

		expect(prompt).toMatchObject({
			result: { resultType: 'complete', completion: { values: ['Ada', 'Grace'], total: 2 } },
		})
		expect(resource).toMatchObject({
			result: { resultType: 'complete', completion: { values: ['one', 'two'] } },
		})
		expect(missing.error?.code).toBe(JSONRPC_INVALID_PARAMS)
		expect(completion.requests.map((request) => request.ref.type)).toEqual([
			'ref/prompt',
			'ref/resource',
			'ref/prompt',
		])
	})

	it('caps a source of more than 100 candidates and marks the projection incomplete', async () => {
		const mcp = createMCPServer({
			identity: { name: 'completion', version: '1.0.0' },
			tools: createToolManager(),
			completion: new MemoryCompletion(),
		})
		const answer = await mcp.dispatch(
			createJSONRPCRequest({
				method: 'completion/complete',
				params: {
					ref: { type: 'ref/prompt', name: 'many' },
					argument: { name: 'value', value: '' },
					_meta: MODERN_METADATA,
				},
			}),
		)
		const response = readUnaryAnswer(answer)
		if (response === undefined) throw new Error('expected a completion response')

		expect(response.result?.['completion']).toMatchObject({ hasMore: true })
		expect(response.result?.['completion']).toHaveProperty('values.length', 100)
		expect(isMCPCompletionResult(response.result)).toBe(true)
	})
})

describe('MCP prompt and completion capability gating', () => {
	it('keeps prompt, resource, and completion registration independently gated', async () => {
		const prompts = createMCPServer({
			identity: { name: 'prompts', version: '1.0.0' },
			tools: createToolManager(),
			prompts: new MemoryPromptManager(),
			subscription: {
				notifications: { promptsListChanged: true },
				producer: () => new TransformStream().readable,
			},
		})
		const completion = createMCPServer({
			identity: { name: 'completion', version: '1.0.0' },
			tools: createToolManager(),
			completion: new MemoryCompletion(),
		})
		const listed = readUnaryAnswer(
			await prompts.dispatch(
				createJSONRPCRequest({ method: 'prompts/list', params: { _meta: MODERN_METADATA } }),
			),
		)
		const resources = readUnaryAnswer(
			await prompts.dispatch(
				createJSONRPCRequest({
					id: 2,
					method: 'resources/list',
					params: { _meta: MODERN_METADATA },
				}),
			),
		)
		const promptDiscovery = await prompts.dispatch(
			createJSONRPCRequest({
				id: 3,
				method: 'server/discover',
				params: { _meta: MODERN_METADATA },
			}),
		)
		const completionDiscovery = await completion.dispatch(
			createJSONRPCRequest({ method: 'server/discover', params: { _meta: MODERN_METADATA } }),
		)
		if (listed === undefined || resources === undefined)
			throw new Error('expected prompt responses')

		expect(listed.error).toBeUndefined()
		expect(resources.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
		expect(promptDiscovery).toMatchObject({
			result: { capabilities: { prompts: { listChanged: true } } },
		})
		expect(promptDiscovery).not.toHaveProperty('result.capabilities.completions')
		expect(completionDiscovery).toMatchObject({ result: { capabilities: { completions: {} } } })
		expect(completionDiscovery).not.toHaveProperty('result.capabilities.prompts')
		expect(completionDiscovery).not.toHaveProperty('result.capabilities.resources')
		expect(prompts.methods.method('prompts/list')).toBeTypeOf('function')
		expect(prompts.methods.method('prompts/get')).toBeTypeOf('function')
		expect(prompts.methods.method('completion/complete')).toBeUndefined()
		expect(completion.methods.method('completion/complete')).toBeTypeOf('function')
		expect(completion.methods.method('prompts/list')).toBeUndefined()
	})
})
