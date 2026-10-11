-- Owner sign-in (bundle): the Google sign-in between the redirect and the callback, and the owner's
-- session. Both are found by the sha256 of their random id only; the raw state and session id never
-- reach the database.

-- A sign-in waiting for Google's callback. Taken with DELETE ... RETURNING, so a state is spent once.
-- code_verifier is the PKCE secret for this one exchange, kept only until the callback (10 minutes).
CREATE TABLE owner_sign_ins (
  state_hash     text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  binding_hash   text NOT NULL CHECK (binding_hash ~ '^[0-9a-f]{64}$'),
  code_verifier  text NOT NULL,
  nonce          text NOT NULL,
  -- A relative path on this site (safeReturnTo); never another host.
  return_to      text NOT NULL CHECK (return_to LIKE '/%' AND return_to NOT LIKE '//%'),
  expires_at     timestamptz NOT NULL
);
CREATE INDEX owner_sign_ins_expires_at ON owner_sign_ins (expires_at);

-- An owner's session: the hash of the opaque cookie value, whose owner, and when it ends.
CREATE TABLE owner_sessions (
  session_hash  text PRIMARY KEY CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  owner_id      text NOT NULL REFERENCES owners (id),
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX owner_sessions_expires_at ON owner_sessions (expires_at);
CREATE INDEX owner_sessions_owner ON owner_sessions (owner_id);
