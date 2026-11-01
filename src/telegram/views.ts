import type { InlineKeyboardMarkup } from 'grammy/types';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import type { PreparedProvider } from '../catalog/service.js';
import {
  ceremonyCard,
  ceremonyKeyboard,
  checkReport,
  clip,
  escape,
  expandId,
  listKeyboard,
  markup,
  providerCard,
  providerKeyboard,
  providerViewSql,
  reviewKeyboard,
  time,
  webLink,
  type CheckRun,
  type ProviderView,
} from './format.js';

export interface View {
  text: string;
  markup?: InlineKeyboardMarkup;
  /** Deep-link payload that reopens the same view in the private chat. */
  start: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAGE = 8;

export function views(db: DB, config: Config) {
  const one = async (sql: string, values: unknown[]) =>
    (await db.query<ProviderView>(`${providerViewSql} ${sql}`, values))[0];
  async function find(query: string) {
    const value = query.trim().toLowerCase();
    if (!value) return undefined;
    const id = uuid.test(value) ? value : expandId(value);
    return id ? one('WHERE p.id=$1', [id]) : one('WHERE p.slug=$1', [value]);
  }
  const search = (query: string, limit: number, offset = 0) =>
    db.query<ProviderView>(
      `${providerViewSql} WHERE ($1='' OR p.name ILIKE '%'||$1||'%' OR p.slug ILIKE '%'||$1||'%') ORDER BY (p.lifecycle='dead') DESC,p.death_at DESC NULLS LAST,p.created_at DESC LIMIT $2 OFFSET $3`,
      [query.trim().slice(0, 120), limit, offset],
    );
  async function following(userId: string | undefined, providerId: string) {
    if (!userId) return false;
    return Boolean(
      (
        await db.query('SELECT 1 FROM follows WHERE user_id=$1 AND provider_id=$2', [
          userId,
          providerId,
        ])
      )[0],
    );
  }
  return {
    find,
    search,
    byId: (id: string) => one('WHERE p.id=$1', [id]),
    async provider(p: ProviderView, username: string, userId?: string): Promise<View> {
      return {
        text: providerCard(p),
        markup: providerKeyboard(p, config, {
          username,
          following: await following(userId, p.id),
          interactive: true,
        }),
        start: `p_${p.id.replace(/-/g, '')}`,
      };
    },
    ceremony: (p: ProviderView): View => ({
      text: ceremonyCard(p),
      markup: ceremonyKeyboard(p, config),
      start: `c_${p.id.replace(/-/g, '')}`,
    }),
    async report(p: ProviderView) {
      const runs = await db.query<CheckRun>(
        'SELECT created_at,health,summary FROM check_runs WHERE provider_id=$1 ORDER BY created_at DESC LIMIT 8',
        [p.id],
      );
      return { ...checkReport(p, runs), start: `r_${p.id.replace(/-/g, '')}` };
    },
    async graveyard(offset: number): Promise<View> {
      const [items, [stats]] = await Promise.all([
        db.query<ProviderView>(
          `${providerViewSql} WHERE p.lifecycle='dead' ORDER BY p.death_at DESC,p.id LIMIT $1 OFFSET $2`,
          [PAGE, offset],
        ),
        db.query<{ total: number }>(
          "SELECT count(*)::int AS total FROM providers WHERE lifecycle='dead'",
        ),
      ]);
      const total = stats!.total,
        pages = Math.max(1, Math.ceil(total / PAGE)),
        page = Math.floor(offset / PAGE) + 1;
      const cemetery = webLink(config, '/cemetery');
      return {
        text: total
          ? `🪦 <b>赛博墓园</b>\n${total} 座墓碑 · 第 ${page}/${pages} 页`
          : '🪦 <b>赛博墓园</b>\n暂无已确认跑路的机场。',
        markup: listKeyboard(items, [
          [
            ...(offset > 0
              ? [{ text: '‹ 上一页', callback_data: `gy:${Math.max(0, offset - PAGE)}` }]
              : []),
            ...(offset + PAGE < total
              ? [{ text: '下一页 ›', callback_data: `gy:${offset + PAGE}` }]
              : []),
          ],
          cemetery ? [{ text: '🌐 网页版墓园', url: cemetery }] : [],
        ]),
        start: 'graveyard',
      };
    },
    async pending(): Promise<View> {
      const [[counts], incidents] = await Promise.all([
        db.query<{ incidents: number; submissions: number; memorials: number }>(
          "SELECT (SELECT count(*)::int FROM incidents WHERE status='open') AS incidents,(SELECT count(*)::int FROM submissions WHERE status='pending') AS submissions,(SELECT count(*)::int FROM memorials WHERE status='pending') AS memorials",
        ),
        db.query<{ id: string; name: string }>(
          "SELECT i.id,p.name FROM incidents i JOIN providers p ON p.id=i.provider_id WHERE i.status='open' ORDER BY i.created_at LIMIT 6",
        ),
      ]);
      const c = counts!;
      const consoleUrl = webLink(config, '/console');
      return {
        text: `🗂 <b>待处理</b>\n异常事件 ${c.incidents} · 投稿 ${c.submissions} · 追悼留言 ${c.memorials}`,
        markup: markup([
          ...incidents.map((i) => [
            { text: clip(`⚠️ ${i.name}`, 60), callback_data: `ri:${i.id}` },
          ]),
          [
            ...(c.submissions ? [{ text: `📮 投稿 ${c.submissions}`, callback_data: 'ps:0' }] : []),
            ...(c.memorials ? [{ text: `🕯 留言 ${c.memorials}`, callback_data: 'pm:0' }] : []),
          ],
          [
            { text: '🔄 刷新', callback_data: 'pd' },
            ...(consoleUrl ? [{ text: '🗂 后台', url: consoleUrl }] : []),
          ],
        ]),
        start: 'pending',
      };
    },
    async incident(id: string): Promise<View | undefined> {
      const [row] = await db.query<{
        id: string;
        status: string;
        summary: string;
        created_at: Date;
        provider_id: string;
      }>('SELECT id,status,summary,created_at,provider_id FROM incidents WHERE id=$1', [id]);
      if (!row) return undefined;
      const p = (await one('WHERE p.id=$1', [row.provider_id]))!;
      const open = row.status === 'open';
      return {
        text: [
          `🧾 <b>异常事件</b> · ${open ? '待复核' : '已处理'}`,
          providerCard(p),
          `<blockquote>${escape(clip(row.summary, 1000))}</blockquote>`,
          `发起：${time(row.created_at)}`,
        ].join('\n'),
        markup: open
          ? reviewKeyboard(row.id, webLink(config, `/airports/${encodeURIComponent(p.slug)}`))
          : markup([[{ text: '‹ 待处理', callback_data: 'pd' }]]),
        start: 'pending',
      };
    },
    async submission(offset: number): Promise<View> {
      const [row] = await db.query<{
        id: string;
        payload: PreparedProvider;
        created_at: Date;
        author: string;
      }>(
        "SELECT s.id,s.payload,s.created_at,u.display_name AS author FROM submissions s JOIN users u ON u.id=s.user_id WHERE s.status='pending' ORDER BY s.created_at LIMIT 1 OFFSET $1",
        [offset],
      );
      if (!row)
        return {
          text: '📮 没有更多待审核的投稿。',
          markup: markup([[{ text: '‹ 待处理', callback_data: 'pd' }]]),
          start: 'pending',
        };
      const p = row.payload;
      return {
        text: [
          '📮 <b>投稿待审核</b>',
          `${escape(p.name)} · <code>${escape(p.slug)}</code>`,
          `官网：${escape(
            p.endpoints
              .filter((e) => e.kind === 'website')
              .map((e) => e.display_host)
              .join('、') || '—',
          )}`,
          `订阅：${p.endpoints.filter((e) => e.kind === 'subscription').length} 个（加密保存）`,
          p.description
            ? `<blockquote expandable>${escape(clip(p.description, 600))}</blockquote>`
            : '',
          `投稿人：${escape(row.author)} · ${time(row.created_at)}`,
        ]
          .filter(Boolean)
          .join('\n'),
        markup: markup([
          [
            { text: '✅ 通过', callback_data: `sb:a:${row.id}`, style: 'success' },
            { text: '❌ 驳回', callback_data: `sb:r:${row.id}`, style: 'danger' },
          ],
          [
            { text: '‹ 待处理', callback_data: 'pd' },
            { text: '下一条 ›', callback_data: `ps:${offset + 1}` },
          ],
        ]),
        start: 'pending',
      };
    },
    async memorial(offset: number): Promise<View> {
      const [row] = await db.query<{ id: string; body: string; provider: string; author: string }>(
        "SELECT m.id,m.body,p.name AS provider,u.display_name AS author FROM memorials m JOIN providers p ON p.id=m.provider_id JOIN users u ON u.id=m.user_id WHERE m.status='pending' ORDER BY m.created_at LIMIT 1 OFFSET $1",
        [offset],
      );
      if (!row)
        return {
          text: '🕯 没有更多待审核的追悼留言。',
          markup: markup([[{ text: '‹ 待处理', callback_data: 'pd' }]]),
          start: 'pending',
        };
      return {
        text: `🕯 <b>追悼留言待审核</b>\n${escape(row.provider)}\n<blockquote>${escape(clip(row.body, 1000))}</blockquote>\n作者：${escape(row.author)}`,
        markup: markup([
          [
            { text: '👁 公开', callback_data: `mm:v:${row.id}`, style: 'success' },
            { text: '🙈 隐藏', callback_data: `mm:h:${row.id}` },
          ],
          [
            { text: '‹ 待处理', callback_data: 'pd' },
            { text: '下一条 ›', callback_data: `pm:${offset + 1}` },
          ],
        ]),
        start: 'pending',
      };
    },
  };
}
