import { lookup } from 'node:dns/promises';
import { isIP, connect } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch, type Headers } from 'undici';
import { AppError } from '../errors.js';

export function publicIp(address: string) {
  if (!ipaddr.isValid(address)) return false;
  const ip = ipaddr.process(address);
  return ip.range() === 'unicast';
}
export function validateUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(400, 'INVALID_URL', 'Invalid endpoint URL');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    /(^|\.)(localhost|local|internal|home|lan|test|invalid)$/.test(host) ||
    (!host.includes('.') && !isIP(host)) ||
    (isIP(host) && !publicIp(host)) ||
    (url.port && !['80', '443', '8080', '8443'].includes(url.port))
  )
    throw new AppError(
      400,
      'UNSAFE_URL',
      'Only public HTTP(S) endpoints on ports 80, 443, 8080 or 8443 are allowed',
    );
  url.hash = '';
  return url;
}
export async function resolvePublic(host: string) {
  host = host.replace(/^\[|\]$/g, '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    isIP(host)
      ? Promise.resolve([{ address: host, family: isIP(host) }])
      : lookup(host, { all: true }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new AppError(408, 'DNS_TIMEOUT', 'DNS lookup timed out')),
        3000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some((a) => !publicIp(a.address)))
    throw new AppError(400, 'BLOCKED_ADDRESS', 'Endpoint resolved to a non-public address');
  return addresses[0]!;
}
export interface HttpResult {
  status: number;
  body: string;
  headers: Headers;
}
export async function safeFetch(
  raw: string,
  timeoutMs: number,
  maxBytes = 1024 * 1024,
): Promise<HttpResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = validateUrl(raw);
  for (let redirect = 0; redirect <= 4; redirect++) {
    const address = await resolvePublic(url.hostname);
    signal.throwIfAborted();
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address: address.address, family: address.family }]);
          else callback(null, address.address, address.family);
        },
      },
    });
    try {
      const response = await fetch(url, {
        dispatcher,
        redirect: 'manual',
        signal,
        headers: { 'User-Agent': 'Deadstick/0.1 (+airport availability monitor)', Accept: '*/*' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirect === 4)
          throw new AppError(400, 'REDIRECT_LIMIT', 'Invalid or excessive redirects');
        const next = validateUrl(new URL(location, url).href);
        if (url.protocol === 'https:' && next.protocol !== 'https:')
          throw new AppError(400, 'INSECURE_REDIRECT', 'HTTPS downgrade blocked');
        url = next;
        continue;
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > maxBytes) {
          await response.body?.cancel().catch(() => {});
          throw new AppError(400, 'BODY_TOO_LARGE', 'Response exceeds limit');
        }
        chunks.push(chunk);
      }
      return {
        status: response.status,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: response.headers,
      };
    } finally {
      await dispatcher.destroy();
    }
  }
  throw new AppError(400, 'REDIRECT_LIMIT', 'Too many redirects');
}
export async function probeTcp(host: string, port: number, timeoutMs: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  try {
    const address = await resolvePublic(host);
    return await new Promise<boolean>((resolve) => {
      const socket = connect({ host: address.address, port, family: address.family });
      const finish = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
  } catch {
    return false;
  }
}
export function networkError(error: unknown) {
  if (error instanceof AppError) return error.code;
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
    return 'TIMEOUT';
  return 'NETWORK_ERROR';
}
