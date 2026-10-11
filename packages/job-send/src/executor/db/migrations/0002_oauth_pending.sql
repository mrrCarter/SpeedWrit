-- OAuth for the agent connection, second part (warden). 0001 holds the clients, codes and tokens.

-- An authorize request waiting for the owner's answer on the consent screen (#515). Found by the
-- hash of its one-time request id and taken with DELETE ... RETURNING, so it is answered once.
CREATE TABLE oauth_pending_authorizations (
  request_hash    text PRIMARY KEY,
  owner_id        text NOT NULL REFERENCES owners (id),
  client_id       text NOT NULL REFERENCES oauth_clients (client_id),
  client_name     text NOT NULL,
  redirect_uri    text NOT NULL,
  code_challenge  text NOT NULL,
  scope           text NOT NULL,
  resource        text NOT NULL,
  state           text,
  expires_at      timestamptz NOT NULL
);
CREATE INDEX oauth_pending_authorizations_expires_at ON oauth_pending_authorizations (expires_at);

-- Revoking an agent connection touches every token and unused code it holds.
CREATE INDEX oauth_codes_agent_connection ON oauth_codes (agent_connection_id) WHERE used_at IS NULL;
CREATE INDEX access_tokens_agent_connection ON access_tokens (agent_connection_id) WHERE revoked_at IS NULL;
CREATE INDEX refresh_tokens_agent_connection ON refresh_tokens (agent_connection_id) WHERE revoked_at IS NULL;
