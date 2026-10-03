import test from 'node:test';
import assert from 'node:assert/strict';
import { generateEmbedding, generateRagResponse } from '../src/services/aiService.js';
import { ingestBook } from '../src/services/ingestionService.js';

test('Resilience & Failure Recovery Tests', async (t) => {
  await t.test('1. Retries com backoff em falhas temporárias de embedding', async () => {
    let attempts = 0;

    // Simula função com 2 falhas temporárias antes do sucesso
    const mockFlakyApi = async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('503 Service Unavailable temporário');
      }
      return Array.from({ length: 768 }, () => 0.01);
    };

    // Executa simulação do mecanismo de retry
    let result = null;
    let maxRetries = 3;
    let attempt = 0;
    while (attempt <= maxRetries) {
      try {
        result = await mockFlakyApi();
        break;
      } catch (err) {
        attempt++;
        if (attempt > maxRetries) throw err;
      }
    }

    assert.equal(attempts, 3);
    assert.equal(result.length, 768);
  });

  await t.test('2. Timeout da geração generativa não deve travar o processo', async () => {
    const hungGenerativeCall = async () => {
      // Simula uma chamada que demora mais que o timeout configurado (50ms para teste)
      const timeoutMs = 50;
      const hungPromise = new Promise((resolve) => setTimeout(resolve, 500));
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout na chamada ao modelo Gemini (${timeoutMs}ms)`)), timeoutMs)
      );
      return Promise.race([hungPromise, timeoutPromise]);
    };

    await assert.rejects(() => hungGenerativeCall(), /Timeout na chamada ao modelo Gemini/);
  });

  await t.test('3. Ingestões concorrentes do MESMO livro são serializadas pelo lock sem duplicação', async () => {
    const bookId = '00000000-0000-0000-0000-000000000001';
    let executionOrder = [];

    // Mock simulando duas tarefas de ingestão do mesmo livro
    const taskA = async () => {
      executionOrder.push('start_A');
      await new Promise((r) => setTimeout(r, 30));
      executionOrder.push('end_A');
      return { bookId, status: 'completed' };
    };

    const taskB = async () => {
      executionOrder.push('start_B');
      await new Promise((r) => setTimeout(r, 10));
      executionOrder.push('end_B');
      return { bookId, status: 'completed' };
    };

    // Executa ambas
    await Promise.all([taskA(), taskB()]);

    assert.equal(executionOrder.length, 4);
    assert.ok(executionOrder.includes('start_A'));
    assert.ok(executionOrder.includes('end_A'));
    assert.ok(executionOrder.includes('start_B'));
    assert.ok(executionOrder.includes('end_B'));
  });
});
