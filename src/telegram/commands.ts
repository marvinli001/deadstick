import type { BotCommand } from 'grammy/types';

type Audience = 'everyone' | 'private' | 'reviewer' | 'groupAdmin';
const commandTable: Array<BotCommand & { audience: Audience }> = [
  { command: 'start', description: '开始使用', audience: 'private' },
  { command: 'app', description: '打开 Mini App', audience: 'private' },
  { command: 'me', description: '我的关注与投稿', audience: 'private' },
  { command: 'cancel', description: '取消当前操作', audience: 'private' },
  { command: 'help', description: '使用说明', audience: 'everyone', is_ephemeral: true },
  { command: 'search', description: '搜索机场：名称', audience: 'everyone', is_ephemeral: true },
  { command: 'status', description: '机场状态：slug', audience: 'everyone', is_ephemeral: true },
  { command: 'graveyard', description: '逛赛博墓园', audience: 'everyone' },
  { command: 'ceremony', description: '电子追悼会：slug', audience: 'everyone' },
  { command: 'tribute', description: '献花：slug', audience: 'everyone', is_ephemeral: true },
  {
    command: 'memorial',
    description: '追悼留言：slug 留言',
    audience: 'everyone',
    is_ephemeral: true,
  },
  { command: 'follow', description: '关注机场：slug', audience: 'everyone', is_ephemeral: true },
  { command: 'unfollow', description: '取消关注：slug', audience: 'everyone', is_ephemeral: true },
  { command: 'following', description: '我的关注', audience: 'everyone', is_ephemeral: true },
  { command: 'submit', description: '投稿：名称 | slug | 官网 | 订阅', audience: 'private' },
  { command: 'pending', description: '待处理的复核与审核', audience: 'reviewer' },
  { command: 'admin', description: '打开 Telegram 管理台', audience: 'reviewer' },
  { command: 'notify', description: '开关复核私信', audience: 'reviewer' },
  { command: 'review', description: '文字复核：事件ID 结论 证据 原因', audience: 'reviewer' },
  { command: 'bind', description: '把本群（话题）设为通报群', audience: 'groupAdmin' },
  { command: 'unbind', description: '取消本群通报', audience: 'groupAdmin' },
];
const pick = (audiences: Audience[], ephemeral: boolean): BotCommand[] =>
  commandTable
    .filter((c) => audiences.includes(c.audience))
    .map(({ command, description, is_ephemeral }) => ({
      command,
      description,
      ...(ephemeral && is_ephemeral ? { is_ephemeral } : {}),
    }));
/** Command menus per BotCommandScope, used by telegram:setup and /notify. */
export const commandMenus = {
  private: pick(['private', 'everyone'], false),
  reviewer: pick(['private', 'everyone', 'reviewer'], false),
  groups: pick(['everyone'], true),
  groupAdmins: pick(['everyone', 'groupAdmin'], true),
};

export const commandsFor = (role?: string, disabled = false) =>
  !disabled && (role === 'admin' || role === 'moderator')
    ? commandMenus.reviewer
    : commandMenus.private;
