import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { fetch, ProxyAgent } from 'undici';
import { AppError } from '../errors.js';
import { resolvePublic } from './network.js';
import type { NodeTarget } from './subscription.js';

const fields = [
  'type',
  'cipher',
  'password',
  'uuid',
  'alterId',
  'tls',
  'servername',
  'sni',
  'skip-cert-verify',
  'client-fingerprint',
  'fingerprint',
  'alpn',
  'flow',
  'network',
  'packet-encoding',
  'username',
  'udp',
  'encryption',
  'obfs',
  'obfs-password',
  'auth-str',
  'up',
  'down',
  'protocol',
  'protocol-param',
  'obfs-param',
  'reduce-rtt',
  'disable-sni',
  'congestion-controller',
  'udp-relay-mode',
];
const nested: Record<string, string[]> = {
  'ws-opts': ['path', 'headers', 'max-early-data', 'early-data-header-name', 'v2ray-http-upgrade'],
  'grpc-opts': ['grpc-service-name', 'grpc-user-agent'],
  'http-opts': ['method', 'path', 'headers'],
  'h2-opts': ['host', 'path'],
  'reality-opts': ['public-key', 'short-id'],
  'xhttp-opts': ['path', 'host', 'mode', 'headers'],
};
const types = new Set([
  'ss',
  'ssr',
  'vmess',
  'vless',
  'trojan',
  'hysteria',
  'hysteria2',
  'tuic',
  'socks5',
  'http',
  'anytls',
]);
export function safeProxyConfig(node: NodeTarget, address: string) {
  const raw = node.proxy;
  if (!raw || !types.has(String(raw.type)))
    throw new AppError(400, 'UNSUPPORTED_PROXY', 'Node protocol cannot be tested by this engine');
  if (raw.network && !['tcp', 'ws', 'grpc', 'http', 'h2', 'xhttp'].includes(String(raw.network)))
    throw new AppError(400, 'UNSUPPORTED_PROXY', 'Node transport is not supported by the probe');
  const proxy: Record<string, unknown> = { name: 'probe', server: address, port: node.port };
  for (const key of fields) if (raw[key] !== undefined) proxy[key] = raw[key];
  for (const [key, allowed] of Object.entries(nested)) {
    const value = raw[key];
    if (value && typeof value === 'object' && !Array.isArray(value))
      proxy[key] = Object.fromEntries(
        Object.entries(value).filter(([name]) => allowed.includes(name)),
      );
  }
  if (raw.tls || ['trojan', 'hysteria2', 'tuic', 'anytls'].includes(String(raw.type))) {
    proxy.servername ??= node.host;
    proxy.sni ??= node.host;
  }
  return proxy;
}
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return port;
}
async function portReady(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(100, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
export async function probeProxy(
  node: NodeTarget,
  binary: string,
  timeoutMs: number,
): Promise<boolean> {
  const address = await resolvePublic(node.host),
    proxy = safeProxyConfig(node, address.address);
  const directory = await mkdtemp(join(tmpdir(), 'deadstick-probe-'));
  let child: ReturnType<typeof spawn> | undefined, agent: ProxyAgent | undefined;
  try {
    const port = await freePort();
    const path = join(directory, 'config.json');
    // Only a whitelisted single outbound is accepted. Subscription-level config is never executed.
    await writeFile(
      path,
      JSON.stringify({
        'mixed-port': port,
        'bind-address': '127.0.0.1',
        'allow-lan': false,
        mode: 'rule',
        'log-level': 'silent',
        ipv6: false,
        'external-controller': '',
        dns: { enable: false },
        profile: { 'store-selected': false, 'store-fake-ip': false },
        proxies: [proxy],
        rules: ['MATCH,probe'],
      }),
      { mode: 0o600 },
    );
    child = spawn(binary, ['-d', directory, '-f', path], {
      stdio: 'ignore',
      env: { PATH: process.env.PATH, HOME: directory },
    });
    let startError = false;
    child.once('error', () => {
      startError = true;
    });
    const deadline = Date.now() + timeoutMs;
    while (!(await portReady(port))) {
      if (startError || child.exitCode !== null || child.signalCode !== null)
        throw new AppError(503, 'PROBE_ENGINE_ERROR', 'Probe engine could not start');
      if (Date.now() >= deadline) return false;
      await sleep(30);
    }
    agent = new ProxyAgent(`http://127.0.0.1:${port}`);
    const response = await fetch('https://www.gstatic.com/generate_204', {
      dispatcher: agent,
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    });
    await response.body?.cancel();
    return response.status === 204;
  } catch (error) {
    if (error instanceof AppError) throw error;
    return false;
  } finally {
    await agent?.destroy();
    if (child && child.exitCode === null && child.signalCode === null && child.pid) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
}
