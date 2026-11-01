import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { database, type DB } from './db.js';

export async function migrate(db: DB) {
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(73912681)');
    await tx.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = new Set(
      (await tx.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name),
    );
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter((f) => f.endsWith('.sql')).sort()) {
      if (applied.has(name)) continue;
      await tx.query(await readFile(new URL(name, directory), 'utf8'));
      await tx.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { db, close } = database(process.env.DATABASE_URL ?? 'postgres://localhost:5432/deadstick');
  try {
    await migrate(db);
    console.log('Migrations applied');
  } finally {
    await close();
  }
}
