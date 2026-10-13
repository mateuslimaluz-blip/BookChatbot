/**
 * Validação do fluxo real — 1 chamada POST /chat por livro.
 */
const BASE = 'http://localhost:3000';
const DRACULA_ID = 'e933d2d0-5e0d-4817-80f6-98b623018429';
const BRAS_ID = '0be14b7e-0cde-4a94-9710-75b864b8306f';

async function chat(label, query, bookId) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, bookId }),
  });
  const json = await res.json();
  const ms = Date.now() - t0;
  console.log(`\n=== ${label} (${res.status}, ${ms}ms) ===`);
  console.log('answer:', JSON.stringify(json.answer));
  console.log('sources:', JSON.stringify((json.sources || []).map((s) => ({ title: s.title, chunkIndex: s.chunkIndex }))));
  return { status: res.status, json, ms };
}

const health = await fetch(`${BASE}/health`).then((r) => r.json());
console.log('health:', JSON.stringify(health));

await chat('DRACULA', 'Quem escreveu Drácula e qual é o enredo?', DRACULA_ID);
await chat('BRÁS CUBAS', 'Quem escreveu Memórias Póstumas de Brás Cubas e qual é o enredo?', BRAS_ID);
