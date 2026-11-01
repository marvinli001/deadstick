import { describe, it, expect, vi } from 'vitest';
import { safeProxyConfig } from '../src/monitor/proxy.js';
import { parseSubscription } from '../src/monitor/subscription.js';
import { summarize } from '../src/monitor/check.js';

describe('proxy egress configuration', () => {
  it('pins the node IP and drops all untrusted routing and secondary destinations', () => {
    const node = {
      host: 'node.example.com',
      port: 443,
      proxy: {
        type: 'vless',
        uuid: 'test',
        tls: true,
        server: '127.0.0.1',
        'dialer-proxy': 'DIRECT',
        'interface-name': 'lo0',
        'routing-mark': 5,
        'proxy-providers': { bad: {} },
        'xhttp-opts': { path: '/', 'download-settings': { server: '169.254.169.254' } },
      },
    };
    const config = safeProxyConfig(node, '1.1.1.1');
    expect(config.server).toBe('1.1.1.1');
    expect(config.servername).toBe('node.example.com');
    expect(config).not.toHaveProperty('dialer-proxy');
    expect(config).not.toHaveProperty('proxy-providers');
    expect(config['xhttp-opts']).toEqual({ path: '/' });
  });
  it('converts VLESS Reality and WebSocket transport credentials', () => {
    const [node] = parseSubscription(
      'vless://test-uuid@node.example.com:443?security=reality&pbk=key&sid=short&type=ws&path=%2Fsocket&sni=cover.example.com',
    );
    const config = safeProxyConfig(node!, '1.1.1.1');
    expect(config).toMatchObject({
      type: 'vless',
      uuid: 'test-uuid',
      servername: 'cover.example.com',
      'reality-opts': { 'public-key': 'key', 'short-id': 'short' },
      'ws-opts': { path: '/socket' },
    });
  });
  it('converts sing-box Shadowsocks', () => {
    const [node] = parseSubscription(
      JSON.stringify({
        outbounds: [
          {
            type: 'shadowsocks',
            server: 'node.example.com',
            server_port: 443,
            method: 'aes-128-gcm',
            password: 'secret',
          },
        ],
      }),
    );
    expect(safeProxyConfig(node!, '1.1.1.1')).toMatchObject({
      type: 'ss',
      cipher: 'aes-128-gcm',
      password: 'secret',
    });
  });
  it('does not treat missing engine support as an airport outage', () => {
    expect(() => safeProxyConfig({ host: 'node.example.com', port: 443 }, '1.1.1.1')).toThrow(
      'protocol',
    );
    expect(
      summarize([
        {
          endpointId: 'test',
          kind: 'subscription',
          ok: false,
          latencyMs: 1,
          errorCode: 'PROBE_ENGINE_ERROR',
        },
      ]).health,
    ).toBe('unknown');
  });
});
