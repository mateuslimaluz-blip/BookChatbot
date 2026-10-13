import { pool } from '../src/config/db.js';

const res = await pool.query(`
  SELECT chunk_index, content
  FROM book_embeddings
  WHERE book_id = '0be14b7e-0cde-4a94-9710-75b864b8306f' AND chunk_index IN (0, 1, 2, 3, 81)
  ORDER BY chunk_index
`);

for (const r of res.rows) {
  console.log(`\n================ CHUNK ${r.chunk_index} (${r.content.length} chars) ================`);
  console.log(r.content);
}

await pool.end();
