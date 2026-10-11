// The secret-path fallback for the agent connection (spec: "10:30 with no OAuth link from
// ChatGPT"): the connector is set to no authentication and given HOST/mcp/c/<secret>, where the
// secret is 43 random characters that name one agent connection the owner created. The same gate
// runs behind it. Only the secret's hash is stored; the full URL is shown to the owner once.

import { assertOrigin, generateOpaqueToken, hashToken } from "../oauth/oauth.js";

/**
 * The client_id of an agent connection made for a secret path, without OAuth. A registered client's
 * id is a random UUID, so it can never be this.
 */
export const SECRET_PATH_CLIENT_ID = "secret-path";

/** /mcp/c/ and exactly 43 base64url characters (32 random bytes). */
export const SECRET_PATH = /^\/mcp\/c\/([A-Za-z0-9_-]{43})$/;

/** A new secret path: the URL to show the owner once, and the hash to store with the connection. */
export function createSecretPath(host: string): { url: string; secretHash: string } {
  const secret = generateOpaqueToken();
  return { url: `${assertOrigin(host)}/mcp/c/${secret}`, secretHash: hashToken(secret) };
}

/** Secret hashes to agent connections, in memory, for tests and a local demo. */
export class InMemorySecretPaths {
  readonly connections = new Map<string, string>();

  async add(secretHash: string, agentConnectionId: string) {
    this.connections.set(secretHash, agentConnectionId);
  }

  async revoke(secretHash: string) {
    this.connections.delete(secretHash);
  }

  async connectionFor(secretHash: string) {
    return this.connections.get(secretHash) ?? null;
  }
}
