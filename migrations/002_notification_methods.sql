ALTER TABLE notifications ADD COLUMN method text NOT NULL DEFAULT 'sendMessage' CHECK (method ~ '^[a-zA-Z]{1,64}$');
ALTER TABLE notifications ADD COLUMN subject text;
ALTER TABLE notifications ADD COLUMN message_id bigint;
CREATE INDEX notifications_subject ON notifications(subject) WHERE subject IS NOT NULL;
