ALTER TABLE providers ADD COLUMN aliases text[] NOT NULL DEFAULT '{}';
ALTER TABLE submissions DROP CONSTRAINT submissions_status_check;
ALTER TABLE submissions ADD CONSTRAINT submissions_status_check
  CHECK (status IN ('pending','needs_info','approved','rejected'));
ALTER TABLE submissions ADD COLUMN kind text NOT NULL DEFAULT 'provider'
  CHECK (kind IN ('provider','website','abnormal','evidence','review'));
ALTER TABLE submissions ADD COLUMN revision integer NOT NULL DEFAULT 1;
CREATE INDEX submissions_owner ON submissions(user_id,created_at DESC);
CREATE INDEX endpoints_public_host ON endpoints(lower(display_host)) WHERE kind='website';
ALTER TABLE incidents ADD COLUMN manual_review boolean NOT NULL DEFAULT false;
UPDATE incidents SET manual_review=true WHERE status='open'
  AND EXISTS(SELECT 1 FROM audit_log WHERE action='incident.create' AND target_id=incidents.id::text);
ALTER TABLE submissions ADD COLUMN incident_id uuid REFERENCES incidents;
CREATE INDEX submissions_incident ON submissions(incident_id) WHERE incident_id IS NOT NULL;
