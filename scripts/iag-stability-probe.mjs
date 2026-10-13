/**
 * FASE 2 — Sonda de instabilidade do Brás Cubas.
 * - 1 recuperação real (Gemini) para Brás Cubas, contexto salvo em temp
 * - Contexto de Dracula montado direto do banco (primeiros 8 chunks, SEM Gemini)
 * - Probes diretos no Ollama: latência, citations, eco, eficácia de 1 nova tentativa
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '../src/config/env.js';
import { pool } from '../src/config/db.js';
import { RAG_SYSTEM_INSTRUCTION, parseRagModelResponse } from '../src/services/aiService.js';
import { retrieveRelevantChunks, buildContextFromChunks } from '../src/services/ragService.js';

const BRAS_ID = '0be14b7e-0cde-4a94-9710-75b864b8306f';
const DRACULA_ID = 'e933d2d0-5e0d-4817-80f6-98b623018429';
const QUERY_BRAS = 'Quem escreveu Memórias Póstumas de Brás Cubas e qual é o enredo?';
const QUERY_DRACULA = 'Quem escreveu Drácula e qual é o enredo?';

const ctxDir = join(tmpdir(), 'opencode', 'ragctx');
mkdirSync(ctxDir, { recursive: true });
const brasCtxFile = join(ctxDir, 'bras-context.txt');
const draculaCtxFile = join(ctxDir, 'dracula-context.txt');

// --- 1. Contexto do Brás Cubas: 1 recuperação real (Gemini) ou cache em temp ---
let brasContext;
if (existsSync(brasCtxFile)) {
  brasContext = readFileSync(brasCtxFile, 'utf8');
  console.log('[Brás Cubas] contexto carregado do cache temp (sem nova chamada Gemini)');
} else {
  const retrieval = await retrieveRelevantChunks(QUERY_BRAS, { bookId: BRAS_ID });
  const built = buildContextFromChunks(retrieval.results);
  brasContext = built.contextText;
  writeFileSync(brasCtxFile, brasContext);
  console.log(`[Brás Cubas] 1 recuperação real (Gemini): ${retrieval.results.length} trechos, contexto ${brasContext.length} chars`);
}

// --- 2. Contexto de Dracula: montado direto do banco (SEM Gemini) ---
let draculaContext;
if (existsSync(draculaCtxFile)) {
  draculaContext = readFileSync(draculaCtxFile, 'utf8');
  console.log('[Drácula] contexto carregado do cache temp');
} else {
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT be.id, be.book_id AS "bookId", b.title, b.author, be.chunk_index AS "chunkIndex", be.content
       FROM book_embeddings be JOIN books b ON b.id = be.book_id
       WHERE be.book_id = $1 ORDER BY be.chunk_index LIMIT 8`,
      [DRACULA_ID]
    );
    const chunks = res.rows.map((r) => ({
      id: r.id, bookId: r.bookId, title: r.title, author: r.author,
      chunkIndex: r.chunkIndex, content: r.content, similarity: 0.7,
    }));
    draculaContext = buildContextFromChunks(chunks).contextText;
    writeFileSync(draculaCtxFile, draculaContext);
    console.log(`[Drácula] contexto montado do banco (sem Gemini): ${draculaContext.length} chars`);
  } finally {
    client.release();
  }
}

// --- 3. Probes diretos no Ollama ---
function buildPrompt(context, query) {
  return `<CONTEXT>
${context.trim()}
</CONTEXT>

<USER_QUERY>
${query.trim()}
</USER_QUERY>

Responda à <USER_QUERY> com base APENAS nos trechos de <CONTEXT>. Cada trecho tem um número de fonte entre colchetes ([1], [2]...).

Responda em JSON: {"answer": "...", "citations": [...]}
- No campo "answer", marque cada afirmação com o número da fonte entre colchetes, ex: "O autor é Bram Stoker [1]."
- No campo "citations", liste todos os números de fonte usados, ex: [1, 3]. É obrigatório preencher citations quando a resposta se baseia nos trechos.
- Se a informação não estiver nos trechos, use {"answer": "Não encontrei essa informação nas obras disponíveis.", "citations": []}.`;
}

const NOT_FOUND_RE = /não encontrei (essa |esta )?informação|não foi possível encontrar|informação suficiente não encontrada|não encontrei menção|não consta nas obras disponíveis|não há menção/i;

async function callOllama(context, query) {
  const t0 = Date.now();
  const res = await fetch(`${env.OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      model: env.OLLAMA_CHAT_MODEL,
      messages: [
        { role: 'system', content: RAG_SYSTEM_INSTRUCTION },
        { role: 'user', content: buildPrompt(context, query) },
      ],
      format: 'json',
      stream: false,
      options: { temperature: 0.2 },
    }),
  });
  const data = await res.json();
  return { ms: Date.now() - t0, content: data?.message?.content || '' };
}

function classify(raw) {
  const parsed = parseRagModelResponse(raw);
  const cites = (parsed.citations || []);
  const normAnswer = (parsed.answer || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const normQuery = QUERY_BRAS.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const echo = normAnswer.length > 0 && normQuery.length > 0 && normAnswer.includes(normQuery.slice(0, 30));
  return {
    ms: parsed._ms,
    citations: cites,
    nCitations: cites.length,
    echo,
    notFound: NOT_FOUND_RE.test(parsed.answer || ''),
    answerHead: (parsed.answer || '').slice(0, 90),
  };
}

async function probeBook(label, context, query) {
  console.log(`\n===== ${label} — 6 probes (com 1 nova tentativa simulada quando citations vazio) =====`);
  let firstOk = 0, firstEmpty = 0, retryOk = 0, retryStillEmpty = 0, errors = 0;
  const latencies = [];
  for (let i = 1; i <= 6; i++) {
    let r;
    try {
      r = await callOllama(context, query);
    } catch (e) {
      errors++;
      console.log(`  run ${i}: ERRO ${e.code || e.message.slice(0, 50)}`);
      continue;
    }
    const parsed = parseRagModelResponse(r.content);
    const cites = (parsed.citations || []);
    const normA = (parsed.answer || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const normQ = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const echo = normA.includes(normQ.slice(0, 30));
    const notFound = NOT_FOUND_RE.test(parsed.answer || '');
    latencies.push(r.ms);
    console.log(`  run ${i}: ${r.ms}ms | citations=${JSON.stringify(cites)} | eco=${echo} | notFound=${notFound} | "${(parsed.answer || '').slice(0, 70)}"`);

    if (cites.length > 0) { firstOk++; continue; }
    firstEmpty++;
    // nova tentativa limitada (1x), apenas se não declarou "não encontrou"
    if (!notFound) {
      try {
        const r2 = await callOllama(context, query);
        const p2 = parseRagModelResponse(r2.content);
        const cites2 = (p2.citations || []);
        latencies.push(r2.ms);
        console.log(`    └ retry: ${r2.ms}ms | citations=${JSON.stringify(cites2)} | "${(p2.answer || '').slice(0, 70)}"`);
        if (cites2.length > 0) retryOk++; else retryStillEmpty++;
      } catch (e) {
        errors++;
        console.log(`    └ retry: ERRO ${e.code || e.message.slice(0, 50)}`);
      }
    }
  }
  const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const max = latencies.length ? Math.max(...latencies) : 0;
  console.log(`  RESUMO ${label}: 1ª tentativa com citations=${firstOk}/6, vazias=${firstEmpty}/6; retry recuperou ${retryOk}, ainda vazias ${retryStillEmpty}; erros=${errors}; latência média=${avg}ms, máx=${max}ms`);
}

await probeBook('DRACULA', draculaContext, QUERY_DRACULA);
await probeBook('BRÁS CUBAS', brasContext, QUERY_BRAS);

await pool.end();
