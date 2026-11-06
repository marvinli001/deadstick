CREATE TABLE mcp_clients (
  id text PRIMARY KEY,
  name text NOT NULL,
  redirect_uris text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mcp_authorizations (
  request_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES mcp_clients ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  challenge text NOT NULL,
  state text,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE TABLE mcp_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL REFERENCES mcp_clients ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '2 minutes'
);
CREATE TABLE mcp_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL REFERENCES mcp_clients,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  resource text NOT NULL,
  access_hash text NOT NULL UNIQUE,
  access_expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour',
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX mcp_connections_user ON mcp_connections(user_id);
CREATE TABLE mcp_refresh_tokens (
  token_hash text PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES mcp_connections ON DELETE CASCADE,
  used_at timestamptz
);
CREATE INDEX mcp_refresh_connection ON mcp_refresh_tokens(connection_id);
