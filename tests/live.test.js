import test from 'node:test';
import assert from 'node:assert/strict';
import { generateEmbedding, generateRagResponse } from '../src/services/aiService.js';
import { checkDatabaseHealth } from '../src/config/db.js';

const RUN_LIVE_TESTS = process.env.RUN_LIVE_TESTS === 'true';

test('Live Gemini & Database Integration (Opt-in via RUN_LIVE_TESTS=true)', { skip: !RUN_LIVE_TESTS }, async (t) => {
  await t.test('1. Conectividade real com PostgreSQL', async () => {
    const isDbConnected = await checkDatabaseHealth();
    assert.equal(isDbConnected, true, 'PostgreSQL deve responder a queries SELECT 1');
  });

  await t.test('2. Geração real de embedding via gemini-embedding-2 (768 dimensões)', async () => {
    const vector = await generateEmbedding('Teste live de embedding para o BookChatbot');
    assert.ok(Array.isArray(vector));
    assert.equal(vector.length, 768);
    for (const val of vector) {
      assert.equal(typeof val, 'number');
      assert.ok(Number.isFinite(val));
    }
  });

  await t.test('3. Geração real de resposta RAG via Gemini generativo', async () => {
    const context = `[1] Livro: Dom Casmurro\nAutor: Machado de Assis\nChunk: 0\nTexto: Capitu tinha olhos de cigana oblíqua e dissimulada.`;
    const query = 'Como são descritos os olhos de Capitu?';

    const result = await generateRagResponse({ query, context });
    assert.ok(result.answer);
    assert.ok(Array.isArray(result.citations));
    assert.match(result.answer, /cigana|oblíqua|dissimulada/i);
  });
});
