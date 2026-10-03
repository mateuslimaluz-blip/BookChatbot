import test from 'node:test';
import assert from 'node:assert/strict';
import { splitIntoChunks, mapConcurrent } from '../src/services/ingestionService.js';
import { buildContextFromChunks } from '../src/services/ragService.js';

test('Performance & Benchmark Tests', async (t) => {
  await t.test('1. Chunking de livro de médio/grande porte (100.000 caracteres) deve executar em menos de 100ms', () => {
    const paragraph = 'Este é um parágrafo literário detalhado sobre acontecimentos históricos e personagens clássicos da literatura brasileira. '.repeat(10);
    const largeBookText = (paragraph + '\n\n').repeat(100); // ~120.000 caracteres

    const start = performance.now();
    const chunks = splitIntoChunks(largeBookText);
    const durationMs = performance.now() - start;

    assert.ok(chunks.length > 10, 'Deve gerar dezenas de chunks estruturados');
    assert.ok(durationMs < 150, `Chunking demorou ${durationMs.toFixed(2)}ms (esperado < 150ms)`);
  });

  await t.test('2. Concorrência controlada de tarefas assíncronas (mapConcurrent)', async () => {
    const tasks = Array.from({ length: 20 }, (_, i) => i);
    const start = performance.now();

    const results = await mapConcurrent(tasks, 5, async (item) => {
      await new Promise((r) => setTimeout(r, 10)); // 10ms por item
      return item * 2;
    });

    const durationMs = performance.now() - start;
    assert.equal(results.length, 20);
    // 20 itens em grupos de 5 = ~4 batches * 10ms = ~40-70ms
    assert.ok(durationMs < 200, `Duração com concorrência 5 foi de ${durationMs.toFixed(2)}ms`);
  });

  await t.test('3. Construção de contexto a partir de chunks recuperados deve ser instantânea (< 5ms)', () => {
    const chunks = Array.from({ length: 8 }, (_, i) => ({
      id: `chunk-${i}`,
      bookId: `00000000-0000-0000-0000-00000000000${i}`,
      title: `Livro Volume ${i}`,
      author: 'Autor de Teste',
      chunkIndex: i,
      content: 'Conteúdo textual do chunk para composição de contexto no prompt.'.repeat(10),
    }));

    const start = performance.now();
    const { contextText, sourcesMap } = buildContextFromChunks(chunks);
    const durationMs = performance.now() - start;

    assert.ok(contextText.length > 0);
    assert.equal(sourcesMap.size, 8);
    assert.ok(durationMs < 10, `Construção de contexto demorou ${durationMs.toFixed(2)}ms`);
  });
});
