import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const token = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function equal(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = (await derive(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, hash: string) {
  const [, salt, expected] = hash.split(':');
  const key = (await derive(password, salt!, 64)) as Buffer;
  return equal(key.toString('hex'), expected!);
}
export function encrypt(value: string, key: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((b) => b.toString('base64url')).join('.');
}
export function decrypt(value: string, key: string) {
  const [iv, tag, data] = value.split('.').map((s) => Buffer.from(s, 'base64url'));
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv!);
  cipher.setAuthTag(tag!);
  return Buffer.concat([cipher.update(data!), cipher.final()]).toString('utf8');
}
