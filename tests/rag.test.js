import test from 'node:test';
import assert from 'node:assert/strict';
import {
  retrieveRelevantChunks,
  buildContextFromChunks,
  executeRagChat,
  resolveBookIdFromQuery,
  NO_CONTEXT_FALLBACK_ANSWER,
  CANDIDATE_K,
  TOP_K,
  MIN_SIMILARITY,
  MAX_QUERY_CHARS,
  UUID_REGEX,
  isIdentityOrModelQuery,
  formatModelConfigAnswer,
} from '../src/services/ragService.js';
import {
  formatQueryForEmbedding,
  parseRagModelResponse,
  EMBEDDING_DIMENSION,
} from '../src/services/aiService.js';
import { pool } from '../src/config/db.js';

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

test('8. Identidade e Configuração de IA (isIdentityOrModelQuery)', async (t) => {
  await t.test('deve identificar perguntas sobre qual IA ou modelo é utilizado', () => {
    assert.equal(isIdentityOrModelQuery('Em qual IA você é baseada?'), true);
    assert.equal(isIdentityOrModelQuery('Qual modelo você usa?'), true);
    assert.equal(isIdentityOrModelQuery('Qual IA você é?'), true);
    assert.equal(isIdentityOrModelQuery('Você usa Ollama ou Gemini?'), true);
    assert.equal(isIdentityOrModelQuery('Qual inteligência artificial você utiliza?'), true);
  });

  await t.test('não deve classificar perguntas sobre livros como consulta de modelo', () => {
    assert.equal(isIdentityOrModelQuery('Quem é o personagem principal de Dom Casmurro?'), false);
    assert.equal(isIdentityOrModelQuery('Qual é a estratégia na Arte da Guerra?'), false);
  });

  await t.test('deve responder à pergunta de identidade sem chamar retrieval nem modelo, com sources: []', async () => {
    let retrievalCalled = false;
    let generateCalled = false;

    const response = await executeRagChat('Em qual IA você é baseada?', {
      retrievalFn: async () => {
        retrievalCalled = true;
        return { results: [] };
      },
      generateFn: async () => {
        generateCalled = true;
        return { answer: 'chamou modelo', citations: [] };
      },
    });

    assert.equal(retrievalCalled, false);
    assert.equal(generateCalled, false);
    assert.equal(response.success, true);
    assert.equal(response.sources.length, 0);
    assert.match(response.answer, /Google Gemini|Ollama/);
    assert.match(response.answer, /gemini-embedding-2/);
  });
});

test('9. Fundamentação Estrita e Tratamento de Ausência de Informação', async (t) => {
  const dummyResults = [
    {
      id: 'chunk-1',
      bookId: '11111111-1111-1111-1111-111111111111',
      title: 'Dom Casmurro',
      author: 'Machado de Assis',
      chunkIndex: 0,
      content: 'Uma noite destas...',
    },
  ];

  await t.test('se a resposta declara que não encontrou informação nos livros, deve retornar sources: []', async () => {
    const response = await executeRagChat('Qual é a receita de bolo de chocolate?', {
      retrievalFn: async () => ({
        query: 'Qual é a receita de bolo de chocolate?',
        results: dummyResults,
        totalResults: 1,
      }),
      generateFn: async () => ({
        answer: 'Não encontrei essa informação nas obras disponíveis.',
        citations: [1], // mesmo se o modelo erroneamente citar o trecho recuperado
      }),
    });

    assert.equal(response.success, true);
    assert.equal(response.answer, 'Não encontrei essa informação nas obras disponíveis.');
    assert.deepEqual(response.sources, []);
  });

  await t.test('se o modelo responder com conhecimento geral sem suporte dos trechos (citations vazias), deve retornar fallback seguro e sources: []', async () => {
    const response = await executeRagChat('Qual é a capital da França?', {
      retrievalFn: async () => ({
        query: 'Qual é a capital da França?',
        results: dummyResults,
        totalResults: 1,
      }),
      generateFn: async () => ({
        answer: 'A capital da França é Paris.',
        citations: [], // sem qualquer suporte no trecho de Dom Casmurro
      }),
    });

    assert.equal(response.success, true);
    assert.equal(response.answer, NO_CONTEXT_FALLBACK_ANSWER);
    assert.deepEqual(response.sources, []);
  });
});

test('10. Desambiguação de Livro e Resolução por Pergunta (resolveBookIdFromQuery)', async (t) => {
  const mockDbWithBooks = {
    select: () => ({
      from: async () => [
        {
          id: 'e933d2d0-5e0d-4817-80f6-98b623018429',
          title: 'Dracula',
          author: 'Bram Stoker',
        },
        {
          id: '0be14b7e-0cde-4a94-9710-75b864b8306f',
          title: 'Memórias Póstumas de Brás Cubas',
          author: 'Machado de Assis',
        },
      ],
    }),
  };

  await t.test('deve identificar livro Dracula pela menção ao título "Drácula" ou "Dracula"', async () => {
    const bookId = await resolveBookIdFromQuery('Quem é o autor e qual é o enredo de Drácula?', mockDbWithBooks);
    assert.equal(bookId, 'e933d2d0-5e0d-4817-80f6-98b623018429');
  });

  await t.test('deve identificar livro Dracula pela menção ao autor "Bram Stoker"', async () => {
    const bookId = await resolveBookIdFromQuery('Quais são as ideias de Bram Stoker?', mockDbWithBooks);
    assert.equal(bookId, 'e933d2d0-5e0d-4817-80f6-98b623018429');
  });

  await t.test('deve identificar livro Memórias Póstumas de Brás Cubas', async () => {
    const bookId = await resolveBookIdFromQuery('Quem foi o autor de Memórias Póstumas de Brás Cubas?', mockDbWithBooks);
    assert.equal(bookId, '0be14b7e-0cde-4a94-9710-75b864b8306f');
  });

  await t.test('deve retornar null para perguntas genéricas sem menção a livro cadastrado', async () => {
    const bookId = await resolveBookIdFromQuery('O que é literatura clássica?', mockDbWithBooks);
    assert.equal(bookId, null);
  });
});

test('11. Reconciliação de Citações Avançada (base 0, chunkIndex e inline)', async (t) => {
  const draculaChunks = [
    {
      id: 'chunk-drac-0',
      bookId: 'e933d2d0-5e0d-4817-80f6-98b623018429',
      title: 'Dracula',
      author: 'Bram Stoker',
      chunkIndex: 0,
      content: 'DRACULA by BRAM STOKER. WESTMINSTER Archibald Constable and Company.',
    },
    {
      id: 'chunk-drac-33',
      bookId: 'e933d2d0-5e0d-4817-80f6-98b623018429',
      title: 'Dracula',
      author: 'Bram Stoker',
      chunkIndex: 33,
      content: 'I saw the fingers and toes grasp the corners of the stones... Count Dracula.',
    },
  ];

  await t.test('deve validar quando o modelo cita citação base 0 [0]', async () => {
    const response = await executeRagChat('Quem é o autor de Drácula?', {
      retrievalFn: async () => ({ query: 'Quem é o autor de Drácula?', results: draculaChunks, totalResults: 2 }),
      generateFn: async () => ({
        answer: 'O autor de Drácula é Bram Stoker.',
        citations: [0],
      }),
    });

    assert.equal(response.success, true);
    assert.equal(response.sources.length, 1);
    assert.equal(response.sources[0].title, 'Dracula');
    assert.equal(response.sources[0].chunkIndex, 0);
  });

  await t.test('deve validar quando o modelo cita pelo chunkIndex [33]', async () => {
    const response = await executeRagChat('Qual é o enredo de Drácula?', {
      retrievalFn: async () => ({ query: 'Qual é o enredo de Drácula?', results: draculaChunks, totalResults: 2 }),
      generateFn: async () => ({
        answer: 'Jonathan Harker observa o Conde Drácula escalar as paredes do castelo.',
        citations: [33],
      }),
    });

    assert.equal(response.success, true);
    assert.equal(response.sources.length, 1);
    assert.equal(response.sources[0].title, 'Dracula');
    assert.equal(response.sources[0].chunkIndex, 33);
  });

  await t.test('deve validar citações inline no texto quando citations array estiver vazio', async () => {
    const response = await executeRagChat('Quem é o autor de Drácula?', {
      retrievalFn: async () => ({ query: 'Quem é o autor de Drácula?', results: draculaChunks, totalResults: 2 }),
      generateFn: async () => ({
        answer: 'Segundo a obra [1], o autor do livro é Bram Stoker.',
        citations: [],
      }),
    });

    assert.equal(response.success, true);
    assert.equal(response.sources.length, 1);
    assert.equal(response.sources[0].title, 'Dracula');
    assert.equal(response.sources[0].sourceId, 1);
  });
});

test('12. Comparação RAG entre Drácula e Memórias Póstumas de Brás Cubas', async (t) => {
  const draculaChunks = [
    {
      id: 'chunk-drac-0',
      bookId: 'e933d2d0-5e0d-4817-80f6-98b623018429',
      title: 'Dracula',
      author: 'Bram Stoker',
      chunkIndex: 0,
      content: 'DRACULA by BRAM STOKER. WESTMINSTER Archibald Constable and Company. 1897.',
    },
    {
      id: 'chunk-drac-1',
      bookId: 'e933d2d0-5e0d-4817-80f6-98b623018429',
      title: 'Dracula',
      author: 'Bram Stoker',
      chunkIndex: 1,
      content: '3 May. Bistritz.—Left Munich at 8:35 P. M... Count Dracula.',
    },
  ];

  const memoriasChunks = [
    {
      id: 'chunk-mem-0',
      bookId: '0be14b7e-0cde-4a94-9710-75b864b8306f',
      title: 'Memórias Póstumas de Brás Cubas',
      author: 'Machado de Assis',
      chunkIndex: 0,
      content: 'Memórias Póstumas de Brás Cubas. Texto-fonte: Obra Completa, Machado de Assis.',
    },
    {
      id: 'chunk-mem-1',
      bookId: '0be14b7e-0cde-4a94-9710-75b864b8306f',
      title: 'Memórias Póstumas de Brás Cubas',
      author: 'Machado de Assis',
      chunkIndex: 1,
      content: 'Ao verme que primeiro roeu as frias carnes do meu cadáver dedico como saudosa lembrança...',
    },
  ];

  await t.test('deve responder pergunta sobre autor e enredo de Drácula com trechos reais e fontes', async () => {
    const response = await executeRagChat('Quem é o autor e qual é o enredo de Drácula?', {
      retrievalFn: async () => ({
        query: 'Quem é o autor e qual é o enredo de Drácula?',
        results: draculaChunks,
        totalResults: 2,
      }),
      generateFn: async () => ({
        answer: 'O autor de Drácula é Bram Stoker. O enredo se inicia com a viagem de Jonathan Harker a Bistritz a caminho do castelo do Conde Drácula.',
        citations: [1, 2],
      }),
    });

    assert.equal(response.success, true);
    assert.match(response.answer, /Bram Stoker/);
    assert.match(response.answer, /Conde Drácula/);
    assert.equal(response.sources.length, 2);
    assert.equal(response.sources[0].title, 'Dracula');
    assert.equal(response.sources[0].author, 'Bram Stoker');
    assert.equal(response.sources[1].title, 'Dracula');
  });

  await t.test('deve responder pergunta sobre autor e enredo de Memórias Póstumas com trechos reais e fontes', async () => {
    const response = await executeRagChat('Quem é o autor e qual é o enredo de Memórias Póstumas de Brás Cubas?', {
      retrievalFn: async () => ({
        query: 'Quem é o autor e qual é o enredo de Memórias Póstumas de Brás Cubas?',
        results: memoriasChunks,
        totalResults: 2,
      }),
      generateFn: async () => ({
        answer: 'O autor é Machado de Assis. A obra é narrada por um defunto autor (Brás Cubas) que dedica seu livro ao verme que primeiro roeu seu cadáver.',
        citations: [1, 2],
      }),
    });

    assert.equal(response.success, true);
    assert.match(response.answer, /Machado de Assis/);
    assert.match(response.answer, /Brás Cubas/);
    assert.equal(response.sources.length, 2);
    assert.equal(response.sources[0].title, 'Memórias Póstumas de Brás Cubas');
    assert.equal(response.sources[0].author, 'Machado de Assis');
  });
});

test.after(async () => {
  await pool.end();
});
