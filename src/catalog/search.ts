import type { QueryResultRow } from 'pg';
import type { DB } from '../db.js';

export function searchTerm(input: string) {
  const value = input.trim().toLowerCase();
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (url.hostname.includes('.') && !/\s/.test(value))
      return url.hostname.replace(/^www\./, '').slice(0, 253);
  } catch {}
  return value.slice(0, 120);
}

// Search only public website hosts. Subscription hosts and encrypted URLs never participate.
export const searchFrom = `FROM providers p CROSS JOIN LATERAL (SELECT CASE
  WHEN $1='' THEN 4
  WHEN lower(p.name)=$1 OR lower(p.slug)=$1 THEN 0
  WHEN EXISTS(SELECT 1 FROM unnest(p.aliases) a WHERE lower(a)=$1) THEN 1
  WHEN EXISTS(SELECT 1 FROM endpoints e WHERE e.provider_id=p.id AND e.kind='website'
    AND regexp_replace(lower(e.display_host),'^www\\.','')=$1) THEN 2
  WHEN starts_with(lower(p.name),$1) OR starts_with(lower(p.slug),$1)
    OR EXISTS(SELECT 1 FROM unnest(p.aliases) a WHERE starts_with(lower(a),$1)) THEN 3
  WHEN strpos(lower(p.name),$1)>0 OR strpos(lower(p.slug),$1)>0
    OR EXISTS(SELECT 1 FROM unnest(p.aliases) a WHERE strpos(lower(a),$1)>0)
    OR EXISTS(SELECT 1 FROM endpoints e WHERE e.provider_id=p.id AND e.kind='website'
      AND strpos(lower(e.display_host),$1)>0) THEN 4
  ELSE 5 END AS rank) relevance
  WHERE relevance.rank < 5 AND ($2::text IS NULL OR p.lifecycle=$2)
  AND ($3::text IS NULL OR $3=ANY(p.tags))`;
export const searchOrder = 'ORDER BY relevance.rank,lower(p.name),p.slug,p.id';
export async function searchProviders<T extends QueryResultRow>(
  db: DB,
  select: string,
  query: string,
  limit: number,
  offset = 0,
  options: { lifecycle?: string; tag?: string; exact?: boolean } = {},
) {
  return db.query<T>(
    `${select} ${searchFrom} ${options.exact ? 'AND relevance.rank<=2' : ''} ${searchOrder} LIMIT $4 OFFSET $5`,
    [searchTerm(query), options.lifecycle ?? null, options.tag ?? null, limit, offset],
  );
}
