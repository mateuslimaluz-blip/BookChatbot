/**
 * Conta embeddings por livro no dump .sql.
 */
import { readFileSync } from 'node:fs';

const sql = readFileSync('transfer/bookchatbot_staging.sql', 'utf8');
const lines = sql.split('\n');

let inEmb = false;
const perBook = {};
for (const line of lines) {
  if (/^COPY public\.book_embeddings /.test(line)) { inEmb = true; continue; }
  if (inEmb && line.trim() === '\\.') break;
  if (inEmb && line.length > 0) {
    const bookId = line.split('\t')[1];
    perBook[bookId] = (perBook[bookId] || 0) + 1;
  }
}
console.log('=== Embeddings por book_id no dump ===');
for (const [id, n] of Object.entries(perBook)) console.log(`${id}: ${n}`);
