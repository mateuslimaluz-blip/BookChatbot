import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from './env.js';
import * as schema from '../db/schema.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
});

// Listener de erros inesperados em conexões ociosas no pool
pool.on('error', (err) => {
  // Log sanitizado sem connection string
  console.error('[Database Pool Error] Erro inesperado em conexão ociosa:', err.message);
});

export const db = drizzle(pool, { schema });

/**
 * Executa uma verificação rápida de conectividade com o banco de dados (Readiness Check).
 *
 * @returns {Promise<boolean>} Retorna true se a conexão estiver saudável
 */
export async function checkDatabaseHealth() {
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      return true;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('[Database Health Check Failed]:', error.message);
    return false;
  }
}

/**
 * Encerra o pool de conexões com o PostgreSQL de forma graciosa.
 *
 * @returns {Promise<void>}
 */
export async function closeDatabase() {
  await pool.end();
}
