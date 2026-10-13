/**
 * Reprodução do fluxo real: frontend → POST /chat
 * Mostra IDs, chunkIndex e scores (sem chaves/credenciais).
 */
const BASE = 'http://localhost:3000';

async function jfetch(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { Accept: 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* não-json */ }
  return { status: res.status, json, text };
}

const QUERY_DRACULA = 'Quem escreveu Drácula e qual é o enredo?';
const QUERY_BRAS = 'Quem escreveu Memórias Póstumas de Brás Cubas e qual é o enredo?';

// 1. Health
const health = await jfetch('/health');
console.log('=== /health ===', health.status, JSON.stringify(health.json).slice(0, 200));

// 2. Lista de livros (o que o frontend usa para montar o seletor de contexto)
const booksRes = await jfetch('/books?page=1&limit=100');
const books = booksRes.json?.books || [];
console.log('\n=== /books ===', booksRes.status);
for (const b of books) {
  console.log(`- id=${b.id} | "${b.title}" — ${b.author} | hasEmbeddings=${b.hasEmbeddings}`);
}
const dracula = books.find((b) => /dracula/i.test(b.title || ''));
const bras = books.find((b) => /memórias póstumas|bras cubas/i.test(b.title || ''));
if (!dracula || !bras) {
  console.log('!! Livros não encontrados via API');
  process.exit(1);
}

async function diagnose(label, query, book) {
  console.log(`\n================ ${label} ================`);
  console.log('bookId enviado pelo frontend:', book.id);
  console.log('query:', JSON.stringify(query));

  // 3. Busca vetorial bruta (POST /chat/search) — candidatos filtrados pelo limiar
  const search = await jfetch('/chat/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, bookId: book.id }),
  });
  console.log('\n--- POST /chat/search (bookId filtrado) ---');
  console.log('status:', search.status);
  const results = search.json?.results || [];
  console.log('totalResults (após filtro de similaridade):', search.json?.totalResults);
  for (const r of results) {
    console.log(
      `  id=${r.id} chunkIndex=${r.chunkIndex} sim=${r.similarity?.toFixed?.(4)} dist=${r.distance?.toFixed?.(4)} | "${(r.title || '')}" | trecho=${(r.content || '').slice(0, 80).replace(/\n/g, ' ')}...`
    );
  }

  // 3b. Mesma busca SEM bookId (Acervo Geral) para comparar limiar
  const searchGlobal = await jfetch('/chat/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  console.log('\n--- POST /chat/search (acervo geral, sem bookId) ---');
  console.log('status:', searchGlobal.status);
  const resultsG = searchGlobal.json?.results || [];
  console.log('totalResults:', searchGlobal.json?.totalResults);
  for (const r of resultsG) {
    console.log(
      `  id=${r.id} chunkIndex=${r.chunkIndex} sim=${r.similarity?.toFixed?.(4)} | "${(r.title || '')}" | trecho=${(r.content || '').slice(0, 60).replace(/\n/g, ' ')}...`
    );
  }

  // 4. POST /chat — fluxo completo até o Ollama
  const chat = await jfetch('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, bookId: book.id }),
  });
  console.log('\n--- POST /chat ---');
  console.log('status:', chat.status);
  console.log('answer:', JSON.stringify(chat.json?.answer || chat.json?.error));
  console.log('sources:', JSON.stringify(chat.json?.sources || null));
}

await diagnose('DRACULA', QUERY_DRACULA, dracula);
await diagnose('BRÁS CUBAS', QUERY_BRAS, bras);
