/**
 * Diagnóstico etapa-por-etapa do executeRagChat com logs detalhados.
 * Usa os serviços reais (Gemini embedding + Ollama llama3.2).
 */
import {
  retrieveRelevantChunks,
  buildContextFromChunks,
  NO_CONTEXT_FALLBACK_ANSWER,
} from '../src/services/ragService.js';
import { generateRagResponse, parseRagModelResponse } from '../src/services/aiService.js';
import { env } from '../src/config/env.js';

const DRACULA_ID = 'e933d2d0-5e0d-4817-80f6-98b623018429';
const BRAS_ID = '0be14b7e-0cde-4a94-9710-75b864b8306f';

async function trace(label, query, bookId) {
  console.log(`\n================ ${label} ================`);
  console.log('provider:', env.AI_CHAT_PROVIDER, '| ollama model:', env.OLLAMA_CHAT_MODEL);

  // Etapa 1: retrieval
  const t0 = Date.now();
  const retrieval = await retrieveRelevantChunks(query, { bookId });
  console.log(`[1] retrieveRelevantChunks: ${retrieval.results.length} resultados em ${Date.now() - t0}ms`);
  for (const r of retrieval.results) {
    console.log(`    id=${r.id} chunkIndex=${r.chunkIndex} sim=${r.similarity.toFixed(4)} title="${r.title}"`);
  }

  // Etapa 2: contexto
  const { contextText, sourcesMap } = buildContextFromChunks(retrieval.results);
  console.log(`[2] buildContextFromChunks: contexto com ${contextText.length} chars, ${sourcesMap.size} fontes`);
  console.log('    fontes map:', JSON.stringify([...sourcesMap.entries()].map(([k, v]) => ({ k, bookId: v.bookId, chunkIndex: v.chunkIndex }))));

  // Etapa 3: chamada ao Ollama (RAW)
  const t1 = Date.now();
  const modelResponse = await generateRagResponse({ query, context: contextText });
  console.log(`[3] generateRagResponse (Ollama) em ${Date.now() - t1}ms`);
  console.log('    RAW answer:', JSON.stringify(modelResponse.answer));
  console.log('    RAW citations:', JSON.stringify(modelResponse.citations));

  // Etapa 4: simulação da validação de citações do executeRagChat
  const candidateCitationIds = [...(modelResponse.citations || [])];
  let extraInline = [];
  if (candidateCitationIds.length === 0 && modelResponse.answer) {
    extraInline = [...modelResponse.answer.matchAll(/\[(?:fonte\s*)?(\d+)\]/gi)].map((m) => parseInt(m[1], 10));
  }
  console.log('[4] candidateCitationIds:', JSON.stringify(candidateCitationIds), '| inline matches:', JSON.stringify(extraInline));

  const validated = [];
  for (const id of [...candidateCitationIds, ...extraInline]) {
    if (sourcesMap.has(id)) validated.push(id);
    else if (id === 0 && sourcesMap.has(1)) validated.push(1);
  }
  console.log('    validated sourceIds:', JSON.stringify(validated));

  const isNotFoundAnswer =
    /não encontrei (essa |esta )?informação|não foi possível encontrar|informação suficiente não encontrada|não encontrei menção|não consta nas obras disponíveis|não há menção/i.test(
      modelResponse.answer || ''
    );
  console.log('    isNotFoundAnswer:', isNotFoundAnswer);

  let finalAnswer, finalSources;
  if (isNotFoundAnswer) {
    finalAnswer = modelResponse.answer; finalSources = [];
  } else if (validated.length > 0) {
    finalAnswer = modelResponse.answer; finalSources = validated;
  } else {
    finalAnswer = NO_CONTEXT_FALLBACK_ANSWER; finalSources = [];
  }
  console.log('    → finalAnswer:', JSON.stringify(finalAnswer).slice(0, 300));
  console.log('    → finalSources:', JSON.stringify(finalSources));
  console.log('    → fallback aplicado?', finalAnswer === NO_CONTEXT_FALLBACK_ANSWER);
}

await trace('DRACULA', 'Quem escreveu Drácula e qual é o enredo?', DRACULA_ID);
await trace('BRÁS CUBAS', 'Quem escreveu Memórias Póstumas de Brás Cubas e qual é o enredo?', BRAS_ID);
