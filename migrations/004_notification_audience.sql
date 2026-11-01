ALTER TABLE notifications ADD COLUMN audience text NOT NULL DEFAULT 'public'
  CHECK (audience IN ('public','group','follower','reviewer','admin'));

UPDATE notifications SET audience='reviewer' WHERE subject IS NOT NULL AND method='sendMessage';
