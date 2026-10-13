import test from 'node:test';
import assert from 'node:assert/strict';
import { generateOllamaRagResponse } from '../src/services/ollamaService.js';

/**
 * Testes direcionados (mocks) para a nova tentativa limitada
 * de generateOllamaRagResponse. Sem chamadas reais a Ollama.
 */

const okResponse = (content) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => ({ message: { role: 'assistant', content } }),
});

function mockFetch(responses) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    const next = responses[calls.length - 1];
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(calls.length);
    return next;
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

test('Ollama retry limitado (mocks)', async (t) => {
  await t.test('repete UMA vez quando a 1ª resposta vem sem citations e recupera', async () => {
    const m = mockFetch([
      okResponse(JSON.stringify({ answer: 'eco da pergunta', citations: [] })),
      okResponse(JSON.stringify({ answer: 'Machado de Assis escreveu a obra [1].', citations: [1] })),
    ]);
    try {
      const result = await generateOllamaRagResponse({
        query: 'Quem escreveu a obra?',
        context: '[1] Livro: X\nAutor: Y\nChunk: 0\nTexto:\nconteúdo',
        options: { timeoutMs: 60_000 },
      });
      assert.deepEqual(result.citations, [1]);
      assert.equal(m.calls.length, 2);
    } finally {
      m.restore();
    }
  });

  await t.test('NÃO repete quando a resposta já tem citations', async () => {
    const m = mockFetch([
      okResponse(JSON.stringify({ answer: 'Resposta [2].', citations: [2] })),
    ]);
    try {
      const result = await generateOllamaRagResponse({
        query: 'Q?',
        context: '[1] Livro: X\nAutor: Y\nChunk: 0\nTexto:\nconteúdo',
        options: { timeoutMs: 60_000 },
      });
      assert.deepEqual(result.citations, [2]);
      assert.equal(m.calls.length, 1);
    } finally {
      m.restore();
    }
  });

  await t.test('NÃO repete quando a resposta declara que não encontrou a informação', async () => {
    const m = mockFetch([
      okResponse(JSON.stringify({
        answer: 'Não encontrei essa informação nas obras disponíveis.',
        citations: [],
      })),
    ]);
    try {
      const result = await generateOllamaRagResponse({
        query: 'Qual é a receita de bolo?',
        context: '[1] Livro: X\nAutor: Y\nChunk: 0\nTexto:\nconteúdo',
        options: { timeoutMs: 60_000 },
      });
      assert.deepEqual(result.citations, []);
      assert.match(result.answer, /não encontrei/i);
      assert.equal(m.calls.length, 1);
    } finally {
      m.restore();
    }
  });

  await t.test('NÃO repete quando a 1ª tentativa foi lenta demais (orçamento de timeout)', async () => {
    const slowThenEmpty = async () => {
      // 600ms: acima do gate (timeoutMs/2 = 500ms) e abaixo do abort (1000ms)
      await new Promise((r) => setTimeout(r, 600));
      return okResponse(JSON.stringify({ answer: 'lenta', citations: [] }));
    };
    const m = mockFetch([slowThenEmpty]);
    try {
      const result = await generateOllamaRagResponse({
        query: 'Q?',
        context: '[1] Livro: X\nAutor: Y\nChunk: 0\nTexto:\nconteúdo',
        options: { timeoutMs: 1000 },
      });
      assert.deepEqual(result.citations, []);
      assert.equal(m.calls.length, 1);
    } finally {
      m.restore();
    }
  });

  await t.test('se a nova tentativa falhar, devolve a 1ª resposta sem lançar erro', async () => {
    const m = mockFetch([
      okResponse(JSON.stringify({ answer: 'primeira', citations: [] })),
      new Error('O serviço Ollama está desligado'),
    ]);
    try {
      const result = await generateOllamaRagResponse({
        query: 'Q?',
        context: '[1] Livro: X\nAutor: Y\nChunk: 0\nTexto:\nconteúdo',
        options: { timeoutMs: 60_000 },
      });
      assert.equal(result.answer, 'primeira');
      assert.deepEqual(result.citations, []);
      assert.equal(m.calls.length, 2);
    } finally {
      m.restore();
    }
  });

  await t.test('erros de indisponibilidade na 1ª tentativa continuam lançando', async () => {
    const m = mockFetch([new Error('O serviço Ollama está desligado ou inacessível')]);
    try {
      await assert.rejects(
        () =>
          generateOllamaRagResponse({
            query: 'Q?',
            context: '[1] Livro: X\nAutor: Y\nChunk: 0\nTexto:\nconteúdo',
            options: { timeoutMs: 60_000 },
          }),
        /desligado ou inacessível/
      );
      assert.equal(m.calls.length, 1);
    } finally {
      m.restore();
    }
  });
});
