import type { DB } from '../db.js';
import { hashPassword } from '../crypto.js';
import { audit } from '../catalog/service.js';

export async function bootstrapAdmin(db: DB, env: NodeJS.ProcessEnv) {
  const telegramId = env.ADMIN_TELEGRAM_ID?.trim();
  const email = env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = env.ADMIN_PASSWORD;
  if (telegramId) {
    if (!/^[1-9][0-9]{0,15}$/.test(telegramId) || !Number.isSafeInteger(Number(telegramId)))
      throw new Error('ADMIN_TELEGRAM_ID must be a positive Telegram user ID');
    if (email || password)
      throw new Error('Use ADMIN_TELEGRAM_ID or ADMIN_EMAIL + ADMIN_PASSWORD, not both');
  } else if (
    !email ||
    !/^\S+@\S+\.\S+$/.test(email) ||
    !password ||
    password.length < 12 ||
    password.length > 128
  ) {
    throw new Error('Set ADMIN_TELEGRAM_ID or ADMIN_EMAIL and ADMIN_PASSWORD (12–128 characters)');
  }
  const passwordHash = telegramId ? null : await hashPassword(password!);
  await db.transaction(async (tx) => {
    const [user] = telegramId
      ? await tx.query<{ id: string }>(
          "INSERT INTO users(telegram_id,display_name,role) VALUES ($1,'管理员','admin') ON CONFLICT(telegram_id) DO UPDATE SET role='admin',disabled=false RETURNING id",
          [telegramId],
        )
      : await tx.query<{ id: string }>(
          "INSERT INTO users(email,password_hash,display_name,role) VALUES ($1,$2,'管理员','admin') ON CONFLICT(email) DO UPDATE SET role='admin',disabled=false,password_hash=excluded.password_hash RETURNING id",
          [email, passwordHash],
        );
    await tx.query('DELETE FROM sessions WHERE user_id=$1', [user!.id]);
    await audit(tx, user!.id, 'admin.bootstrap', user!.id, {
      via: telegramId ? 'telegram' : 'email',
    });
  });
}
