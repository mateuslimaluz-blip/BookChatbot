import { pool } from '../src/config/db.js';
import { retrieveRelevantChunks, buildContextFromChunks } from '../src/services/ragService.js';

const BRAS_ID = '0be14b7e-0cde-4a94-9710-75b864b8306f';

const queries = [
  'Sobre o que o livro fala?',
  'Faz uma resenha do livro curta mas simples',
  'Fale sobre o Livro',
  'O que é pentateuco',
];

for (const q of queries) {
  console.log(`\n================ QUERY: "${q}" ================`);
  const retrieval = await retrieveRelevantChunks(q, { bookId: BRAS_ID });
  console.log(`Resultados retornados: ${retrieval.results.length}`);
  for (const r of retrieval.results) {
    console.log(`  Chunk #${r.chunkIndex} (sim=${r.similarity.toFixed(4)}, dist=${r.distance.toFixed(4)}): "${r.content.slice(0, 100).replace(/\n/g, ' ')}..."`);
  }
}

await pool.end();
