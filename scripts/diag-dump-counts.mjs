/**
 * Conta linhas de dados dos blocos COPY do dump .sql (sem expor dados sensíveis).
 */
import { readFileSync } from 'node:fs';

const sql = readFileSync('transfer/bookchatbot_staging.sql', 'utf8');
const lines = sql.split('\n');

const tables = ['books', 'book_embeddings', 'ingestion_jobs', 'ingestion_job_chunks'];
const counts = {};
let current = null;

for (const line of lines) {
  const m = line.match(/^COPY public\.(\w+)/);
  if (m) {
    current = m[1];
    counts[current] = 0;
    continue;
  }
  if (current && line.trim() === '\\.') {
    current = null;
    continue;
  }
  if (current && line.length > 0) {
    counts[current]++;
  }
}

console.log('=== Dump .sql — linhas por tabela ===');
for (const t of tables) {
  console.log(`${t}: ${counts[t] ?? 'n/a'}`);
}

// Títulos dos livros no dump (primeiro campo do COPY de books: id, title, author...)
console.log('\n=== Livros no dump (id | título | autor) ===');
let inBooks = false;
for (const line of lines) {
  if (/^COPY public\.books /.test(line)) { inBooks = true; continue; }
  if (inBooks && line.trim() === '\\.') break;
  if (inBooks && line.length > 0) {
    const parts = line.split('\t');
    console.log(`${parts[0]} | ${parts[1]} | ${parts[2]}`);
  }
}
