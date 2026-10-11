-- Connect Gmail (slice 3c): a connect in progress, between the redirect to Google and the callback.
-- Found by the hash of its state and taken once (the callback deletes it); bound to the owner who
-- started it and, by the hash of a cookie, to the browser they started it in.
CREATE TABLE gmail_connect_pending (
  state_hash     text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  owner_id       text NOT NULL REFERENCES owners (id),
  binding_hash   text NOT NULL CHECK (binding_hash ~ '^[0-9a-f]{64}$'),
  code_verifier  text NOT NULL,
  nonce          text NOT NULL,
  return_to      text NOT NULL,
  expires_at     timestamptz NOT NULL
);
