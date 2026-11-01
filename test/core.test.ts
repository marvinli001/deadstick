import { describe, it, expect } from 'vitest';
import { randomBytes, createHmac } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { encrypt, decrypt, hashPassword, verifyPassword } from '../src/crypto.js';
import { loadConfig } from '../src/config.js';
import { publicIp, validateUrl } from '../src/monitor/network.js';
import { parseSubscription, subscriptionLimits } from '../src/monitor/subscription.js';
import { summarize } from '../src/monitor/check.js';
import { verifyMiniApp, verifyTelegramIdToken } from '../src/auth/telegram.js';

const key = randomBytes(32).toString('base64');
describe('credentials and startup', () => {
  it('authenticates ciphertext and rejects a tampered value', () => {
    const encrypted = encrypt('https://sub.example.com/?token=secret', key);
    expect(encrypted).not.toContain('secret');
    expect(decrypt(encrypted, key)).toContain('token=secret');
    expect(() => decrypt(encrypted, randomBytes(32).toString('base64'))).toThrow();
  });
  it('hashes passwords with salt', async () => {
    const a = await hashPassword('long-test-password'),
      b = await hashPassword('long-test-password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('long-test-password', a)).toBe(true);
    expect(await verifyPassword('wrong', a)).toBe(false);
  });
  it('requires an explicit key and HTTPS in production', () => {
    expect(() => loadConfig({})).toThrow('APP_KEY');
    expect(() => loadConfig({ APP_KEY: key, NODE_ENV: 'production' })).toThrow('HTTPS');
  });
});
describe('public network boundaries', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '64:ff9b::7f00:1',
  ])('blocks private and special address %s', (address) => expect(publicIp(address)).toBe(false));
  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('allows public address %s', (address) =>
    expect(publicIp(address)).toBe(true),
  );
  it.each([
    'http://127.1',
    'http://0x7f000001',
    'http://[::1]',
    'http://localhost',
    'http://host.local',
    'file:///etc/passwd',
    'https://user:pass@example.com',
    'https://example.com:6379',
  ])('rejects unsafe endpoint %s', (url) => expect(() => validateUrl(url)).toThrow());
});
describe('subscription parsing', () => {
  it('parses Clash YAML', () =>
    expect(
      parseSubscription(
        'proxies:\n  - name: A\n    type: ss\n    server: node.example.com\n    port: 443\n    cipher: aes-128-gcm\n    password: secret',
      )[0],
    ).toMatchObject({ host: 'node.example.com', port: 443 }));
  it('parses sing-box and ignores direct outbounds', () =>
    expect(
      parseSubscription(
        JSON.stringify({
          outbounds: [
            { type: 'direct' },
            { type: 'vless', server: 'node.example.com', server_port: 8443, uuid: 'abc' },
          ],
        }),
      ),
    ).toHaveLength(1));
  it('parses base64 URI lists and vmess', () => {
    const vmess = Buffer.from(
      JSON.stringify({ add: 'node.example.com', port: '443', id: 'uuid' }),
    ).toString('base64');
    const body = Buffer.from(`vless://uuid@a.example.com:443#one\nvmess://${vmess}`).toString(
      'base64',
    );
    expect(parseSubscription(body)).toHaveLength(2);
  });
  it('parses fully encoded shadowsocks and Surge', () => {
    expect(
      parseSubscription(
        `ss://${Buffer.from('aes-128-gcm:secret@node.example.com:443').toString('base64')}`,
      ),
    ).toHaveLength(1);
    expect(
      parseSubscription(
        '[Proxy]\nTest = trojan, node.example.com, 443, password=secret\n[Rule]\nFINAL,DIRECT',
      ),
    ).toHaveLength(1);
  });
  it.each([
    '<html>login</html>',
    'proxies: []',
    'outbounds: [{type: direct}]',
    'not a subscription',
    'proxies: [{type: ss, server: x, port: 0}]',
  ])('rejects invalid content', (body) => expect(() => parseSubscription(body)).toThrow());
  it('detects expired and exhausted accounts', () => {
    expect(subscriptionLimits('upload=4;download=6;total=10;expire=1')).toEqual({
      expired: true,
      quotaExhausted: true,
    });
    expect(subscriptionLimits(null)).toEqual({ expired: false, quotaExhausted: false });
  });
  it('keeps partial failures separate from total outages', () => {
    const r = { endpointId: 'x', kind: 'website' as const, ok: true, latencyMs: 1 };
    expect(summarize([r, { ...r, ok: false }]).health).toBe('degraded');
    expect(summarize([r, { ...r, kind: 'subscription', ok: false }]).health).toBe('down');
    expect(summarize([]).health).toBe('down');
  });
});
describe('Telegram authentication', () => {
  function signedMiniApp(date: number) {
    const params = new URLSearchParams({
      auth_date: String(date),
      user: JSON.stringify({ id: 42, first_name: 'Tester' }),
      query_id: 'test',
    });
    const check = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = createHmac('sha256', 'WebAppData').update('test-bot-token').digest();
    params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
    return params.toString();
  }
  it('verifies signed Mini App data and rejects stale or tampered data', () => {
    const data = signedMiniApp(Math.floor(Date.now() / 1000));
    expect(verifyMiniApp(data, 'test-bot-token').id).toBe('42');
    expect(() => verifyMiniApp(data + 'x', 'test-bot-token')).toThrow();
    expect(() => verifyMiniApp(signedMiniApp(1), 'test-bot-token')).toThrow();
    expect(() => verifyMiniApp(data + '&user=oops', 'test-bot-token')).toThrow();
  });
  it('checks OIDC signature, audience and nonce; uses numeric id rather than sub', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwk.kid = 'test';
    const keys = createLocalJWKSet({ keys: [jwk] });
    const jwt = await new SignJWT({ id: 42, name: 'Tester', nonce: 'expected' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer('https://oauth.telegram.org')
      .setAudience('123')
      .setSubject('different-subject')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    expect(await verifyTelegramIdToken(jwt, '123', 'expected', keys)).toEqual({
      id: '42',
      name: 'Tester',
      subject: 'different-subject',
    });
    await expect(verifyTelegramIdToken(jwt, 'wrong', 'expected', keys)).rejects.toThrow();
    await expect(verifyTelegramIdToken(jwt, '123', 'wrong', keys)).rejects.toThrow();
  });
});
