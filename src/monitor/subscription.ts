import { parseDocument } from 'yaml';
import { AppError } from '../errors.js';

export interface NodeTarget {
  host: string;
  port: number;
  proxy?: Record<string, unknown>;
}
const protocols = new Set([
  'ss',
  'ssr',
  'vmess',
  'vless',
  'trojan',
  'hysteria',
  'hysteria2',
  'hy2',
  'tuic',
  'socks',
  'socks5',
  'http',
  'https',
  'wireguard',
  'anytls',
]);
function target(host: unknown, port: unknown, proxy?: Record<string, unknown>): NodeTarget | null {
  const n = Number(port);
  return typeof host === 'string' &&
    host.length > 0 &&
    host.length <= 253 &&
    Number.isInteger(n) &&
    n > 0 &&
    n < 65536
    ? { host, port: n, ...(proxy ? { proxy } : {}) }
    : null;
}
function decode(value: string) {
  if (!/^[A-Za-z0-9+/_=-]+$/.test(value.replace(/\s/g, ''))) return '';
  return Buffer.from(value.replace(/\s/g, ''), 'base64').toString('utf8');
}
function uriNode(line: string): NodeTarget | null {
  try {
    const protocol = line.split('://')[0]!;
    if (!protocols.has(protocol)) return null;
    if (protocol === 'vmess') {
      const node = JSON.parse(decode(line.slice(8)));
      return node.id
        ? target(node.add, node.port, {
            type: 'vmess',
            uuid: node.id,
            alterId: Number(node.aid ?? 0),
            cipher: node.scy ?? 'auto',
            tls: node.tls === 'tls',
            servername: node.sni ?? node.host ?? node.add,
            network: node.net ?? 'tcp',
            ...(node.net === 'ws'
              ? { 'ws-opts': { path: node.path ?? '/', headers: { Host: node.host ?? node.add } } }
              : {}),
            ...(node.net === 'grpc'
              ? { 'grpc-opts': { 'grpc-service-name': node.path ?? '' } }
              : {}),
          })
        : null;
    }
    if (protocol === 'ssr') {
      const decoded = decode(line.slice(6)),
        [base, query = ''] = decoded.split('/?');
      const [host, port, protocol, method, obfs, password] = base!.split(':');
      const opts = new URLSearchParams(query);
      return method && password
        ? target(host, port, {
            type: 'ssr',
            cipher: method,
            password: decode(password),
            protocol,
            obfs,
            'protocol-param': decode(opts.get('protoparam') ?? ''),
            'obfs-param': decode(opts.get('obfsparam') ?? ''),
          })
        : null;
    }
    if (protocol === 'ss' && !line.slice(5).includes('@')) {
      const base = line.slice(5).split('#')[0]!;
      return uriNode(`ss://${decode(base)}`);
    }
    const url = new URL(line);
    if (!url.username && !url.password) return null;
    const host = url.hostname.replace(/^\[|\]$/g, ''),
      query = url.searchParams;
    const type =
      protocol === 'hy2'
        ? 'hysteria2'
        : protocol === 'socks'
          ? 'socks5'
          : protocol === 'https'
            ? 'http'
            : protocol;
    const proxy: Record<string, unknown> = { type };
    const username = decodeURIComponent(url.username),
      password = decodeURIComponent(url.password);
    if (['vmess', 'vless', 'tuic'].includes(type)) {
      proxy.uuid = username;
      if (password) proxy.password = password;
    } else if (type === 'ss') {
      const credential = password ? `${username}:${password}` : decode(username),
        split = credential.indexOf(':');
      proxy.cipher = credential.slice(0, split);
      proxy.password = credential.slice(split + 1);
    } else if (['trojan', 'hysteria', 'hysteria2', 'anytls'].includes(type))
      proxy.password = username;
    else {
      proxy.username = username;
      proxy.password = password;
    }
    proxy.tls = ['tls', 'reality'].includes(query.get('security') ?? '') || protocol === 'https';
    if (query.get('sni') || query.get('peer')) {
      proxy.servername = query.get('sni') ?? query.get('peer');
      proxy.sni = proxy.servername;
    }
    if (query.get('fp')) proxy['client-fingerprint'] = query.get('fp');
    if (query.get('flow')) proxy.flow = query.get('flow');
    if (query.get('pbk'))
      proxy['reality-opts'] = {
        'public-key': query.get('pbk'),
        'short-id': query.get('sid') ?? '',
      };
    const network = query.get('type') ?? 'tcp';
    proxy.network = network;
    if (network === 'ws')
      proxy['ws-opts'] = {
        path: query.get('path') ?? '/',
        headers: { Host: query.get('host') ?? host },
      };
    if (network === 'grpc')
      proxy['grpc-opts'] = { 'grpc-service-name': query.get('serviceName') ?? '' };
    return target(
      host,
      url.port || (['https', 'trojan', 'hysteria2', 'hy2', 'tuic'].includes(protocol) ? 443 : 0),
      proxy,
    );
  } catch {
    return null;
  }
}
export function parseSubscription(body: string): NodeTarget[] {
  let text = body.trim();
  if (!text || /^\s*<(?:!doctype|html|head|body)/i.test(text))
    throw new AppError(
      400,
      'INVALID_SUBSCRIPTION',
      'Subscription contains no usable configuration',
    );
  if (/^[A-Za-z0-9+/_=\s-]+$/.test(text)) text = decode(text);
  const nodes: NodeTarget[] = [];
  if (text.includes('://') && !/^\s*[{[]/.test(text) && !/^proxies\s*:/m.test(text)) {
    for (const line of text.split(/\r?\n/)) {
      const n = uriNode(line.trim());
      if (n) nodes.push(n);
    }
  }
  if (!nodes.length) {
    try {
      const document = parseDocument(text, { uniqueKeys: true });
      if (document.errors.length) throw new Error('Invalid YAML');
      const config = document.toJS({ maxAliasCount: 10 }) as Record<string, unknown>;
      if (config && typeof config === 'object') {
        if (Array.isArray(config.proxies))
          for (const raw of config.proxies) {
            if (!raw || typeof raw !== 'object' || !protocols.has(raw.type)) continue;
            const n = target(raw.server, raw.port, raw);
            if (n) nodes.push(n);
          }
        if (Array.isArray(config.outbounds))
          for (const raw of config.outbounds) {
            if (
              !raw ||
              typeof raw !== 'object' ||
              (!protocols.has(raw.type) && raw.type !== 'shadowsocks')
            )
              continue;
            const proxy: Record<string, unknown> = {
              type: raw.type === 'shadowsocks' ? 'ss' : raw.type,
              uuid: raw.uuid,
              password: raw.password,
              cipher: raw.method,
              username: raw.username,
              tls: raw.tls?.enabled ?? false,
              servername: raw.tls?.server_name,
              'client-fingerprint': raw.tls?.utls?.fingerprint,
              'skip-cert-verify': raw.tls?.insecure ?? false,
            };
            if (raw.tls?.reality?.enabled)
              proxy['reality-opts'] = {
                'public-key': raw.tls.reality.public_key,
                'short-id': raw.tls.reality.short_id,
              };
            if (raw.transport?.type === 'ws') {
              proxy.network = 'ws';
              proxy['ws-opts'] = {
                path: raw.transport.path ?? '/',
                headers: raw.transport.headers ?? {},
              };
            }
            if (raw.transport?.type === 'grpc') {
              proxy.network = 'grpc';
              proxy['grpc-opts'] = { 'grpc-service-name': raw.transport.service_name ?? '' };
            }
            const n = target(raw.server, raw.server_port, proxy);
            if (n) nodes.push(n);
          }
      }
    } catch {
      /* URI lists and Surge profiles need no YAML object. */
    }
  }
  if (!nodes.length && /^\[Proxy\]/im.test(text)) {
    const section = text.split(/^\[Proxy\]\s*$/im)[1]?.split(/^\[/m)[0] ?? '';
    for (const line of section.split('\n')) {
      const match = line.match(/^[^#;=]+\s*=\s*([\w-]+)\s*,\s*([^,]+)\s*,\s*(\d+)/);
      if (match && protocols.has(match[1]!)) {
        const n = target(match[2]!.trim(), match[3]);
        if (n) nodes.push(n);
      }
    }
  }
  if (!nodes.length)
    throw new AppError(
      400,
      'INVALID_SUBSCRIPTION',
      'Subscription contains no supported proxy nodes',
    );
  return nodes.slice(0, 10000);
}
export function subscriptionLimits(header: string | null, now = Date.now()) {
  const values = new Map(
    (header ?? '').split(';').map((s) => {
      const [k, v] = s.trim().split('=');
      return [k!, v ?? ''] as const;
    }),
  );
  const expiry = Number(values.get('expire') ?? 0),
    total = Number(values.get('total') ?? 0);
  return {
    expired: expiry > 0 && expiry * 1000 <= now,
    quotaExhausted:
      total > 0 && Number(values.get('upload') ?? 0) + Number(values.get('download') ?? 0) >= total,
  };
}
