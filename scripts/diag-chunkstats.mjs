/**
 * Estatísticas de chunks por livro (tamanho dos trechos).
 */
import { pool } from '../src/config/db.js';

const client = await pool.connect();
try {
  const res = await client.query(
    `SELECT b.title,
            count(*) AS n,
            min(length(be.content)) AS min_len,
            max(length(be.content)) AS max_len,
            round(avg(length(be.content))) AS avg_len,
            min(be.chunk_index) AS min_idx,
            max(be.chunk_index) AS max_idx
     FROM book_embeddings be
     JOIN books b ON b.id = be.book_id
     GROUP BY b.title ORDER BY b.title`
  );
  for (const r of res.rows) {
    console.log(`${r.title}: n=${r.n} idx=[${r.min_idx}..${r.max_idx}] len min/avg/max = ${r.min_len}/${r.avg_len}/${r.max_len}`);
  }
  // Brás Cubas chunk 0 e 1 completos (primeiros 300 chars)
  const bras = await client.query(
    `SELECT chunk_index, left(content, 300) AS head FROM book_embeddings
     WHERE book_id = '0be14b7e-0cde-4a94-9710-75b864b8306f' AND chunk_index IN (0,1,2)
     ORDER BY chunk_index`
  );
  console.log('\nBrás Cubas primeiros chunks:');
  for (const r of bras.rows) {
    console.log(`[chunk ${r.chunk_index}] ${JSON.stringify(r.head)}`);
  }
} finally {
  client.release();
  await pool.end();
}
