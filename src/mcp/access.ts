import type { DB } from '../db.js';
import type { User } from '../auth/service.js';
import { digest } from '../crypto.js';

export const mcpScope = 'deadstick:admin';
export const mcpProtocolPaths = new Set(['/oauth/register', '/oauth/token', '/oauth/revoke']);

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export async function mcpIdentity(db: DB, bearer: string, resource: string) {
  if (!/^dsmcp_[A-Za-z0-9_-]{43}$/.test(bearer)) return null;
  const [row] = await db.query<User & { connection_id: string }>(
    `SELECT u.id,u.email,u.display_name,u.role,u.telegram_id,u.disabled,c.id AS connection_id
     FROM mcp_connections c JOIN users u ON u.id=c.user_id
     WHERE c.access_hash=$1 AND c.resource=$2 AND c.revoked_at IS NULL AND c.access_expires_at>now()
       AND c.expires_at>now() AND u.role='admin' AND NOT u.disabled`,
    [digest(bearer), resource],
  );
  return row ?? null;
}
