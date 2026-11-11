import { DomUtils, parseDocument } from 'htmlparser2';
import type { InlineKeyboardButton, InlineKeyboardMarkup } from 'grammy/types';
import { clip, escape, markup } from './format.js';

type Node = ReturnType<typeof parseDocument>['children'][number];
export interface WidgetDocument {
  blocks: string[];
  buttons: Array<{ text: string; data: string; style?: string }>;
  keyboard: InlineKeyboardMarkup;
  caption: string;
  requiredRole?: 'reviewer' | 'admin';
  threadId?: number;
}
export interface CardMessage {
  text: string;
  rich?: string;
  markup?: InlineKeyboardMarkup;
}
const textOf = (node: Node) => DomUtils.textContent(node);
const plainText = (html: string) =>
  textOf(
    parseDocument(
      html
        .replace(/<br>/g, '\n')
        .replace(/<\/(?:h[1-6]|p|blockquote|details|summary|small)>/g, '$&\n'),
    ),
  ).trim();
// Reserve navigation space in a 200px bubble with 24px text.
const columns = (value: string) =>
  Array.from(value).reduce((sum, char) => sum + (char.codePointAt(0)! > 255 ? 2 : 1), 0);
const textHeight = (value: string) =>
  value.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(columns(line) / 14)) * 34, 0);
const blockHeight = (html: string) =>
  html
    ? textHeight(plainText(html)) +
      (html.match(/<h[1-4]>/g)?.length ?? 0) * 17 +
      (html.match(/<(?:p|blockquote|details|summary)>/g)?.length ?? 0) * 8
    : 0;
function clean(node: Node): string {
  if (node.type === 'text') return escape(node.data.replace(/\0/g, ''));
  if (!('name' in node) || !('attribs' in node)) return '';
  const tag = node.name;
  if (tag === 'tg-button-row' || tag === 'tg-button' || tag === 'script' || tag === 'style')
    return '';
  const children = node.children.map(clean).join('');
  if (tag === 'tg-time') return `<span>${children}</span>`;
  if (tag === 'footer') return `<small>${children}</small>`;
  if (tag === 'a') {
    const href = node.attribs.href ?? '';
    return /^https:\/\//.test(href) && href.length <= 256
      ? `<a href="${escape(href)}">${children}</a>`
      : children;
  }
  if (
    !/^(h[1-4]|p|b|strong|i|em|u|s|code|pre|span|small|blockquote|details|summary|br|hr|ul|ol|li)$/.test(
      tag,
    )
  )
    return children;
  return tag === 'br' || tag === 'hr' ? `<${tag}>` : `<${tag}>${children}</${tag}>`;
}
function chunks(value: string, bytes: number) {
  const result: string[] = [];
  let chunk = '';
  for (const char of value) {
    if (
      Buffer.byteLength(JSON.stringify(escape(chunk + char))) > bytes ||
      textHeight(chunk + char) > 280
    ) {
      result.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) result.push(chunk);
  return result;
}

export function widgetDocument(message: CardMessage): WidgetDocument {
  const source = parseDocument(message.rich ?? message.text.replace(/\n/g, '<br>'));
  const rows: InlineKeyboardButton[][] = [...(message.markup?.inline_keyboard ?? [])];
  for (const anchor of DomUtils.getElementsByTagName('a', source.children)) {
    const href = anchor.attribs.href ?? '';
    if (/^(http:\/\/|tg:\/\/)/.test(href) || (/^https:\/\//.test(href) && href.length > 256))
      rows.push([{ text: clip(textOf(anchor) || '打开链接', 60), url: href }]);
  }
  const blocks: string[] = [];
  function add(node: Node) {
    if ('name' in node && 'children' in node && node.name === 'tg-button-row') {
      const row: InlineKeyboardButton[] = [];
      for (const button of node.children) {
        if (!('name' in button) || !('attribs' in button) || button.name !== 'tg-button') continue;
        const a = button.attribs;
        const text = textOf(button);
        const style = a.style as InlineKeyboardButton['style'];
        if (a.type === 'callback_data') row.push({ text, style, callback_data: a.data! });
        else if (a.type === 'url') row.push({ text, url: a.url! });
        else if (a.type === 'web_app') row.push({ text, web_app: { url: a.url! } });
        else if (a.type === 'switch_inline_query')
          row.push({ text, switch_inline_query: a.query! });
        else if (a.type === 'switch_inline_query_current_chat')
          row.push({ text, switch_inline_query_current_chat: a.query! });
        else if (a.type === 'copy_text') row.push({ text, copy_text: { text: a.text! } });
      }
      rows.push(row);
      return;
    }
    if ('name' in node && 'children' in node && node.name === 'table') {
      const tr = DomUtils.getElementsByTagName('tr', node.children);
      const firstCells =
        tr[0]?.children.filter((n) => 'name' in n && (n.name === 'th' || n.name === 'td')) ?? [];
      const headers = firstCells.every((n) => 'name' in n && n.name === 'th') ? firstCells : [];
      for (const row of tr.slice(headers.length ? 1 : 0)) {
        const cells = row.children.filter((n) => 'name' in n && n.name === 'td');
        const rowHeader = row.children.find((n) => 'name' in n && n.name === 'th');
        const html = cells
          .map(
            (cell, i) =>
              `${headers[i] || rowHeader ? `<b>${clean((headers[i] ?? rowHeader)!)}</b> ` : ''}${clean(cell)}`,
          )
          .join(' · ');
        add(parseDocument(`<p>${html}</p>`).children[0]!);
      }
      return;
    }
    const html = clean(node);
    if (!html.trim()) return;
    if (Buffer.byteLength(JSON.stringify(html)) <= 420 && blockHeight(html) <= 360)
      blocks.push(html);
    else for (const part of chunks(textOf(node), 340)) blocks.push(`<p>${escape(part)}</p>`);
  }
  for (const node of source.children) add(node);
  const buttons = rows
    .flat()
    .flatMap((button) =>
      'callback_data' in button
        ? [{ text: clip(button.text, 40), data: button.callback_data, style: button.style }]
        : [],
    );
  const caption = clip(plainText(blocks.join('')), 1024);
  return {
    blocks,
    buttons,
    keyboard: markup(rows.map((row) => row.filter((b) => !('callback_data' in b)))),
    caption,
    requiredRole: buttons.some((b) =>
      /^(ad$|pd$|nt(?::|$)|(?:ri|review|ps|pm|rv|sb|mm):)/.test(b.data),
    )
      ? 'reviewer'
      : undefined,
  };
}

export function widgetPages(document: WidgetDocument) {
  const pages: Array<{ h: string; b: Array<[number, string, string]> }> = [];
  let block = 0,
    button = 0;
  do {
    const page = { h: document.blocks[block++] ?? '', b: [] as Array<[number, string, string]> };
    let buttonsHeight = 0;
    while (button < document.buttons.length && page.b.length < 3) {
      const item = document.buttons[button]!;
      const height = Math.max(42, Math.ceil(columns(item.text) / 12) * 34 + 16) + 6;
      const entry: [number, string, string] = [button, item.text, item.style ?? ''];
      if (
        buttonsHeight + height + blockHeight(page.h) > 430 ||
        Buffer.byteLength(JSON.stringify({ h: page.h, b: [...page.b, entry] })) > 920
      )
        break;
      page.b.push(entry);
      buttonsHeight += height;
      button++;
    }
    while (block < document.blocks.length) {
      const html = page.h + document.blocks[block]!;
      if (
        buttonsHeight + blockHeight(html) > 430 ||
        Buffer.byteLength(JSON.stringify({ h: html, b: page.b })) > 920
      )
        break;
      page.h = html;
      block++;
    }
    pages.push(page);
  } while (block < document.blocks.length || button < document.buttons.length);
  return pages;
}

export function widgetState(document: WidgetDocument, revision: string, page = 0) {
  const pages = widgetPages(document);
  return JSON.stringify({ ...pages[page]!, r: revision, p: page, n: pages.length });
}

export function widgetHtml(id: string) {
  return `<html><head><style>
body{margin:0;padding:14px;color:var(--tg-theme-text-color);font-family:system-ui;line-height:1.4}
h1,h2,h3,h4{font-size:1.2em;margin:0 0 8px}p{margin:6px 0}small,.hint{color:var(--tg-theme-hint-color);font-size:.85em}code{overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:var(--tg-theme-link-color)}blockquote{margin:8px 0;padding:0 10px;border-left:2px solid var(--tg-theme-section-separator-color)}#body{overflow-wrap:anywhere}#actions{display:grid;gap:6px;margin-top:10px}button{min-height:42px;white-space:normal;overflow-wrap:anywhere;padding:8px 10px;border-radius:10px}button:active{transform:scale(.98)}button.primary,button.success{background:var(--tg-theme-button-color);color:var(--tg-theme-button-text-color)}button.danger{color:var(--tg-theme-destructive-text-color)}nav{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px}#notice{min-height:1.4em;margin:6px 0 0;font-size:.85em;color:var(--tg-theme-hint-color)}@media(prefers-reduced-motion:reduce){button:active{transform:none}}
</style></head><body><div id="body"></div><div id="actions"></div><nav id="nav"></nav><p id="notice"></p><script>
const W=TelegramWidget,K=${JSON.stringify(id)},$=id=>document.getElementById(id);let state,busy=false;
function request(op){if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);$('notice').textContent='处理中…';W.request('w:'+K+':'+state.r+':'+op).then(a=>{$('notice').textContent=a.result||''},e=>{$('notice').textContent=({NOT_ALLOWED:'请在机器人私聊中操作',BUSY:'请等待当前操作完成',RATE_LIMITED:'操作频繁，请稍后重试',TIMEOUT:'响应超时，请重试',FAILED:'连接失败，请重试',INVALID_ANSWER:'响应无效，请重试'})[e.code]||'暂时无法操作，请重试'}).finally(()=>{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false)})}
function button(text,op,style){const b=document.createElement('button');b.textContent=text;b.className=style||'';b.onclick=()=>request(op);b.disabled=busy;return b}
function render(){state=JSON.parse(W.chatData);$('body').innerHTML=state.h;$('actions').replaceChildren(...state.b.map(b=>button(b[1],'a:'+b[0],b[2])));$('nav').replaceChildren();if(state.n>1){if(state.p>0)$('nav').append(button('‹','p:'+(state.p-1)));const label=document.createElement('span');label.className='hint';label.textContent=(state.p+1)+' / '+state.n;$('nav').append(label);if(state.p+1<state.n)$('nav').append(button('›','p:'+(state.p+1)))}}
W.onEvent('chatDataChanged',render);render();W.ready();
</script></body></html>`;
}
