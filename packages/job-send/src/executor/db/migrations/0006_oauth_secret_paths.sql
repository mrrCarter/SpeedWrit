-- The secret-path fallback (#521): HOST/mcp/c/<secret> names one agent connection. Only the
-- secret's hash is stored; a revoked agent connection stops answering because /mcp reads
-- agent_connections.revoked_at.
CREATE TABLE oauth_secret_paths (
  secret_hash          text PRIMARY KEY CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  agent_connection_id  text NOT NULL REFERENCES agent_connections (id),
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_secret_paths_agent_connection ON oauth_secret_paths (agent_connection_id);
