import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type {
  CheckRun,
  Lifecycle,
  Memorial,
  Page,
  Provider,
  ProviderDetail,
  Stats,
  TributeKind,
} from './types';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const useStats = () =>
  useQuery({ queryKey: ['stats'], queryFn: () => api<Stats>('/stats') });

export const useGraveyard = (limit: number, offset = 0) =>
  useQuery({
    queryKey: ['graveyard', limit, offset],
    queryFn: () => api<Page<Provider>>('/graveyard', { query: { limit, offset } }),
    placeholderData: keepPreviousData,
  });

export interface ProviderFilter {
  q?: string;
  lifecycle?: Lifecycle;
  tag?: string;
  limit?: number;
  offset?: number;
}

export const useProviders = (filter: ProviderFilter, enabled = true) =>
  useQuery({
    queryKey: ['providers', filter],
    queryFn: () => api<Page<Provider>>('/providers', { query: { ...filter } }),
    placeholderData: keepPreviousData,
    enabled,
  });

export const providerKey = (slug: string) => ['provider', slug];

export const useProvider = (slug: string) =>
  useQuery({
    queryKey: providerKey(slug),
    queryFn: () =>
      api<ProviderDetail>(
        uuid.test(slug) ? `/providers/${slug}` : `/providers/slug/${encodeURIComponent(slug)}`,
      ),
  });

export const useChecks = (id: string | undefined, limit = 60) =>
  useQuery({
    queryKey: ['checks', id, limit],
    queryFn: () => api<Page<CheckRun>>(`/providers/${id}/checks`, { query: { limit } }),
    enabled: Boolean(id),
  });

export const useMemorials = (id: string | undefined, enabled = true) =>
  useQuery({
    queryKey: ['memorials', id],
    queryFn: () => api<Page<Memorial>>(`/providers/${id}/memorials`, { query: { limit: 50 } }),
    enabled: Boolean(id) && enabled,
  });

export function useTribute(provider: ProviderDetail, slug: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (kind: TributeKind) =>
      api<{ created: boolean }>(`/providers/${provider.id}/tributes`, {
        method: 'POST',
        body: { kind },
      }),
    onSuccess: (result, kind) => {
      if (!result.created) return;
      client.setQueryData<ProviderDetail>(providerKey(slug), (old) => {
        if (!old) return old;
        const has = old.tributes.some((t) => t.kind === kind);
        return {
          ...old,
          tributes: has
            ? old.tributes.map((t) => (t.kind === kind ? { ...t, count: t.count + 1 } : t))
            : [...old.tributes, { kind, count: 1 }],
        };
      });
      void client.invalidateQueries({ queryKey: ['graveyard'] });
      void client.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useFollow(provider: ProviderDetail, slug: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (follow: boolean) =>
      api(`/providers/${provider.id}/follow`, { method: follow ? 'PUT' : 'DELETE' }),
    onSuccess: (_, follow) => {
      client.setQueryData<ProviderDetail>(providerKey(slug), (old) =>
        old
          ? {
              ...old,
              following: follow,
              follower_count: Math.max(
                0,
                old.follower_count + (follow === Boolean(old.following) ? 0 : follow ? 1 : -1),
              ),
            }
          : old,
      );
      void client.invalidateQueries({ queryKey: ['follows'] });
    },
  });
}

export const tributeCount = (provider: ProviderDetail, kind: TributeKind) =>
  provider.tributes.find((t) => t.kind === kind)?.count ?? 0;
