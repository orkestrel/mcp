// The live-service harness for `@modelcontextprotocol/conformance` — the real foreign
// client that drives this package's server over a real socket (live services).
//
// This file exists as TYPESCRIPT for one reason. The fixture below is the host half of
// every port `MCPServerOptions` publishes, so it is typed against the real exported
// interfaces: rename a port accessor and `npm run check` fails at compile time instead of
// twenty minutes later inside a foreign runner's summary. The same fixture as untyped
// JavaScript enforced nothing, and a public rename once took the suite 23/0 → 16/7 with
// every gate green.
//
// The ports are backed by PLAIN OBJECTS and no `@orkestrel/workspace`. That is the claim:
// no adapter is privileged, and what backs a port is the host's decision.

import type { ToolManagerInterface } from '@orkestrel/tool'
import type {
	MCPCompletion,
	MCPCompletionInterface,
	MCPContent,
	MCPContinuationInterface,
	MCPInputContext,
	MCPInputRequestMap,
	MCPInputResult,
	MCPInputRound,
	MCPPrompt,
	MCPPromptGetParams,
	MCPPromptManagerInterface,
	MCPPromptMessage,
	MCPResource,
	MCPResourceContents,
	MCPResourceManagerInterface,
	MCPServerOptions,
} from '@src/core'
import type { StartedServerInterface } from './setupServer.js'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isFiniteNumber, isRecord, isString } from '@orkestrel/contract'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { createTool, createToolManager } from '@orkestrel/tool'
import { createMCPServer } from '@src/core'
import { createMCPContinuation, createMCPRoutes } from '@src/server'
import { startServer } from './setupServer.js'

// ── The pinned runner ────────────────────────────────────────────────────────

/** The conformance runner package, pinned as a development dependency and resolved from disk. */
export const CONFORMANCE_PACKAGE = '@modelcontextprotocol/conformance'

/** The runner's entry module inside its installed package. */
export const CONFORMANCE_ENTRY = `${CONFORMANCE_PACKAGE}/dist/index.js`

/** The dated protocol revision the runner drives the server at. */
export const CONFORMANCE_SPEC = '2026-07-28'

/** The identity the fixture server answers `initialize` with. */
export const CONFORMANCE_IDENTITY = Object.freeze({
	name: 'orkestrel-conformance',
	version: '0.0.9',
})

/** One `✓ <scenario>: N passed, M failed` line in the runner's summary block. */
export const CONFORMANCE_TALLY = /^\S+ ([a-z0-9-]+): (\d+) passed, (\d+) failed$/

/** The runner's closing `Total: N passed, M failed` line. */
export const CONFORMANCE_TOTAL = /^Total: (\d+) passed, (\d+) failed$/

/** The scenario-name prefix marking the runner's OAuth family. */
export const CONFORMANCE_AUTH = 'auth/'

/** The `list` heading that opens the runner's client-scenario section. */
export const CONFORMANCE_CLIENTS = /^Client scenarios/

/** One `  - <scenario> [<revisions>]` entry inside a `list` section. */
export const CONFORMANCE_LISTED = /^ {2}- (\S+) \[/

/**
 * Every client scenario the runner's own `list` reports as applicable at
 * {@link CONFORMANCE_SPEC}, except the {@link CONFORMANCE_AUTH} family.
 *
 * @remarks
 * The `auth/*` scenarios are EXCLUDED on purpose: each one drives an OAuth 2.1 client
 * through discovery, dynamic registration, and a token grant, and this package ships no
 * OAuth client at all. `createHTTPClientTransport` takes a `headers` record, so a consumer
 * supplies its own bearer; the authorization flow that mints one is outside this package.
 * Running those scenarios would measure a client this package does not publish.
 *
 * The set is written down rather than derived so the exclusion is a decision on the record.
 * `tests/conformance.test.ts` compares it against what {@link parseConformanceClients} reads
 * back from the runner, so a scenario the runner adds fails that comparison instead of
 * disappearing from the run.
 */
export const CONFORMANCE_CLIENT_SCENARIOS: readonly string[] = Object.freeze([
	'tools_call',
	'request-metadata',
	'sep-2322-client-request-state',
	'http-standard-headers',
	'http-custom-headers',
	'http-invalid-tool-headers',
	'json-schema-ref-no-deref',
	'json-schema-2020-12-preservation',
])

/** The runner's per-scenario `Passed: N/D, M failed, W warnings` result line in client mode. */
export const CONFORMANCE_OUTCOME = /^Passed: (\d+)\/\d+, (\d+) failed, (\d+) warnings$/

// ── The runner's reported shape ──────────────────────────────────────────────

/** One conformance scenario's tally, exactly as the runner's summary reports it. */
export interface ConformanceScenario {
	/** The scenario identifier, such as `dns-rebinding-protection`. */
	readonly name: string
	/** Checks the scenario passed. */
	readonly passed: number
	/** Checks the scenario failed. */
	readonly failed: number
}

/**
 * One client scenario's outcome, exactly as the runner's per-scenario result block reports it.
 *
 * @remarks
 * `warnings` has no counterpart in {@link ConformanceScenario} because the two modes report
 * differently. The server-mode summary collapses each scenario to passed and failed, so a
 * SHOULD-level check that reported WARNING is invisible there and shows up only as a row
 * tallying neither. Client mode prints the warning count beside them, so this shape keeps it:
 * the runner treats a warning as an overall failure, and a baseline that dropped the count
 * would hide a check moving between WARNING and SUCCESS.
 */
export interface ConformanceOutcome {
	/** The scenario identifier, such as `http-standard-headers`. */
	readonly name: string
	/** Checks the scenario passed. */
	readonly passed: number
	/** Checks the scenario failed. */
	readonly failed: number
	/** Checks the scenario reported at SHOULD level. */
	readonly warnings: number
}

/** The parsed outcome of one whole conformance run. */
export interface ConformanceResult {
	/** Every scenario tally in the order the runner reported it. */
	readonly scenarios: readonly ConformanceScenario[]
	/** The runner's own total of passed checks. */
	readonly passed: number
	/** The runner's own total of failed checks. */
	readonly failed: number
}

/** Describes one direct comparison with the vendored Tasks extension schema. */
export interface TaskSchemaRow {
	/** The schema coordinate the row proves. */
	readonly symbol: string
	/** The package's pinned projection of the coordinate. */
	readonly expected: string
	/** The projection read from the vendored schema. */
	readonly model: string
}

/** Pins the raw Tasks extension schema bytes used by this suite. */
export const TASK_SCHEMA_DIGEST = 'bf30afb7ac251e3e22c037b7a685f60ef6603031b5484c0d08b1fa0bbe86d460'

/** Pins the identifier declared by the Tasks extension schema. */
export const TASK_SCHEMA_ID = 'https://modelcontextprotocol.io/ext-tasks/2026-07-28/schema.json'

/** Resolves the vendored Tasks extension schema mirror. */
export const TASK_SCHEMA_PATH = fileURLToPath(
	new URL('./mirrors/ext-tasks-2026-07-28-schema.json', import.meta.url),
)

/** The JSON Schema spelling of an integer millisecond value in the Tasks extension. */
export const TASK_INTEGER_SCHEMA = Object.freeze({
	type: 'integer',
	minimum: -9007199254740991,
	maximum: 9007199254740991,
})

/** The properties every task variant shares. */
export const TASK_PROPERTIES: readonly string[] = [
	'taskId',
	'status',
	'statusMessage',
	'createdAt',
	'lastUpdatedAt',
	'ttlMs',
	'pollIntervalMs',
]

/** The properties every task owes. */
export const TASK_REQUIRED: readonly string[] = [
	'taskId',
	'status',
	'createdAt',
	'lastUpdatedAt',
	'ttlMs',
]

/** Formats an authority value for a direct conformance comparison. */
export function formatConformanceValue(value: unknown): string {
	if (value === undefined) return 'undefined'
	if (typeof value === 'string') return value
	let serialized: string | undefined
	try {
		serialized = JSON.stringify(value)
	} catch {
		serialized = undefined
	}
	return serialized === undefined ? String(value) : serialized
}

/** Formats a direct schema-drift message. */
export function formatConformanceDrift(symbol: string, authority: string, value: unknown): string {
	return `${symbol} drifted; ${authority}=${formatConformanceValue(value)}`
}

/** Reports a drift message when a direct comparison differs. */
export function readConformanceDrift(
	symbol: string,
	local: unknown,
	authority: string,
	value: unknown,
): string | undefined {
	return Object.is(local, value) ? undefined : formatConformanceDrift(symbol, authority, value)
}

/** Computes the SHA-256 digest of a file's raw bytes. */
export function readFileDigest(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Reads one nested schema value without assuming its shape. */
export function readSchemaPath(root: unknown, path: ReadonlyArray<string | number>): unknown {
	let value = root
	for (const segment of path) {
		if (Array.isArray(value)) {
			if (typeof segment !== 'number') return undefined
			value = value[segment]
			continue
		}
		if (!isRecord(value) || typeof segment !== 'string') return undefined
		value = Reflect.get(value, segment)
	}
	return value
}

/** Loads the digest-pinned Tasks extension schema. */
export function readTaskSchema(path: string, digest: string = TASK_SCHEMA_DIGEST): unknown {
	const actual = readFileDigest(path)
	if (actual !== digest) {
		throw new Error(formatConformanceDrift('Tasks schema bytes', 'SHA-256', digest))
	}
	const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
	if (!isRecord(parsed)) throw new Error('The Tasks extension schema root is not a record')
	return parsed
}

/** Holds the parsed Tasks extension schema used to construct each comparison row. */
export const TASK_SCHEMA = readTaskSchema(TASK_SCHEMA_PATH)

/** Builds one row from a direct schema path. */
export function createTaskSchemaRow(
	symbol: string,
	expected: unknown,
	path: ReadonlyArray<string | number>,
): TaskSchemaRow {
	return {
		symbol,
		expected: formatConformanceValue(expected),
		model: formatConformanceValue(readSchemaPath(TASK_SCHEMA, path)),
	}
}

/** Builds one row from a projected schema value. */
export function createTaskProjectionRow(
	symbol: string,
	expected: unknown,
	model: unknown,
): TaskSchemaRow {
	return {
		symbol,
		expected: formatConformanceValue(expected),
		model: formatConformanceValue(model),
	}
}

/** Reads whether the Tasks schema requires one `Task` property. */
export function readTaskRequiredness(member: string): boolean {
	const required = readSchemaPath(TASK_SCHEMA, ['$defs', 'Task', 'required'])
	return Array.isArray(required) && required.includes(member)
}

/** Projects one `DetailedTask` variant onto its status and owed payload. */
export function readTaskVariant(index: number): unknown {
	const variant = readSchemaPath(TASK_SCHEMA, ['$defs', 'DetailedTask', 'anyOf', index])
	if (!isRecord(variant)) return undefined
	const properties = Reflect.get(variant, 'properties')
	const required = Reflect.get(variant, 'required')
	if (!isRecord(properties) || !Array.isArray(required)) return undefined
	const status = readSchemaPath(properties, ['status', 'const'])
	if (status === 'input_required') {
		return {
			status,
			required,
			payload: {
				inputRequests: Reflect.get(properties, 'inputRequests'),
			},
		}
	}
	if (status === 'completed') {
		return {
			status,
			required,
			payload: { result: Reflect.get(properties, 'result') },
		}
	}
	if (status === 'failed') {
		return {
			status,
			required,
			payload: { error: Reflect.get(properties, 'error') },
		}
	}
	return { status, required, payload: {} }
}

/** Projects the flat `CreateTaskResult` composition. */
export function readCreateTaskResult(): unknown {
	const properties = readSchemaPath(TASK_SCHEMA, [
		'$defs',
		'CreateTaskResult',
		'allOf',
		1,
		'properties',
	])
	if (!isRecord(properties)) return undefined
	return {
		base: readSchemaPath(TASK_SCHEMA, ['$defs', 'CreateTaskResult', 'allOf', 0, '$ref']),
		properties: Object.keys(properties),
		required: readSchemaPath(TASK_SCHEMA, ['$defs', 'CreateTaskResult', 'allOf', 1, 'required']),
		nested: Reflect.has(properties, 'task'),
		resultType: readSchemaPath(TASK_SCHEMA, [
			'$defs',
			'CreateTaskResult',
			'allOf',
			2,
			'properties',
			'resultType',
			'const',
		]),
	}
}

/** Projects one completed task-result composition. */
export function readCompleteTaskResult(definition: string): unknown {
	const detail = readSchemaPath(TASK_SCHEMA, ['$defs', definition, 'allOf', 1, 'anyOf'])
	const result = Array.isArray(detail) ? 2 : 1
	return {
		base: readSchemaPath(TASK_SCHEMA, ['$defs', definition, 'allOf', 0, '$ref']),
		detail: Array.isArray(detail),
		resultType: readSchemaPath(TASK_SCHEMA, [
			'$defs',
			definition,
			'allOf',
			result,
			'properties',
			'resultType',
			'const',
		]),
	}
}

/** Projects the flat task-status notification parameters. */
export function readTaskNotificationShape(): unknown {
	const variants = readSchemaPath(TASK_SCHEMA, [
		'$defs',
		'TaskStatusNotificationParams',
		'allOf',
		1,
		'anyOf',
	])
	if (!Array.isArray(variants)) return undefined
	const statuses: unknown[] = []
	for (let index = 0; index < variants.length; index += 1) {
		statuses.push(
			readSchemaPath(TASK_SCHEMA, [
				'$defs',
				'TaskStatusNotificationParams',
				'allOf',
				1,
				'anyOf',
				index,
				'properties',
				'status',
				'const',
			]),
		)
	}
	return {
		base: readSchemaPath(TASK_SCHEMA, [
			'$defs',
			'TaskStatusNotificationParams',
			'allOf',
			0,
			'$ref',
		]),
		statuses,
		nested:
			readSchemaPath(TASK_SCHEMA, [
				'$defs',
				'TaskStatusNotificationParams',
				'allOf',
				1,
				'properties',
				'task',
			]) !== undefined,
	}
}

/** Projects the metadata inherited by task-status notification parameters. */
export function readTaskNotificationMetadata(): unknown {
	return {
		params: readSchemaPath(TASK_SCHEMA, ['$defs', 'NotificationParams', 'properties', '_meta']),
		metadata: {
			type: readSchemaPath(TASK_SCHEMA, ['$defs', 'NotificationMetaObject', 'type']),
			subscription: readSchemaPath(TASK_SCHEMA, [
				'$defs',
				'NotificationMetaObject',
				'properties',
				'io.modelcontextprotocol/subscriptionId',
				'$ref',
			]),
		},
	}
}

/** Projects one task-subscription fragment. */
export function readTaskSubscription(definition: string): unknown {
	return {
		type: readSchemaPath(TASK_SCHEMA, ['$defs', definition, 'type']),
		properties: readSchemaPath(TASK_SCHEMA, ['$defs', definition, 'properties']),
		required: readSchemaPath(TASK_SCHEMA, ['$defs', definition, 'required']),
	}
}

/** Projects the Tasks extension capability's exactly-empty object schema. */
export function readTaskCapability(): unknown {
	return {
		type: readSchemaPath(TASK_SCHEMA, ['$defs', 'TasksExtensionCapability', 'type']),
		propertyNames: readSchemaPath(TASK_SCHEMA, [
			'$defs',
			'TasksExtensionCapability',
			'propertyNames',
		]),
		additionalProperties: readSchemaPath(TASK_SCHEMA, [
			'$defs',
			'TasksExtensionCapability',
			'additionalProperties',
		]),
	}
}

/** Covers `Task` requiredness, `ttlMs` nullability, and integer spellings. */
export const TASK_SCHEMA_TASK_ROWS: readonly TaskSchemaRow[] = [
	...TASK_PROPERTIES.map((member) =>
		createTaskProjectionRow(
			`Task.${member} required`,
			TASK_REQUIRED.includes(member),
			readTaskRequiredness(member),
		),
	),
	createTaskSchemaRow('Task.ttlMs nullable', 'null', [
		'$defs',
		'Task',
		'properties',
		'ttlMs',
		'anyOf',
		1,
		'type',
	]),
	createTaskSchemaRow('Task.ttlMs integer schema', TASK_INTEGER_SCHEMA, [
		'$defs',
		'Task',
		'properties',
		'ttlMs',
		'anyOf',
		0,
	]),
	createTaskSchemaRow('Task.pollIntervalMs integer schema', TASK_INTEGER_SCHEMA, [
		'$defs',
		'Task',
		'properties',
		'pollIntervalMs',
	]),
]

/** Covers each `TaskStatus` member. */
export const TASK_SCHEMA_STATUS_ROWS: readonly TaskSchemaRow[] = [
	createTaskSchemaRow('TaskStatus.working', 'working', [
		'$defs',
		'TaskStatus',
		'anyOf',
		0,
		'const',
	]),
	createTaskSchemaRow('TaskStatus.input_required', 'input_required', [
		'$defs',
		'TaskStatus',
		'anyOf',
		1,
		'const',
	]),
	createTaskSchemaRow('TaskStatus.completed', 'completed', [
		'$defs',
		'TaskStatus',
		'anyOf',
		2,
		'const',
	]),
	createTaskSchemaRow('TaskStatus.failed', 'failed', ['$defs', 'TaskStatus', 'anyOf', 3, 'const']),
	createTaskSchemaRow('TaskStatus.cancelled', 'cancelled', [
		'$defs',
		'TaskStatus',
		'anyOf',
		4,
		'const',
	]),
]

/** Covers each `DetailedTask` variant and the payload it owes. */
export const TASK_SCHEMA_DETAIL_ROWS: readonly TaskSchemaRow[] = [
	createTaskProjectionRow(
		'DetailedTask.working',
		{ status: 'working', required: TASK_REQUIRED, payload: {} },
		readTaskVariant(0),
	),
	createTaskProjectionRow(
		'DetailedTask.input_required',
		{
			status: 'input_required',
			required: [...TASK_REQUIRED, 'inputRequests'],
			payload: { inputRequests: { $ref: '#/$defs/InputRequests' } },
		},
		readTaskVariant(1),
	),
	createTaskProjectionRow(
		'DetailedTask.completed',
		{
			status: 'completed',
			required: [...TASK_REQUIRED, 'result'],
			payload: {
				result: {
					type: 'object',
					propertyNames: { type: 'string' },
					additionalProperties: {},
				},
			},
		},
		readTaskVariant(2),
	),
	createTaskProjectionRow(
		'DetailedTask.failed',
		{
			status: 'failed',
			required: [...TASK_REQUIRED, 'error'],
			payload: { error: { $ref: '#/$defs/Error' } },
		},
		readTaskVariant(3),
	),
	createTaskProjectionRow(
		'DetailedTask.cancelled',
		{ status: 'cancelled', required: TASK_REQUIRED, payload: {} },
		readTaskVariant(4),
	),
]

/** Covers the flat creation result. */
export const TASK_SCHEMA_CREATE_ROWS: readonly TaskSchemaRow[] = [
	createTaskProjectionRow(
		'CreateTaskResult',
		{
			base: '#/$defs/Result',
			properties: TASK_PROPERTIES,
			required: TASK_REQUIRED,
			nested: false,
			resultType: 'task',
		},
		readCreateTaskResult(),
	),
]

/** Covers the completed get, update, and cancel result shapes. */
export const TASK_SCHEMA_RESULT_ROWS: readonly TaskSchemaRow[] = [
	createTaskProjectionRow(
		'GetTaskResult',
		{ base: '#/$defs/Result', detail: true, resultType: 'complete' },
		readCompleteTaskResult('GetTaskResult'),
	),
	createTaskProjectionRow(
		'UpdateTaskResult',
		{ base: '#/$defs/Result', detail: false, resultType: 'complete' },
		readCompleteTaskResult('UpdateTaskResult'),
	),
	createTaskProjectionRow(
		'CancelTaskResult',
		{ base: '#/$defs/Result', detail: false, resultType: 'complete' },
		readCompleteTaskResult('CancelTaskResult'),
	),
]

/** Covers task-status notification flatness and metadata. */
export const TASK_SCHEMA_NOTIFICATION_ROWS: readonly TaskSchemaRow[] = [
	createTaskProjectionRow(
		'TaskStatusNotificationParams flatness',
		{
			base: '#/$defs/NotificationParams',
			statuses: ['working', 'input_required', 'completed', 'failed', 'cancelled'],
			nested: false,
		},
		readTaskNotificationShape(),
	),
	createTaskProjectionRow(
		'TaskStatusNotificationParams metadata',
		{
			params: { $ref: '#/$defs/NotificationMetaObject' },
			metadata: { type: 'object', subscription: '#/$defs/RequestId' },
		},
		readTaskNotificationMetadata(),
	),
]

/** Covers the request-side and acknowledged-side `taskIds` fragments. */
export const TASK_SCHEMA_SUBSCRIPTION_ROWS: readonly TaskSchemaRow[] = [
	createTaskProjectionRow(
		'TaskSubscriptionNotifications.taskIds',
		{
			type: 'object',
			properties: {
				taskIds: { type: 'array', items: { type: 'string' } },
			},
		},
		readTaskSubscription('TaskSubscriptionNotifications'),
	),
	createTaskProjectionRow(
		'TaskSubscriptionAcknowledgedNotifications.taskIds',
		{
			type: 'object',
			properties: {
				taskIds: { type: 'array', items: { type: 'string' } },
			},
		},
		readTaskSubscription('TaskSubscriptionAcknowledgedNotifications'),
	),
]

/** Covers the exactly-empty Tasks extension capability. */
export const TASK_SCHEMA_CAPABILITY_ROWS: readonly TaskSchemaRow[] = [
	createTaskProjectionRow(
		'TasksExtensionCapability',
		{
			type: 'object',
			propertyNames: { type: 'string' },
			additionalProperties: { not: {} },
		},
		readTaskCapability(),
	),
]

/** Covers every method literal declared by the schema. */
export const TASK_SCHEMA_METHOD_ROWS: readonly TaskSchemaRow[] = [
	createTaskSchemaRow('CancelTaskRequest.method', 'tasks/cancel', [
		'$defs',
		'CancelTaskRequest',
		'allOf',
		1,
		'properties',
		'method',
		'const',
	]),
	createTaskSchemaRow('GetTaskRequest.method', 'tasks/get', [
		'$defs',
		'GetTaskRequest',
		'allOf',
		1,
		'properties',
		'method',
		'const',
	]),
	createTaskSchemaRow('TaskStatusNotification.method', 'notifications/tasks', [
		'$defs',
		'TaskStatusNotification',
		'allOf',
		1,
		'properties',
		'method',
		'const',
	]),
	createTaskSchemaRow('UpdateTaskRequest.method', 'tasks/update', [
		'$defs',
		'UpdateTaskRequest',
		'allOf',
		1,
		'properties',
		'method',
		'const',
	]),
	createTaskSchemaRow('CreateMessageRequest.method', 'sampling/createMessage', [
		'$defs',
		'CreateMessageRequest',
		'properties',
		'method',
		'const',
	]),
	createTaskSchemaRow('ElicitRequest.method', 'elicitation/create', [
		'$defs',
		'ElicitRequest',
		'properties',
		'method',
		'const',
	]),
	createTaskSchemaRow('ListRootsRequest.method', 'roots/list', [
		'$defs',
		'ListRootsRequest',
		'properties',
		'method',
		'const',
	]),
]

/** Covers the schema identifier. */
export const TASK_SCHEMA_ID_ROWS: readonly TaskSchemaRow[] = [
	createTaskSchemaRow('Tasks schema $id', TASK_SCHEMA_ID, ['$id']),
]

// ── The tool fixture ─────────────────────────────────────────────────────────

/**
 * The rich content the content-block scenarios ask for VERBATIM.
 *
 * @remarks
 * A plain `execute` return is an ordinary domain value, and the server normalizes one
 * into text plus `structuredContent` exactly as its contract states — so a fixture with no
 * `execution` port cannot answer an image, an audio clip, an embedded resource, or a
 * mixed sequence, and its failures would measure the fixture rather than the library.
 * `MCPServerOptions.execution` is the shipped, documented port for precisely this.
 */
export const CONFORMANCE_CONTENT: Readonly<Record<string, readonly MCPContent[]>> = Object.freeze({
	test_image_content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
	test_audio_content: [{ type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav' }],
	test_embedded_resource: [
		{
			type: 'resource',
			resource: {
				uri: 'test://embedded-resource',
				mimeType: 'text/plain',
				text: 'This is an embedded resource content.',
			},
		},
	],
	test_multiple_content_types: [
		{ type: 'text', text: 'Multiple content types test:' },
		{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
		{
			type: 'resource',
			resource: {
				uri: 'test://mixed-content-resource',
				mimeType: 'application/json',
				text: '{"test":"data","value":123}',
			},
		},
	],
})

/**
 * The JSON Schema 2020-12 document `json-schema-2020-12` reads back out of `tools/list`.
 *
 * @remarks
 * The scenario checks PRESERVATION, so this is the schema verbatim as the runner declares it:
 * `$schema`, `$defs`, and `additionalProperties` for SEP-1613, and the `$anchor`, composition
 * (`allOf`/`anyOf`), and conditional (`if`/`then`/`else`) keywords for SEP-2106. A tool's
 * `parameters` becomes the advertised `inputSchema` unchanged, so anything the listing drops is
 * the library dropping it.
 */
export const CONFORMANCE_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
	$schema: 'https://json-schema.org/draft/2020-12/schema',
	type: 'object',
	$defs: {
		address: {
			$anchor: 'addressDef',
			type: 'object',
			properties: {
				street: { type: 'string' },
				city: { type: 'string' },
			},
		},
	},
	properties: {
		name: { type: 'string' },
		address: { $ref: '#/$defs/address' },
		contactMethod: { type: 'string', enum: ['phone', 'email'] },
		phone: { type: 'string' },
		email: { type: 'string' },
	},
	allOf: [{ anyOf: [{ required: ['phone'] }, { required: ['email'] }] }],
	if: {
		properties: { contactMethod: { const: 'phone' } },
		required: ['contactMethod'],
	},
	then: { required: ['phone'] },
	else: { required: ['email'] },
	additionalProperties: false,
})

/**
 * The text each input-driven tool answers with once its rounds are answered.
 *
 * @remarks
 * The keys are also the REGISTRATION list for that tool family, so a scenario's tool name
 * exists in exactly one place. The text is static on purpose: the built-in input mechanism
 * verifies each response and then continues into the registry, and
 * `ToolManagerInterface.execute` takes a call and nothing else, so a tool never receives the
 * answer its own round asked for. A fixture that re-read the raw request to interpolate one
 * would be reporting on itself rather than on the library.
 *
 * `test_missing_capability` is the exception that proves the gate: SEP-2575 requires the
 * server to REFUSE it, so its text is a sentence no passing run ever sees. A gate that failed
 * open would put that sentence in the runner's own failure detail.
 */
export const CONFORMANCE_ANSWERS: Readonly<Record<string, string>> = Object.freeze({
	test_input_required_result_elicitation: 'Elicitation answered; the call is complete.',
	test_input_required_result_sampling: 'Sampling answered; the call is complete.',
	test_input_required_result_list_roots: 'Roots answered; the call is complete.',
	test_input_required_result_request_state: 'state-ok: the echoed request state verified.',
	test_input_required_result_multiple_inputs: 'Every input answered; the call is complete.',
	test_input_required_result_multi_round: 'Both rounds answered; the call is complete.',
	test_input_required_result_tampered_state: 'Request state verified; the call is complete.',
	test_input_required_result_capabilities: 'Declared-capability input answered.',
	test_missing_capability: 'This tool ran without the sampling capability the round needs.',
})

/**
 * Build the live tool registry the conformance scenarios call.
 *
 * @returns A fresh `ToolManagerInterface` holding every `test_*` tool
 */
export function buildConformanceTools(): ToolManagerInterface {
	const tools = createToolManager()
	tools.add(
		createTool({
			name: 'test_simple_text',
			description: 'Return the conformance suite simple-text fixture.',
			execute: () => 'This is a simple text response for testing.',
		}),
	)
	tools.add(
		createTool({
			name: 'test_image_content',
			description: 'Exercise the declared image-content conformance gap.',
			execute: () => ({
				type: 'image',
				data: 'iVBORw0KGgo=',
				mimeType: 'image/png',
			}),
		}),
	)
	tools.add(
		createTool({
			name: 'test_multiple_content_types',
			description: 'Exercise the declared mixed-content conformance gap.',
			execute: () => CONFORMANCE_CONTENT.test_multiple_content_types,
		}),
	)
	tools.add(
		createTool({
			name: 'test_audio_content',
			description: 'Exercise the declared audio-content conformance gap.',
			execute: () => ({
				type: 'audio',
				data: 'UklGRg==',
				mimeType: 'audio/wav',
			}),
		}),
	)
	tools.add(
		createTool({
			name: 'test_embedded_resource',
			description: 'Exercise the declared embedded-resource conformance gap.',
			execute: () => ({
				type: 'resource',
				resource: {
					uri: 'test://embedded-resource',
					mimeType: 'text/plain',
					text: 'This is an embedded resource content.',
				},
			}),
		}),
	)
	tools.add(
		createTool({
			name: 'test_error_handling',
			description: 'Return the conformance suite isolated tool-error fixture.',
			execute: () => {
				throw new Error('This tool intentionally returns an error for testing')
			},
		}),
	)
	tools.add(
		createTool({
			name: 'test_tool_with_progress',
			description: 'Exercise the declared tool-progress conformance gap.',
			execute: () => 'Tool execution completed.',
		}),
	)
	tools.add(
		createTool({
			name: 'test_header_parameter',
			description: 'Exercise the declared Mcp-Param header conformance gap.',
			parameters: {
				type: 'object',
				properties: {
					value: { type: 'string', 'x-mcp-header': 'value' },
				},
				required: ['value'],
			},
			execute: (values) => values,
		}),
	)
	tools.add(
		createTool({
			name: 'json_schema_2020_12_tool',
			description: 'Tool with JSON Schema 2020-12 features',
			parameters: CONFORMANCE_SCHEMA,
			execute: (values) => values,
		}),
	)
	for (const [name, answer] of Object.entries(CONFORMANCE_ANSWERS)) {
		tools.add(
			createTool({
				name,
				description: `Exercise the input-required round the ${name} scenario drives.`,
				execute: () => answer,
			}),
		)
	}
	return tools
}

// ── The multi-round-trip fixture ─────────────────────────────────────────────
//
// SEP-2322 is a SERVER mechanism, and `MCPServerOptions.input` is where the library owns it:
// the consumer composes each round and supplies principal, continuation, and TTL policy, while
// MCP gates the round against the client's declared capabilities, seals the state, and checks
// every answer against the question it answers. So this half is policy only. Nothing here
// produces an `input_required` result, because a fixture that produced one would be answering
// the conformance run on the library's behalf.
//
// The continuation port is the shipped `createMCPContinuation`, whose `seal` / `open` are
// `@orkestrel/server`'s HMAC token primitives. That is what makes `input-required-result-
// tampered-state` a real proof: the rejection comes from a signature that does not verify.

/** The signing secret the fixture's continuation port protects its request state with. */
export const CONFORMANCE_SECRET = 'orkestrel-conformance-continuation-secret'

/** The principal the fixture binds into protected state; this host authenticates nobody. */
export const CONFORMANCE_PRINCIPAL = 'conformance-client'

/** How long one protected continuation round stays valid, in milliseconds. */
export const CONFORMANCE_TTL = 60_000

/** The integrity-protected continuation port both the tool and prompt rounds seal state with. */
export const CONFORMANCE_CONTINUATION: MCPContinuationInterface =
	createMCPContinuation(CONFORMANCE_SECRET)

/**
 * The rounds each input-driven tool asks for, in the order the scenario drives them.
 *
 * @remarks
 * A tool absent from this table needs no input, so its call runs straight into the registry.
 * The KEYS are the consumer's, and the scenarios read them: `-basic-elicitation` demands the
 * literal `user_name`, and `-multiple-input-requests` demands three keys of three different
 * kinds in one round. `test_input_required_result_multi_round` is the only two-round entry, and
 * the round the selector is on is carried in the continuation's consumer state rather than
 * stored here.
 *
 * `test_input_required_result_capabilities` and `test_missing_capability` ask for sampling
 * ALONE. That is the whole difference between them: the first call declares `sampling`, so the
 * round is issued; the second declares no capabilities at all, so the library refuses it with
 * -32021 before the tool runs.
 */
export const CONFORMANCE_ROUNDS: Readonly<Record<string, readonly MCPInputRequestMap[]>> =
	Object.freeze({
		test_input_required_result_elicitation: [
			{
				user_name: {
					method: 'elicitation/create',
					params: {
						message: 'What is your name?',
						requestedSchema: {
							type: 'object',
							properties: { name: { type: 'string' } },
							required: ['name'],
						},
					},
				},
			},
		],
		test_input_required_result_sampling: [
			{
				capital_question: {
					method: 'sampling/createMessage',
					params: {
						messages: [
							{ role: 'user', content: { type: 'text', text: 'What is the capital of France?' } },
						],
						maxTokens: 100,
					},
				},
			},
		],
		test_input_required_result_list_roots: [{ client_roots: { method: 'roots/list', params: {} } }],
		test_input_required_result_request_state: [
			{
				confirmation: {
					method: 'elicitation/create',
					params: {
						message: 'Please confirm',
						requestedSchema: {
							type: 'object',
							properties: { ok: { type: 'boolean' } },
							required: ['ok'],
						},
					},
				},
			},
		],
		test_input_required_result_multiple_inputs: [
			{
				user_name: {
					method: 'elicitation/create',
					params: {
						message: 'What is your name?',
						requestedSchema: {
							type: 'object',
							properties: { name: { type: 'string' } },
							required: ['name'],
						},
					},
				},
				greeting: {
					method: 'sampling/createMessage',
					params: {
						messages: [{ role: 'user', content: { type: 'text', text: 'Generate a greeting' } }],
						maxTokens: 50,
					},
				},
				client_roots: { method: 'roots/list', params: {} },
			},
		],
		test_input_required_result_multi_round: [
			{
				step1: {
					method: 'elicitation/create',
					params: {
						message: 'Step 1: What is your name?',
						requestedSchema: {
							type: 'object',
							properties: { name: { type: 'string' } },
							required: ['name'],
						},
					},
				},
			},
			{
				step2: {
					method: 'elicitation/create',
					params: {
						message: 'Step 2: What is your favorite color?',
						requestedSchema: {
							type: 'object',
							properties: { color: { type: 'string' } },
							required: ['color'],
						},
					},
				},
			},
		],
		test_input_required_result_tampered_state: [
			{
				confirmation: {
					method: 'elicitation/create',
					params: {
						message: 'Please confirm',
						requestedSchema: {
							type: 'object',
							properties: { ok: { type: 'boolean' } },
							required: ['ok'],
						},
					},
				},
			},
		],
		test_input_required_result_capabilities: [
			{
				capability_probe: {
					method: 'sampling/createMessage',
					params: {
						messages: [{ role: 'user', content: { type: 'text', text: 'What is your name?' } }],
						maxTokens: 50,
					},
				},
			},
		],
		test_missing_capability: [
			{
				capability_probe: {
					method: 'sampling/createMessage',
					params: {
						messages: [{ role: 'user', content: { type: 'text', text: 'Sample something' } }],
						maxTokens: 50,
					},
				},
			},
		],
	})

/**
 * Decide whether the call in hand still owes this host an answer.
 *
 * @remarks
 * The selector is the WHOLE of the consumer's half of a round trip. It sees every verified
 * answer on a retry and the state it carried into the round, and it answers with the next
 * round or with `undefined` — MCP owns the capability gate, the seal, the expiry, and the
 * per-answer check. The round index rides in the continuation's consumer state, so nothing
 * here is stored between requests and two concurrent exchanges cannot collide.
 *
 * @param context - The call in hand, plus every verified answer and the state on a retry
 * @returns The next round, or `undefined` when the tool may run
 */
export function buildConformanceInput(context: MCPInputContext): MCPInputRound | undefined {
	const rounds = CONFORMANCE_ROUNDS[context.name]
	if (rounds === undefined) return undefined
	const round = isFiniteNumber(context.state) ? context.state + 1 : 0
	const requests = rounds[round]
	return requests === undefined ? undefined : { requests, state: round }
}

/**
 * Project the accepted string answers a verified retry carried.
 *
 * @remarks
 * The server has already verified the response against the schema it issued by the time this
 * reads it, so this is a projection rather than a second validation. A declined or cancelled
 * round contributes nothing.
 *
 * @param responses - The retry's `inputResponses` map, keyed by the server-minted request key
 * @returns Every accepted string field, flattened across the map's rounds
 */
export function readConformanceAnswers(
	responses: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, string>> {
	const answers: Record<string, string> = {}
	for (const response of Object.values(responses ?? {})) {
		if (!isRecord(response) || response['action'] !== 'accept') continue
		const content = response['content']
		if (!isRecord(content)) continue
		for (const [field, value] of Object.entries(content)) {
			if (isString(value)) answers[field] = value
		}
	}
	return answers
}

// ── The resource fixture ─────────────────────────────────────────────────────
//
// The host-owned registries the resource, prompt, and completion ports project.
// Each is an ordinary in-memory object — deliberately NOT a workspace and not a template
// engine — because the ports are ports: what backs them is the host's decision and this
// file is one host's answer.

/** The static resources the fixture advertises over `resources/list`. */
export const CONFORMANCE_RESOURCES: readonly MCPResource[] = Object.freeze([
	{
		uri: 'test://static-text',
		name: 'static-text',
		description: 'The conformance suite static text resource.',
		mimeType: 'text/plain',
	},
	{
		uri: 'test://static-binary',
		name: 'static-binary',
		description: 'The conformance suite static binary resource.',
		mimeType: 'image/png',
	},
])

/** The contents each static resource URI resolves to. */
export const CONFORMANCE_CONTENTS: Readonly<Record<string, readonly MCPResourceContents[]>> =
	Object.freeze({
		'test://static-text': [
			{
				uri: 'test://static-text',
				mimeType: 'text/plain',
				text: 'This is the content of the static text resource.',
			},
		],
		'test://static-binary': [
			{
				uri: 'test://static-binary',
				mimeType: 'image/png',
				blob: 'iVBORw0KGgo=',
			},
		],
	})

/**
 * The already-substituted form of the fixture's one resource template.
 *
 * @remarks
 * The template is published as a DESCRIPTOR and matched HERE. MCP expands nothing: it
 * forwards the already-concrete `test://template/123/data` the client sent, and the party
 * that owns the template owns knowing its variables. `scenario resources-templates-read`
 * sends the substituted URI for exactly this reason, so a template engine inside MCP
 * would have nothing to do.
 */
export const CONFORMANCE_TEMPLATE = /^test:\/\/template\/([^/]+)\/data$/

/** The descriptor form of {@link CONFORMANCE_TEMPLATE}, as `resources/templates/list` advertises it. */
export const CONFORMANCE_DESCRIPTOR = 'test://template/{id}/data'

/**
 * Resolve one already-substituted template URI to its JSON document.
 *
 * @param uri - The concrete URI the client sent
 * @returns The document contents, or `undefined` when the URI is not this template's
 */
export function readConformanceTemplate(uri: string): readonly MCPResourceContents[] | undefined {
	const matched = CONFORMANCE_TEMPLATE.exec(uri)
	if (matched === null) return undefined
	const id = matched[1]
	if (id === undefined) return undefined
	return [
		{
			uri,
			mimeType: 'application/json',
			text: JSON.stringify({
				id,
				templateTest: true,
				data: `Data for ID: ${id}`,
			}),
		},
	]
}

// ── The prompt fixture ───────────────────────────────────────────────────────

/** The prompts the fixture advertises over `prompts/list`. */
export const CONFORMANCE_PROMPTS: readonly MCPPrompt[] = Object.freeze([
	{
		name: 'test_simple_prompt',
		description: 'The conformance suite simple-prompt fixture.',
	},
	{
		name: 'test_prompt_with_arguments',
		description: 'The conformance suite parameterized-prompt fixture.',
		arguments: [
			{
				name: 'arg1',
				description: 'First test argument.',
				required: true,
			},
			{
				name: 'arg2',
				description: 'Second test argument.',
				required: true,
			},
		],
	},
	{
		name: 'test_prompt_with_embedded_resource',
		description: 'The conformance suite embedded-resource prompt fixture.',
		arguments: [
			{
				name: 'resourceUri',
				description: 'The resource to embed.',
				required: true,
			},
		],
	},
	{
		name: 'test_prompt_with_image',
		description: 'The conformance suite image-prompt fixture.',
	},
	{
		name: 'test_input_required_result_prompt',
		description: 'The conformance suite multi-round-trip prompt fixture.',
	},
])

/**
 * The input request the multi-round prompt asks for before it can be filled.
 *
 * @remarks
 * `prompts/get` is the arm of SEP-2322 the library places on the HOST: the prompt port may
 * answer an {@link MCPInputResult} of its own, so the key, the request, and the round are this
 * fixture's to choose. That is the opposite division from `tools/call`, where the library owns
 * the round and the consumer supplies only policy.
 */
export const CONFORMANCE_REQUESTS: MCPInputRequestMap = Object.freeze({
	user_context: {
		method: 'elicitation/create',
		params: {
			mode: 'form',
			message: 'What context should the prompt use?',
			requestedSchema: {
				type: 'object',
				properties: { context: { type: 'string' } },
				required: ['context'],
			},
		},
	},
})

/** The canonical state the multi-round prompt seals into its opaque `requestState`. */
export const CONFORMANCE_STATE = 'test_input_required_result_prompt/user_context'

/**
 * Issue the multi-round prompt's round, or let a verified retry through.
 *
 * @remarks
 * The carrier is protected by the same shipped continuation port the tool rounds use, so a
 * `requestState` this host did not seal opens to `undefined` and the round is re-issued rather
 * than honoured.
 *
 * @param params - The `prompts/get` parameters, including the retry carrier
 * @returns The round to answer, or `undefined` when this prompt may be filled
 */
export async function buildConformanceRound(
	params: MCPPromptGetParams,
): Promise<MCPInputResult | undefined> {
	if (params.name !== 'test_input_required_result_prompt') return undefined
	const carrier = params.requestState
	const opened = carrier === undefined ? undefined : await CONFORMANCE_CONTINUATION.open(carrier)
	if (opened === CONFORMANCE_STATE) return undefined
	return {
		resultType: 'input_required',
		inputRequests: CONFORMANCE_REQUESTS,
		requestState: await CONFORMANCE_CONTINUATION.seal(CONFORMANCE_STATE),
	}
}

/**
 * Fill one named prompt with the caller's arguments.
 *
 * @remarks
 * `arguments` are strings by contract, so filling a prompt is the host's own
 * substitution — the same division as the resource template above. MCP validates the
 * argument record and forwards it.
 *
 * @param name - The prompt name the client asked for
 * @param values - The string arguments the client supplied
 * @returns The prompt's messages, or `undefined` when this host owns no such prompt
 */
export function buildConformanceMessages(
	name: string,
	values: Readonly<Record<string, string>>,
): readonly MCPPromptMessage[] | undefined {
	if (name === 'test_simple_prompt') {
		return [
			{
				role: 'user',
				content: {
					type: 'text',
					text: 'This is a simple prompt for testing.',
				},
			},
		]
	}
	if (name === 'test_prompt_with_arguments') {
		return [
			{
				role: 'user',
				content: {
					type: 'text',
					text: `Prompt with arguments: arg1='${values.arg1 ?? ''}', arg2='${values.arg2 ?? ''}'`,
				},
			},
		]
	}
	if (name === 'test_prompt_with_embedded_resource') {
		return [
			{
				role: 'user',
				content: {
					type: 'resource',
					resource: {
						uri: values.resourceUri ?? 'test://example-resource',
						mimeType: 'text/plain',
						text: 'Embedded resource content for testing.',
					},
				},
			},
			{
				role: 'user',
				content: {
					type: 'text',
					text: 'Please process the embedded resource above.',
				},
			},
		]
	}
	if (name === 'test_prompt_with_image') {
		return [
			{
				role: 'user',
				content: {
					type: 'image',
					data: 'iVBORw0KGgo=',
					mimeType: 'image/png',
				},
			},
			{
				role: 'user',
				content: {
					type: 'text',
					text: 'Please analyze the image above.',
				},
			},
		]
	}
	if (name === 'test_input_required_result_prompt') {
		return [
			{
				role: 'user',
				content: {
					type: 'text',
					text: `Prompt with elicited context: '${values.context ?? ''}'`,
				},
			},
		]
	}
	return undefined
}

// ── The completion fixture ───────────────────────────────────────────────────
//
// Completion is a top-level capability, independent of the resource and prompt ports: the host owns
// reference lookup for BOTH arms, because the party that expands a template is the party
// that knows its variables. A reference this host does not recognize answers `undefined`,
// which MCP maps to `-32602` rather than inventing an empty candidate list.

/** The candidate values each prompt argument completes to. */
export const CONFORMANCE_CANDIDATES: Readonly<
	Record<string, Readonly<Record<string, readonly string[]>>>
> = Object.freeze({
	test_prompt_with_arguments: {
		arg1: ['testValue1', 'testAlpha', 'production'],
		arg2: ['testValue2', 'testBeta', 'staging'],
	},
	test_prompt_with_embedded_resource: {
		resourceUri: CONFORMANCE_RESOURCES.map((entry) => entry.uri),
	},
})

/** The candidate identifiers the fixture's resource template completes to. */
export const CONFORMANCE_IDENTIFIERS: readonly string[] = Object.freeze(['123', '456', '789'])

/**
 * Project one candidate list onto the fragment the client has typed so far.
 *
 * @param candidates - Every value the reference could complete to
 * @param value - The fragment already typed
 * @returns The matching candidates plus the unprojected total
 */
export function buildConformanceCompletion(
	candidates: readonly string[],
	value: string,
): MCPCompletion {
	return {
		values: candidates.filter((candidate) => candidate.startsWith(value)),
		total: candidates.length,
	}
}

// ── The assembled host ───────────────────────────────────────────────────────

/**
 * Build the whole conformance host — every port `MCPServerOptions` publishes, backed by
 * the plain objects above.
 *
 * @returns The server options one `createMCPServer` call away from a live fixture
 */
export function buildConformanceOptions(): MCPServerOptions {
	const resources: MCPResourceManagerInterface = {
		resources: () => ({ resources: CONFORMANCE_RESOURCES }),
		resource: (params) => CONFORMANCE_CONTENTS[params.uri] ?? readConformanceTemplate(params.uri),
		templates: () => ({
			resourceTemplates: [
				{
					uriTemplate: CONFORMANCE_DESCRIPTOR,
					name: 'template-data',
					description: 'One JSON document per identifier.',
					mimeType: 'application/json',
				},
			],
		}),
	}
	const prompts: MCPPromptManagerInterface = {
		prompts: () => ({ prompts: CONFORMANCE_PROMPTS }),
		prompt: async (params) => {
			const round = await buildConformanceRound(params)
			if (round !== undefined) return round
			// Declared arguments and elicited answers fill the same substitution, because the
			// host that owns a prompt's variables owns them whichever round supplied one.
			const values = {
				...(params.arguments ?? {}),
				...readConformanceAnswers(params.inputResponses),
			}
			const messages = buildConformanceMessages(params.name, values)
			if (messages === undefined) return undefined
			const prompt = CONFORMANCE_PROMPTS.find((entry) => entry.name === params.name)
			if (prompt === undefined) return undefined
			return {
				resultType: 'complete',
				...(prompt.description === undefined ? {} : { description: prompt.description }),
				messages,
			}
		},
	}
	const completion: MCPCompletionInterface = {
		complete: (params) => {
			const ref = params.ref
			if (ref.type === 'ref/prompt') {
				const prompt = CONFORMANCE_PROMPTS.find((entry) => entry.name === ref.name)
				if (prompt === undefined) return undefined
				const candidates = CONFORMANCE_CANDIDATES[ref.name]?.[params.argument.name] ?? []
				return buildConformanceCompletion(candidates, params.argument.value)
			}
			const known = CONFORMANCE_TEMPLATE.test(ref.uri) || ref.uri === CONFORMANCE_DESCRIPTOR
			if (!known) return undefined
			return buildConformanceCompletion(CONFORMANCE_IDENTIFIERS, params.argument.value)
		},
	}
	return {
		identity: CONFORMANCE_IDENTITY,
		tools: buildConformanceTools(),
		resources,
		prompts,
		completion,
		input: {
			continuation: CONFORMANCE_CONTINUATION,
			ttl: CONFORMANCE_TTL,
			principal: () => CONFORMANCE_PRINCIPAL,
			selector: buildConformanceInput,
		},
		execution: async (context) => {
			// The request-scoped reporter exists only when the caller sent a `progressToken`, and
			// reporting is the executor's job rather than the server's — the port hands the reporter
			// over and the work decides what a step is. `tools-call-with-progress` specifies the
			// steps below exactly (0/100, 50/100, 100/100) and counts them, so the fixture reports
			// what the scenario asks for rather than a shape of its own.
			if (context.progress !== undefined) {
				await context.progress.report({ progress: 0, total: 100 })
				await context.progress.report({ progress: 50, total: 100 })
				await context.progress.report({ progress: 100, total: 100 })
			}
			const content = CONFORMANCE_CONTENT[context.call.name]
			if (content !== undefined) return { resultType: 'complete', content }
			return await context.tools.execute(context.call)
		},
	}
}

/**
 * Start the conformance fixture on an ephemeral loopback port.
 *
 * @remarks
 * The whole spine is real: `createMCPServer` behind `createMCPRoutes` behind a real
 * `@orkestrel/server` listener, reachable over a real socket by any foreign client.
 * Call `stop()` in `afterAll`.
 *
 * @returns The started-server handle (`base` URL + `stop`)
 */
export async function startConformance(): Promise<StartedServerInterface<undefined>> {
	const mcp = createMCPServer(buildConformanceOptions())
	const dispatcher = createDispatcher<undefined>()
	dispatcher.add(createMCPRoutes<undefined>(mcp))
	return await startServer(createServer<undefined>({ dispatcher, state: () => undefined }))
}

// ── The foreign runner ───────────────────────────────────────────────────────

/**
 * Read the runner build the package manifest pins.
 *
 * @remarks
 * The manifest is the SINGLE authority for the version. It is what `npm install` puts on
 * disk and what the lockfile records, so a constant copied beside it is a second copy that
 * can disagree with the build actually running. The recorded scenario baseline is a
 * baseline of exactly this build, so the suite asserts the runner reports it.
 *
 * @returns The exact version `devDependencies` pins the runner to
 * @throws When the manifest pins no such development dependency
 */
export function readConformanceRelease(): string {
	const parsed: unknown = JSON.parse(
		readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
	)
	if (!isRecord(parsed) || !isRecord(parsed['devDependencies'])) {
		throw new Error('Package manifest must declare object devDependencies')
	}
	const release = parsed['devDependencies'][CONFORMANCE_PACKAGE]
	if (typeof release !== 'string') {
		throw new Error(`Package manifest must pin ${CONFORMANCE_PACKAGE} in devDependencies`)
	}
	return release
}

/**
 * Resolve the installed runner's entry module.
 *
 * @remarks
 * The runner is a development dependency, so its entry is already on disk when the suite
 * starts and no invocation fetches anything. Resolution is anchored on this module, which
 * is what makes the answer the tree's own install rather than whatever a cache holds.
 *
 * @returns The absolute path to the runner's entry module
 * @throws When the development dependency is not installed, naming what to do about it
 */
export function resolveConformanceRunner(): string {
	try {
		return createRequire(import.meta.url).resolve(CONFORMANCE_ENTRY)
	} catch {
		throw new Error(
			`The conformance project needs the ${CONFORMANCE_PACKAGE} development dependency, ` +
				`which is not installed. Run \`npm install\`, then rerun \`npm run test:conformance\`.`,
		)
	}
}

/**
 * Invoke the installed conformance runner and collect everything it wrote.
 *
 * @remarks
 * Node runs the runner's entry file directly. A file path needs no shell on any host, so
 * none is enabled and nothing the caller passes is ever handed to one.
 *
 * @param command - The runner subcommand and its options
 * @returns The runner's combined standard output and standard error
 */
export async function executeRunner(command: readonly string[]): Promise<string> {
	const runner = spawn(process.execPath, [resolveConformanceRunner(), ...command], {
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	const chunks: string[] = []
	runner.stdout.setEncoding('utf8')
	runner.stderr.setEncoding('utf8')
	runner.stdout.on('data', (chunk: string) => chunks.push(chunk))
	runner.stderr.on('data', (chunk: string) => chunks.push(chunk))
	await once(runner, 'close')
	return chunks.join('')
}

/**
 * Parse the runner's `=== SUMMARY ===` block.
 *
 * @param output - Everything the runner wrote
 * @returns The scenario tallies and totals, or `undefined` when it printed no summary
 */
export function parseConformance(output: string): ConformanceResult | undefined {
	const scenarios: ConformanceScenario[] = []
	for (const line of output.split(/\r?\n/)) {
		const totalled = CONFORMANCE_TOTAL.exec(line)
		if (totalled !== null) {
			const passed = totalled[1]
			const failed = totalled[2]
			if (passed === undefined || failed === undefined) return undefined
			return {
				scenarios,
				passed: Number.parseInt(passed, 10),
				failed: Number.parseInt(failed, 10),
			}
		}
		const tallied = CONFORMANCE_TALLY.exec(line)
		if (tallied === null) continue
		const name = tallied[1]
		const passed = tallied[2]
		const failed = tallied[3]
		if (name === undefined || passed === undefined || failed === undefined) continue
		scenarios.push({
			name,
			passed: Number.parseInt(passed, 10),
			failed: Number.parseInt(failed, 10),
		})
	}
	return undefined
}

/**
 * Drive the pinned runner's whole `server` scenario set at {@link CONFORMANCE_SPEC} against
 * a live MCP endpoint.
 *
 * @remarks
 * `--suite all` widens the run past the runner's own `active` default, which excludes its
 * `draft` and `pending` scenarios. This project pins one spec version, so the widened run
 * still names every scenario the runner's own `list --spec-version 2026-07-28` reports for
 * it, and the recorded baseline in `tests/conformance.test.ts` covers scenarios this server
 * does not answer yet.
 *
 * @param url - The fixture's absolute MCP endpoint
 * @returns The parsed run outcome
 * @throws When the runner produced no summary block, carrying everything it wrote
 */
export async function executeConformance(url: string): Promise<ConformanceResult> {
	const output = await executeRunner([
		'server',
		'--url',
		url,
		'--spec-version',
		CONFORMANCE_SPEC,
		'--suite',
		'all',
	])
	const result = parseConformance(output)
	if (result === undefined) {
		throw new Error(
			`${CONFORMANCE_PACKAGE} printed no summary for ${url}. Its output was:\n${output}`,
		)
	}
	return result
}

// ── The client under test ────────────────────────────────────────────────────

/**
 * Compose the command the runner spawns as the client under test.
 *
 * @remarks
 * The runner splits `--command` on spaces and appends the scenario URL, so every token here
 * must be space-free. That rules out `process.execPath`, whose usual Windows value sits
 * under `Program Files`, and leaves the bare `node` the host resolves from `PATH`.
 * `--experimental-strip-types` is passed because the driver is TypeScript: Node enables
 * stripping by default from 22.18, and the manifest's `engines` floor is 22.12, so the flag
 * covers the whole supported range and is accepted as a no-op above it.
 *
 * The driver imports the BUILT surface, which is the only client face a spawned `node`
 * process can resolve. `dist/` must therefore exist before this runs. The gate chain builds
 * before it tests, so `npm test` is satisfied; a standalone `npm run test:conformance` during
 * development needs `npm run build:src` first.
 *
 * @returns The spawn command, driver path included
 * @throws When the driver's path relative to the working directory contains a space, which
 * the runner's own splitting cannot carry
 */
export function resolveConformanceDriver(): string {
	const driver = fileURLToPath(new URL('./conformanceClient.ts', import.meta.url))
	const command = relative(process.cwd(), driver).replaceAll('\\', '/')
	if (command.includes(' ')) {
		throw new Error(
			`${CONFORMANCE_PACKAGE} splits its --command on spaces, and the driver resolves to ` +
				`'${command}'. Run the conformance project from a directory whose path to ` +
				`tests/conformanceClient.ts carries no space.`,
		)
	}
	return `node --experimental-strip-types ${command}`
}

/**
 * Read every client scenario name out of the runner's own `list` output.
 *
 * @remarks
 * `list` prints one section per scenario family, each opening with its own heading and
 * closing at the first line that is not an entry. This reads the client section alone, so a
 * server or authorization-server scenario sharing a name never enters the answer.
 *
 * @param output - Everything `list` wrote
 * @returns The client scenario names in the order the runner printed them, empty when it
 * printed no client section
 */
export function parseConformanceClients(output: string): readonly string[] {
	const names: string[] = []
	let listing = false
	for (const line of output.split(/\r?\n/)) {
		if (!listing) {
			listing = CONFORMANCE_CLIENTS.test(line)
			continue
		}
		const matched = CONFORMANCE_LISTED.exec(line)
		if (matched === null) break
		const name = matched[1]
		if (name !== undefined) names.push(name)
	}
	return names
}

/**
 * Parse the runner's per-scenario result block from one client-mode run.
 *
 * @remarks
 * Client mode prints no `=== SUMMARY ===` block for a single scenario. Its verdict is the
 * one `Passed: N/D, M failed, W warnings` line, whose denominator is the passed-plus-failed
 * total and carries nothing the three counts do not.
 *
 * @param name - The scenario the run drove
 * @param output - Everything the runner wrote
 * @returns The scenario's outcome, or `undefined` when it printed no result line
 */
export function parseConformanceOutcome(
	name: string,
	output: string,
): ConformanceOutcome | undefined {
	for (const line of output.split(/\r?\n/)) {
		const matched = CONFORMANCE_OUTCOME.exec(line)
		if (matched === null) continue
		const passed = matched[1]
		const failed = matched[2]
		const warnings = matched[3]
		if (passed === undefined || failed === undefined || warnings === undefined) continue
		return {
			name,
			passed: Number.parseInt(passed, 10),
			failed: Number.parseInt(failed, 10),
			warnings: Number.parseInt(warnings, 10),
		}
	}
	return undefined
}

/**
 * Drive this package's own client through every scenario in
 * {@link CONFORMANCE_CLIENT_SCENARIOS}.
 *
 * @remarks
 * Each scenario runs as its own invocation rather than through `--suite`, for two reasons.
 * The runner's suites are `all`, `core`, `extensions`, `backcompat`, `auth`, `metadata`,
 * `draft`, and `sep-835`, and every one of them that reaches this package's scenarios also
 * drags in the `auth/*` family this package excludes. And `--suite` runs its scenarios in
 * parallel, so a hang reports as the whole suite rather than as the scenario that hung.
 * Serial invocation costs a process launch per scenario and buys a per-scenario reading.
 *
 * The runner starts and stops each scenario's own server, so nothing here binds a port.
 *
 * @returns Every scenario's outcome, in {@link CONFORMANCE_CLIENT_SCENARIOS} order
 * @throws When the runner produced no result line for a scenario, carrying everything it wrote
 */
export async function executeConformanceClient(): Promise<readonly ConformanceOutcome[]> {
	const command = resolveConformanceDriver()
	const outcomes: ConformanceOutcome[] = []
	for (const scenario of CONFORMANCE_CLIENT_SCENARIOS) {
		const output = await executeRunner([
			'client',
			'--command',
			command,
			'--scenario',
			scenario,
			'--spec-version',
			CONFORMANCE_SPEC,
		])
		const outcome = parseConformanceOutcome(scenario, output)
		if (outcome === undefined) {
			throw new Error(
				`${CONFORMANCE_PACKAGE} printed no result for client scenario ${scenario}. ` +
					`Its output was:\n${output}`,
			)
		}
		outcomes.push(outcome)
	}
	return outcomes
}
