import { loadConfig } from './config.js';
import { database } from './db.js';
import { hashPassword } from './crypto.js';
import { audit } from './catalog/service.js';

const config = loadConfig(),
  email = process.env.ADMIN_EMAIL?.trim().toLowerCase(),
  password = process.env.ADMIN_PASSWORD;
if (
  !email ||
  !/^\S+@\S+\.\S+$/.test(email) ||
  !password ||
  password.length < 12 ||
  password.length > 128
)
  throw new Error(
    'Set ADMIN_EMAIL and ADMIN_PASSWORD (12–128 characters); values are never printed',
  );
const { db, close } = database(config.databaseUrl);
try {
  await db.transaction(async (tx) => {
    const [user] = await tx.query<{ id: string }>(
      "INSERT INTO users(email,password_hash,display_name,role) VALUES ($1,$2,'管理员','admin') ON CONFLICT(email) DO UPDATE SET role='admin',disabled=false,password_hash=excluded.password_hash RETURNING id",
      [email, await hashPassword(password)],
    );
    await tx.query('DELETE FROM sessions WHERE user_id=$1', [user!.id]);
    await audit(tx, user!.id, 'admin.bootstrap', user!.id);
  });
  console.log('Administrator ready');
} finally {
  await close();
}
