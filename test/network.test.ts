import { beforeEach, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), fetch: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('undici', () => ({
  fetch: mocks.fetch,
  Agent: class {
    destroy = vi.fn();
    constructor(public options: unknown) {}
  },
}));
import { safeFetch, resolvePublic } from '../src/monitor/network.js';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.lookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
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
