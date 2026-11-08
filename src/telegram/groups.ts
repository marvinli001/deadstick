import type { FastifyInstance } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import type { Update } from 'grammy/types';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import { decrypt } from '../crypto.js';
import { administrator } from '../auth/service.js';
import { audit } from '../catalog/service.js';
import { AppError, required } from '../errors.js';
import { Page } from '../catalog/schemas.js';
import type { TelegramSender } from './notifications.js';
import {
  NotificationPolicy,
  policyWithDefaults,
  presets,
  validatePolicy,
} from './notification-policy.js';

export const GroupId = Type.Object({ id: Type.String({ pattern: '^-[0-9]{1,20}$' }) });
// A single nullable type prevents Ajv from coercing an invalid 0 into null.
export const GroupTopicId = Type.Unsafe<number | null>({
  type: ['integer', 'null'],
  minimum: 1,
  maximum: 2147483647,
});
export interface GroupMember {
  status: string;
  is_member?: boolean;
  can_send_messages?: boolean;
}
interface GroupChat {
  id: number | string;
  type: string;
  title?: string;
  username?: string;
}
export interface TelegramGroup {
  id: string;
  title: string;
  enabled: boolean;
  approval_status: 'pending' | 'approved' | 'rejected';
  bot_member_status: string;
  bot_can_send: boolean;
  query_enabled: boolean;
  guest_enabled: boolean;
  topic_id: number | null;
  notification_policy: Partial<NotificationPolicy>;
  admin_note: string;
  username: string | null;
}
export const canSendInGroup = (member: GroupMember) =>
  ['creator', 'administrator', 'member'].includes(member.status) ||
  (member.status === 'restricted' && Boolean(member.is_member && member.can_send_messages));

export async function cancelGroupNotifications(db: DB, id: string) {
  await db.query(
    "UPDATE notifications SET status='failed',error_code='RECIPIENT_REVOKED',lease_until=NULL WHERE chat_id=$1 AND audience='group' AND status IN ('pending','running')",
    [id],
  );
}

export async function recordGroupMembership(
  db: DB,
  chat: GroupChat,
  member: GroupMember,
  invitation?: { id: number; first_name: string },
) {
  const id = String(chat.id),
    canSend = canSendInGroup(member);
  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7))', [id]);
    const [row] = await tx.query<TelegramGroup>(
      `INSERT INTO telegram_chats(id,title,kind,enabled,username,bot_member_status,bot_can_send,inviter_telegram_id,inviter_name,joined_at,left_at)
       VALUES ($1,$2,'group',false,$3,$4,$5,$6,$7,CASE WHEN $8 THEN now() END,CASE WHEN $9 THEN now() END)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title,username=excluded.username,
       bot_member_status=excluded.bot_member_status,bot_can_send=excluded.bot_can_send,
       enabled=CASE WHEN NOT $5 OR $8 THEN false ELSE telegram_chats.enabled END,
       approval_status=CASE WHEN $8 AND telegram_chats.approval_status<>'rejected' THEN 'pending' ELSE telegram_chats.approval_status END,
       inviter_telegram_id=CASE WHEN $8 THEN excluded.inviter_telegram_id ELSE telegram_chats.inviter_telegram_id END,
       inviter_name=CASE WHEN $8 THEN excluded.inviter_name ELSE telegram_chats.inviter_name END,
       joined_at=CASE WHEN $8 THEN now() ELSE telegram_chats.joined_at END,
       left_at=CASE WHEN $9 THEN now() WHEN $5 THEN NULL ELSE telegram_chats.left_at END,
       updated_at=now() RETURNING *`,
      [
        id,
        (chat.title ?? id).slice(0, 255),
        chat.username ?? null,
        member.status,
        canSend,
        invitation ? String(invitation.id) : null,
        invitation?.first_name ?? null,
        Boolean(invitation),
        ['left', 'kicked'].includes(member.status) ||
          (member.status === 'restricted' && !member.is_member),
      ],
    );
    if (!row!.enabled) await cancelGroupNotifications(tx, id);
    return row!;
  });
}

export async function requireGroupActive(db: DB, id: string) {
  const [row] = await db.query<TelegramGroup>(
    "SELECT * FROM telegram_chats WHERE id=$1 AND kind='group'",
    [id],
  );
  if (!row || row.approval_status === 'pending')
    throw new AppError(409, 'GROUP_PENDING', '本群正在等待站点管理员审批');
  if (row.approval_status === 'rejected')
    throw new AppError(403, 'GROUP_REJECTED', '本群已被站点管理员拒绝');
  if (!row.enabled || !row.bot_can_send)
    throw new AppError(409, 'GROUP_INACTIVE', '本群已停用，请联系站点管理员');
  return row;
}

export async function liveGroup(sender: TelegramSender, id: string) {
  const chat = (await sender.send('getChat', { chat_id: id })) as GroupChat;
  if (!['group', 'supergroup'].includes(chat.type))
    throw new AppError(400, 'CHAT_TYPE', '这不是群组');
  const bot = (await sender.send('getMe', {})) as { id: number };
  const member = (await sender.send('getChatMember', {
    chat_id: id,
    user_id: bot.id,
  })) as GroupMember;
  return { chat: { ...chat, id }, member };
}

export function adminGroupRoutes(
  app: FastifyInstance,
  db: DB,
  sender: TelegramSender,
  config: Config,
) {
  const api = app.withTypeProvider<TypeBoxTypeProvider>();
  const get = async (id: string) =>
    required(
      (
        await db.query<TelegramGroup>("SELECT * FROM telegram_chats WHERE id=$1 AND kind='group'", [
          id,
        ])
      )[0],
    );
  api.post(
    '/admin/telegram/groups/discover',
    {
      preHandler: administrator,
      config: { rateLimit: { max: 1, timeWindow: '1 minute' } },
      schema: { body: Type.Object({}, { additionalProperties: false }) },
    },
    async (req) => {
      const seen = new Set<string>();
      let before = '9223372036854775807',
        imported = 0;
      while (true) {
        const rows = await db.query<{ update_id: string; payload_ciphertext: string }>(
          'SELECT update_id,payload_ciphertext FROM bot_updates WHERE update_id<$1 ORDER BY update_id DESC LIMIT 500',
          [before],
        );
        for (const row of rows) {
          const update = JSON.parse(decrypt(row.payload_ciphertext, config.appKey)) as Update;
          if (update.message?.migrate_to_chat_id) seen.add(String(update.message.chat.id));
          const event = update.my_chat_member;
          if (!event || !['group', 'supergroup'].includes(event.chat.type)) continue;
          const id = String(event.chat.id);
          if (seen.has(id)) continue;
          seen.add(id);
          const joined = ['left', 'kicked'].includes(event.old_chat_member.status);
          const member = event.new_chat_member;
          const inserted = await db.query(
            `INSERT INTO telegram_chats(id,title,kind,enabled,username,bot_member_status,bot_can_send,inviter_telegram_id,inviter_name,joined_at,left_at)
           VALUES ($1,$2,'group',false,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING RETURNING id`,
            [
              id,
              (('title' in event.chat ? event.chat.title : undefined) ?? id).slice(0, 255),
              'username' in event.chat ? (event.chat.username ?? null) : null,
              member.status,
              canSendInGroup(member),
              joined ? String(event.from.id) : null,
              joined ? event.from.first_name : null,
              joined ? new Date(event.date * 1000) : null,
              ['left', 'kicked'].includes(member.status) ? new Date(event.date * 1000) : null,
            ],
          );
          imported += inserted.length;
        }
        if (rows.length < 500) break;
        before = rows.at(-1)!.update_id;
      }
      await audit(db, req.user!.id, 'telegram.group.discover', 'groups', { imported });
      return { imported };
    },
  );
  api.get(
    '/admin/telegram/groups',
    {
      preHandler: administrator,
      schema: {
        querystring: Type.Object({
          ...Page,
          q: Type.Optional(Type.String({ maxLength: 120 })),
          status: Type.Optional(
            Type.Union([
              Type.Literal('pending'),
              Type.Literal('approved'),
              Type.Literal('rejected'),
              Type.Literal('enabled'),
              Type.Literal('disabled'),
              Type.Literal('left'),
            ]),
          ),
        }),
      },
    },
    async (req) => {
      const [items, stats] = await Promise.all([
        db.query(
          `SELECT * FROM telegram_chats WHERE kind='group'
        AND ($1::text IS NULL OR title ILIKE '%'||$1||'%' OR id=$1 OR username ILIKE '%'||$1||'%')
        AND ($2::text IS NULL OR approval_status=$2 OR $2='enabled' AND enabled AND bot_can_send AND approval_status='approved'
          OR $2='disabled' AND approval_status='approved' AND NOT enabled OR $2='left' AND bot_member_status IN ('left','kicked'))
        ORDER BY CASE approval_status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,created_at DESC,id LIMIT $3 OFFSET $4`,
          [
            req.query.q ?? null,
            req.query.status ?? null,
            req.query.limit ?? 30,
            req.query.offset ?? 0,
          ],
        ),
        db.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE approval_status='pending')::int AS pending,
        count(*) FILTER(WHERE approval_status='approved' AND enabled AND bot_can_send)::int AS enabled,
        count(*) FILTER(WHERE approval_status='rejected')::int AS rejected FROM telegram_chats WHERE kind='group'`),
      ]);
      return { items, stats: stats[0] };
    },
  );
  api.get(
    '/admin/telegram/groups/:id',
    { preHandler: administrator, schema: { params: GroupId } },
    async (req) => {
      const row = await get(req.params.id);
      return {
        ...row,
        chat_id: row.id,
        active: row.enabled && row.approval_status === 'approved' && row.bot_can_send,
        policy: policyWithDefaults(row.notification_policy),
        presets,
      };
    },
  );
  api.post(
    '/admin/telegram/groups/:id/sync',
    {
      preHandler: administrator,
      schema: { params: GroupId, body: Type.Object({}, { additionalProperties: false }) },
    },
    async (req) => {
      const { chat, member } = await liveGroup(sender, req.params.id);
      const row = await recordGroupMembership(db, chat, member);
      await audit(db, req.user!.id, 'telegram.group.sync', row.id);
      return row;
    },
  );
  api.put(
    '/admin/telegram/groups/:id',
    {
      preHandler: administrator,
      schema: {
        params: GroupId,
        body: Type.Object(
          {
            enabled: Type.Optional(Type.Boolean()),
            queryEnabled: Type.Optional(Type.Boolean()),
            guestEnabled: Type.Optional(Type.Boolean()),
            topicId: Type.Optional(GroupTopicId),
            policy: Type.Optional(NotificationPolicy),
            note: Type.Optional(Type.String({ maxLength: 1000 })),
          },
          { additionalProperties: false, minProperties: 1 },
        ),
      },
    },
    async (req) => {
      if (req.body.policy) validatePolicy(req.body.policy);
      const live = req.body.enabled ? await liveGroup(sender, req.params.id) : undefined;
      if (live && !canSendInGroup(live.member))
        throw new AppError(409, 'BOT_NOT_MEMBER', '机器人不在本群或无法发言');
      await db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7))', [req.params.id]);
        const row = required(
          (
            await tx.query<TelegramGroup>(
              "SELECT * FROM telegram_chats WHERE id=$1 AND kind='group' FOR UPDATE",
              [req.params.id],
            )
          )[0],
        );
        if (req.body.enabled && row.approval_status !== 'approved')
          throw new AppError(409, 'GROUP_APPROVAL_REQUIRED', '请先同意本群加入');
        await tx.query(
          `UPDATE telegram_chats SET enabled=$2,query_enabled=$3,guest_enabled=$4,topic_id=$5,notification_policy=$6,admin_note=$7,
        bot_member_status=$8,bot_can_send=$9,updated_at=now(),
        manager_telegram_id=CASE WHEN $10 THEN NULL ELSE manager_telegram_id END WHERE id=$1`,
          [
            row.id,
            req.body.enabled ?? row.enabled,
            req.body.queryEnabled ?? row.query_enabled,
            req.body.guestEnabled ?? row.guest_enabled,
            req.body.topicId === undefined ? row.topic_id : req.body.topicId,
            JSON.stringify(req.body.policy ?? row.notification_policy),
            req.body.note ?? row.admin_note,
            live?.member.status ?? row.bot_member_status,
            live ? canSendInGroup(live.member) : row.bot_can_send,
            Boolean(req.body.policy || req.body.enabled),
          ],
        );
        if (req.body.enabled === false) await cancelGroupNotifications(tx, row.id);
        else
          await tx.query(
            "UPDATE notifications SET available_at=now() WHERE chat_id=$1 AND audience='group' AND status='pending' AND error_code IS NULL",
            [row.id],
          );
        await audit(tx, req.user!.id, 'telegram.group.update', row.id, req.body);
      });
      const row = await get(req.params.id);
      return { active: row.enabled && row.approval_status === 'approved' && row.bot_can_send };
    },
  );
  api.post(
    '/admin/telegram/groups/:id/reopen',
    {
      preHandler: administrator,
      schema: { params: GroupId, body: Type.Object({}, { additionalProperties: false }) },
    },
    async (req) =>
      db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7))', [req.params.id]);
        const row = required(
          (
            await tx.query<TelegramGroup>(
              "SELECT * FROM telegram_chats WHERE id=$1 AND kind='group' FOR UPDATE",
              [req.params.id],
            )
          )[0],
        );
        if (row.approval_status !== 'rejected')
          throw new AppError(409, 'GROUP_STATE', '群组状态已变化，请刷新后重试');
        await tx.query(
          "UPDATE telegram_chats SET approval_status='pending',enabled=false,reviewed_by=$2,reviewed_at=now(),updated_at=now() WHERE id=$1",
          [row.id, req.user!.id],
        );
        await audit(tx, req.user!.id, 'telegram.group.reopen', row.id);
        return { ok: true };
      }),
  );
  api.post(
    '/admin/telegram/groups/:id/review',
    {
      preHandler: administrator,
      schema: {
        params: GroupId,
        body: Type.Object({ approve: Type.Boolean() }, { additionalProperties: false }),
      },
    },
    async (req) => {
      const group = await get(req.params.id);
      const live = req.body.approve ? await liveGroup(sender, req.params.id) : undefined;
      if (live && !canSendInGroup(live.member))
        throw new AppError(409, 'BOT_NOT_MEMBER', '请先把机器人加入本群并允许发言');
      await db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7))', [req.params.id]);
        await tx.query(
          `UPDATE telegram_chats SET approval_status=$2,enabled=$3,reviewed_by=$4,reviewed_at=now(),updated_at=now(),
        bot_member_status=coalesce($5,bot_member_status),bot_can_send=coalesce($6,bot_can_send),
        left_at=CASE WHEN $3 THEN NULL ELSE left_at END,
        manager_telegram_id=CASE WHEN $3 THEN NULL ELSE manager_telegram_id END WHERE id=$1 AND kind='group'`,
          [
            req.params.id,
            req.body.approve ? 'approved' : 'rejected',
            req.body.approve,
            req.user!.id,
            live?.member.status ?? null,
            live ? true : null,
          ],
        );
        if (!req.body.approve) await cancelGroupNotifications(tx, req.params.id);
        await audit(
          tx,
          req.user!.id,
          req.body.approve ? 'telegram.group.approve' : 'telegram.group.reject',
          req.params.id,
        );
      });
      if (!req.body.approve && !['left', 'kicked'].includes(group.bot_member_status)) {
        try {
          await sender.send('leaveChat', { chat_id: req.params.id });
        } catch {
          throw new AppError(502, 'GROUP_LEAVE_FAILED', '已拒绝并停用，退出群组失败，请重试');
        }
        await recordGroupMembership(
          db,
          {
            id: req.params.id,
            type: 'supergroup',
            title: group.title,
            username: group.username ?? undefined,
          },
          { status: 'left' },
        );
      }
      return { ok: true };
    },
  );
}
