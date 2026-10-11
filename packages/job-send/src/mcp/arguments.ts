// A tool call's arguments are checked against the tool's input schema before any handler runs,
// because the low-level MCP server does not. The schemas in MCP_TOOLS and the owner API use a small
// subset of JSON Schema, and this checks exactly that subset; SCHEMA_KEYWORDS lists it, and tests
// fail if a schema uses any other keyword. Anything it does not understand fails closed.

export const SCHEMA_KEYWORDS = Object.freeze([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "maxLength",
  "enum",
  "minimum",
  "maximum",
  "description",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Null when `value` fits `schema`; otherwise one short reason. A reason names only properties the
 * schema declares, never a key or a value the caller sent.
 */
export function argumentProblem(schema: object, value: unknown, path = "arguments"): string | null {
  const rule = schema as Record<string, unknown>;
  if (rule.type === "string") {
    if (typeof value !== "string") return `${path} must be a string`;
    // JSON Schema counts characters as code points.
    if (typeof rule.maxLength === "number" && [...value].length > rule.maxLength) {
      return `${path} is longer than ${rule.maxLength} characters`;
    }
    if (rule.enum !== undefined && !(Array.isArray(rule.enum) && rule.enum.includes(value))) {
      return `${path} is not one of the allowed values`;
    }
    return null;
  }
  if (rule.type === "boolean") {
    return typeof value === "boolean" ? null : `${path} must be true or false`;
  }
  if (rule.type === "integer") {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) return `${path} must be a whole number`;
    if (typeof rule.minimum === "number" && value < rule.minimum) return `${path} must be at least ${rule.minimum}`;
    if (typeof rule.maximum === "number" && value > rule.maximum) return `${path} must be at most ${rule.maximum}`;
    return null;
  }
  if (rule.type === "object") {
    if (!isRecord(value)) return `${path} must be an object`;
    const properties = isRecord(rule.properties) ? rule.properties : {};
    for (const key of Array.isArray(rule.required) ? rule.required : []) {
      if (!Object.hasOwn(value, key)) return `${path}.${String(key)} is required`;
    }
    for (const [key, item] of Object.entries(value)) {
      // hasOwn, so a key such as "constructor" never finds a rule on the prototype.
      const declared = Object.hasOwn(properties, key);
      const child = declared ? properties[key] : rule.additionalProperties;
      if (child === undefined || child === true) continue;
      if (!isRecord(child)) return `${path} has a property that is not allowed`;
      const problem = argumentProblem(child, item, declared ? `${path}.${key}` : `${path} property`);
      if (problem) return problem;
    }
    return null;
  }
  return `${path}: the schema type is not supported`;
}
