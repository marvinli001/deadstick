import { loadConfig } from './config.js';
import { database } from './db.js';
import { bootstrapAdmin } from './auth/bootstrap.js';

const config = loadConfig();
const { db, close } = database(config.databaseUrl);
try {
  await bootstrapAdmin(db, process.env);
  console.log('Administrator ready');
} finally {
  await close();
}
