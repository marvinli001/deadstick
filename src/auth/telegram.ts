import { createHmac, createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { equal } from '../crypto.js';
import { AppError } from '../errors.js';

const keys = createRemoteJWKSet(new URL('https://oauth.telegram.org/.well-known/jwks.json'));
export async function verifyTelegramIdToken(
  idToken: string,
  clientId: string,
  nonce: string,
  getKey: JWTVerifyGetKey = keys,
) {
  try {
    const { payload } = await jwtVerify(idToken, getKey, {
      issuer: 'https://oauth.telegram.org',
      audience: clientId,
      algorithms: ['RS256', 'ES256'],
      maxTokenAge: '10m',
      requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
    });
    if (
      typeof payload.nonce !== 'string' ||
      !equal(payload.nonce, nonce) ||
      !Number.isSafeInteger(payload.id) ||
      Number(payload.id) <= 0 ||
      typeof payload.name !== 'string' ||
      !payload.name.trim()
    )
      throw new Error('claims');
    return { id: String(payload.id), subject: payload.sub!, name: payload.name.trim() };
  } catch {
    throw new AppError(401, 'TELEGRAM_AUTH', 'Invalid Telegram ID token');
  }
}
export const pkceChallenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');
export function verifyMiniApp(initData: string, botToken: string, now = Date.now()) {
  const params = new URLSearchParams(initData),
    supplied = params.get('hash') ?? '';
  if (new Set(params.keys()).size !== [...params.keys()].length)
    throw new AppError(401, 'TELEGRAM_AUTH', 'Duplicate fields');
  params.delete('hash');
  const check = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest('hex');
  const authDate = params.get('auth_date') ?? '';
  const age = now / 1000 - Number(authDate);
  if (
    !/^\d+$/.test(authDate) ||
    !equal(expected, supplied) ||
    !Number.isFinite(age) ||
    age < -30 ||
    age > 300
  )
    throw new AppError(401, 'TELEGRAM_AUTH', 'Invalid or expired Mini App data');
  let user: { id?: number; first_name?: string };
  try {
    user = JSON.parse(params.get('user') ?? 'null');
  } catch {
    throw new AppError(401, 'TELEGRAM_AUTH', 'Invalid Mini App user');
  }
  if (
    !user ||
    !Number.isSafeInteger(user.id) ||
    user.id! <= 0 ||
    typeof user.first_name !== 'string'
  )
    throw new AppError(401, 'TELEGRAM_AUTH', 'Invalid Mini App user');
  return { id: String(user.id), name: user.first_name };
}
