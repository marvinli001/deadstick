import { afterEach, beforeEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), fetch: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('undici', () => ({
  fetch: mocks.fetch,
  Agent: class {
    destroy = vi.fn();
    constructor(public options: unknown) {}
  },
}));
import { safeFetch, resolvePublic, networkError } from '../src/monitor/network.js';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
});
afterEach(() => vi.useRealTimers());
it('offers every validated address to the connector for connection fallback', async () => {
  const addresses = [
    { address: '2606:4700:4700::1111', family: 6 },
    { address: '1.1.1.1', family: 4 },
    { address: '8.8.8.8', family: 4 },
  ];
  mocks.lookup.mockResolvedValue(addresses);
  mocks.fetch.mockImplementationOnce(async (_url, { dispatcher }) => {
    expect(dispatcher.options).toMatchObject({
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 250,
    });
    const callback = vi.fn();
    dispatcher.options.connect.lookup('example.com', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, addresses);
    return new Response('Available');
  });
  expect(await safeFetch('https://example.com', 1000)).toMatchObject({ status: 200 });
  expect(mocks.lookup).toHaveBeenCalledTimes(1);
});
it('rejects mixed public and private DNS answers before attempting any connection', async () => {
  mocks.lookup.mockResolvedValue([
    { address: '1.1.1.1', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  await expect(safeFetch('https://example.com', 1000)).rejects.toMatchObject({
    code: 'BLOCKED_ADDRESS',
  });
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it('includes DNS resolution in the request timeout budget', async () => {
  vi.useFakeTimers();
  mocks.lookup.mockImplementation(() => new Promise(() => {}));
  const pending = expect(safeFetch('https://example.com', 1000)).rejects.toMatchObject({
    code: 'DNS_TIMEOUT',
  });
  await vi.advanceTimersByTimeAsync(1000);
  await pending;
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it.each([
  ['ENOTFOUND', 'DNS_NOT_FOUND'],
  ['EAI_AGAIN', 'DNS_TEMPORARY'],
  ['ECONNREFUSED', 'CONNECTION_REFUSED'],
  ['ECONNRESET', 'CONNECTION_RESET'],
  ['UND_ERR_SOCKET', 'CONNECTION_RESET'],
  ['ENETUNREACH', 'NETWORK_UNREACHABLE'],
  ['ETIMEDOUT', 'TIMEOUT'],
  ['UND_ERR_CONNECT_TIMEOUT', 'TIMEOUT'],
  ['UND_ERR_HEADERS_TIMEOUT', 'TIMEOUT'],
  ['UND_ERR_BODY_TIMEOUT', 'TIMEOUT'],
  ['CERT_HAS_EXPIRED', 'TLS_ERROR'],
  ['ERR_TLS_CERT_ALTNAME_INVALID', 'TLS_ERROR'],
])('preserves the network failure reason %s', (code, expected) => {
  const cause = Object.assign(new Error('Do not expose endpoint details'), { code });
  expect(networkError(new TypeError('fetch failed', { cause }))).toBe(expected);
});
it('reports the actionable failure when IPv6 is unavailable and IPv4 times out', () => {
  const cause = new AggregateError([
    Object.assign(new Error(), { code: 'ENETUNREACH' }),
    Object.assign(new Error(), { code: 'ETIMEDOUT' }),
  ]);
  expect(networkError(new TypeError('fetch failed', { cause }))).toBe('TIMEOUT');
});
it('rejects DNS answers containing even one private address', async () => {
  mocks.lookup.mockResolvedValue([
    { address: '1.1.1.1', family: 4 },
    { address: '10.0.0.1', family: 4 },
  ]);
  await expect(resolvePublic('example.com')).rejects.toThrow();
});
it('revalidates redirect destinations', async () => {
  mocks.fetch.mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data' },
    }),
  );
  await expect(safeFetch('https://example.com', 1000)).rejects.toThrow();
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});
it('rejects DNS rebinding on a public-looking redirected hostname', async () => {
  mocks.lookup
    .mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }])
    .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
  mocks.fetch.mockResolvedValue(
    new Response(null, { status: 302, headers: { location: 'https://redirect.example.com' } }),
  );
  await expect(safeFetch('https://example.com', 1000)).rejects.toThrow();
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
});
it('caps streamed response size', async () => {
  mocks.fetch.mockResolvedValue(new Response('oversized response'));
  await expect(safeFetch('https://example.com', 1000, 5)).rejects.toThrow('limit');
});
it('blocks HTTPS downgrade redirects', async () => {
  mocks.fetch.mockResolvedValue(
    new Response(null, { status: 302, headers: { location: 'http://example.com' } }),
  );
  await expect(safeFetch('https://example.com', 1000)).rejects.toThrow('downgrade');
});
