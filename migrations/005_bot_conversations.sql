CREATE TABLE bot_conversations (
  user_id text PRIMARY KEY CHECK (user_id ~ '^[0-9]+$'),
  state jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX bot_conversations_expiry ON bot_conversations(expires_at);
