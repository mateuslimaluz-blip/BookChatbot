/**
 * Captura respostas RAW do Ollama para Brás Cubas (prompt corrigido).
 */
import { env } from '../src/config/env.js';
import { RAG_SYSTEM_INSTRUCTION } from '../src/services/aiService.js';
import { retrieveRelevantChunks, buildContextFromChunks } from '../src/services/ragService.js';

const BRAS_ID = '0be14b7e-0cde-4a94-9710-75b864b8306f';
const query = 'Quem escreveu Memórias Póstumas de Brás Cubas e qual é o enredo?';

const retrieval = await retrieveRelevantChunks(query, { bookId: BRAS_ID });
const { contextText } = buildContextFromChunks(retrieval.results);

const prompt = `<CONTEXT>
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

for (let i = 1; i <= 3; i++) {
  const t0 = Date.now();
  const res = await fetch(`${env.OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      model: env.OLLAMA_CHAT_MODEL,
      messages: [
        { role: 'system', content: RAG_SYSTEM_INSTRUCTION },
        { role: 'user', content: prompt },
      ],
      format: 'json',
      stream: false,
      options: { temperature: 0.2 },
    }),
  });
  const data = await res.json();
  const ms = Date.now() - t0;
  console.log(`\n===== run ${i} (${ms}ms, done_reason=${data.done_reason}) =====`);
  console.log('content:', JSON.stringify(data?.message?.content));
  console.log('eval_count:', data.eval_count, 'prompt_eval_count:', data.prompt_eval_count);
}
