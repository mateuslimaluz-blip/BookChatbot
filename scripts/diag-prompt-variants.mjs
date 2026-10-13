/**
 * Experimento de prompt: testa variantes para fazer llama3.2 emitir citations.
 */
import { env } from '../src/config/env.js';
import { RAG_SYSTEM_INSTRUCTION } from '../src/services/aiService.js';
import { retrieveRelevantChunks, buildContextFromChunks } from '../src/services/ragService.js';

const DRACULA_ID = 'e933d2d0-5e0d-4817-80f6-98b623018429';
const query = 'Quem escreveu Drácula e qual é o enredo?';

const retrieval = await retrieveRelevantChunks(query, { bookId: DRACULA_ID });
const { contextText } = buildContextFromChunks(retrieval.results);

const variants = [
  {
    name: 'ATUAL (baseline)',
    userPrompt: `<CONTEXT>
${contextText.trim()}
</CONTEXT>

<USER_QUERY>
${query.trim()}
</USER_QUERY>

Com base estritamente no <CONTEXT> acima, responda à <USER_QUERY> em formato JSON com as seguintes chaves:
- "answer": string com a resposta fundamentada exclusivamente nos trechos de <CONTEXT>. Se os trechos não sustentarem a resposta, afirme claramente que não encontrou essa informação nas obras disponíveis.
- "citations": array de inteiros com os números de identificação das fontes utilizadas (ex: [1, 2]), ou array vazio [] se a informação não foi encontrada nos trechos.`,
  },
  {
    name: 'VARIANT B (instrução forte + exemplo)',
    userPrompt: `<CONTEXT>
${contextText.trim()}
</CONTEXT>

<USER_QUERY>
${query.trim()}
</USER_QUERY>

Responda à <USER_QUERY> usando APENAS os trechos de <CONTEXT>. As fontes são numeradas entre colchetes no início de cada trecho ([1], [2], [3]...).

Responda OBRIGATORIAMENTE em JSON com exatamente este formato:
{"answer": "sua resposta em português", "citations": [1, 2]}

Regras obrigatórias:
1. "citations" DEVE conter os números das fontes ([1] a [8]) cujos trechos sustentam sua resposta. Nunca deixe "citations" vazio se a resposta usar informação dos trechos.
2. Se os trechos não contiverem a informação, responda: {"answer": "Não encontrei essa informação nas obras disponíveis.", "citations": []}
3. Não use conhecimento externo.`,
  },
  {
    name: 'VARIANT C (citação inline obrigatória no texto)',
    userPrompt: `<CONTEXT>
${contextText.trim()}
</CONTEXT>

<USER_QUERY>
${query.trim()}
</USER_QUERY>

Responda à <USER_QUERY> com base APENAS nos trechos de <CONTEXT>. Cada trecho tem um número de fonte entre colchetes ([1], [2]...).

Responda em JSON: {"answer": "...", "citations": [...]}
- No campo "answer", marque cada afirmação com o número da fonte entre colchetes, ex: "O autor é Bram Stoker [1]."
- No campo "citations", liste todos os números de fonte usados, ex: [1, 3]. É obrigatório preencher citations quando a resposta se baseia nos trechos.
- Se a informação não estiver nos trechos, use {"answer": "Não encontrei essa informação nas obras disponíveis.", "citations": []}.`,
  },
];

for (const v of variants) {
  console.log(`\n===== ${v.name} =====`);
  const res = await fetch(`${env.OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      model: env.OLLAMA_CHAT_MODEL,
      messages: [
        { role: 'system', content: RAG_SYSTEM_INSTRUCTION },
        { role: 'user', content: v.userPrompt },
      ],
      format: 'json',
      stream: false,
      options: { temperature: 0.2 },
    }),
  });
  const data = await res.json();
  console.log('RAW content:', data?.message?.content);
}
