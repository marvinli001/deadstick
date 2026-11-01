import { decrypt } from '../crypto.js';
import type { Config } from '../config.js';
import type { MonitorSettings } from '../catalog/schemas.js';
import { safeFetch, probeTcp, networkError } from './network.js';
import { parseSubscription, subscriptionLimits } from './subscription.js';
import { probeProxy } from './proxy.js';

export interface Endpoint {
  id: string;
  kind: 'website' | 'subscription';
  url_ciphertext: string;
}
export interface EndpointResult {
  endpointId: string;
  kind: Endpoint['kind'];
  ok: boolean;
  httpStatus?: number;
  latencyMs: number;
  errorCode?: string;
  nodeCount?: number;
  reachableNodes?: number;
  sampledNodes?: number;
  subscriptionExpired?: boolean;
  quotaExhausted?: boolean;
  probeMode?: 'tcp' | 'proxy';
}
export type CheckEndpoint = (
  endpoint: Endpoint,
  settings: MonitorSettings,
) => Promise<EndpointResult>;
export function checker(config: Config): CheckEndpoint {
  return async (endpoint, settings) => {
    const start = Date.now();
    const result: EndpointResult = {
      endpointId: endpoint.id,
      kind: endpoint.kind,
      ok: false,
      latencyMs: 0,
    };
    try {
      const response = await safeFetch(
        decrypt(endpoint.url_ciphertext, config.appKey),
        settings.checkTimeoutMs,
      );
      result.httpStatus = response.status;
      if (response.status < 200 || response.status >= 400)
        result.errorCode = `HTTP_${response.status}`;
      else if (endpoint.kind === 'website') result.ok = true;
      else {
        const nodes = parseSubscription(response.body),
          limits = subscriptionLimits(response.headers.get('subscription-userinfo'));
        result.nodeCount = nodes.length;
        result.subscriptionExpired = limits.expired;
        result.quotaExhausted = limits.quotaExhausted;
        const count = Math.min(settings.nodeSampleSize, nodes.length);
        const samples = Array.from(
          { length: count },
          (_, i) => nodes[Math.floor((i * nodes.length) / count)]!,
        );
        result.sampledNodes = count;
        const reachable: boolean[] = [];
        result.probeMode = config.probeMode;
        for (const node of samples) {
          const budget = Math.max(
            1,
            Math.min(
              5000,
              Math.floor(
                (start + settings.checkTimeoutMs - Date.now()) / (count - reachable.length),
              ),
            ),
          );
          reachable.push(
            config.probeMode === 'proxy'
              ? await probeProxy(node, config.mihomoBin!, budget)
              : await probeTcp(node.host, node.port, budget),
          );
        }
        result.reachableNodes = reachable.filter(Boolean).length;
        result.ok =
          !limits.expired && !limits.quotaExhausted && (count === 0 || result.reachableNodes > 0);
        if (!result.ok)
          result.errorCode = limits.expired
            ? 'SUBSCRIPTION_EXPIRED'
            : limits.quotaExhausted
              ? 'QUOTA_EXHAUSTED'
              : 'NODES_UNREACHABLE';
      }
    } catch (error) {
      result.errorCode = networkError(error);
    }
    result.latencyMs = Date.now() - start;
    return result;
  };
}
export function summarize(results: EndpointResult[]) {
  const websites = results.filter((r) => r.kind === 'website'),
    subscriptions = results.filter((r) => r.kind === 'subscription');
  const websiteUp = websites.length === 0 || websites.some((r) => r.ok),
    subscriptionUp = subscriptions.length === 0 || subscriptions.some((r) => r.ok);
  const inconclusive = results.some((r) =>
    ['UNSUPPORTED_PROXY', 'PROBE_ENGINE_ERROR'].includes(r.errorCode ?? ''),
  );
  const health = inconclusive
    ? 'unknown'
    : !results.length || !websiteUp || !subscriptionUp
      ? 'down'
      : results.every((r) => r.ok)
        ? 'healthy'
        : 'degraded';
  return {
    health,
    website: { total: websites.length, up: websites.filter((r) => r.ok).length },
    subscription: { total: subscriptions.length, up: subscriptions.filter((r) => r.ok).length },
    nodeProbe: subscriptions.find((r) => r.probeMode)?.probeMode ?? 'none',
  };
}
