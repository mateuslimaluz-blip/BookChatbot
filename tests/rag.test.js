import test from 'node:test';
import assert from 'node:assert/strict';
import {
  retrieveRelevantChunks,
  buildContextFromChunks,
  executeRagChat,
  NO_CONTEXT_FALLBACK_ANSWER,
  CANDIDATE_K,
  TOP_K,
  MIN_SIMILARITY,
  MAX_QUERY_CHARS,
  UUID_REGEX,
} from '../src/services/ragService.js';
import {
  formatQueryForEmbedding,
  parseRagModelResponse,
  EMBEDDING_DIMENSION,
} from '../src/services/aiService.js';

test('1. Formatação da Query para Retrieval (formatQueryForEmbedding)', async (t) => {
  await t.test('deve formatar no padrão oficial: task: question answering | query: {query}', () => {
    const formatted = formatQueryForEmbedding('Quem foi Capitu?');
    assert.equal(formatted, 'task: question answering | query: Quem foi Capitu?');
  });

  await t.test('deve aplicar trim na query', () => {
    const formatted = formatQueryForEmbedding('   O que é o Humanitismo?   ');
    assert.equal(formatted, 'task: question answering | query: O que é o Humanitismo?');
  });
});

test('2. Validações de Entrada da Query (retrieveRelevantChunks)', async (t) => {
  await t.test('deve rejeitar query nula, vazia ou apenas com espaços', async () => {
    await assert.rejects(
      () => retrieveRelevantChunks(''),
      /não pode ser vazia/
    );
    await assert.rejects(
      () => retrieveRelevantChunks('   '),
      /não pode ser vazia/
    );
    await assert.rejects(
      () => retrieveRelevantChunks(null),
      /não pode ser vazia/
    );
  });

  await t.test('deve rejeitar query que exceda MAX_QUERY_CHARS', async () => {
    const hugeQuery = 'a'.repeat(MAX_QUERY_CHARS + 1);
    await assert.rejects(
      () => retrieveRelevantChunks(hugeQuery),
      /excede o limite/
    );
  });

  await t.test('deve rejeitar bookId inválido que não seja UUID', async () => {
    await assert.rejects(
      () => retrieveRelevantChunks('Pergunta', { bookId: 'id-invalido-123' }),
      /UUID válido/
    );
  });
});

test('3. Validação do Vetor de Embedding', async (t) => {
  await t.test('deve rejeitar vetor com dimensionalidade diferente de 768', async () => {
    const mockEmbeddingFn = async () => [0.1, 0.2, 0.3]; // apenas 3 dimensões
    await assert.rejects(
      () =>
        retrieveRelevantChunks('Pergunta válida', {
          embeddingFn: mockEmbeddingFn,
        }),
      /768 dimensões/
    );
  });
});

test('4. Filtragem por Limiar (MIN_SIMILARITY) e Ordenação (TOP_K)', async (t) => {
  const dummyVector = Array.from({ length: 768 }, () => 0.05);
  const mockEmbeddingFn = async () => dummyVector;

  const mockDb = {
    select: () => mockDb,
    from: () => mockDb,
    innerJoin: () => mockDb,
    where: () => mockDb,
    orderBy: () => mockDb,
    limit: async () => [
      {
        id: 'chunk-1',
        bookId: '11111111-1111-1111-1111-111111111111',
        title: 'Dom Casmurro',
        author: 'Machado de Assis',
        chunkIndex: 0,
        content: 'Olhos de ressaca...',
        metadata: { source: 'content' },
        distance: 0.15,
        similarity: 0.85,
      },
      {
        id: 'chunk-2',
        bookId: '11111111-1111-1111-1111-111111111111',
        title: 'Dom Casmurro',
        author: 'Machado de Assis',
        chunkIndex: 1,
        content: 'Capitu era Capitu...',
        metadata: { source: 'content' },
        distance: 0.25,
        similarity: 0.75,
      },
      {
        id: 'chunk-3',
        bookId: '22222222-2222-2222-2222-222222222222',
        title: 'Memórias Póstumas',
        author: 'Machado de Assis',
        chunkIndex: 0,
        content: 'Trecho irrelevante...',
        metadata: { source: 'content' },
        distance: 0.8,
        similarity: 0.2,
      },
    ],
  };

  await t.test('deve filtrar itens abaixo de MIN_SIMILARITY e ordenar por similaridade decrescente', async () => {
    const result = await retrieveRelevantChunks('Quem é Capitu?', {
      embeddingFn: mockEmbeddingFn,
      dbInstance: mockDb,
      minSimilarity: 0.35,
    });

    assert.equal(result.query, 'Quem é Capitu?');
    assert.equal(result.totalResults, 2);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].id, 'chunk-1');
    assert.equal(result.results[0].similarity, 0.85);
    assert.equal(result.results[1].id, 'chunk-2');
    assert.equal(result.results[1].similarity, 0.75);
    assert.equal(result.results[0].embedding, undefined);
  });

  await t.test('deve retornar lista vazia se nenhum resultado atingir o limiar', async () => {
    const result = await retrieveRelevantChunks('Pergunta sem correspondência', {
      embeddingFn: mockEmbeddingFn,
      dbInstance: mockDb,
      minSimilarity: 0.9,
    });

    assert.equal(result.totalResults, 0);
    assert.deepEqual(result.results, []);
  });
});

test('5. Formatação de Contexto e Deduplicação (buildContextFromChunks)', async (t) => {
  await t.test('deve construir bloco de texto formatado com tags e deduplicar chunks iguais', () => {
    const chunks = [
      {
        id: 'chunk-1',
        bookId: '11111111-1111-1111-1111-111111111111',
        title: 'Dom Casmurro',
        author: 'Machado de Assis',
        chunkIndex: 0,
        content: 'Olhos de cigana oblíqua e dissimulada.',
      },
      {
        id: 'chunk-1', // Duplicata proposital
        bookId: '11111111-1111-1111-1111-111111111111',
        title: 'Dom Casmurro',
        author: 'Machado de Assis',
        chunkIndex: 0,
        content: 'Olhos de cigana oblíqua e dissimulada.',
      },
      {
        id: 'chunk-2',
        bookId: '11111111-1111-1111-1111-111111111111',
        title: 'Dom Casmurro',
        author: 'Machado de Assis',
        chunkIndex: 1,
        content: 'Capitu e Bentinho na infância.',
      },
    ];

    const { contextText, sourcesMap } = buildContextFromChunks(chunks);
    assert.match(contextText, /\[1\] Livro: Dom Casmurro/);
    assert.match(contextText, /\[2\] Livro: Dom Casmurro/);
    assert.equal(sourcesMap.size, 2); // Apenas 2 fontes únicas
    assert.equal(sourcesMap.get(1).chunkIndex, 0);
    assert.equal(sourcesMap.get(2).chunkIndex, 1);
  });

  await t.test('deve retornar vazio para lista de chunks vazia', () => {
    const { contextText, sourcesMap } = buildContextFromChunks([]);
    assert.equal(contextText, '');
    assert.equal(sourcesMap.size, 0);
  });
});

test('6. Parser de Resposta do Modelo RAG (parseRagModelResponse)', async (t) => {
  await t.test('deve extrair JSON com answer e citations', () => {
    const raw = JSON.stringify({
      answer: 'Capitu é a personagem de Dom Casmurro.',
      citations: [1, 2],
    });
    const parsed = parseRagModelResponse(raw);
    assert.equal(parsed.answer, 'Capitu é a personagem de Dom Casmurro.');
    assert.deepEqual(parsed.citations, [1, 2]);
  });

  await t.test('deve limpar blocos de código markdown ```json', () => {
    const raw = '```json\n{"answer": "Texto explicativo.", "citations": [1]}\n```';
    const parsed = parseRagModelResponse(raw);
    assert.equal(parsed.answer, 'Texto explicativo.');
    assert.deepEqual(parsed.citations, [1]);
  });

  await t.test('deve realizar fallback com regex se o modelo responder em texto simples com [1]', () => {
    const raw = 'Segundo o trecho [1], Bentinho casou-se com Capitu.';
    const parsed = parseRagModelResponse(raw);
    assert.equal(parsed.answer, raw);
    assert.deepEqual(parsed.citations, [1]);
  });
});

test('7. Fluxo Completo do Chatbot RAG (executeRagChat)', async (t) => {
  await t.test('quando não houver chunks, deve retornar fallback SEM chamar o modelo generativo', async () => {
    let generativeCalled = false;

    const mockRetrieval = async () => ({
      query: 'Pergunta sem resultado',
      results: [],
      totalResults: 0,
    });

    const mockGenerate = async () => {
      generativeCalled = true;
      return { answer: 'Resposta alucinada', citations: [] };
    };

    const response = await executeRagChat('Pergunta sem resultado', {
      retrievalFn: mockRetrieval,
      generateFn: mockGenerate,
    });

    assert.equal(generativeCalled, false);
    assert.equal(response.success, true);
    assert.equal(response.answer, NO_CONTEXT_FALLBACK_ANSWER);
    assert.deepEqual(response.sources, []);
  });

  await t.test('deve reconciliar as citações retornadas com os metadados reais do banco', async () => {
    const mockRetrieval = async () => ({
      query: 'Quem foi Capitu?',
      results: [
        {
          id: 'chunk-1',
          bookId: '11111111-1111-1111-1111-111111111111',
          title: 'Dom Casmurro',
          author: 'Machado de Assis',
          chunkIndex: 3,
          content: 'Capitu era Capitu...',
        },
      ],
      totalResults: 1,
    });

    const mockGenerate = async () => ({
      answer: 'Capitu é apresentada como uma personagem singular.',
      citations: [1, 999], // 999 é citação inválida que não existe no retrieval
    });

    const response = await executeRagChat('Quem foi Capitu?', {
      retrievalFn: mockRetrieval,
      generateFn: mockGenerate,
    });

    assert.equal(response.success, true);
    assert.equal(response.answer, 'Capitu é apresentada como uma personagem singular.');
    assert.equal(response.sources.length, 1);
    assert.equal(response.sources[0].sourceId, 1);
    assert.equal(response.sources[0].title, 'Dom Casmurro');
    assert.equal(response.sources[0].chunkIndex, 3);
    assert.equal(response.sources[0].bookId, '11111111-1111-1111-1111-111111111111');
  });
});
