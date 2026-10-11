import { RenderError } from "./errors.js";

// Templates substitute {{name}} and nothing else: no logic, no nesting, no escapes, no whitespace
// inside the braces. Any other brace in a template is a malformed template, so text that looks like
// template syntax never passes through. Values are inserted literally in one pass, so a value that
// contains "{{x}}" is never expanded.

const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

type Segment = { text: string } | { name: string };

function parse(template: string): Segment[] {
  if (typeof template !== "string") {
    throw new RenderError("malformed_template", "template must be a string");
  }
  const segments: Segment[] = [];
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const index = match.index ?? 0;
    pushText(segments, template.slice(last, index));
    segments.push({ name: match[1] ?? "" });
    last = index + match[0].length;
  }
  pushText(segments, template.slice(last));
  return segments;
}

function pushText(segments: Segment[], text: string): void {
  if (text.includes("{") || text.includes("}")) {
    throw new RenderError("malformed_template", "template has a brace outside a {{name}} placeholder");
  }
  if (text !== "") segments.push({ text });
}

/** The placeholder names in `template`, in order of appearance, with repeats. */
export function placeholderNames(template: string): string[] {
  return parse(template).flatMap((segment) => ("name" in segment ? [segment.name] : []));
}

/**
 * Replaces each {{name}} with `fields[name]`. A placeholder without an own string entry in
 * `fields` throws unknown_placeholder.
 */
export function fill(template: string, fields: Readonly<Record<string, string>>): string {
  let out = "";
  for (const segment of parse(template)) {
    if ("text" in segment) {
      out += segment.text;
      continue;
    }
    const value = Object.hasOwn(fields, segment.name) ? fields[segment.name] : undefined;
    if (typeof value !== "string") {
      throw new RenderError("unknown_placeholder", `template placeholder {{${segment.name}}} has no field`, segment.name);
    }
    out += value;
  }
  return out;
}
