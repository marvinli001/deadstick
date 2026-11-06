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
it.each(['proxy', 'tcp'] as const)(
  'accepts parsed subscriptions when every %s node probe fails',
  async (probeMode) => {
    mocks.proxy.mockResolvedValue(false);
    mocks.tcp.mockResolvedValue(false);
    const result = await checker({ ...config, probeMode })(endpoint, settings);
    expect(result).toMatchObject({
      ok: true,
      nodeCount: 2,
      probeMode,
      sampledNodes: 2,
      reachableNodes: 0,
      probeErrorCode: 'NODES_UNREACHABLE',
    });
    expect(result.errorCode).toBeUndefined();
    expect(summarize([result])).toMatchObject({
      health: 'healthy',
      subscription: { total: 1, up: 1 },
    });
    expect(probeMode === 'proxy' ? mocks.tcp : mocks.proxy).not.toHaveBeenCalled();
  },
);
it('accepts a usable sampled node even when a different protocol cannot be probed', async () => {
  mocks.proxy
    .mockRejectedValueOnce(new AppError(400, 'UNSUPPORTED_PROXY', 'Unsupported'))
    .mockResolvedValueOnce(true);
  expect(await checker(config)(endpoint, settings)).toMatchObject({ ok: true, reachableNodes: 1 });
});
it.each(['PROBE_ENGINE_ERROR', 'UNSUPPORTED_PROXY'])(
  'keeps %s diagnostic without failing a valid subscription',
  async (code) => {
    mocks.proxy.mockRejectedValue(new AppError(503, code, 'Probe unavailable'));
    const result = await checker(config)(endpoint, settings);
    expect(result).toMatchObject({ ok: true, reachableNodes: 0, probeErrorCode: code });
    expect(result.errorCode).toBeUndefined();
    expect(summarize([result]).health).toBe('healthy');
  },
);
it('does not claim a node probe ran when sampling is disabled', async () => {
  const result = await checker(config)(endpoint, { ...settings, nodeSampleSize: 0 });
  expect(result).toMatchObject({ ok: true, sampledNodes: 0 });
  expect(result.probeMode).toBeUndefined();
  expect(summarize([result]).nodeProbe).toBe('none');
  expect(mocks.proxy).not.toHaveBeenCalled();
});
it.each([
  { header: 'expire=1', expired: true, quotaExhausted: false },
  { header: 'upload=4;download=6;total=10', expired: false, quotaExhausted: true },
])('records account limits without failing parsed nodes: $header', async (limits) => {
  mocks.fetch.mockResolvedValue({
    status: 200,
    headers: new Headers({ 'subscription-userinfo': limits.header }),
    body: 'vless://id@node.example.com:443',
  });
  const result = await checker(config)(endpoint, settings);
  expect(result).toMatchObject({
    ok: true,
    nodeCount: 1,
    subscriptionExpired: limits.expired,
    quotaExhausted: limits.quotaExhausted,
    sampledNodes: 0,
  });
  expect(result.errorCode).toBeUndefined();
  expect(summarize([result]).health).toBe('healthy');
  expect(mocks.proxy).not.toHaveBeenCalled();
});
it.each(['', '<html>Login required</html>', 'proxies: []', 'not a subscription'])(
  'rejects a successful HTTP response without parseable nodes: %j',
  async (body) => {
    mocks.fetch.mockResolvedValue({ status: 200, headers: new Headers(), body });
    const result = await checker(config)(endpoint, settings);
    expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_SUBSCRIPTION' });
    expect(summarize([result]).health).toBe('down');
    expect(mocks.proxy).not.toHaveBeenCalled();
  },
);
it('rejects HTTP failures even if the response contains nodes', async () => {
  mocks.fetch.mockResolvedValue({
    status: 403,
    headers: new Headers(),
    body: 'vless://id@node.example.com:443',
  });
  expect(await checker(config)(endpoint, settings)).toMatchObject({
    ok: false,
    errorCode: 'HTTP_403',
  });
  expect(mocks.proxy).not.toHaveBeenCalled();
});
it('rejects subscription download failures', async () => {
  mocks.fetch.mockRejectedValue(new DOMException('Timed out', 'TimeoutError'));
  expect(await checker(config)(endpoint, settings)).toMatchObject({
    ok: false,
    errorCode: 'TIMEOUT',
  });
  expect(mocks.proxy).not.toHaveBeenCalled();
});
