ALTER TABLE auth_replays ADD COLUMN user_id uuid REFERENCES users ON DELETE CASCADE;
ALTER TABLE auth_challenges ADD COLUMN return_path text;
