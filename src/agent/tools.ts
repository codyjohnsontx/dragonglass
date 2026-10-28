import { JsonSchema, JsonSchemaProperty, ToolDefinition } from '../providers/types';
import { ChangeProposal } from '../vault/proposals';

/**
 * The validated tool layer. The model never touches the vault directly: it
 * emits a tool call, the runtime validates the arguments against the tool's
 * JSON schema, and only then does the tool's `execute` run. Write tools do
 * not write; they return a ChangeProposal for the user to review.
 */

export interface ToolContext {
	conversationId: string;
	signal: AbortSignal;
}

export interface ToolResult {
	/** Text handed back to the model as the tool message. */
	content: string;
	isError?: boolean;
	/** For write tools: the proposal to surface in the review UI. */
	proposal?: ChangeProposal;
}

export interface AgentTool {
	name: string;
	description: string;
	parameters: JsonSchema;
	/** Read-only tools run without approval. Write tools only propose. */
	readOnly: boolean;
	execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
	private readonly tools = new Map<string, AgentTool>();

	register(tool: AgentTool): this {
		if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
		this.tools.set(tool.name, tool);
		return this;
	}

	get(name: string): AgentTool | undefined {
		return this.tools.get(name);
	}

	list(): AgentTool[] {
		return [...this.tools.values()];
	}

	definitions(): ToolDefinition[] {
		return this.list().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
	}
}

export class ToolValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ToolValidationError';
	}
}

/** Parse the raw JSON arguments and validate them against the schema. */
export function parseToolArguments(tool: AgentTool, argumentsJson: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = argumentsJson.trim() === '' ? {} : (JSON.parse(argumentsJson) as unknown);
	} catch {
		throw new ToolValidationError(`Arguments for ${tool.name} are not valid JSON.`);
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new ToolValidationError(`Arguments for ${tool.name} must be a JSON object.`);
	}
	const errors: string[] = [];
	validateObject(parsed as Record<string, unknown>, tool.parameters, '', errors);
	if (errors.length > 0) throw new ToolValidationError(`Invalid arguments for ${tool.name}: ${errors.join('; ')}`);
	return parsed as Record<string, unknown>;
}

function validateObject(
	value: Record<string, unknown>,
	schema: JsonSchema | JsonSchemaProperty,
	prefix: string,
	errors: string[],
): void {
	const props = schema.properties ?? {};
	for (const req of schema.required ?? []) {
		if (!(req in value) || value[req] === undefined) errors.push(`missing required "${prefix}${req}"`);
	}
	for (const [key, val] of Object.entries(value)) {
		const propSchema = props[key];
		if (!propSchema) {
			if ('additionalProperties' in schema && schema.additionalProperties === false) {
				errors.push(`unexpected property "${prefix}${key}"`);
			}
			continue;
		}
		validateValue(val, propSchema, `${prefix}${key}`, errors);
	}
}

function validateValue(value: unknown, schema: JsonSchemaProperty, path: string, errors: string[]): void {
	if (value === undefined) return;
	switch (schema.type) {
		case 'string':
			if (typeof value !== 'string') return void errors.push(`"${path}" must be a string`);
			if (schema.enum && !schema.enum.includes(value)) {
				errors.push(`"${path}" must be one of ${schema.enum.join(', ')}`);
			}
			return;
		case 'number':
		case 'integer':
			if (typeof value !== 'number' || Number.isNaN(value)) return void errors.push(`"${path}" must be a number`);
			if (schema.type === 'integer' && !Number.isInteger(value)) errors.push(`"${path}" must be an integer`);
			if (schema.minimum !== undefined && value < schema.minimum) errors.push(`"${path}" must be >= ${schema.minimum}`);
			if (schema.maximum !== undefined && value > schema.maximum) errors.push(`"${path}" must be <= ${schema.maximum}`);
			return;
		case 'boolean':
			if (typeof value !== 'boolean') errors.push(`"${path}" must be a boolean`);
			return;
		case 'array':
			if (!Array.isArray(value)) return void errors.push(`"${path}" must be an array`);
			if (schema.items) value.forEach((item, i) => validateValue(item, schema.items as JsonSchemaProperty, `${path}[${i}]`, errors));
			return;
		case 'object':
			if (value === null || typeof value !== 'object' || Array.isArray(value)) {
				return void errors.push(`"${path}" must be an object`);
			}
			validateObject(value as Record<string, unknown>, schema, `${path}.`, errors);
			return;
	}
}
