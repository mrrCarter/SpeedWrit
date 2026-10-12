-- Optional notification state only. No email authority, receipt or dispatch row is changed.
-- Preferences are first created by an authenticated owner's explicit POST, never by a GET.
CREATE TABLE owner_alert_preferences (
  owner_id text PRIMARY KEY REFERENCES owners(id),
  enabled boolean NOT NULL DEFAULT false,
  cursor_seq integer NOT NULL DEFAULT 0 CHECK (cursor_seq >= 0),
  last_attempt_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE owner_alert_outbox (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES owner_alert_preferences(owner_id),
  receipt_seq integer,
  kind text NOT NULL CHECK (kind IN ('attention', 'test')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'attempted', 'accepted', 'unknown', 'failed', 'cancelled')),
  attempt_id text,
  due_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE(owner_id, receipt_seq),
  FOREIGN KEY(owner_id, receipt_seq) REFERENCES receipts(owner_id, seq)
);
CREATE INDEX owner_alert_queue ON owner_alert_outbox(owner_id, due_at) WHERE status = 'queued';
