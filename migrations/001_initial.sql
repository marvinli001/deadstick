CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE, password_hash text, display_name text NOT NULL,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user','moderator','admin')),
  telegram_id text UNIQUE, telegram_subject text UNIQUE,
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  csrf_token text NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE auth_challenges (
  state_hash text PRIMARY KEY, browser_hash text NOT NULL, nonce text NOT NULL,
  verifier text NOT NULL, mode text NOT NULL CHECK (mode IN ('login','link','miniapp')),
  user_id uuid REFERENCES users ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE TABLE providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE,
  name text NOT NULL, description text NOT NULL DEFAULT '', tags text[] NOT NULL DEFAULT '{}',
  lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','suspected','dead')),
  health text NOT NULL DEFAULT 'unknown' CHECK (health IN ('unknown','healthy','degraded','down')),
  enabled boolean NOT NULL DEFAULT true, failure_streak integer NOT NULL DEFAULT 0,
  config_version integer NOT NULL DEFAULT 1,
  next_check_at timestamptz NOT NULL DEFAULT now(), last_checked_at timestamptz,
  death_at timestamptz, epitaph text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX providers_due ON providers(next_check_at) WHERE enabled AND lifecycle <> 'dead';
CREATE TABLE endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_id uuid NOT NULL REFERENCES providers ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('website','subscription')), label text NOT NULL,
  display_host text NOT NULL, public_url text, url_ciphertext text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX endpoints_provider ON endpoints(provider_id);
CREATE TABLE submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users,
  payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reason text, provider_id uuid REFERENCES providers, reviewer_id uuid REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now(), reviewed_at timestamptz, source_update_id bigint UNIQUE
);
CREATE TABLE check_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_id uuid NOT NULL REFERENCES providers ON DELETE CASCADE,
  dedupe_key text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_token uuid,
  attempts integer NOT NULL DEFAULT 0, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX jobs_claim ON check_jobs(available_at) WHERE status IN ('pending','running');
CREATE TABLE check_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL UNIQUE REFERENCES check_jobs ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES providers ON DELETE CASCADE,
  health text NOT NULL, summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runs_provider ON check_runs(provider_id,created_at DESC);
CREATE TABLE endpoint_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES check_runs ON DELETE CASCADE,
  endpoint_id uuid REFERENCES endpoints ON DELETE SET NULL, kind text NOT NULL,
  ok boolean NOT NULL, http_status integer, latency_ms integer NOT NULL,
  error_code text, node_count integer, reachable_nodes integer, sampled_nodes integer,
  subscription_expired boolean, quota_exhausted boolean, probe_mode text CHECK (probe_mode IN ('tcp','proxy'))
);
CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_id uuid NOT NULL REFERENCES providers,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','confirmed_dead','dismissed')),
  summary text NOT NULL, resolution text, evidence_urls text[] NOT NULL DEFAULT '{}',
  reviewer_id uuid REFERENCES users, created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
);
CREATE UNIQUE INDEX one_open_incident ON incidents(provider_id) WHERE status='open';
CREATE TABLE telegram_chats (
  id text PRIMARY KEY CHECK (id ~ '^-?[0-9]+$'), title text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('group','admin')),
  topic_id integer CHECK (topic_id > 0), enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE follows (
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES providers ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,provider_id)
);
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dedupe_key text NOT NULL UNIQUE,
  chat_id text NOT NULL, topic_id integer, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','sent','failed')),
  attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz, lease_token uuid, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz
);
CREATE INDEX notifications_claim ON notifications(available_at) WHERE status IN ('pending','running');
CREATE TABLE tributes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_id uuid NOT NULL REFERENCES providers,
  user_id uuid NOT NULL REFERENCES users, kind text NOT NULL CHECK (kind IN ('flower','candle','incense')),
  day date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider_id,user_id,kind,day)
);
CREATE TABLE memorials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_id uuid NOT NULL REFERENCES providers,
  user_id uuid NOT NULL REFERENCES users, body text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','visible','hidden')),
  created_at timestamptz NOT NULL DEFAULT now(), source_update_id bigint UNIQUE
);
CREATE TABLE audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id uuid REFERENCES users,
  action text NOT NULL, target_id text, details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE settings (key text PRIMARY KEY, value jsonb NOT NULL);
INSERT INTO settings VALUES ('monitor','{"intervalHours":24,"batchSize":20,"concurrency":4,"failureThreshold":2,"checkTimeoutMs":10000,"nodeSampleSize":3,"retentionDays":90}');
CREATE TABLE bot_updates (
  update_id bigint PRIMARY KEY, payload_ciphertext text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz, lease_token uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bot_updates_claim ON bot_updates(available_at) WHERE status IN ('pending','running');
CREATE TABLE auth_replays (hash text PRIMARY KEY, expires_at timestamptz NOT NULL);
CREATE TABLE worker_heartbeats(id uuid PRIMARY KEY,last_seen_at timestamptz NOT NULL);
CREATE TABLE bot_rate_limits(user_id text PRIMARY KEY, window_start timestamptz NOT NULL, count integer NOT NULL);
