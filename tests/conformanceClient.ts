// The client under test — the process `@modelcontextprotocol/conformance` SPAWNS for every
// client scenario. The runner appends the scenario server's URL as the last argument, names
// the scenario in `MCP_CONFORMANCE_SCENARIO`, forwards the resolved revision in
// `MCP_CONFORMANCE_PROTOCOL_VERSION`, and hands a scenario that scripts exact tool calls its
// script as JSON in `MCP_CONFORMANCE_CONTEXT`.
//
// This file imports the BUILT surface through the package's own published specifiers. A
// plain `node` process resolves neither the `@src/*` aliases nor the `.js`-suffixed relative
// imports inside `src/`, so the published artifact is the only client face a spawned process
// can reach. `dist/` must therefore exist before this file runs: the gate chain builds before
// it tests, and a standalone `npm run test:conformance` during development needs
// `npm run build:src` first. `tests/setupConformance.ts` states that requirement where it
// composes the command.
//
// Nothing imports this module and nothing can. Its helpers are module-scope and unexported
// because the runner spawns it as a runtime entry, and a spawned entry cannot reach
// `tests/setupConformance.ts` — whose own imports that process cannot resolve. That
// self-containment is the reason the export-and-test rule does not reach these helpers.
//
// It carries NO scenario knowledge. It calls exactly the tools the client itself listed, or
// exactly the calls the runner scripted, with arguments read from each tool's own advertised
// schema. So a check about which tools a client keeps measures the client rather than this
// file: a tool the client failed to exclude is a tool this driver calls. A free-form object
// argument is the one leaf whose schema describes no shape to build, so it carries another
// listed tool's received schema — peer data rather than scenario knowledge.

import type {
	MCPCallOutcome,
	MCPClientInterface,
	MCPElicitValue,
	MCPInputRequest,
	MCPInputRequestMap,
	MCPInputResponse,
} from '@orkestrel/mcp'
import type { ToolInterface } from '@orkestrel/tool'
import { isArray, isRecord, isString } from '@orkestrel/contract'
import { createMCPClient } from '@orkestrel/mcp'
import { createHTTPClientTransport } from '@orkestrel/mcp/server'

/** One tool call, either scripted by the runner or derived from a listed tool. */
interface ConformanceCall {
	readonly name: string
	readonly arguments: Readonly<Record<string, unknown>>
}

/** The identity this driver reports as its `clientInfo`. */
const DRIVER_IDENTITY = { name: 'orkestrel-conformance-client', version: '0.0.9' }

/**
 * Read one JSON Schema leaf as a value an elicitation answer and a tool argument both accept.
 *
 * @param schema - The leaf schema to read
 * @returns A value of the declared type, or `undefined` when the leaf declares none this
 * driver can supply
 */
function readSchemaValue(schema: unknown): MCPElicitValue | undefined {
	if (!isRecord(schema)) return undefined
	const type = schema['type']
	if (type === 'string') return 'conformance'
	if (type === 'integer') return 1
	if (type === 'number') return 1.5
	if (type === 'boolean') return true
	if (type === 'array') return []
	return undefined
}

/**
 * Build one argument record from an advertised object schema.
 *
 * @remarks
 * Every property the schema declares a supplyable type for is filled; a `$ref`, a nested
 * object, and any other leaf this driver cannot supply is omitted rather than guessed.
 *
 * @param schema - The object schema whose `properties` describe the record
 * @returns The filled record, empty when the schema declares no usable property
 */
function buildSchemaRecord(schema: unknown): Record<string, MCPElicitValue> {
	const properties = isRecord(schema) ? schema['properties'] : undefined
	if (!isRecord(properties)) return {}
	const record: Record<string, MCPElicitValue> = {}
	for (const [key, leaf] of Object.entries(properties)) {
		const value = readSchemaValue(leaf)
		if (value !== undefined) record[key] = value
	}
	return record
}

/**
 * Read the schema this driver received for a listed tool other than the one being called.
 *
 * @remarks
 * A free-form object argument declares no shape the driver could compose, so the only object
 * it can supply without inventing one is an object the peer itself delivered: another listed
 * tool's `inputSchema`. The tool being called is skipped, because handing a peer back the
 * schema it just sent under that same name reports nothing about what the client preserved.
 *
 * @param tools - Every tool the client listed
 * @param name - The tool being called
 * @returns The other tool's received schema, or `undefined` when the listing holds no other
 * tool
 */
function readReceivedSchema(
	tools: readonly ToolInterface[],
	name: string,
): Readonly<Record<string, unknown>> | undefined {
	return tools.find((tool) => tool.name !== name)?.parameters
}

/**
 * Build one tool call's arguments from that tool's own advertised schema.
 *
 * @remarks
 * Every leaf {@link buildSchemaRecord} can supply is supplied exactly as an elicitation
 * answer supplies it. A property typed `object` that declares no `properties` of its own is
 * the one leaf this adds: that is a free-form object slot, and `received` fills it verbatim.
 * An object leaf that DOES declare its own properties stays omitted, because a record the
 * driver did not compose from that leaf would contradict the shape the leaf declares.
 *
 * @param schema - The tool's advertised `inputSchema`
 * @param received - The schema to place in a free-form object slot, absent when the listing
 * offered none
 * @returns The filled argument record
 */
function buildCallArguments(schema: unknown, received: unknown): Record<string, unknown> {
	const record: Record<string, unknown> = buildSchemaRecord(schema)
	const properties = isRecord(schema) ? schema['properties'] : undefined
	if (received === undefined || !isRecord(properties)) return record
	for (const [key, leaf] of Object.entries(properties)) {
		if (!isRecord(leaf) || leaf['type'] !== 'object' || isRecord(leaf['properties'])) continue
		record[key] = received
	}
	return record
}

/**
 * Answer one embedded input request with the arm its method names.
 *
 * @param request - The request the peer issued under one round key
 * @returns The matching client answer
 */
function buildInputResponse(request: MCPInputRequest): MCPInputResponse {
	if (request.method === 'roots/list') return { roots: [] }
	if (request.method === 'sampling/createMessage') {
		return {
			role: 'assistant',
			content: { type: 'text', text: 'conformance' },
			model: DRIVER_IDENTITY.name,
		}
	}
	const params = request.params
	if (params.mode === 'url') return { action: 'accept' }
	return { action: 'accept', content: buildSchemaRecord(params.requestedSchema) }
}

/**
 * Answer every key of one issued round.
 *
 * @param requests - The round the peer issued
 * @returns The answer map keyed exactly as the round was
 */
function buildInputResponses(requests: MCPInputRequestMap): Record<string, MCPInputResponse> {
	const responses: Record<string, MCPInputResponse> = {}
	for (const [key, request] of Object.entries(requests)) {
		responses[key] = buildInputResponse(request)
	}
	return responses
}

/**
 * Read the exact calls the runner scripted for this scenario.
 *
 * @param context - The raw `MCP_CONFORMANCE_CONTEXT` value, absent for an unscripted scenario
 * @returns The scripted calls, or `undefined` when the scenario scripted none
 */
function readScriptedCalls(context: string | undefined): readonly ConformanceCall[] | undefined {
	if (context === undefined) return undefined
	const parsed: unknown = JSON.parse(context)
	const scripted = isRecord(parsed) ? parsed['toolCalls'] : undefined
	if (!isArray(scripted)) return undefined
	const calls: ConformanceCall[] = []
	for (const entry of scripted) {
		if (!isRecord(entry) || !isString(entry['name'])) continue
		const args = entry['arguments']
		calls.push({ name: entry['name'], arguments: isRecord(args) ? args : {} })
	}
	return calls
}

/**
 * Report one fault to the runner without ending the run.
 *
 * @remarks
 * The exit code separates the two kinds of fault, because the runner reads a nonzero exit as
 * the client under test having failed. A peer that refuses ONE call — an unknown tool, a
 * method the scenario server never handles — has answered correctly, so that fault is
 * reported and the exit code is left alone. A fault opening, listing, or closing means the
 * client could not be driven at all, and the entry sets the nonzero exit for it.
 *
 * @param label - What was being driven when the fault surfaced
 * @param error - The fault itself
 */
function reportFault(label: string, error: unknown): void {
	const detail = error instanceof Error ? error.message : String(error)
	process.stderr.write(`${label}: ${detail}\n`)
}

/**
 * Drive one call and, when the peer asks for another round, answer it once.
 *
 * @remarks
 * The retry maps the peer's round onto `MCPCallOptions.input`, whose `state` leaf is
 * OPTIONAL: SEP-2322 lets a peer issue a round with no `requestState`, and the retry answering
 * that round omits the parameter rather than inventing a carrier. A result carrying a carrier
 * and no requests asks nothing, so there is nothing to answer.
 *
 * @param client - The client under test
 * @param call - The call to drive
 * @returns The peer's answer to the last round issued
 */
async function driveCall(
	client: MCPClientInterface,
	call: ConformanceCall,
): Promise<MCPCallOutcome> {
	const outcome = await client.call(call.name, call.arguments)
	if (outcome.resultType !== 'input_required') return outcome
	const state = outcome.requestState
	const requests = outcome.inputRequests
	if (requests === undefined) {
		reportFault(`retry ${call.name}`, 'the round carries no inputRequests to answer')
		return outcome
	}
	const responses = buildInputResponses(requests)
	return await client.call(call.name, call.arguments, {
		input: state === undefined ? { responses } : { state, responses },
	})
}

const url = process.argv[2]
if (url === undefined) throw new Error('The conformance runner appends the scenario URL')

const client = createMCPClient({
	transport: createHTTPClientTransport({ url }),
	identity: DRIVER_IDENTITY,
	capabilities: { elicitation: {}, roots: {}, sampling: {} },
})

try {
	await client.connect()
	const tools = await client.tools()
	const scripted = readScriptedCalls(process.env['MCP_CONFORMANCE_CONTEXT'])
	const calls =
		scripted ??
		tools.map((tool) => ({
			name: tool.name,
			arguments: buildCallArguments(tool.parameters, readReceivedSchema(tools, tool.name)),
		}))
	for (const call of calls) {
		try {
			await driveCall(client, call)
		} catch (error) {
			reportFault(`call ${call.name}`, error)
		}
	}
} catch (error) {
	process.exitCode = 1
	reportFault('drive', error)
}

try {
	await client.disconnect()
} catch (error) {
	process.exitCode = 1
	reportFault('disconnect', error)
}
