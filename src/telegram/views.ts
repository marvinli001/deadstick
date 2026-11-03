import { searchProviders } from '../catalog/search.js';
import type { InlineKeyboardMarkup } from 'grammy/types';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import type { SubmissionPayload } from '../catalog/submissions.js';
import {
  ceremonyCard,
  ceremonyKeyboard,
  checkReport,
  clip,
  escape,
  expandId,
  listKeyboard,
  markup,
  miniAppButton,
  miniAppLink,
  compactId,
  providerCard,
  providerRichCard,
  ceremonyRichCard,
  richButtons,
  providerKeyboard,
  providerViewSql,
  providerViewSelect,
  reviewKeyboard,
  time,
  type CheckRun,
  type ProviderView,
} from './format.js';

export interface View {
  text: string;
  rich?: string;
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
    if (id) return one('WHERE p.id=$1', [id]);
    const matches = await searchProviders<ProviderView>(db, providerViewSelect, value, 2, 0, { exact: true });
    return matches.length === 1 ? matches[0] : undefined;
  }
  const search = (query: string, limit: number, offset = 0) =>
    searchProviders<ProviderView>(db, providerViewSelect, query, limit, offset);
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
      const keyboard = providerKeyboard(p, config, {
        username,
        following: await following(userId, p.id),
        interactive: true,
      });
      return {
        text: providerCard(p),
        rich: providerRichCard(p) + richButtons(keyboard),
        start: `p_${p.id.replace(/-/g, '')}`,
      };
    },
    ceremony: (p: ProviderView): View => ({
      text: ceremonyCard(p),
      rich: ceremonyRichCard(p) + richButtons(ceremonyKeyboard(p, config)),
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
          miniAppButton(config, '📱 打开墓园', 'graveyard'),
        ]),
        start: 'graveyard',
      };
    },
    async dashboard(role: string): Promise<View> {
      const [[counts], [notify]] = await Promise.all([
        db.query<{
          incidents: number;
          submissions: number;
          memorials: number;
          groups: number;
          failed: number;
        }>(
          "SELECT (SELECT count(*)::int FROM incidents WHERE status='open') AS incidents,(SELECT count(*)::int FROM submissions WHERE status='pending') AS submissions,(SELECT count(*)::int FROM memorials WHERE status='pending') AS memorials,(SELECT count(*)::int FROM telegram_chats WHERE kind='group' AND enabled) AS groups,(SELECT count(*)::int FROM notifications WHERE status='failed') AS failed",
        ),
        db.query<{ online: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM worker_heartbeats WHERE last_seen_at>now()-interval '30 seconds') AS online",
        ),
      ]);
      const c = counts!;
      return {
        text: '🗂 工作台',
        rich:
          `<h2>🗂 ${role === 'admin' ? '管理员' : '审核员'}工作台</h2><table bordered compact><tr><th>异常复核</th><th>投稿</th><th>留言</th></tr><tr><td>${c.incidents}</td><td>${c.submissions}</td><td>${c.memorials}</td></tr></table>` +
          (role === 'admin'
            ? `<p>通报群 ${c.groups} · 投递失败 ${c.failed} · Worker ${notify!.online ? '在线' : '离线'}</p>`
            : '') +
          richButtons(
            markup([
              [
                { text: '🗂 待处理', callback_data: 'pd', style: 'primary' },
                { text: '🔔 复核私信', callback_data: 'nt' },
              ],
              miniAppButton(config, '打开管理台', 'admin', true),
              [
                ...miniAppButton(config, '异常复核', 'incidents', true),
                ...miniAppButton(config, '投稿审核', 'review_submissions', true),
                ...miniAppButton(config, '留言审核', 'memorials', true),
              ],
              ...(role === 'admin'
                ? [
                    [
                      ...miniAppButton(config, '机器人与通报群', 'telegram', true),
                      ...miniAppButton(config, '用户权限', 'users', true),
                    ],
                    [
                      ...miniAppButton(config, '检测队列', 'jobs', true),
                      ...miniAppButton(config, '通知投递', 'notifications', true),
                      ...miniAppButton(config, '审计', 'audit', true),
                    ],
                  ]
                : []),
              [{ text: '🔄 刷新', callback_data: 'ad' }],
            ]),
          ),
        start: 'admin',
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
      return {
        text: `🗂 <b>待处理</b>\n异常事件 ${c.incidents} · 投稿 ${c.submissions} · 追悼留言 ${c.memorials}`,
        rich: `<h2>🗂 待处理</h2><table bordered compact><tr><th>异常复核</th><th>投稿审核</th><th>留言审核</th></tr><tr><td>${c.incidents}</td><td>${c.submissions}</td><td>${c.memorials}</td></tr></table>`,
        markup: markup([
          ...incidents.map((i) => [
            { text: clip(`⚠️ ${i.name}`, 60), callback_data: `ri:${i.id}` },
          ]),
          [
            ...(c.submissions ? [{ text: `📮 投稿 ${c.submissions}`, callback_data: 'ps:0' }] : []),
            ...(c.memorials ? [{ text: `🕯 留言 ${c.memorials}`, callback_data: 'pm:0' }] : []),
          ],
          [{ text: '🔄 刷新', callback_data: 'pd' }, ...miniAppButton(config, '🗂 管理台', 'admin')],
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
        rich: `<h2>🧾 异常事件 · ${open ? '待复核' : '已处理'}</h2>${providerRichCard(p)}<details open><summary>异常记录</summary><p>${escape(clip(row.summary, 1000))}</p></details><footer>发起：${time(row.created_at)}</footer>`,
        markup: open
          ? reviewKeyboard(row.id, miniAppLink(config, `i_${compactId(row.id)}`))
          : markup([[{ text: '‹ 待处理', callback_data: 'pd' }]]),
        start: 'pending',
      };
    },
    async submission(offset: number): Promise<View> {
      const [row] = await db.query<{
        id: string;
        payload: SubmissionPayload;
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
          p.report ? '<b>线索待审核</b>' : '<b>投稿待审核</b>',
          p.report ? escape(clip(p.report.body, 600)) : '',
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
          ...(p.report ? [] : [[
            { text: '✅ 通过', callback_data: `sb:a:${row.id}`, style: 'success' as const },
            { text: '❌ 驳回', callback_data: `sb:r:${row.id}`, style: 'danger' as const },
          ]]),
          [
            { text: '‹ 待处理', callback_data: 'pd' },
            { text: '下一条 ›', callback_data: `ps:${offset + 1}` },
          ],
          miniAppButton(config, '📱 打开审核表单', `s_${compactId(row.id)}`, true),
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
          miniAppButton(config, '📱 打开留言审核', `m_${compactId(row.id)}`, true),
        ]),
        start: 'pending',
      };
    },
  };
}
