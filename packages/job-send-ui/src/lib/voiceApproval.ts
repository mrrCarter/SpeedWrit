export const VOICE_APPROVAL_DISCLOSURE = "voice-approval-v1" as const;
export interface VoiceApprovalPreference {
  configured: boolean;
  eligible_owner: boolean;
  enabled: boolean;
  disclosure_version: typeof VOICE_APPROVAL_DISCLOSURE;
}

/** Keep only the public contract; contradictory or unfamiliar authority is unconfirmed. */
export function parseVoiceApprovalPreference(value: unknown): VoiceApprovalPreference {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("unconfirmed_voice_preference");
  const row = value as Record<string, unknown>;
  if (typeof row.configured !== "boolean" || typeof row.eligible_owner !== "boolean" || typeof row.enabled !== "boolean" ||
      row.disclosure_version !== VOICE_APPROVAL_DISCLOSURE ||
      (row.configured && !row.eligible_owner) || (row.enabled && (!row.configured || !row.eligible_owner))) {
    throw new Error("unconfirmed_voice_preference");
  }
  return { configured: row.configured, eligible_owner: row.eligible_owner, enabled: row.enabled, disclosure_version: VOICE_APPROVAL_DISCLOSURE };
}
