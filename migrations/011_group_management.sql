ALTER TABLE telegram_chats
  ADD COLUMN approval_status text NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('pending','approved','rejected')),
  ADD COLUMN bot_member_status text NOT NULL DEFAULT 'unknown',
  ADD COLUMN bot_can_send boolean NOT NULL DEFAULT true,
  ADD COLUMN guest_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN username text,
  ADD COLUMN inviter_telegram_id text,
  ADD COLUMN inviter_name text,
  ADD COLUMN joined_at timestamptz,
  ADD COLUMN left_at timestamptz,
  ADD COLUMN reviewed_by uuid REFERENCES users ON DELETE SET NULL,
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN admin_note text NOT NULL DEFAULT '',
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Preserve existing bindings, including the administrator's disabled state.
UPDATE telegram_chats SET approval_status='approved' WHERE kind='group';
CREATE INDEX telegram_groups_review ON telegram_chats(approval_status,created_at)
  WHERE kind='group';
