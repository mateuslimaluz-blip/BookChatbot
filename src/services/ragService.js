import { eq, asc, sql, cosineDistance } from 'drizzle-orm';
import { db } from '../config/db.js';
import { env } from '../config/env.js';
import { books, bookEmbeddings, EMBEDDING_DIMENSION } from '../db/schema.js';
import { generateQueryEmbedding, generateRagResponse } from './aiService.js';

/**
 * Parâmetros de calibração do pipeline de recuperação vetorial e RAG.
 */
export const CANDIDATE_K = env.RAG_CANDIDATE_K;
export const TOP_K = env.RAG_TOP_K;
export const MIN_SIMILARITY = env.RAG_MIN_SIMILARITY;
export const MAX_QUERY_CHARS = env.MAX_QUERY_CHARS;
export const MAX_CONTEXT_CHARS = env.MAX_CONTEXT_CHARS;

export const NO_CONTEXT_FALLBACK_ANSWER =
  'Não encontrei informação suficiente nas obras disponíveis para responder a essa pergunta.';

// Validador de formato UUID v4 / UUID padrão
export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Executa a recuperação vetorial de chunks relevantes no PostgreSQL via pgvector/HNSW.
 *
 * @param {string} query - Pergunta do usuário
 * @param {object} [options] - Opções de busca
 * @param {string} [options.bookId] - ID opcional de um livro específico
 * @param {number} [options.candidateK=CANDIDATE_K] - Número de candidatos recuperados na busca vetorial
 * @param {number} [options.topK=TOP_K] - Número máximo de resultados retornados
 * @param {number} [options.minSimilarity=MIN_SIMILARITY] - Limiar mínimo de similaridade semântica
 * @param {function} [options.embeddingFn] - Função de embedding injetável para testes
 * @param {object} [options.dbInstance] - Instância de banco injetável para testes
 * @returns {Promise<{ query: string, results: Array<object>, totalResults: number }>}
 */
export async function retrieveRelevantChunks(
  query,
  {
    bookId = null,
    candidateK = CANDIDATE_K,
    topK = TOP_K,
    minSimilarity = undefined,
    embeddingFn = generateQueryEmbedding,
    dbInstance = db,
  } = {}
) {
  // 1. Validação da query
  if (!query || typeof query !== 'string' || query.trim() === '') {
    throw new Error('A pergunta para busca não pode ser vazia ou nula.');
  }

  const cleanQuery = query.trim();
  if (cleanQuery.length > MAX_QUERY_CHARS) {
    throw new Error(
      `A pergunta excede o limite máximo permitido de ${MAX_QUERY_CHARS} caracteres.`
    );
  }

  // 2. Validação e verificação do livro (quando bookId é fornecido)
  if (bookId !== null && bookId !== undefined) {
    if (typeof bookId !== 'string' || !UUID_REGEX.test(bookId)) {
      throw new Error('ID de livro inválido. Deve ser um UUID válido.');
    }

    const [existingBook] = await dbInstance
      .select({ id: books.id })
      .from(books)
      .where(eq(books.id, bookId));

    if (!existingBook) {
      throw new Error(`Livro com ID ${bookId} não encontrado.`);
    }
  }

  // 3. Geração do embedding da query com gemini-embedding-2
  const queryEmbedding = await embeddingFn(cleanQuery);

  if (
    !queryEmbedding ||
    !Array.isArray(queryEmbedding) ||
    queryEmbedding.length !== EMBEDDING_DIMENSION
  ) {
    throw new Error(
      `Embedding de consulta inválido: esperado vetor com ${EMBEDDING_DIMENSION} dimensões.`
    );
  }

  // 4. Expressões SQL para distância cosseno e similaridade
  const distanceExpr = cosineDistance(bookEmbeddings.embedding, queryEmbedding);
  const similarityExpr = sql`1 - (${distanceExpr})`;

  // 5. Montagem da query vetorial parametrizada com JOIN em books
  let baseQuery = dbInstance
    .select({
      id: bookEmbeddings.id,
      bookId: bookEmbeddings.bookId,
      title: books.title,
      author: books.author,
      chunkIndex: bookEmbeddings.chunkIndex,
      content: bookEmbeddings.content,
      metadata: bookEmbeddings.metadata,
      distance: distanceExpr,
      similarity: similarityExpr,
    })
    .from(bookEmbeddings)
    .innerJoin(books, eq(bookEmbeddings.bookId, books.id));

  if (bookId) {
    baseQuery = baseQuery.where(eq(bookEmbeddings.bookId, bookId));
  }

  // Executa a busca HNSW no PostgreSQL
  const candidates = await baseQuery.orderBy(asc(distanceExpr)).limit(candidateK);

  // 6. Processamento dos candidatos: cálculo de similaridade e aplicação de limiar
  const effectiveMinSimilarity =
    minSimilarity !== undefined
      ? minSimilarity
      : bookId
      ? Math.min(MIN_SIMILARITY, 0.25)
      : MIN_SIMILARITY;

  const filteredResults = [];

  for (const row of candidates) {
    const rawDistance = Number(row.distance);
    const rawSimilarity = Number(row.similarity);

    const distance = Number.isFinite(rawDistance) ? rawDistance : 1;
    const similarity = Number.isFinite(rawSimilarity) ? rawSimilarity : 1 - distance;

    if (similarity >= effectiveMinSimilarity) {
      filteredResults.push({
        id: row.id,
        bookId: row.bookId,
        title: row.title,
        author: row.author,
        chunkIndex: row.chunkIndex,
        content: row.content,
        metadata: row.metadata,
        similarity,
        distance,
      });
    }
  }

  // 7. Ordenação por similaridade decrescente e limite TOP_K
  filteredResults.sort((a, b) => b.similarity - a.similarity);
  const finalResults = filteredResults.slice(0, topK);

  return {
    query: cleanQuery,
    results: finalResults,
    totalResults: finalResults.length,
  };
}

/**
 * Constrói o bloco de contexto estruturado a partir dos chunks recuperados,
 * aplicando deduplicação, controle de tamanho e indexação para citações.
 *
 * @param {Array<object>} results - Chunks recuperados
 * @param {object} [options]
 * @param {number} [options.maxContextChars=MAX_CONTEXT_CHARS] - Tamanho máximo permitido para o contexto
 * @returns {{ contextText: string, sourcesMap: Map<number, object> }}
 */
export function buildContextFromChunks(
  results,
  { maxContextChars = MAX_CONTEXT_CHARS } = {}
) {
  if (!results || !Array.isArray(results) || results.length === 0) {
    return { contextText: '', sourcesMap: new Map() };
  }

  const seenKeys = new Set();
  const sourcesMap = new Map();
  const formattedSections = [];
  let currentTotalChars = 0;
  let sourceCounter = 1;

  for (const item of results) {
    const chunkKey = item.id || `${item.bookId}_${item.chunkIndex}`;
    if (seenKeys.has(chunkKey)) {
      continue;
    }
    seenKeys.add(chunkKey);

    const section = `[${sourceCounter}] Livro: ${item.title}
Autor: ${item.author}
Chunk: ${item.chunkIndex}
Texto:
${item.content.trim()}`;

    if (currentTotalChars + section.length > maxContextChars && formattedSections.length > 0) {
      break;
    }

    sourcesMap.set(sourceCounter, {
      sourceId: sourceCounter,
      bookId: item.bookId,
      title: item.title,
      author: item.author,
      chunkIndex: item.chunkIndex,
    });

    formattedSections.push(section);
    currentTotalChars += section.length;
    sourceCounter++;
  }

  return {
    contextText: formattedSections.join('\n\n---\n\n'),
    sourcesMap,
  };
}

/**
 * Identifica se a pergunta do usuário é sobre a identidade, provedor ou modelo de inteligência artificial
 * configurado no BookChatbot (ex: "Em qual IA você é baseada?", "Qual modelo de IA você usa?", "Qual IA você usa?").
 *
 * @param {string} query
 * @returns {boolean}
 */
export function isIdentityOrModelQuery(query) {
  if (!query || typeof query !== 'string') return false;

  const norm = query
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!norm) return false;

  // Termos típicos de busca de enredo/conteúdo literário
  const contentKeywords = [
    'capitulo', 'personagem', 'enredo', 'resumo', 'resuma', 'sinopse',
    'significa', 'acontece', 'morre', 'morte', 'citacao', 'cite', 'frase',
    'estrategia', 'vencer', 'guerra'
  ];

  if (contentKeywords.some((kw) => norm.includes(kw))) {
    return false;
  }

  const identityOrModelPatterns = [
    /(?:em\s+)?qual\s+(?:ia|inteligencia\s+artificial|modelo|llm)\s+(?:voce\s+)?(?:e\s+)?(?:baseada|baseado|utiliza|usa|roda|funciona)/,
    /(?:voce\s+)?(?:e\s+|usa\s+)?(?:baseada|baseado)\s+em\s+(?:qual|que)\s+(?:ia|inteligencia\s+artificial|modelo|llm)/,
    /(?:qual|que)\s+(?:ia|inteligencia\s+artificial|modelo|llm)(?:\s+de\s+ia)?\s+(?:voce\s+)?(?:usa|utiliza|e|voce\s+e)/,
    /(?:qual|que)\s+(?:e\s+)?(?:o\s+)?(?:seu\s+)?(?:modelo|llm|provedor)(?:\s+de\s+ia)?/,
    /(?:qual|que)\s+(?:tecnologia|motor)\s+(?:de\s+ia\s+)?(?:voce\s+)?(?:usa|utiliza|e\s+usado|e\s+usada)/,
    /(?:voce\s+)?(?:e\s+|usa\s+)?(?:o\s+)?(?:chatgpt|gemini|ollama|llama|claude|deepseek|gpt)/,
    /(?:qual\s+ia\s+esta\s+configurada|qual\s+provedor\s+esta\s+configurado)/,
    /(?:como\s+suas\s+respostas\s+sao\s+geradas|quem\s+gera\s+(?:as\s+)?(?:suas\s+)?respostas)/,
    /(?:qual\s+modelo\s+gera\s+(?:as\s+)?respostas|qual\s+modelo\s+(?:gera\s+os\s+)?embeddings)/,
    /^qual\s+ia\s+voce\s+e\??$/,
    /^(?:voce\s+)?usa\s+qual\s+(?:ia|modelo|llm)\??$/,
    /^(?:em\s+)?qual\s+ia\s+voce\s+e\s+(?:baseada|baseado)\??$/
  ];

  return identityOrModelPatterns.some((pattern) => pattern.test(norm));
}

/**
 * Retorna a resposta direta informando a arquitetura e modelos ativos no BookChatbot,
 * inspecionando diretamente as variáveis de ambiente sem invocar nenhum modelo ou busca vetorial.
 *
 * @returns {string}
 */
export function formatModelConfigAnswer() {
  const provider = (env.AI_CHAT_PROVIDER || 'gemini').toLowerCase();
  const ollamaModel = env.OLLAMA_CHAT_MODEL || 'llama3.2';
  const geminiGenModel = env.GEMINI_GENERATIVE_MODEL || 'gemini-3.8-flash';
  const embeddingModel = 'gemini-embedding-2';

  if (provider === 'ollama') {
    return `Eu sou o assistente do BookChatbot e utilizo uma arquitetura híbrida de inteligência artificial:

- **Geração de respostas:** Ollama local com o modelo **${ollamaModel}**;
- **Busca vetorial (Embeddings):** Google Gemini com o modelo **${embeddingModel}** para gerar os embeddings das perguntas e dos trechos das obras.`;
  }

  return `Eu sou o assistente do BookChatbot e opero com a infraestrutura do Google Gemini:

- **Geração de respostas:** Google Gemini com o modelo **${geminiGenModel}**;
- **Busca vetorial (Embeddings):** Google Gemini com o modelo **${embeddingModel}** para gerar os embeddings das perguntas e dos trechos das obras.`;
}

/**
 * Identifica se a pergunta do usuário é uma saudação (ex: "Olá", "Bom dia", "Oi")
 * ou uma pergunta sobre o propósito/como usar o aplicativo (ex: "o que você faz?", "como posso usar o BookChatbot?").
 *
 * @param {string} query
 * @returns {boolean}
 */
export function isGreetingOrHelpQuery(query) {
  if (!query || typeof query !== 'string') return false;

  const norm = query
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!norm) return false;

  // Se a pergunta menciona termos de conteúdo textual ou análise interna de obra, não é saudação/ajuda pura
  const contentKeywords = [
    'capitulo', 'personagem', 'enredo', 'resumo', 'resuma', 'sinopse',
    'significa', 'acontece', 'morre', 'morte', 'citacao', 'cite', 'frase',
    'analise', 'do que fala', 'sobre o que fala', 'sobre o que trata',
    'o que diz', 'qual a mensagem', 'qual a moral', 'como termina', 'inicio',
    'quem foi', 'estrategia', 'vencer', 'guerra', 'morte de'
  ];

  if (contentKeywords.some((kw) => norm.includes(kw))) {
    return false;
  }

  // Saudações comuns puras
  const pureGreetings = [
    'ola', 'oi', 'oie', 'opa', 'ola tudo bem', 'oi tudo bem', 'e ai',
    'bom dia', 'boa tarde', 'boa noite', 'tudo bem', 'como vai',
    'ola como vai', 'oi como vai', 'ola bom dia', 'ola boa tarde', 'ola boa noite'
  ];

  if (pureGreetings.includes(norm)) {
    return true;
  }

  // Padrões de saudações combinadas e perguntas sobre o aplicativo
  const greetingOrHelpPatterns = [
    /^(?:ola\s+|oi\s+|oie\s+|opa\s+|bom dia\s+|boa tarde\s+|boa noite\s+)?o\s+que\s+(?:voce\s+)?faz\??$/,
    /^(?:ola\s+|oi\s+)?como\s+(?:posso\s+|podemos\s+|eu\s+posso\s+)?usar\s+(?:o\s+)?(?:bookchatbot|chatbot|chat|aplicativo|app|sistema)\??$/,
    /como\s+(?:posso\s+|podemos\s+)?usar\s+(?:o\s+)?(?:bookchatbot|chatbot|chat|aplicativo|app|sistema)/,
    /^(?:ola\s+|oi\s+)?quem\s+(?:e\s+voce|voce\s+e)\??$/,
    /^(?:ola\s+|oi\s+)?qual\s+(?:e\s+o\s+)?seu\s+nome\??$/,
    /^(?:ola\s+|oi\s+)?para\s+que\s+(?:voce\s+)?serve\??$/,
    /^(?:ola\s+|oi\s+)?como\s+(?:voce\s+)?funciona\??$/,
    /^(?:ola\s+|oi\s+)?como\s+funciona\s+(?:o\s+)?(?:bookchatbot|aplicativo|app|sistema)\??$/,
    /^(?:ola\s+|oi\s+)?qual\s+(?:e\s+)?(?:a\s+)?(?:sua\s+)?funcao\??$/,
    /^(?:ola\s+|oi\s+)?qual\s+(?:e\s+)?(?:o\s+)?(?:seu\s+)?objetivo\??$/,
    /^(?:ajuda|socorro|help|me\s+ajuda|preciso\s+de\s+ajuda)\??$/,
    /o\s+que\s+(?:eu\s+)?posso\s+(?:perguntar|fazer|consultar)\s+(?:aqui|com\s+voce)/
  ];

  return greetingOrHelpPatterns.some((pattern) => pattern.test(norm));
}

/**
 * Retorna a resposta direta para saudações e dúvidas sobre o funcionamento do BookChatbot.
 *
 * @param {object} [options]
 * @param {string|null} [options.selectedBookTitle]
 * @returns {string}
 */
export function formatAppInfoAnswer({ selectedBookTitle = null } = {}) {
  const base =
    'Olá! Eu sou o assistente do BookChatbot. Minha função é responder a perguntas e analisar conteúdos fundamentados nos livros cadastrados e disponíveis no catálogo.\n\nVocê pode me fazer perguntas sobre o enredo, personagens e ideias das obras disponíveis, ou perguntar "Quais livros você tem?" para ver as obras prontas para consulta.';

  if (selectedBookTitle) {
    return `${base}\n\n*Nota: Sua conversa atual está filtrada no livro "${selectedBookTitle}". Para consultar todas as obras do catálogo, utilize o "Acervo Geral".*`;
  }

  return base;
}

/**
 * Identifica se a pergunta do usuário é uma consulta sobre o catálogo de livros disponíveis no acervo,
 * diferenciando-a de perguntas que tratam do conteúdo textual interno de uma obra.
 *
 * @param {string} query
 * @returns {boolean}
 */
export function isCatalogQuery(query) {
  if (!query || typeof query !== 'string') return false;

  const norm = query
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Termos típicos de busca de conteúdo/enredo interno que desqualificam a pergunta como catálogo puro
  const contentKeywords = [
    'capitulo', 'personagem', 'enredo', 'resumo', 'resuma', 'sinopse',
    'significa', 'acontece', 'morre', 'morte', 'citacao', 'cite', 'frase',
    'analise', 'do que fala', 'sobre o que fala', 'sobre o que trata',
    'o que diz', 'qual a mensagem', 'qual a moral', 'como termina', 'inicio',
    'quem foi', 'quem e', 'estrategia', 'vencer', 'guerra', 'morte de'
  ];

  for (const kw of contentKeywords) {
    if (norm.includes(kw)) {
      return false;
    }
  }

  // Padrões específicos que solicitam a lista de livros, obras disponíveis ou catálogo
  const catalogPatterns = [
    /(?:sobre|de)?\s*quais\s+(?:livros|obras|titulos)\s+(?:voce\s+)?(?:pode|consegue|sabe)\s+(?:falar|responder|tratar|conversar)/,
    /(?:quais|que)\s+(?:livros|obras|titulos)\s+(?:voce\s+)?(?:tem|possui|conhece|disponibiliza)/,
    /(?:quais|que)\s+(?:sao\s+)?(?:os\s+|as\s+)?(?:livros|obras|titulos)\s+(?:estao\s+)?(?:disponiveis|cadastrados|no acervo|na biblioteca|no catalogo|prontos|prontas)/,
    /^(?:quais\s+)?(?:livros|obras|titulos)\s+disponiveis(?:\s+para\s+consulta)?$/,
    /o\s+que\s+(?:voce\s+)?tem\s+(?:no acervo|na biblioteca|no catalogo)/,
    /qual\s+(?:e\s+)?(?:o\s+)?(?:catalogo|acervo|biblioteca)/,
    /(?:listar|liste|lista\s+de|mostrar|mostre|ver)\s+(?:os\s+|as\s+)?(?:livros|obras|titulos|catalogo|acervo)/,
    /sobre\s+(?:o\s+que|quais\s+assuntos)\s+(?:voce\s+)?(?:pode|consegue|sabe)\s+(?:falar|responder|conversar)/,
    /(?:quais|que)\s+(?:livros|obras)\s+(?:posso|podemos|consigo)\s+(?:consultar|pesquisar|perguntar|acessar|ler)/,
    /^quais\s+(?:sao\s+)?(?:os\s+|as\s+)?(?:livros|obras)(?:\s+cadastrados|\s+no\s+sistema|\s+no\s+acervo)?$/
  ];

  return catalogPatterns.some((pattern) => pattern.test(norm));
}

/**
 * Consulta o estado real do catálogo de livros no PostgreSQL, verificando a existência
 * de embeddings em book_embeddings e o status do job de ingestão mais recente.
 *
 * @param {object} [dbInstance=db]
 * @returns {Promise<{
 *   readyBooks: Array<{ id: string, title: string, author: string }>,
 *   pendingBooks: Array<{ id: string, title: string, author: string, status: string }>,
 *   failedBooks: Array<{ id: string, title: string, author: string }>,
 * }>}
 */
export async function getCatalogStatus(dbInstance = db) {
  const result = await dbInstance.execute(sql`
    SELECT
      b.id,
      b.title,
      b.author,
      EXISTS(SELECT 1 FROM book_embeddings be WHERE be.book_id = b.id) AS "hasEmbeddings",
      (
        SELECT j.status
        FROM ingestion_jobs j
        WHERE j.book_id = b.id
        ORDER BY j.created_at DESC
        LIMIT 1
      ) AS "jobStatus"
    FROM books b
    ORDER BY b.title ASC;
  `);

  const readyBooks = [];
  const pendingBooks = [];
  const failedBooks = [];

  for (const row of result.rows || []) {
    const item = {
      id: row.id,
      title: row.title,
      author: row.author,
      hasEmbeddings: Boolean(row.hasEmbeddings),
      jobStatus: row.jobStatus || null,
    };

    // Disponível apenas se possui embeddings gerados e não está em estado de falha
    if (item.hasEmbeddings && (item.jobStatus === 'completed' || !item.jobStatus)) {
      readyBooks.push(item);
    } else if (
      item.jobStatus === 'queued' ||
      item.jobStatus === 'running' ||
      item.jobStatus === 'waiting_retry'
    ) {
      pendingBooks.push(item);
    } else if (item.jobStatus === 'failed' || (!item.hasEmbeddings && item.jobStatus)) {
      failedBooks.push(item);
    } else {
      pendingBooks.push(item);
    }
  }

  return { readyBooks, pendingBooks, failedBooks };
}

/**
 * Formata a resposta textual do catálogo de livros cadastrados.
 * Lista apenas obras com processamento concluído como disponíveis para consulta,
 * explicitando obras que estejam pendentes de ingestão ou com falha.
 *
 * @param {object} catalog
 * @param {object} [options]
 * @param {string|null} [options.selectedBookId]
 * @returns {string}
 */
export function formatCatalogAnswer(
  { readyBooks = [], pendingBooks = [], failedBooks = [] },
  { selectedBookId = null } = {}
) {
  if (readyBooks.length === 0 && pendingBooks.length === 0 && failedBooks.length === 0) {
    return 'No momento, não há nenhum livro cadastrado no acervo do BookChatbot.';
  }

  const sections = [];

  if (readyBooks.length > 0) {
    const list = readyBooks
      .map((b, i) => `${i + 1}. **${b.title}** — ${b.author || 'Autor desconhecido'}`)
      .join('\n');

    sections.push(
      `Atualmente, posso falar sobre os seguintes livros disponíveis no catálogo:\n\n${list}\n\nEssas obras já foram processadas e estão prontas para consulta com busca semântica e citações de trechos.`
    );
  } else {
    sections.push(
      'No momento, nenhuma obra cadastrada possui processamento de embeddings concluído para consulta.'
    );
  }

  if (pendingBooks.length > 0) {
    const pendingList = pendingBooks
      .map((b) => `- **${b.title}** — ${b.author || 'Autor n/d'} (em processamento de ingestão)`)
      .join('\n');
    sections.push(
      `Obras em processamento (ainda não disponíveis para perguntas):\n${pendingList}`
    );
  }

  if (failedBooks.length > 0) {
    const failedList = failedBooks
      .map((b) => `- **${b.title}** — ${b.author || 'Autor n/d'} (falha na ingestão; requer reprocessamento)`)
      .join('\n');
    sections.push(
      `Obras com falha registrada no processamento:\n${failedList}`
    );
  }

  if (selectedBookId) {
    const currentSelected = readyBooks.find((b) => b.id === selectedBookId);
    if (currentSelected) {
      sections.push(
        `*Nota: Sua conversa atual está filtrada no contexto de "${currentSelected.title}". Para perguntar sobre todo o catálogo, você pode alternar para "Acervo Geral".*`
      );
    }
  }

  return sections.join('\n\n');
}

/**
 * Tenta identificar se a pergunta do usuário referencia explicitamente uma obra ou autor
 * específico do catálogo cadastrado no banco, retornando o bookId correspondente.
 * Útil para desambiguação e filtro de escopo quando o usuário faz perguntas com bookId nulo ("Acervo Geral").
 *
 * @param {string} query - Pergunta do usuário
 * @param {object} [dbInstance=db]
 * @returns {Promise<string|null>} bookId encontrado ou null
 */
export async function resolveBookIdFromQuery(query, dbInstance = db) {
  if (!query || typeof query !== 'string') return null;

  const normQuery = query
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normQuery) return null;

  try {
    const allBooks = await dbInstance
      .select({
        id: books.id,
        title: books.title,
        author: books.author,
      })
      .from(books);

    for (const book of allBooks) {
      const normTitle = (book.title || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const normAuthor = (book.author || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Verifica correspondência exata do título no texto (ex: "dracula", "dom casmurro")
      if (normTitle && normTitle.length >= 3 && normQuery.includes(normTitle)) {
        return book.id;
      }

      // Verifica palavras significativas do título (ex: "memorias postumas", "bras cubas", "arte da guerra")
      const titleWords = normTitle.split(' ').filter((w) => w.length >= 4);
      if (titleWords.length > 0 && titleWords.every((w) => normQuery.includes(w))) {
        return book.id;
      }

      // Se o autor foi citado (ex: "bram stoker", "stoker", "machado de assis", "sun tzu")
      if (normAuthor && normAuthor.length >= 4 && normQuery.includes(normAuthor)) {
        return book.id;
      }
      const authorLastName = normAuthor.split(' ').pop();
      if (authorLastName && authorLastName.length >= 5 && normQuery.includes(authorLastName)) {
        return book.id;
      }
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Orquestra o fluxo completo do Chat RAG:
 * 1. Validação de entrada;
 * 2. Detecção de perguntas sobre o catálogo de livros disponíveis (respondidas via catálogo real);
 * 3. Recuperação vetorial de chunks relevantes no PostgreSQL via pgvector;
 * 4. Se não houver contexto suficiente, responde diretamente sem chamar o LLM;
 * 5. Montagem de contexto estruturado e seguro com deduplicação;
 * 6. Chamada ao modelo generativo do Gemini;
 * 7. Validação e reconciliação das fontes citadas com os metadados reais do banco.
 *
 * @param {string} query - Pergunta do usuário
 * @param {object} [options] - Opções de execução
 * @param {string} [options.bookId] - ID opcional do livro para busca filtrada
 * @param {function} [options.retrievalFn] - Função de retrieval injetável para testes
 * @param {function} [options.generateFn] - Função generativa injetável para testes
 * @param {object} [options.dbInstance] - Instância de banco injetável
 * @returns {Promise<{ success: boolean, query: string, answer: string, sources: Array<object> }>}
 */
export async function executeRagChat(
  query,
  {
    bookId = null,
    retrievalFn = retrieveRelevantChunks,
    generateFn = generateRagResponse,
    dbInstance = db,
  } = {}
) {
  // 1. Validação básica da query
  if (!query || typeof query !== 'string' || query.trim() === '') {
    throw new Error('A pergunta para busca não pode ser vazia ou nula.');
  }

  const cleanQuery = query.trim();
  if (cleanQuery.length > MAX_QUERY_CHARS) {
    throw new Error(
      `A pergunta excede o limite máximo permitido de ${MAX_QUERY_CHARS} caracteres.`
    );
  }

  // 2. Se for pergunta sobre a identidade, provedor ou modelo de IA do BookChatbot, responde diretamente com as configs ativas
  if (isIdentityOrModelQuery(cleanQuery)) {
    const answer = formatModelConfigAnswer();
    return {
      success: true,
      query: cleanQuery,
      answer,
      sources: [],
    };
  }

  // 3. Se for saudação ou pergunta sobre a função do aplicativo, responde diretamente sem buscar trechos, gerar embedding ou chamar o modelo
  if (isGreetingOrHelpQuery(cleanQuery)) {
    let selectedBookTitle = null;
    if (bookId) {
      try {
        const [book] = await dbInstance
          .select({ title: books.title })
          .from(books)
          .where(eq(books.id, bookId))
          .limit(1);
        selectedBookTitle = book?.title || null;
      } catch {
        selectedBookTitle = null;
      }
    }

    const answer = formatAppInfoAnswer({ selectedBookTitle });
    return {
      success: true,
      query: cleanQuery,
      answer,
      sources: [],
    };
  }

  // 4. Se a pergunta for sobre os livros do acervo / catálogo disponíveis, responde pelo catálogo cadastrado
  if (isCatalogQuery(cleanQuery)) {
    const catalog = await getCatalogStatus(dbInstance);
    const answer = formatCatalogAnswer(catalog, { selectedBookId: bookId });
    const sources = catalog.readyBooks.map((b, index) => ({
      sourceId: index + 1,
      bookId: b.id,
      title: b.title,
      author: b.author,
    }));

    return {
      success: true,
      query: cleanQuery,
      answer,
      sources,
    };
  }

  // 5. Se não houver bookId fornecido, tenta inferir a obra a partir da pergunta do usuário
  let effectiveBookId = bookId || null;
  if (!effectiveBookId) {
    try {
      effectiveBookId = await resolveBookIdFromQuery(cleanQuery, dbInstance);
    } catch {
      effectiveBookId = null;
    }
  }

  // 6. Executa a recuperação vetorial de trechos
  const retrievalResult = await retrievalFn(cleanQuery, { bookId: effectiveBookId, dbInstance });

  // 7. Se não houver resultados relevantes acima do limiar, retorna fallback seguro
  if (!retrievalResult.results || retrievalResult.results.length === 0) {
    return {
      success: true,
      query: retrievalResult.query,
      answer: NO_CONTEXT_FALLBACK_ANSWER,
      sources: [],
    };
  }

  // 8. Monta o contexto delimitado
  const { contextText, sourcesMap } = buildContextFromChunks(retrievalResult.results);

  if (!contextText) {
    return {
      success: true,
      query: retrievalResult.query,
      answer: NO_CONTEXT_FALLBACK_ANSWER,
      sources: [],
    };
  }

  // 9. Invoca o modelo generativo
  const modelResponse = await generateFn({
    query: retrievalResult.query,
    context: contextText,
  });

  // 10. Valida e reconcilia as fontes citadas com os metadados reais
  const validatedSources = [];
  const addedSourceIds = new Set();

  const candidateCitationIds = [];
  if (Array.isArray(modelResponse.citations) && modelResponse.citations.length > 0) {
    candidateCitationIds.push(...modelResponse.citations);
  }

  // Se o modelo não preencheu o array de citations, busca citações inline no texto da resposta (ex: [1], [Fonte 1], [0])
  if (candidateCitationIds.length === 0 && modelResponse.answer) {
    const inlineMatches = [...modelResponse.answer.matchAll(/\[(?:fonte\s*)?(\d+)\]/gi)];
    for (const match of inlineMatches) {
      const parsedNum = parseInt(match[1], 10);
      if (Number.isInteger(parsedNum)) {
        candidateCitationIds.push(parsedNum);
      }
    }
  }

  for (const citationId of candidateCitationIds) {
    // A. Casamento direto por sourceId (1, 2, 3...)
    if (sourcesMap.has(citationId) && !addedSourceIds.has(citationId)) {
      validatedSources.push(sourcesMap.get(citationId));
      addedSourceIds.add(citationId);
      continue;
    }

    // B. Casamento base 0 (se o modelo citou 0, mapeia para a primeira fonte ou fonte com chunkIndex 0)
    if (citationId === 0) {
      let matchedZero = null;
      for (const src of sourcesMap.values()) {
        if (src.chunkIndex === 0) {
          matchedZero = src;
          break;
        }
      }
      if (!matchedZero && sourcesMap.has(1)) {
        matchedZero = sourcesMap.get(1);
      }
      if (matchedZero && !addedSourceIds.has(matchedZero.sourceId)) {
        validatedSources.push(matchedZero);
        addedSourceIds.add(matchedZero.sourceId);
        continue;
      }
    }

    // C. Casamento por chunkIndex (caso o modelo tenha citado o chunkIndex direto)
    for (const [sId, source] of sourcesMap.entries()) {
      if (source.chunkIndex === citationId && !addedSourceIds.has(sId)) {
        validatedSources.push(source);
        addedSourceIds.add(sId);
        break;
      }
    }
  }

  // Verifica se a resposta afirma expressamente que a informação não foi encontrada nas obras disponíveis
  const isNotFoundAnswer =
    /não encontrei (essa |esta )?informação|não foi possível encontrar|informação suficiente não encontrada|não encontrei menção|não consta nas obras disponíveis|não há menção/i.test(
      modelResponse.answer || ''
    );

  let finalAnswer = modelResponse.answer || NO_CONTEXT_FALLBACK_ANSWER;
  let finalSources = [];

  if (isNotFoundAnswer) {
    // Quando o modelo declara que não encontrou a informação, mantém a declaração e não anexa fontes irrelevantes
    finalSources = [];
  } else if (validatedSources.length > 0) {
    // Preserva rigorosamente as fontes reais citadas e validadas pelo modelo que comprovam a afirmação
    finalSources = validatedSources;
  } else {
    // Se os trechos recuperados não sustentarem a afirmação (nenhuma fonte válida do contexto foi citada),
    // o chatbot declara que não encontrou essa informação nos livros, sem completar com conhecimento geral
    finalAnswer = NO_CONTEXT_FALLBACK_ANSWER;
    finalSources = [];
  }

  return {
    success: true,
    query: retrievalResult.query,
    answer: finalAnswer,
    sources: finalSources,
  };
}
