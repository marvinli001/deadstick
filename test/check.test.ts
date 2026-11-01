import { beforeEach, expect, it, vi } from 'vitest';
import { AppError } from '../src/errors.js';
import { loadConfig } from '../src/config.js';
import { encrypt } from '../src/crypto.js';
import type { MonitorSettings } from '../src/catalog/schemas.js';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), tcp: vi.fn(), proxy: vi.fn() }));
vi.mock('../src/monitor/network.js', async (original) => ({
  ...(await original<typeof import('../src/monitor/network.js')>()),
  safeFetch: mocks.fetch,
  probeTcp: mocks.tcp,
}));
vi.mock('../src/monitor/proxy.js', () => ({ probeProxy: mocks.proxy }));
import { checker, summarize } from '../src/monitor/check.js';
const config = loadConfig({
  APP_KEY: Buffer.alloc(32).toString('base64'),
  PROBE_MODE: 'proxy',
  MIHOMO_BIN: '/test/mihomo',
});
const settings: MonitorSettings = {
  intervalHours: 24,
  batchSize: 20,
  concurrency: 4,
  failureThreshold: 2,
  checkTimeoutMs: 10000,
  nodeSampleSize: 3,
  retentionDays: 90,
};
const endpoint = {
  id: 'test',
  kind: 'subscription' as const,
  url_ciphertext: encrypt('https://sub.example.com/private', config.appKey),
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.fetch.mockResolvedValue({
    status: 200,
    headers: new Headers(),
    body: 'vless://first@one.example.com:443\nvless://second@two.example.com:443',
  });
});
it('requires actual egress success in proxy mode', async () => {
  mocks.proxy.mockResolvedValue(false);
  const result = await checker(config)(endpoint, settings);
  expect(result).toMatchObject({
    ok: false,
    probeMode: 'proxy',
    sampledNodes: 2,
    reachableNodes: 0,
    errorCode: 'NODES_UNREACHABLE',
  });
  expect(mocks.tcp).not.toHaveBeenCalled();
});
it('accepts a usable sampled node even when a different protocol cannot be probed', async () => {
  mocks.proxy
    .mockRejectedValueOnce(new AppError(400, 'UNSUPPORTED_PROXY', 'Unsupported'))
    .mockResolvedValueOnce(true);
  expect(await checker(config)(endpoint, settings)).toMatchObject({ ok: true, reachableNodes: 1 });
});
it('preserves inconclusive engine failures', async () => {
  mocks.proxy.mockRejectedValue(new AppError(503, 'PROBE_ENGINE_ERROR', 'Engine unavailable'));
  const result = await checker(config)(endpoint, settings);
  expect(summarize([result]).health).toBe('unknown');
});
it('does not claim a node probe ran when sampling is disabled', async () => {
  const result = await checker(config)(endpoint, { ...settings, nodeSampleSize: 0 });
  expect(result).toMatchObject({ ok: true, sampledNodes: 0 });
  expect(result.probeMode).toBeUndefined();
  expect(summarize([result]).nodeProbe).toBe('none');
  expect(mocks.proxy).not.toHaveBeenCalled();
});
it('detects expired credentials without probing nodes', async () => {
  mocks.fetch.mockResolvedValue({
    status: 200,
    headers: new Headers({ 'subscription-userinfo': 'expire=1' }),
    body: 'vless://id@node.example.com:443',
  });
  expect(await checker(config)(endpoint, settings)).toMatchObject({
    ok: false,
    subscriptionExpired: true,
    errorCode: 'SUBSCRIPTION_EXPIRED',
    sampledNodes: 0,
  });
  expect(mocks.proxy).not.toHaveBeenCalled();
});
