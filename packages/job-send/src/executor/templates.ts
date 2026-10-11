import type { Pool } from "pg";

import type { FieldRule } from "../contract/types.js";
import { one } from "./db/tx.js";
import { placeholderNames } from "./render/fill.js";
import { templateSha256 } from "./render/render.js";

// Shared templates (owner_id NULL): what a job uses when the owner names none. The `fields` column
// holds the template's default field rules, which createJobDraft copies into the job's authority.

export type SharedTemplate = { id: string; subjectTpl: string; bodyTpl: string; fieldRules: Record<string, FieldRule> };

/** The demo's recap template, with the spec's example field rules ("The job is the authority"). */
export const DEMO_RECAP_TEMPLATE: SharedTemplate = Object.freeze({
  id: "tpl_recap",
  subjectTpl: "Recap: {{topic}}",
  bodyTpl: "Hi {{first_name}},\n\nThanks for the {{topic}}. Here is the recap:\n\n{{recap}}\n\nBest regards",
  fieldRules: Object.freeze({
    first_name: Object.freeze({ max: 40, single_line: true, required: true }),
    topic: Object.freeze({ max: 80, single_line: true, required: true }),
    recap: Object.freeze({ max: 600, required: true, free_text: true }),
  }),
});

/**
 * Inserts a shared template once. Jobs pin a template by id and hash, so the same id with different
 * text is refused: change the id instead. The field rules must name exactly the placeholders.
 */
export async function ensureSharedTemplate(pool: Pool, template: SharedTemplate): Promise<{ id: string; sha256: string }> {
  const placeholders = [...new Set([...placeholderNames(template.subjectTpl), ...placeholderNames(template.bodyTpl)])].sort();
  if (placeholders.join("\n") !== Object.keys(template.fieldRules).sort().join("\n")) {
    throw new Error(`template ${template.id}: the field rules must name exactly its placeholders`);
  }
  const sha256 = templateSha256({ subject_tpl: template.subjectTpl, body_tpl: template.bodyTpl });
  await pool.query(
    `INSERT INTO templates (id, owner_id, subject_tpl, body_tpl, fields, sha256) VALUES ($1, NULL, $2, $3, $4::jsonb, $5)
     ON CONFLICT (id) DO NOTHING`,
    [template.id, template.subjectTpl, template.bodyTpl, JSON.stringify(template.fieldRules), sha256],
  );
  const row = await one<{ sha256: string; owner_id: string | null }>(pool, "SELECT sha256, owner_id FROM templates WHERE id = $1", [template.id]);
  if (!row || row.owner_id !== null || row.sha256 !== sha256) {
    throw new Error(`template ${template.id} already exists with other text or another owner; give the new text a new id`);
  }
  return { id: template.id, sha256 };
}
