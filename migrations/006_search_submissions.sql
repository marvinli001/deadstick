ALTER TABLE providers ADD COLUMN aliases text[] NOT NULL DEFAULT '{}';
ALTER TABLE submissions DROP CONSTRAINT submissions_status_check;
ALTER TABLE submissions ADD CONSTRAINT submissions_status_check
  CHECK (status IN ('pending','needs_info','approved','rejected'));
ALTER TABLE submissions ADD COLUMN kind text NOT NULL DEFAULT 'provider'
  CHECK (kind IN ('provider','website','abnormal','evidence','review'));
ALTER TABLE submissions ADD COLUMN revision integer NOT NULL DEFAULT 1;
CREATE INDEX submissions_owner ON submissions(user_id,created_at DESC);
CREATE INDEX endpoints_public_host ON endpoints(lower(display_host)) WHERE kind='website';
