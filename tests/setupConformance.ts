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
	MCPCompletionManagerInterface,
	MCPContent,
	MCPPrompt,
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
import { fileURLToPath } from 'node:url'
import { isRecord } from '@orkestrel/contract'
import { createDispatcher } from '@orkestrel/router'
import { createServer } from '@orkestrel/server'
import { createTool, createToolManager } from '@orkestrel/tool'
import { createMCPServer } from '@src/core'
import { createMCPRoutes } from '@src/server'
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
 * into text plus `structuredContent` exactly as it should — so a fixture with no
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
	return tools
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
])

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
		prompt: (params) => {
			const messages = buildConformanceMessages(params.name, params.arguments ?? {})
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
	const completion: MCPCompletionManagerInterface = {
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
