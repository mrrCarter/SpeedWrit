-- The owner core (slice 3b): what the Connect screen shows, and a receipt for disconnecting an agent.

-- The scopes Google granted at Connect Gmail (a person can untick one on Google's screen).
ALTER TABLE connections ADD COLUMN granted_scopes text[] NOT NULL DEFAULT '{}';

-- When the agent connection last reached /mcp, touched at most once a minute.
ALTER TABLE agent_connections ADD COLUMN last_used_at timestamptz;

-- AGENT_REVOKED: the owner disconnects an agent.
ALTER TABLE receipts DROP CONSTRAINT receipts_type_check;
ALTER TABLE receipts ADD CONSTRAINT receipts_type_check CHECK (type IN (
  'CONNECTION_CREATED', 'AGENT_CONNECTED', 'JOB_CONFIRMED', 'ATTEMPT_DENIED',
  'PROPOSAL_CREATED', 'PROPOSAL_REVISED', 'AI_REVIEW', 'APPROVAL_GRANTED',
  'APPROVAL_REJECTED', 'APPROVAL_REFUSED', 'DISPATCH_RESERVED', 'DISPATCH_REFUSED',
  'PROVIDER_ACCEPTED', 'NOT_SENT', 'OUTCOME_UNKNOWN', 'OUTCOME_RESOLVED',
  'DELIVERY_WITNESSED', 'STOP_ENGAGED', 'PROVIDER_REVOKE_REQUESTED', 'PROVIDER_REVOKE_RESULT',
  'AGENT_REVOKED'
));
