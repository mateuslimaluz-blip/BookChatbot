/**
 * Diagnóstico de inventário do banco — usa os próprios módulos do app.
 * NÃO imprime connection strings, chaves de API nem credenciais.
 */
import { db, pool } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { sql } from 'drizzle-orm';

console.log('=== AMBIENTE (sem segredos) ===');
console.log('NODE_ENV:', env.NODE_ENV);
console.log('AI_CHAT_PROVIDER:', env.AI_CHAT_PROVIDER);
console.log('OLLAMA_BASE_URL:', env.OLLAMA_BASE_URL);
console.log('OLLAMA_CHAT_MODEL:', env.OLLAMA_CHAT_MODEL);
console.log('GEMINI_API_KEY:', env.GEMINI_API_KEY ? 'SET (oculta)' : 'MISSING');
console.log('RAG_CANDIDATE_K:', env.RAG_CANDIDATE_K);
console.log('RAG_TOP_K:', env.RAG_TOP_K);
console.log('RAG_MIN_SIMILARITY:', env.RAG_MIN_SIMILARITY);
console.log('DATABASE_URL host/port/db:', (() => {
  try {
    const u = new URL(env.DATABASE_URL);
    return `${u.hostname}:${u.port}${u.pathname} (user oculto)`;
  } catch {
    return 'parse error';
  }
})());

console.log('\n=== CONECTIVIDADE ===');
const client = await pool.connect();
try {
  const idRes = await client.query('SELECT current_database(), current_user, version()');
  console.log('current_database:', idRes.rows[0].current_database);
  console.log('current_user:', idRes.rows[0].current_user);
  console.log('version:', idRes.rows[0].version);

  const extRes = await client.query(
    "SELECT extname, extversion FROM pg_extension WHERE extname='vector'"
  );
  console.log('pgvector:', extRes.rows[0] ? `${extRes.rows[0].extname} ${extRes.rows[0].extversion}` : 'NOT INSTALLED');

  const booksRes = await client.query(
    `SELECT b.id, b.title, b.author,
            (SELECT count(*) FROM book_embeddings be WHERE be.book_id = b.id) AS n_embeddings,
            (SELECT j.status FROM ingestion_jobs j WHERE j.book_id = b.id ORDER BY j.created_at DESC LIMIT 1) AS job_status
     FROM books b ORDER BY b.title ASC`
  );
  console.log('\n=== LIVROS ===');
  for (const r of booksRes.rows) {
    console.log(`- id=${r.id} | "${r.title}" — ${r.author} | embeddings=${r.n_embeddings} | job=${r.job_status}`);
  }

  const totalEmb = await client.query('SELECT count(*) AS c FROM book_embeddings');
  console.log('\nTotal embeddings:', totalEmb.rows[0].c);
} finally {
  client.release();
  await pool.end();
}
