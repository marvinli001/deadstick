ALTER TABLE telegram_chats
  ADD COLUMN query_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN notification_policy jsonb NOT NULL DEFAULT '{"enabled":false}',
  ADD COLUMN manager_telegram_id text;

-- Existing bindings explicitly opted into the previous broadcast behavior.
UPDATE telegram_chats SET notification_policy='{"enabled":true}' WHERE kind='group';

CREATE TABLE notification_preferences (
  user_id uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  policy jsonb NOT NULL
);

ALTER TABLE notifications ADD COLUMN event_meta jsonb;
CREATE INDEX notifications_recipient_events ON notifications(chat_id,available_at)
  WHERE event_meta IS NOT NULL AND status IN ('pending','running');
