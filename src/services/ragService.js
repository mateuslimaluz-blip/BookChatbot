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
    minSimilarity = MIN_SIMILARITY,
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
  const filteredResults = [];

  for (const row of candidates) {
    const rawDistance = Number(row.distance);
    const rawSimilarity = Number(row.similarity);

    const distance = Number.isFinite(rawDistance) ? rawDistance : 1;
    const similarity = Number.isFinite(rawSimilarity) ? rawSimilarity : 1 - distance;

    if (similarity >= minSimilarity) {
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
 * Orquestra o fluxo completo do Chat RAG:
 * 1. Validação de entrada;
 * 2. Recuperação vetorial de chunks relevantes no PostgreSQL via pgvector;
 * 3. Se não houver contexto suficiente, responde diretamente sem chamar o LLM;
 * 4. Montagem de contexto estruturado e seguro com deduplicação;
 * 5. Chamada ao modelo generativo do Gemini;
 * 6. Validação e reconciliação das fontes citadas com os metadados reais do banco.
 *
 * @param {string} query - Pergunta do usuário
 * @param {object} [options] - Opções de execução
 * @param {string} [options.bookId] - ID opcional do livro para busca filtrada
 * @param {function} [options.retrievalFn] - Função de retrieval injetável para testes
 * @param {function} [options.generateFn] - Função generativa injetável para testes
 * @returns {Promise<{ success: boolean, query: string, answer: string, sources: Array<object> }>}
 */
export async function executeRagChat(
  query,
  {
    bookId = null,
    retrievalFn = retrieveRelevantChunks,
    generateFn = generateRagResponse,
  } = {}
) {
  // 1. Executa a recuperação vetorial
  const retrievalResult = await retrievalFn(query, { bookId });

  // 2. Se não houver resultados relevantes acima do limiar, retorna fallback seguro
  if (!retrievalResult.results || retrievalResult.results.length === 0) {
    return {
      success: true,
      query: retrievalResult.query,
      answer: NO_CONTEXT_FALLBACK_ANSWER,
      sources: [],
    };
  }

  // 3. Monta o contexto delimitado
  const { contextText, sourcesMap } = buildContextFromChunks(retrievalResult.results);

  if (!contextText) {
    return {
      success: true,
      query: retrievalResult.query,
      answer: NO_CONTEXT_FALLBACK_ANSWER,
      sources: [],
    };
  }

  // 4. Invoca o modelo generativo
  const modelResponse = await generateFn({
    query: retrievalResult.query,
    context: contextText,
  });

  // 5. Valida e reconcilia as fontes citadas com os metadados reais
  const validatedSources = [];
  const addedSourceIds = new Set();

  if (Array.isArray(modelResponse.citations)) {
    for (const citationId of modelResponse.citations) {
      if (sourcesMap.has(citationId) && !addedSourceIds.has(citationId)) {
        validatedSources.push(sourcesMap.get(citationId));
        addedSourceIds.add(citationId);
      }
    }
  }

  const finalSources =
    validatedSources.length > 0 ? validatedSources : Array.from(sourcesMap.values());

  return {
    success: true,
    query: retrievalResult.query,
    answer: modelResponse.answer || NO_CONTEXT_FALLBACK_ANSWER,
    sources: finalSources,
  };
}
