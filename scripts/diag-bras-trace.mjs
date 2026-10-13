/**
 * Traço repetido para Brás Cubas com o prompt corrigido — verifica variância do modelo.
 */
import { env } from '../src/config/env.js';
import { generateRagResponse } from '../src/services/aiService.js';
import { retrieveRelevantChunks, buildContextFromChunks } from '../src/services/ragService.js';

const BRAS_ID = '0be14b7e-0cde-4a94-9710-75b864b8306f';
const query = 'Quem escreveu Memórias Póstumas de Brás Cubas e qual é o enredo?';

const retrieval = await retrieveRelevantChunks(query, { bookId: BRAS_ID });
const { contextText, sourcesMap } = buildContextFromChunks(retrieval.results);
console.log('contexto:', contextText.length, 'chars | fontes:', sourcesMap.size);

for (let i = 1; i <= 4; i++) {
  const r = await generateRagResponse({ query, context: contextText });
  const cites = r.citations || [];
  const valid = cites.filter((c) => sourcesMap.has(c));
  const notFound = /não encontrei (essa |esta )?informação|não foi possível encontrar|informação suficiente não encontrada|não encontrei menção|não consta nas obras disponíveis|não há menção/i.test(r.answer || '');
  console.log(`run ${i}: citations=${JSON.stringify(cites)} validas=${JSON.stringify(valid)} isNotFound=${notFound}`);
  console.log(`   answer: ${JSON.stringify((r.answer || '').slice(0, 160))}`);
}
