import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { DB } from '../db.js';
import { authenticated, type User } from '../auth/service.js';
import { audit } from '../catalog/service.js';
import { AppError } from '../errors.js';
import { enqueue, type TelegramSender } from './notifications.js';
import {
  NotificationPolicy,
  policyWithDefaults,
  presets,
  validatePolicy,
} from './notification-policy.js';

export const GroupId = Type.Object({ id: Type.String({ pattern: '^-[0-9]{1,20}$' }) });
export async function requireGroupManager(
  sender: TelegramSender,
  chatId: string,
  user: Pick<User, 'role' | 'telegram_id'>,
) {
  const chat = (await sender.send('getChat', { chat_id: chatId })) as {
    type: string;
    title?: string;
  };
  if (!['group', 'supergroup'].includes(chat.type))
    throw new AppError(400, 'CHAT_TYPE', '这不是群组');
  await requireBotMembership(sender, chatId);
  if (user.role !== 'admin') {
    if (!user.telegram_id) throw new AppError(403, 'GROUP_ADMIN', '需要本群管理员权限');
    if (!(await isGroupAdministrator(sender, chatId, user.telegram_id)))
      throw new AppError(403, 'GROUP_ADMIN', '需要本群管理员权限');
  }
  return chat;
}
export async function isGroupAdministrator(sender: TelegramSender, chatId: string, userId: string) {
  // getChatMember only guarantees lookup of other users when the bot is an administrator.
  const members = (await sender.send('getChatAdministrators', { chat_id: chatId })) as Array<{
    user: { id: number };
  }>;
  return members.some((member) => String(member.user.id) === userId);
}
export async function requireBotMembership(sender: TelegramSender, chatId: string) {
  const bot = (await sender.send('getMe', {})) as { id: number };
  const member = (await sender.send('getChatMember', { chat_id: chatId, user_id: bot.id })) as {
    status: string;
    is_member?: boolean;
    can_send_messages?: boolean;
  };
  if (
    !['creator', 'administrator', 'member'].includes(member.status) &&
    !(member.status === 'restricted' && member.is_member && member.can_send_messages)
  )
    throw new AppError(403, 'BOT_NOT_MEMBER', '请先把机器人加入本群并允许发言');
}
export async function groupSettings(db: DB, id: string) {
  const [row] = await db.query<{
    title: string;
    enabled: boolean;
    query_enabled: boolean;
    topic_id: number | null;
    notification_policy: Partial<NotificationPolicy>;
  }>("SELECT * FROM telegram_chats WHERE id=$1 AND kind='group'", [id]);
  return {
    chat_id: id,
    title: row?.title ?? id,
    active: row?.enabled ?? false,
    query_enabled: row?.query_enabled ?? false,
    topic_id: row?.topic_id ?? null,
    policy: policyWithDefaults(row?.notification_policy ?? null),
    presets,
  };
}
export function groupSettingsRoutes(app: FastifyInstance, db: DB, sender: TelegramSender) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const access = async (id: string, user: User) => requireGroupManager(sender, id, user);
  api.get(
    '/telegram/groups/:id',
    { preHandler: authenticated, schema: { tags: ['telegram'], params: GroupId } },
    async (req) => {
      const chat = await access(req.params.id, req.user!);
      return { ...(await groupSettings(db, req.params.id)), title: chat.title ?? req.params.id };
    },
  );
  api.put(
    '/telegram/groups/:id',
    {
      preHandler: authenticated,
      config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
      schema: {
        tags: ['telegram'],
        params: GroupId,
        body: Type.Object(
          {
            queryEnabled: Type.Boolean(),
            topicId: Type.Union([Type.Integer({ minimum: 1, maximum: 2147483647 }), Type.Null()]),
            policy: NotificationPolicy,
          },
          { additionalProperties: false },
        ),
      },
    },
    async (req) => {
      const chat = await access(req.params.id, req.user!);
      validatePolicy(req.body.policy);
      await db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7))', [req.params.id]);
        await tx.query(
          `INSERT INTO telegram_chats(id,title,kind,enabled,query_enabled,topic_id,notification_policy,manager_telegram_id)
        VALUES ($1,$2,'group',true,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,enabled=true,query_enabled=excluded.query_enabled,topic_id=excluded.topic_id,
        notification_policy=excluded.notification_policy,manager_telegram_id=excluded.manager_telegram_id`,
          [
            req.params.id,
            (chat.title ?? req.params.id).slice(0, 255),
            req.body.queryEnabled,
            req.body.topicId,
            JSON.stringify(req.body.policy),
            req.user!.role === 'admin' ? null : req.user!.telegram_id,
          ],
        );
        await audit(tx, req.user!.id, 'telegram.group.settings', req.params.id, req.body);
        await tx.query(
          "UPDATE notifications SET available_at=now() WHERE chat_id=$1 AND audience='group' AND event_meta IS NOT NULL AND status='pending' AND error_code IS NULL",
          [req.params.id],
        );
        await tx.query(
          "UPDATE notifications SET status='failed',error_code='RULE_CHANGED' WHERE chat_id=$1 AND audience='group' AND event_meta IS NULL AND status='pending'",
          [req.params.id],
        );
      });
      return groupSettings(db, req.params.id);
    },
  );
  api.post(
    '/telegram/groups/:id/test',
    {
      preHandler: authenticated,
      config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
      schema: {
        tags: ['telegram'],
        params: GroupId,
        body: Type.Object({}, { additionalProperties: false }),
      },
    },
    async (req) => {
      await access(req.params.id, req.user!);
      const settings = await groupSettings(db, req.params.id);
      if (!settings.active) throw new AppError(409, 'GROUP_INACTIVE', '请先保存群配置');
      // An explicit test is labelled and bypasses quiet hours; delivery still rechecks membership.
      await enqueue(
        db,
        `group-test:${req.params.id}:${crypto.randomUUID()}`,
        req.params.id,
        { text: '<b>通知测试</b>\n这是一条测试消息，机场状态未发生变化。', parse_mode: 'HTML' },
        settings.topic_id,
        { audience: 'group', event: { test: true } },
      );
      await audit(db, req.user!.id, 'telegram.group.test', req.params.id);
      return { ok: true };
    },
  );
  api.get(
    '/telegram/notifications/preferences',
    { preHandler: authenticated, schema: { tags: ['telegram'] } },
    async (req) => {
      const [row] = await db.query<{ policy: NotificationPolicy }>(
        'SELECT policy FROM notification_preferences WHERE user_id=$1',
        [req.user!.id],
      );
      return { policy: policyWithDefaults(row?.policy ?? null, true), presets };
    },
  );
  api.put(
    '/telegram/notifications/preferences',
    {
      preHandler: authenticated,
      schema: { tags: ['telegram'], body: NotificationPolicy },
    },
    async (req) => {
      validatePolicy(req.body);
      await db.transaction(async (tx) => {
        if (req.user!.telegram_id)
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7))', [
            req.user!.telegram_id,
          ]);
        await tx.query(
          'INSERT INTO notification_preferences(user_id,policy) VALUES ($1,$2) ON CONFLICT(user_id) DO UPDATE SET policy=excluded.policy',
          [req.user!.id, JSON.stringify(req.body)],
        );
        await tx.query(
          "UPDATE notifications SET available_at=now() WHERE chat_id=$1 AND audience='follower' AND event_meta IS NOT NULL AND status='pending' AND error_code IS NULL",
          [req.user!.telegram_id],
        );
      });
      return { policy: req.body };
    },
  );
}
