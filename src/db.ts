import pg, { type QueryResultRow } from 'pg';

export interface DB {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (tx: DB) => Promise<T>): Promise<T>;
}

export function database(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 12,
    connectionTimeoutMillis: 5000,
    options: '-c timezone=UTC -c statement_timeout=30000',
  });
  pool.on('error', (error) =>
    console.error(JSON.stringify({ event: 'database_connection_error', type: error.name })),
  );
  const db: DB = {
    query: async (text, values) => (await pool.query(text, values)).rows,
    async transaction(fn) {
      const client = await pool.connect();
      const tx: DB = {
        query: async (text, values) => (await client.query(text, values)).rows,
        transaction: () => {
          throw new Error('Nested transactions are not supported');
        },
      };
      try {
        await client.query('BEGIN');
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
  return { db, close: () => pool.end() };
}
