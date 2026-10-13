/**
 * Teste de estabilidade da variante C + caso "não encontrado".
 */
import { env } from '../src/config/env.js';
import { RAG_SYSTEM_INSTRUCTION } from '../src/services/aiService.js';
import { retrieveRelevantChunks, buildContextFromChunks } from '../src/services/ragService.js';

const DRACULA_ID = 'e933d2d0-5e0d-4817-80f6-98b623018429';
const BRAS_ID = '0be14b7e-0cde-4a94-9710-75b864b8306f';

function buildPrompt(contextText, query) {
  return `<CONTEXT>
${contextText.trim()}
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

async function callOllama(contextText, query) {
  const res = await fetch(`${env.OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      model: env.OLLAMA_CHAT_MODEL,
      messages: [
        { role: 'system', content: RAG_SYSTEM_INSTRUCTION },
        { role: 'user', content: buildPrompt(contextText, query) },
      ],
      format: 'json',
      stream: false,
      options: { temperature: 0.2 },
    }),
  });
  return res.json();
}

// Estabilidade: 3x Dracula
const draculaCtx = buildContextFromChunks(
  (await retrieveRelevantChunks('Quem escreveu Drácula e qual é o enredo?', { bookId: DRACULA_ID })).results
).contextText;

for (let i = 1; i <= 3; i++) {
  const data = await callOllama(draculaCtx, 'Quem escreveu Drácula e qual é o enredo?');
  const content = data?.message?.content || '';
  let parsed = null;
  try { parsed = JSON.parse(content); } catch { parsed = { raw: content }; }
  console.log(`DRACULA run ${i}: citations=${JSON.stringify(parsed.citations)} answer=${JSON.stringify((parsed.answer || content).slice(0, 120))}`);
}

// Brás Cubas
const brasCtx = buildContextFromChunks(
  (await retrieveRelevantChunks('Quem escreveu Memórias Póstumas de Brás Cubas e qual é o enredo?', { bookId: BRAS_ID })).results
).contextText;
const brasData = await callOllama(brasCtx, 'Quem escreveu Memórias Póstumas de Brás Cubas e qual é o enredo?');
let brasParsed = null;
try { brasParsed = JSON.parse(brasData?.message?.content || ''); } catch { brasParsed = { raw: brasData?.message?.content }; }
console.log(`BRÁS CUBAS: citations=${JSON.stringify(brasParsed.citations)} answer=${JSON.stringify((brasParsed.answer || '').slice(0, 120))}`);

// Caso "não encontrado" (pergunta fora do contexto de Dracula)
const notFoundData = await callOllama(draculaCtx, 'Qual é a receita de bolo de chocolate?');
let nfParsed = null;
try { nfParsed = JSON.parse(notFoundData?.message?.content || ''); } catch { nfParsed = { raw: notFoundData?.message?.content }; }
console.log(`NÃO ENCONTRADO: citations=${JSON.stringify(nfParsed.citations)} answer=${JSON.stringify((nfParsed.answer || '').slice(0, 120))}`);
