/**
 * Chamada RAW ao Ollama /api/chat com o payload exato do ollamaService.
 */
import { env } from '../src/config/env.js';
import { RAG_SYSTEM_INSTRUCTION } from '../src/services/aiService.js';
import { retrieveRelevantChunks, buildContextFromChunks } from '../src/services/ragService.js';

const DRACULA_ID = 'e933d2d0-5e0d-4817-80f6-98b623018429';
const query = 'Quem escreveu Drácula e qual é o enredo?';

const retrieval = await retrieveRelevantChunks(query, { bookId: DRACULA_ID });
const { contextText } = buildContextFromChunks(retrieval.results);

const prompt = `<CONTEXT>
${contextText.trim()}
</CONTEXT>

<USER_QUERY>
${query.trim()}
</USER_QUERY>

Com base estritamente no <CONTEXT> acima, responda à <USER_QUERY> em formato JSON com as seguintes chaves:
- "answer": string com a resposta fundamentada exclusivamente nos trechos de <CONTEXT>. Se os trechos não sustentarem a resposta, afirme claramente que não encontrou essa informação nas obras disponíveis.
- "citations": array de inteiros com os números de identificação das fontes utilizadas (ex: [1, 2]), ou array vazio [] se a informação não foi encontrada nos trechos.`;

const body = {
  model: env.OLLAMA_CHAT_MODEL,
  messages: [
    { role: 'system', content: RAG_SYSTEM_INSTRUCTION },
    { role: 'user', content: prompt },
  ],
  format: 'json',
  stream: false,
  options: { temperature: 0.2 },
};

console.log('Enviando para Ollama...');
const res = await fetch(`${env.OLLAMA_BASE_URL}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify(body),
});
console.log('HTTP', res.status);
const raw = await res.text();
console.log('RAW RESPONSE BODY:');
console.log(raw);
