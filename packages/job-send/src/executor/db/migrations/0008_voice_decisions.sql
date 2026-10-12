-- A separate, explicit authority channel. Generic alerts never populate these tables.
CREATE TABLE owner_voice_preferences (
  owner_id text PRIMARY KEY REFERENCES owners(id),
  enabled boolean NOT NULL DEFAULT false,
  cursor_seq integer NOT NULL DEFAULT 0 CHECK (cursor_seq >= 0),
  disclosure_version text,
  config_sha256 text CHECK (config_sha256 ~ '^[0-9a-f]{64}$'),
  last_attempt_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE owner_voice_sessions (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES owner_voice_preferences(owner_id),
  proposal_version_id text NOT NULL UNIQUE REFERENCES proposal_versions(id),
  version_sha256 text NOT NULL CHECK (version_sha256 ~ '^[0-9a-f]{64}$'),
  config_sha256 text NOT NULL CHECK (config_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN
    ('queued','placing','awaiting_reply','allowed','denied','no_decision','cancelled','unknown','failed')),
  call_id text UNIQUE,
  token_sha256 text CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  instruction_sha256 text CHECK (instruction_sha256 ~ '^[0-9a-f]{64}$'),
  phone_sha256 text CHECK (phone_sha256 ~ '^[0-9a-f]{64}$'),
  from_sha256 text CHECK (from_sha256 ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  event_id text UNIQUE,
  decision text CHECK (decision IN ('allow','deny')),
  transcript_sha256 text CHECK (transcript_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz
);
CREATE INDEX owner_voice_queue ON owner_voice_sessions(owner_id,created_at) WHERE status='queued';
