import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { database } from './db.js';

const config = loadConfig(),
  { db, close } = database(config.databaseUrl);
const app = await buildApp(db, config);
await db.query('SELECT 1 FROM schema_migrations LIMIT 1');
app.addHook('onClose', close);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void app.close();
  });
await app.listen({ host: config.host, port: config.port });
