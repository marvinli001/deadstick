import { decrypt } from '../crypto.js';
import type { Config } from '../config.js';
import type { MonitorSettings } from '../catalog/schemas.js';
import { safeFetch, probeTcp, networkError } from './network.js';
import { parseSubscription, subscriptionLimits } from './subscription.js';
import { probeProxy } from './proxy.js';
import { AppError } from '../errors.js';

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
  probeErrorCode?: string;
}
export type CheckEndpoint = (
  endpoint: Endpoint,
  settings: MonitorSettings,
) => Promise<EndpointResult>;

async function fetchWithRetry(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    const canRetry = () => attempt < 2 && deadline - Date.now() > 200;
    try {
      const response = await safeFetch(url, Math.max(1, deadline - Date.now()));
      if (!canRetry() || ![408, 500, 502, 503, 504].includes(response.status)) return response;
    } catch (error) {
      if (
        !canRetry() ||
        ![
          'TIMEOUT',
          'DNS_TIMEOUT',
          'DNS_TEMPORARY',
          'CONNECTION_RESET',
          'CONNECTION_REFUSED',
          'NETWORK_UNREACHABLE',
          'NETWORK_ERROR',
        ].includes(networkError(error))
      )
        throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

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
      const response = await fetchWithRetry(
        decrypt(endpoint.url_ciphertext, config.appKey),
        settings.checkTimeoutMs,
      );
      result.httpStatus = response.status;
      if (endpoint.kind === 'website' && response.headers.get('cf-mitigated') === 'challenge')
        result.errorCode = 'WEBSITE_CHALLENGE';
      else if (response.status < 200 || response.status >= 400)
        result.errorCode = `HTTP_${response.status}`;
      else if (endpoint.kind === 'website') result.ok = true;
      else {
        const nodes = parseSubscription(response.body),
          limits = subscriptionLimits(response.headers.get('subscription-userinfo'));
        result.ok = true;
        result.nodeCount = nodes.length;
        result.subscriptionExpired = limits.expired;
        result.quotaExhausted = limits.quotaExhausted;
        const count =
          limits.expired || limits.quotaExhausted
            ? 0
            : Math.min(settings.nodeSampleSize, nodes.length);
        const samples = Array.from(
          { length: count },
          (_, i) => nodes[Math.floor((i * nodes.length) / count)]!,
        );
        result.sampledNodes = count;
        const reachable: boolean[] = [];
        let probeError: string | undefined;
        result.probeMode = count > 0 ? config.probeMode : undefined;
        for (const node of samples) {
          if (Date.now() >= start + settings.checkTimeoutMs) {
            reachable.push(false);
            continue;
          }
          const budget = Math.max(
            1,
            Math.min(
              5000,
              Math.floor(
                (start + settings.checkTimeoutMs - Date.now()) / (count - reachable.length),
              ),
            ),
          );
          try {
            reachable.push(
              config.probeMode === 'proxy'
                ? await probeProxy(node, config.mihomoBin!, budget)
                : await probeTcp(node.host, node.port, budget),
            );
          } catch (error) {
            if (
              error instanceof AppError &&
              ['UNSUPPORTED_PROXY', 'PROBE_ENGINE_ERROR'].includes(error.code)
            )
              probeError = error.code;
            reachable.push(false);
          }
        }
        result.reachableNodes = reachable.filter(Boolean).length;
        if (count > 0 && result.reachableNodes === 0)
          result.probeErrorCode = probeError ?? 'NODES_UNREACHABLE';
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
  const blocked = websites.filter((r) => r.errorCode === 'WEBSITE_CHALLENGE').length;
  const health = !results.some((r) => r.ok)
    ? blocked > 0
      ? 'unknown'
      : 'down'
    : results.every((r) => r.ok)
      ? 'healthy'
      : 'degraded';
  return {
    health,
    website: {
      total: websites.length,
      up: websites.filter((r) => r.ok).length,
      ...(blocked > 0 ? { blocked } : {}),
    },
    subscription: { total: subscriptions.length, up: subscriptions.filter((r) => r.ok).length },
    nodeProbe: subscriptions.find((r) => r.probeMode)?.probeMode ?? 'none',
  };
}
