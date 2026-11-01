import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'grammy/types';
import type { Config } from '../config.js';

// Every value from users or the catalog must pass through escape() before it enters HTML.
export const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

export const lifecycleLabels: Record<string, string> = {
  active: '存活',
  suspected: '疑似跑路',
  dead: '已入土',
};
export const healthLabels: Record<string, string> = {
  unknown: '未知',
  healthy: '正常',
  degraded: '部分异常',
  down: '无法访问',
};
const icons: Record<string, string> = { active: '✈️', suspected: '⚠️', dead: '🪦' };
export const tributeKinds = ['flower', 'candle', 'incense'] as const;
export type TributeKind = (typeof tributeKinds)[number];
export const tributeLabels: Record<TributeKind, string> = {
  flower: '🌼 献花',
  candle: '🕯 点烛',
  incense: '🙏 上香',
};

export function time(value: Date | string | null | undefined, format: 'wDT' | 'D' | 'r' = 'wDT') {
  if (!value) return '—';
  const date = new Date(value);
  const iso = date.toISOString();
  const fallback = format === 'D' ? iso.slice(0, 10) : `${iso.slice(0, 16).replace('T', ' ')} UTC`;
  return `<tg-time unix="${Math.floor(date.getTime() / 1000)}" format="${format}">${fallback}</tg-time>`;
}

// UUIDs without dashes fit Telegram deep links (64 chars) and callback data (64 bytes).
export const compactId = (id: string) => id.replace(/-/g, '');
export function expandId(value: string) {
  const match = /^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})$/.exec(value);
  return match ? match.slice(1).join('-') : undefined;
}
// Telegram rejects buttons with non-public URLs, so local development gets no website buttons.
export const webLink = (config: Config, path: string) =>
  config.publicUrl.startsWith('https://') ? `${config.publicUrl}${path}` : undefined;
export const startLink = (username: string | undefined, payload: string) =>
  username ? `https://t.me/${username}?start=${payload}` : undefined;
export const miniAppLink = (config: Config, payload: string) =>
  config.botUsername ? `https://t.me/${config.botUsername}?startapp=${payload}` : undefined;
export function miniAppButton(config: Config, text: string, payload: string, privateChat = false) {
  const site = webLink(config, `/?tgWebAppStartParam=${payload}`);
  if (privateChat && site) return [{ text, web_app: { url: site } }];
  const href = miniAppLink(config, payload);
  return href ? [{ text, url: href }] : [];
}

export interface ProviderView {
  id: string;
  name: string;
  slug: string;
  lifecycle: string;
  health: string;
  description?: string | null;
  epitaph: string | null;
  last_checked_at?: Date | null;
  death_at?: Date | null;
  flowers?: number;
  candles?: number;
  incense?: number;
}
export const providerViewSql = `SELECT p.id,p.name,p.slug,p.lifecycle,p.health,p.description,p.epitaph,p.last_checked_at,p.death_at,
  (SELECT count(*)::int FROM tributes t WHERE t.provider_id=p.id AND t.kind='flower') AS flowers,
  (SELECT count(*)::int FROM tributes t WHERE t.provider_id=p.id AND t.kind='candle') AS candles,
  (SELECT count(*)::int FROM tributes t WHERE t.provider_id=p.id AND t.kind='incense') AS incense
  FROM providers p`;

export const providerTitle = (p: Pick<ProviderView, 'lifecycle' | 'name'>) =>
  `${icons[p.lifecycle] ?? '✈️'} ${p.name}`;
const tributeLine = (p: ProviderView) =>
  `🌼 ${p.flowers ?? 0} · 🕯 ${p.candles ?? 0} · 🙏 ${p.incense ?? 0}`;

export function providerCard(p: ProviderView) {
  const lines = [
    `<b>${escape(providerTitle(p))}</b>`,
    `<code>${escape(p.slug)}</code> · ${lifecycleLabels[p.lifecycle] ?? p.lifecycle} · ${healthLabels[p.health] ?? p.health}`,
    `最近检测：${time(p.last_checked_at)}`,
  ];
  if (p.lifecycle === 'suspected') lines.push('自动检测连续异常，等待人工核验，尚未确认跑路。');
  if (p.lifecycle === 'dead') {
    lines.push(`入土：${time(p.death_at, 'D')}`);
    if (p.epitaph) lines.push(`<blockquote>${escape(clip(p.epitaph, 500))}</blockquote>`);
    lines.push(tributeLine(p));
  }
  if (p.description)
    lines.push(`<blockquote expandable>${escape(clip(p.description, 600))}</blockquote>`);
  return lines.join('\n');
}
export function ceremonyCard(p: ProviderView) {
  return [
    '🕯 <b>电子追悼会</b>',
    `<b>${escape(p.name)}</b> · <code>${escape(p.slug)}</code>`,
    `入土：${time(p.death_at, 'D')}`,
    `<blockquote>${escape(clip(p.epitaph ?? '愿后来者少走弯路。', 500))}</blockquote>`,
    tributeLine(p),
  ].join('\n');
}

type Row = InlineKeyboardButton[];
export const markup = (rows: Row[]): InlineKeyboardMarkup => ({
  inline_keyboard: rows.filter((row) => row.length),
});

export function richButtons(keyboard: InlineKeyboardMarkup) {
  return keyboard.inline_keyboard
    .map(
      (row) =>
        `<tg-button-row>${row
          .map((button) => {
            const style = button.style ? ` style="${button.style}"` : '';
            let action: string;
            if ('callback_data' in button)
              action = `type="callback_data" data="${escape(button.callback_data)}"`;
            else if ('url' in button) action = `type="url" url="${escape(button.url)}"`;
            else if ('web_app' in button)
              action = `type="web_app" url="${escape(button.web_app.url)}"`;
            else if ('switch_inline_query' in button)
              action = `type="switch_inline_query" query="${escape(button.switch_inline_query)}"`;
            else if ('switch_inline_query_current_chat' in button)
              action = `type="switch_inline_query_current_chat" query="${escape(button.switch_inline_query_current_chat)}"`;
            else if ('copy_text' in button)
              action = `type="copy_text" text="${escape(button.copy_text.text)}"`;
            else if ('disabled' in button) action = 'type="disabled"';
            else throw new Error('Unsupported rich message button');
            return `<tg-button ${action}${style}>${escape(button.text)}</tg-button>`;
          })
          .join('')}</tg-button-row>`,
    )
    .join('');
}

export function providerRichCard(p: ProviderView) {
  return [
    `<h2>${escape(providerTitle(p))}</h2>`,
    `<p><code>${escape(p.slug)}</code></p>`,
    `<table bordered compact><tr><th>状态</th><th>检测</th></tr><tr><td>${escape(lifecycleLabels[p.lifecycle] ?? p.lifecycle)}</td><td>${escape(healthLabels[p.health] ?? p.health)}</td></tr></table>`,
    p.lifecycle === 'suspected'
      ? '<blockquote>连续检测异常，等待人工核验，尚未确认跑路。</blockquote>'
      : '',
    p.lifecycle === 'dead'
      ? `<p>入土：${time(p.death_at, 'D')}</p><blockquote>${escape(clip(p.epitaph ?? '愿后来者少走弯路。', 500))}</blockquote><p>${tributeLine(p)}</p>`
      : '',
    p.description
      ? `<details><summary>机场介绍</summary><p>${escape(clip(p.description, 600))}</p></details>`
      : '',
    `<footer>最近检测：${time(p.last_checked_at)}</footer>`,
  ].join('');
}

export function ceremonyRichCard(p: ProviderView) {
  return `<h2>🕯 电子追悼会</h2><h3>${escape(p.name)}</h3><p><code>${escape(p.slug)}</code> · 入土 ${time(p.death_at, 'D')}</p><aside>${escape(clip(p.epitaph ?? '愿后来者少走弯路。', 500))}</aside><table compact><tr><th>🌼 献花</th><th>🕯 点烛</th><th>🙏 上香</th></tr><tr><td>${p.flowers ?? 0}</td><td>${p.candles ?? 0}</td><td>${p.incense ?? 0}</td></tr></table>`;
}
const url = (text: string, href: string | undefined): Row => (href ? [{ text, url: href }] : []);
export const tributeRow = (id: string): Row =>
  tributeKinds.map((kind) => ({ text: tributeLabels[kind], callback_data: `${kind}:${id}` }));

/** Buttons under a provider card. `interactive` is false where callbacks cannot work (inline, guest). */
export function providerKeyboard(
  p: ProviderView,
  config: Config,
  options: { username?: string; following?: boolean; interactive: boolean },
) {
  const site = miniAppButton(config, '📱 详情与留言', `p_${compactId(p.id)}`);
  if (!options.interactive)
    return markup([
      [...url('🤖 在机器人中查看', startLink(options.username, `p_${compactId(p.id)}`)), ...site],
      p.lifecycle === 'dead'
        ? url('🕯 前往追悼会', startLink(options.username, `c_${compactId(p.id)}`))
        : [],
    ]);
  return markup([
    p.lifecycle === 'dead' ? tributeRow(p.id) : [],
    [
      options.following
        ? { text: '🔕 取消关注', callback_data: `uf:${p.id}` }
        : { text: '🔔 关注', callback_data: `fo:${p.id}`, style: 'success' },
      { text: '📊 检测记录', callback_data: `rep:${p.id}` },
    ],
    [
      ...(p.lifecycle === 'dead' ? [{ text: '🕯 追悼会', callback_data: `cer:${p.id}` }] : []),
      { text: '📤 分享', switch_inline_query: p.slug },
      ...site,
    ],
  ]);
}
export function ceremonyKeyboard(p: ProviderView, config: Config) {
  return markup([
    tributeRow(p.id),
    [
      { text: '📤 转发追悼会', switch_inline_query: p.slug },
      ...miniAppButton(config, '📱 留言', `p_${compactId(p.id)}`),
    ],
  ]);
}
export function listKeyboard(items: ProviderView[], extra: Row[] = []) {
  return markup([
    ...items.map((p) => [
      {
        text: clip(`${providerTitle(p)} · ${lifecycleLabels[p.lifecycle] ?? p.lifecycle}`, 60),
        callback_data: `p:${p.id}`,
      },
    ]),
    ...extra,
  ]);
}
export const reviewKeyboard = (incidentId: string, detail?: string) =>
  markup([
    [
      { text: '🪦 确认跑路', callback_data: `rv:d:${incidentId}`, style: 'danger' },
      { text: '✅ 已恢复', callback_data: `rv:r:${incidentId}`, style: 'success' },
    ],
    [{ text: '🚫 排除误报', callback_data: `rv:x:${incidentId}` }, ...url('🌐 详情', detail)],
  ]);

export interface CheckRun {
  created_at: Date;
  health: string;
  summary: {
    website?: { total: number; up: number };
    subscription?: { total: number; up: number };
    nodeProbe?: string;
  };
}
const ratio = (part?: { total: number; up: number }) =>
  part && part.total ? `${part.up}/${part.total}` : '—';
const probeLabels: Record<string, string> = { proxy: '真实出网', tcp: '端口连通', none: '未抽样' };

/** Rich message (Bot API 10.1+) with a table, and the plain HTML fallback for older clients. */
export function checkReport(p: ProviderView, runs: CheckRun[]) {
  const heading = `${providerTitle(p)} · 检测记录`;
  const note = '自动检测只会把机场标为疑似跑路，确认跑路需要人工核验。';
  const rows = runs.map((r) => ({
    at: new Date(r.created_at),
    health: healthLabels[r.health] ?? r.health,
    website: ratio(r.summary.website),
    subscription: ratio(r.summary.subscription),
    probe: probeLabels[r.summary.nodeProbe ?? 'none'] ?? '—',
  }));
  const rich = runs.length
    ? `<h3>${escape(heading)}</h3><table bordered striped compact><tr><th>时间</th><th>结果</th><th>官网</th><th>订阅</th><th>节点</th></tr>${rows
        .map(
          (r) =>
            `<tr><td>${time(r.at)}</td><td>${r.health}</td><td align="center">${r.website}</td><td align="center">${r.subscription}</td><td>${r.probe}</td></tr>`,
        )
        .join('')}</table><footer>${note}</footer>`
    : `<h3>${escape(heading)}</h3><p>暂无检测记录。</p>`;
  const text = [
    `<b>${escape(heading)}</b>`,
    ...(rows.length
      ? rows.map(
          (r) =>
            `${time(r.at)} · ${r.health} · 官网 ${r.website} · 订阅 ${r.subscription} · ${r.probe}`,
        )
      : ['暂无检测记录。']),
    `<i>${note}</i>`,
  ].join('\n');
  return { rich, text };
}
