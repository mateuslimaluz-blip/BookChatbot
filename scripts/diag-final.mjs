/**
 * Verificação final: guarda anti-alucinação + repro completo.
 */
const BASE = 'http://localhost:3000';
const DRACULA_ID = 'e933d2d0-5e0d-4817-80f6-98b623018429';

async function chat(query, bookId) {
  const res = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, bookId }),
  });
  return { status: res.status, json: await res.json() };
}

// 1. Pergunta fora do contexto (guarda anti-alucinação deve preservar "não encontrei")
const nf = await chat('Qual é a receita de bolo de chocolate?', DRACULA_ID);
console.log('=== GUARDA ANTI-ALUCINAÇÃO (fora do contexto) ===');
console.log('status:', nf.status);
console.log('answer:', JSON.stringify(nf.json.answer));
console.log('sources:', JSON.stringify(nf.json.sources));

// 2. Pergunta principal
const ok = await chat('Quem escreveu Drácula e qual é o enredo?', DRACULA_ID);
console.log('\n=== PERGUNTA PRINCIPAL DRACULA ===');
console.log('status:', ok.status);
console.log('answer:', JSON.stringify(ok.json.answer));
console.log('sources:', JSON.stringify(ok.json.sources.map(s => ({ title: s.title, chunkIndex: s.chunkIndex }))));
