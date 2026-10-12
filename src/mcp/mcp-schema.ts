// MCP tool descriptor and argument validation. Everything a server advertises is untrusted input: names are constrained,
// descriptions are length-capped and stripped of control characters, input schemas are limited to a small, fully-checkable
// JSON Schema subset (a tool that uses anything else is REJECTED at discovery, never silently half-validated), and call
// arguments are validated against that schema before anything is sent or even approved.
import crypto from 'node:crypto';

export const MCP_MAX_TOOLS = 200;
export const MCP_MAX_SCHEMA_BYTES = 16 * 1024;
export const MCP_MAX_SCHEMA_DEPTH = 8;
export const MCP_MAX_ARGUMENT_BYTES = 64 * 1024;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export type McpJsonSchema = {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';
  description?: string;
  properties?: Record<string, McpJsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: Array<string | number | boolean | null>;
  items?: McpJsonSchema;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
};

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: McpJsonSchema;
  // Server-provided hints. NEVER used to grant permission; shown to the user only.
  readOnlyHint: boolean | null;
  schemaHash: string;
}

export type McpToolParse = { ok: true; tool: McpToolDescriptor } | { ok: false; name: string; reason: string };

const ALLOWED_KEYWORDS = new Set(['type', 'description', 'title', 'properties', 'required', 'additionalProperties', 'enum', 'items', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'default', '$schema']);
const TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array', 'null']);

export function sanitizeText(value: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

export function hashSchema(name: string, description: string, schema: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonical({ name, description, schema }))).digest('hex');
}

// Returns a reason string when the schema uses anything outside the supported subset.
function checkSchema(schema: unknown, depth: number): string | null {
  if (depth > MCP_MAX_SCHEMA_DEPTH) return 'SCHEMA_TOO_DEEP';
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return 'SCHEMA_NOT_OBJECT';
  const s = schema as Record<string, unknown>;
  for (const key of Object.keys(s)) if (!ALLOWED_KEYWORDS.has(key)) return `UNSUPPORTED_KEYWORD:${key.slice(0, 40)}`;
  if (s.type !== undefined && (typeof s.type !== 'string' || !TYPES.has(s.type))) return 'UNSUPPORTED_TYPE';
  if (s.properties !== undefined) {
    if (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties)) return 'INVALID_PROPERTIES';
    for (const [name, child] of Object.entries(s.properties)) {
      if (name.length > 100) return 'PROPERTY_NAME_TOO_LONG';
      const reason = checkSchema(child, depth + 1);
      if (reason) return reason;
    }
  }
  if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some((entry) => typeof entry !== 'string'))) return 'INVALID_REQUIRED';
  if (s.items !== undefined) {
    const reason = checkSchema(s.items, depth + 1);
    if (reason) return reason;
  }
  if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length > 100 || s.enum.some((entry) => entry !== null && !['string', 'number', 'boolean'].includes(typeof entry)))) return 'INVALID_ENUM';
  if (s.additionalProperties !== undefined && typeof s.additionalProperties !== 'boolean') return 'UNSUPPORTED_ADDITIONAL_PROPERTIES';
  for (const key of ['minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems'] as const) {
    if (s[key] !== undefined && (typeof s[key] !== 'number' || !Number.isFinite(s[key] as number))) return `INVALID_${key.toUpperCase()}`;
  }
  return null;
}

export function parseToolDescriptor(raw: unknown): McpToolParse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, name: '', reason: 'NOT_AN_OBJECT' };
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name : '';
  if (!TOOL_NAME.test(name)) return { ok: false, name: sanitizeText(name, 64), reason: 'INVALID_NAME' };
  const description = sanitizeText(r.description, 2000);
  const schema = r.inputSchema === undefined ? { type: 'object', properties: {} } : r.inputSchema;
  let serialized: string;
  try { serialized = JSON.stringify(schema); } catch { return { ok: false, name, reason: 'SCHEMA_NOT_SERIALIZABLE' }; }
  if (serialized.length > MCP_MAX_SCHEMA_BYTES) return { ok: false, name, reason: 'SCHEMA_TOO_LARGE' };
  const problem = checkSchema(schema, 0);
  if (problem) return { ok: false, name, reason: problem };
  if ((schema as McpJsonSchema).type !== 'object' && (schema as McpJsonSchema).type !== undefined) return { ok: false, name, reason: 'ROOT_SCHEMA_NOT_OBJECT' };
  const annotations = r.annotations && typeof r.annotations === 'object' ? (r.annotations as Record<string, unknown>) : {};
  const inputSchema = { type: 'object', ...(schema as McpJsonSchema) } as McpJsonSchema;
  return { ok: true, tool: { name, description, inputSchema, readOnlyHint: typeof annotations.readOnlyHint === 'boolean' ? annotations.readOnlyHint : null, schemaHash: hashSchema(name, description, inputSchema) } };
}

// Validates call arguments against a (previously accepted) schema. Returns human-readable problems; empty means valid.
export function validateArguments(schema: McpJsonSchema, args: unknown): string[] {
  const problems: string[] = [];
  let size = 0;
  try { size = JSON.stringify(args ?? {}).length; } catch { return ['Arguments are not serializable.']; }
  if (size > MCP_MAX_ARGUMENT_BYTES) return ['Arguments are too large.'];
  walk(schema, args ?? {}, '$', problems, 0);
  return problems;
}

function walk(schema: McpJsonSchema, value: unknown, at: string, problems: string[], depth: number): void {
  if (depth > MCP_MAX_SCHEMA_DEPTH + 4 || problems.length >= 10) return;
  const type = schema.type;
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (type) {
    const ok = type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
      : type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : type === actual;
    if (!ok) { problems.push(`${at} must be ${type}.`); return; }
  }
  if (schema.enum && !schema.enum.some((entry) => entry === value)) problems.push(`${at} must be one of the allowed values.`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${at} is too short.`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${at} is too long.`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${at} is below the minimum.`);
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${at} is above the maximum.`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${at} has too few items.`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${at} has too many items.`);
    if (schema.items) value.forEach((item, index) => walk(schema.items as McpJsonSchema, item, `${at}[${index}]`, problems, depth + 1));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) problems.push(`${at}.${key} is required.`);
    for (const [key, child] of Object.entries(object)) {
      const sub = schema.properties?.[key];
      if (sub) walk(sub, child, `${at}.${key}`, problems, depth + 1);
      else if (schema.additionalProperties === false) problems.push(`${at}.${key} is not allowed.`);
    }
  }
}
