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
async function publicAddresses(host: string, timeoutMs = 3000) {
  host = host.replace(/^\[|\]$/g, '');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    isIP(host)
      ? Promise.resolve([{ address: host, family: isIP(host) }])
      : lookup(host, { all: true }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new AppError(408, 'DNS_TIMEOUT', 'DNS lookup timed out')),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some((a) => !publicIp(a.address)))
    throw new AppError(400, 'BLOCKED_ADDRESS', 'Endpoint resolved to a non-public address');
  return addresses;
}
export async function resolvePublic(host: string) {
  return (await publicAddresses(host))[0]!;
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
  const deadline = Date.now() + timeoutMs;
  const signal = AbortSignal.timeout(timeoutMs);
  let url = validateUrl(raw);
  for (let redirect = 0; redirect <= 4; redirect++) {
    signal.throwIfAborted();
    const addresses = await publicAddresses(
      url.hostname,
      Math.max(1, Math.min(3000, deadline - Date.now())),
    );
    signal.throwIfAborted();
    const dispatcher = new Agent({
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 250,
      connect: {
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
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
export function networkError(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (error instanceof Error) {
    if (['TimeoutError', 'AbortError'].includes(error.name)) return 'TIMEOUT';
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND') return 'DNS_NOT_FOUND';
    if (code === 'EAI_AGAIN') return 'DNS_TEMPORARY';
    if (code === 'ECONNREFUSED') return 'CONNECTION_REFUSED';
    if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'CONNECTION_RESET';
    if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'NETWORK_UNREACHABLE';
    if (code === 'ETIMEDOUT' || /^UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT$/.test(code ?? ''))
      return 'TIMEOUT';
    if (
      code &&
      (/^ERR_(TLS|SSL)_/.test(code) ||
        code.includes('CERT') ||
        code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    )
      return 'TLS_ERROR';
    if (error instanceof AggregateError) {
      const codes = error.errors.map(networkError);
      return (
        codes.find((c) => !['NETWORK_UNREACHABLE', 'NETWORK_ERROR'].includes(c)) ??
        codes[0] ??
        'NETWORK_ERROR'
      );
    }
    if (error.cause) return networkError(error.cause);
  }
  return 'NETWORK_ERROR';
}
