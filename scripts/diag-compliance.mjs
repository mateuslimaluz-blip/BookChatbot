/**
 * Mede a taxa de compliance de citations com o prompt corrigido (N runs por livro).
 */
import { env } from '../src/config/env.js';
import { generateRagResponse } from '../src/services/aiService.js';
import { retrieveRelevantChunks, buildContextFromChunks } from '../src/services/ragService.js';

const CASES = [
  { label: 'DRACULA', bookId: 'e933d2d0-5e0d-4817-80f6-98b623018429', query: 'Quem escreveu Drácula e qual é o enredo?' },
  { label: 'BRÁS CUBAS', bookId: '0be14b7e-0cde-4a94-9710-75b864b8306f', query: 'Quem escreveu Memórias Póstumas de Brás Cubas e qual é o enredo?' },
];

const RUNS = 5;

for (const c of CASES) {
  const retrieval = await retrieveRelevantChunks(c.query, { bookId: c.bookId });
  const { contextText, sourcesMap } = buildContextFromChunks(retrieval.results);
  let ok = 0, empty = 0, errors = 0;
  const details = [];
  for (let i = 1; i <= RUNS; i++) {
    try {
      const r = await generateRagResponse({ query: c.query, context: contextText });
      const cites = (r.citations || []).filter((x) => sourcesMap.has(x));
      if (cites.length > 0) { ok++; details.push(`run${i}:OK:${JSON.stringify(cites)}`); }
      else { empty++; details.push(`run${i}:EMPTY`); }
    } catch (e) {
      errors++;
      details.push(`run${i}:ERR:${e.code || e.message.slice(0, 40)}`);
    }
  }
  console.log(`${c.label}: ok=${ok}/${RUNS} empty=${empty} errors=${errors}`);
  console.log('  ', details.join(' | '));
}
