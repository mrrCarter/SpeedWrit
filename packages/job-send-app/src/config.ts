// The service's configuration, read once from the environment at start. Every problem is collected
// and reported together by NAME, never by value: a secret must not reach a log because it was set
// wrong. Nothing here talks to the network or the database.

/** One configuration problem: the variable's name and what is wrong with it, never its value. */
export type ConfigProblem = { name: string; problem: string };

export class ConfigError extends Error {
  constructor(readonly problems: readonly ConfigProblem[]) {
    super(`configuration: ${problems.map((p) => `${p.name} ${p.problem}`).join("; ")}`);
    this.name = "ConfigError";
  }
}

export type AppConfig = {
  /** The public https origin (no path, no trailing slash). OAuth resources and redirects hang off it. */
  host: string;
  port: number;
  databaseUrl: string;
  google: { clientId: string; clientSecret: string };
  /** Ed25519 PKCS#8 PEM. Signs every receipt. */
  receiptSigningKey: string;
  /** 32 bytes, base64. Seals the Gmail refresh tokens at rest. */
  custodyKey: string;
  /** The built owner app (job-send-ui build:app). */
  ownerAppDir: string;
  /** The template a draft uses when it names none (the demo's seeded one). */
  defaultTemplateId: string | null;
  /** DEMO_RECIPIENTS as set: the executor's parseDemoRecipients reads it, so there is one parser. */
  demoRecipients: string | null;
  /** Redirect URIs allowed besides ChatGPT's, by exact string (e.g. MCP Inspector's callback). */
  redirectFallbacks: string[];
  /** The secret-path fallback (spec: "10:30 with no OAuth link from ChatGPT"). Off unless "on". */
  secretPathFallback: boolean;
  /** The AI-review vendor key; review is skipped (and holds as unavailable) without it. */
  aiReviewKey: string | null;
  /** One access-log line per request (secret paths redacted). */
  accessLog: boolean;
  /** The owner app's contact list (spec: contacts are owner-supplied), from OWNER_APP_CONTACTS as JSON. */
  contacts: { name: string; email: string; company?: string }[];
  /** The purpose a new job starts with on the confirm screen. */
  jobPurpose: string;
};

const ORIGIN = /^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$/;

/** Reads the configuration, or throws ConfigError naming every missing or malformed variable. */
export function loadConfig(env: Readonly<Record<string, string | undefined>>): AppConfig {
  const problems: ConfigProblem[] = [];
  const text = (name: string): string | null => {
    const value = env[name];
    return typeof value === "string" && value.trim() !== "" ? value : null;
  };
  const required = (name: string): string => {
    const value = text(name);
    if (value === null) problems.push({ name, problem: "is required" });
    return value ?? "";
  };
  const list = (name: string): string[] =>
    (text(name) ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");

  const host = required("HOST");
  if (host !== "" && !ORIGIN.test(host)) problems.push({ name: "HOST", problem: "must be an https origin with no path or trailing slash" });

  const portText = text("PORT") ?? "8080";
  const port = Number(portText);
  if (!/^[0-9]{1,5}$/.test(portText) || port < 1 || port > 65535) problems.push({ name: "PORT", problem: "must be a port number" });

  const databaseUrl = required("DATABASE_URL");
  if (databaseUrl !== "" && !/^postgres(ql)?:\/\//.test(databaseUrl)) problems.push({ name: "DATABASE_URL", problem: "must be a postgres:// URL" });

  const clientId = required("GOOGLE_CLIENT_ID");
  const clientSecret = required("GOOGLE_CLIENT_SECRET");

  const receiptSigningKey = required("RECEIPT_SIGNING_KEY");
  if (receiptSigningKey !== "" && !/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/.test(receiptSigningKey)) {
    problems.push({ name: "RECEIPT_SIGNING_KEY", problem: "must be a PKCS#8 PEM private key" });
  }

  const custodyKey = required("CUSTODY_KEY");
  if (custodyKey !== "" && Buffer.from(custodyKey, "base64").length !== 32) problems.push({ name: "CUSTODY_KEY", problem: "must be 32 bytes, base64" });

  const ownerAppDir = required("OWNER_APP_DIR");

  const redirectFallbacks = list("REDIRECT_FALLBACKS");
  for (const uri of redirectFallbacks) {
    // A fallback is matched by exact string, so it must at least be an absolute http(s) URL.
    if (!/^https?:\/\/[^\s]+$/.test(uri)) {
      problems.push({ name: "REDIRECT_FALLBACKS", problem: "must list absolute http(s) URLs, comma-separated" });
      break;
    }
  }

  const fallbackFlag = text("SECRET_PATH_FALLBACK") ?? "off";
  if (fallbackFlag !== "on" && fallbackFlag !== "off") problems.push({ name: "SECRET_PATH_FALLBACK", problem: 'must be "on" or "off"' });
  const logFlag = text("ACCESS_LOG") ?? "on";
  if (logFlag !== "on" && logFlag !== "off") problems.push({ name: "ACCESS_LOG", problem: 'must be "on" or "off"' });

  let contacts: AppConfig["contacts"] = [];
  const contactsText = text("OWNER_APP_CONTACTS");
  if (contactsText !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contactsText);
    } catch {
      parsed = null;
    }
    const valid =
      Array.isArray(parsed) &&
      parsed.every(
        (c) =>
          c !== null &&
          typeof c === "object" &&
          typeof c.name === "string" &&
          typeof c.email === "string" &&
          (c.company === undefined || typeof c.company === "string"),
      );
    if (valid) contacts = parsed as AppConfig["contacts"];
    else problems.push({ name: "OWNER_APP_CONTACTS", problem: 'must be a JSON list of { "name", "email", "company"? }' });
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    host,
    port,
    databaseUrl,
    google: { clientId, clientSecret },
    receiptSigningKey,
    custodyKey,
    ownerAppDir,
    defaultTemplateId: text("DEFAULT_TEMPLATE_ID"),
    demoRecipients: text("DEMO_RECIPIENTS"),
    redirectFallbacks,
    secretPathFallback: fallbackFlag === "on",
    aiReviewKey: text("TYPESAFE_API_KEY"),
    accessLog: logFlag === "on",
    contacts,
    jobPurpose: text("JOB_PURPOSE") ?? "Send a recap of our call.",
  };
}
