import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { administrator } from '../auth/service.js';
import { digest, equal, token } from '../crypto.js';
import { AppError, required } from '../errors.js';
import { audit } from '../catalog/service.js';
import { Id, Page } from '../catalog/schemas.js';
import { mcpScope, OAuthError } from './access.js';

type Client = { id: string; name: string; redirect_uris: string[] };
type Authorization = {
  client_id: string;
  redirect_uri: string;
  challenge: string;
  resource: string;
  state: string | null;
};

function parameters(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OAuthError('invalid_request', 'Expected an object');
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string, max = 4096) {
  if (typeof value !== 'string' || !value.length || value.length > max)
    throw new OAuthError('invalid_request', `Invalid ${name}`);
  return value;
}

function redirectUrl(value: string) {
  if (!URL.canParse(value)) throw new OAuthError('invalid_redirect_uri', 'Invalid redirect URI');
  const url = new URL(value);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (
    url.hash ||
    url.username ||
    url.password ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
  )
    throw new OAuthError('invalid_redirect_uri', 'Use HTTPS or an HTTP loopback callback');
  return url;
}

function matchesRedirect(registered: string, requested: string) {
  if (registered === requested) return true;
  const left = new URL(registered),
    right = new URL(requested);
  // Native clients select a free loopback port for each login (RFC 8252).
  if (left.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(left.hostname)) return false;
  left.port = right.port;
  return left.href === right.href;
}

function checkScope(value: unknown) {
  if (value !== undefined && value !== mcpScope)
    throw new OAuthError('invalid_scope', `Use ${mcpScope}`);
}

function checkResource(value: unknown, config: Config) {
  if (value !== undefined && value !== `${config.publicUrl}/mcp`)
    throw new OAuthError('invalid_target', 'Unknown MCP resource');
}

export function oauthRoutes(app: FastifyInstance, db: DB, config: Config) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const issuer = config.publicUrl;
  const metadata = () => ({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [mcpScope],
    authorization_response_iss_parameter_supported: true,
  });
  api.get('/.well-known/oauth-authorization-server', metadata);
  const resourceMetadata = () => ({
    resource: `${issuer}/mcp`,
    resource_name: 'Deadstick 管理员 MCP',
    authorization_servers: [issuer],
    scopes_supported: [mcpScope],
    bearer_methods_supported: ['header'],
  });
  api.get('/.well-known/oauth-protected-resource', resourceMetadata);
  api.get('/.well-known/oauth-protected-resource/mcp', resourceMetadata);

  app.register(async (oauth) => {
    oauth.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        const params = new URLSearchParams(body as string);
        if (new Set(params.keys()).size !== [...params.keys()].length)
          return done(new OAuthError('invalid_request', 'Duplicate parameters'));
        done(null, Object.fromEntries(params));
      },
    );
    oauth.post(
      '/oauth/register',
      {
        config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      },
      async (req, reply) => {
        const body = parameters(req.body);
        const name = string(body.client_name ?? 'MCP 客户端', 'client_name', 120).trim();
        if (!name) throw new OAuthError('invalid_client_metadata', 'Client name required');
        if (
          !Array.isArray(body.redirect_uris) ||
          !body.redirect_uris.length ||
          body.redirect_uris.length > 10
        )
          throw new OAuthError('invalid_client_metadata', 'Provide 1–10 redirect URIs');
        const redirects = body.redirect_uris.map((value) => {
          const uri = string(value, 'redirect_uri', 2048);
          redirectUrl(uri);
          return uri;
        });
        if (
          body.token_endpoint_auth_method !== undefined &&
          body.token_endpoint_auth_method !== 'none'
        )
          throw new OAuthError('invalid_client_metadata', 'Only public PKCE clients are supported');
        for (const [field, allowed] of [
          ['grant_types', ['authorization_code', 'refresh_token']],
          ['response_types', ['code']],
        ] as const) {
          const values = body[field];
          if (
            values !== undefined &&
            (!Array.isArray(values) ||
              !values.length ||
              values.some((value) => !(allowed as readonly unknown[]).includes(value)))
          )
            throw new OAuthError('invalid_client_metadata', `Unsupported ${field}`);
        }
        checkScope(body.scope);
        const clientId = token();
        await db.query('INSERT INTO mcp_clients(id,name,redirect_uris) VALUES ($1,$2,$3)', [
          clientId,
          name,
          redirects,
        ]);
        return reply.code(201).send({
          client_id: clientId,
          client_name: name,
          redirect_uris: redirects,
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          scope: mcpScope,
        });
      },
    );

    oauth.get('/oauth/authorize', async (req, reply) => {
      const query = parameters(req.query);
      const clientId = string(query.client_id, 'client_id', 200);
      const [client] = await db.query<Client>('SELECT * FROM mcp_clients WHERE id=$1', [clientId]);
      if (!client) throw new OAuthError('invalid_client', 'Unknown client');
      const redirect = string(query.redirect_uri, 'redirect_uri', 2048);
      redirectUrl(redirect);
      if (!client.redirect_uris.some((uri) => matchesRedirect(uri, redirect)))
        throw new OAuthError('invalid_request', 'Redirect URI is not registered');
      if (query.response_type !== 'code')
        throw new OAuthError('unsupported_response_type', 'Use authorization code');
      const challenge = string(query.code_challenge, 'code_challenge', 128);
      if (query.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
        throw new OAuthError('invalid_request', 'PKCE S256 is required');
      checkScope(query.scope);
      checkResource(query.resource, config);
      const state = query.state === undefined ? null : string(query.state, 'state', 2048);
      const request = token();
      await db.query(
        'INSERT INTO mcp_authorizations(request_hash,client_id,redirect_uri,challenge,state,resource) VALUES ($1,$2,$3,$4,$5,$6)',
        [digest(request), clientId, redirect, challenge, state, `${issuer}/mcp`],
      );
      return reply.redirect(`/mcp/authorize?request=${request}`);
    });

    oauth.post('/oauth/token', async (req) => {
      const body = parameters(req.body);
      const clientId = string(body.client_id, 'client_id', 200);
      checkResource(body.resource, config);
      checkScope(body.scope);
      const accessToken = `dsmcp_${token()}`;
      const refreshToken = `dsmcpr_${token()}`;
      if (body.grant_type === 'authorization_code') {
        const code = string(body.code, 'code', 200);
        const redirect = string(body.redirect_uri, 'redirect_uri', 2048);
        const verifier = string(body.code_verifier, 'code_verifier', 128);
        if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
          throw new OAuthError('invalid_grant', 'Invalid PKCE verifier');
        await db.transaction(async (tx) => {
          const [owner] = await tx.query<{ id: string }>(
            `SELECT id FROM users WHERE id=(SELECT user_id FROM mcp_codes WHERE code_hash=$1)
             AND role='admin' AND NOT disabled FOR NO KEY UPDATE`,
            [digest(code)],
          );
          if (!owner)
            throw new OAuthError('invalid_grant', 'Authorization code is invalid or expired');
          const [authorization] = await tx.query<Authorization & { user_id: string }>(
            'SELECT * FROM mcp_codes WHERE code_hash=$1 AND user_id=$2 AND expires_at>now() FOR UPDATE',
            [digest(code), owner.id],
          );
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (
            !authorization ||
            authorization.client_id !== clientId ||
            authorization.redirect_uri !== redirect ||
            authorization.resource !== `${issuer}/mcp` ||
            !equal(challenge, authorization.challenge)
          )
            throw new OAuthError('invalid_grant', 'Authorization code is invalid or expired');
          await tx.query('DELETE FROM mcp_codes WHERE code_hash=$1', [digest(code)]);
          const [connection] = await tx.query<{ id: string }>(
            'INSERT INTO mcp_connections(client_id,user_id,access_hash,resource) VALUES ($1,$2,$3,$4) RETURNING id',
            [clientId, authorization.user_id, digest(accessToken), authorization.resource],
          );
          await tx.query(
            'INSERT INTO mcp_refresh_tokens(token_hash,connection_id) VALUES ($1,$2)',
            [digest(refreshToken), connection!.id],
          );
          await audit(tx, authorization.user_id, 'mcp.connect', connection!.id, { clientId });
        });
      } else if (body.grant_type === 'refresh_token') {
        const refresh = string(body.refresh_token, 'refresh_token', 200);
        const valid = await db.transaction(async (tx) => {
          const [connection] = await tx.query<{
            id: string;
            user_id: string;
            used_at: Date | null;
          }>(
            `SELECT c.id,c.user_id,t.used_at FROM mcp_refresh_tokens t JOIN mcp_connections c ON c.id=t.connection_id JOIN users u ON u.id=c.user_id
             WHERE t.token_hash=$1 AND c.client_id=$2 AND c.resource=$3 AND c.revoked_at IS NULL AND c.expires_at>now() AND u.role='admin' AND NOT u.disabled FOR UPDATE OF c,t`,
            [digest(refresh), clientId, `${issuer}/mcp`],
          );
          if (!connection) return false;
          if (connection.used_at) {
            await tx.query('UPDATE mcp_connections SET revoked_at=now() WHERE id=$1', [
              connection.id,
            ]);
            await audit(tx, connection.user_id, 'mcp.refresh_reuse', connection.id);
            return false;
          }
          await tx.query('UPDATE mcp_refresh_tokens SET used_at=now() WHERE token_hash=$1', [
            digest(refresh),
          ]);
          await tx.query(
            "UPDATE mcp_connections SET access_hash=$1,access_expires_at=least(expires_at,now()+interval '1 hour') WHERE id=$2",
            [digest(accessToken), connection.id],
          );
          await tx.query(
            'INSERT INTO mcp_refresh_tokens(token_hash,connection_id) VALUES ($1,$2)',
            [digest(refreshToken), connection.id],
          );
          return true;
        });
        if (!valid) throw new OAuthError('invalid_grant', 'Refresh token is invalid or expired');
      } else throw new OAuthError('unsupported_grant_type', 'Unsupported grant type');
      return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: refreshToken,
        scope: mcpScope,
      };
    });

    oauth.post('/oauth/revoke', async (req) => {
      const body = parameters(req.body);
      const value = string(body.token, 'token', 200);
      const clientId = string(body.client_id, 'client_id', 200);
      await db.transaction(async (tx) => {
        const rows = await tx.query<{ id: string; user_id: string }>(
          `UPDATE mcp_connections SET revoked_at=now() WHERE client_id=$1 AND revoked_at IS NULL
           AND (access_hash=$2 OR id IN (SELECT connection_id FROM mcp_refresh_tokens WHERE token_hash=$2)) RETURNING id,user_id`,
          [clientId, digest(value)],
        );
        for (const row of rows) await audit(tx, row.user_id, 'mcp.revoke', row.id);
      });
      return {};
    });
  });

  const RequestId = Type.Object({ request: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }) });
  api.get(
    '/auth/mcp/request/:request',
    { preHandler: administrator, schema: { params: RequestId } },
    async (req) => {
      const [row] = await db.query<{ client_name: string; redirect_uri: string; expires_at: Date }>(
        'SELECT c.name AS client_name,a.redirect_uri,a.expires_at FROM mcp_authorizations a JOIN mcp_clients c ON c.id=a.client_id WHERE a.request_hash=$1 AND a.expires_at>now()',
        [digest(req.params.request)],
      );
      if (!row) throw new AppError(410, 'OAUTH_EXPIRED', 'Authorization request expired');
      return row;
    },
  );
  api.post(
    '/auth/mcp/request/:request',
    {
      preHandler: administrator,
      schema: {
        params: RequestId,
        body: Type.Object({ approved: Type.Boolean() }, { additionalProperties: false }),
      },
    },
    async (req) =>
      db.transaction(async (tx) => {
        const [account] = await tx.query(
          "SELECT id FROM users WHERE id=$1 AND role='admin' AND NOT disabled FOR NO KEY UPDATE",
          [req.user!.id],
        );
        const [session] = await tx.query(
          'SELECT token_hash FROM sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()',
          [req.sessionHash, req.user!.id],
        );
        if (!account || !session) throw new AppError(401, 'UNAUTHORIZED', 'Login required');
        const [authorization] = await tx.query<Authorization>(
          'DELETE FROM mcp_authorizations WHERE request_hash=$1 AND resource=$2 AND expires_at>now() RETURNING *',
          [digest(req.params.request), `${issuer}/mcp`],
        );
        if (!authorization)
          throw new AppError(410, 'OAUTH_EXPIRED', 'Authorization request expired');
        const redirect = new URL(authorization.redirect_uri);
        if (authorization.state !== null) redirect.searchParams.set('state', authorization.state);
        redirect.searchParams.set('iss', issuer);
        if (req.body.approved) {
          const code = token();
          await tx.query(
            'INSERT INTO mcp_codes(code_hash,client_id,user_id,redirect_uri,challenge,resource) VALUES ($1,$2,$3,$4,$5,$6)',
            [
              digest(code),
              authorization.client_id,
              req.user!.id,
              authorization.redirect_uri,
              authorization.challenge,
              authorization.resource,
            ],
          );
          redirect.searchParams.set('code', code);
        } else redirect.searchParams.set('error', 'access_denied');
        return { redirect: redirect.href };
      }),
  );
  api.get('/admin/mcp', { preHandler: administrator }, async () => ({
    url: `${issuer}/mcp`,
    scope: mcpScope,
  }));
  api.get(
    '/admin/mcp/connections',
    { preHandler: administrator, schema: { querystring: Type.Object(Page) } },
    async (req) => ({
      items: await db.query(
        `SELECT c.id,cl.name AS client_name,u.display_name AS user_name,c.created_at,c.last_used_at,c.expires_at,c.revoked_at
       FROM mcp_connections c JOIN mcp_clients cl ON cl.id=c.client_id JOIN users u ON u.id=c.user_id
       ORDER BY c.created_at DESC LIMIT $1 OFFSET $2`,
        [req.query.limit ?? 20, req.query.offset ?? 0],
      ),
    }),
  );
  api.delete(
    '/admin/mcp/connections/:id',
    { preHandler: administrator, schema: { params: Id } },
    async (req) =>
      db.transaction(async (tx) => {
        required(
          (
            await tx.query(
              'UPDATE mcp_connections SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 RETURNING id',
              [req.params.id],
            )
          )[0],
        );
        await audit(tx, req.user!.id, 'mcp.revoke', req.params.id);
        return { ok: true };
      }),
  );
}
