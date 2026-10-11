// The AI-review question ids, with no vendor code: the contract and the owner screens import
// these, so a browser build never pulls in the review adapter (./provider.ts).

export const FLAGS = Object.freeze([
  "off_purpose",
  "other_client",
  "commitment",
  "hostile_tone",
  "asks_secrets",
  "ai_instructions",
] as const);

export type Flag = (typeof FLAGS)[number];
