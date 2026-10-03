import {
  executeRagChat,
  retrieveRelevantChunks,
  UUID_REGEX,
  MAX_QUERY_CHARS,
} from '../services/ragService.js';

/**
 * Controller principal do Chatbot RAG (POST /chat).
 *
 * @param {import('fastify').FastifyRequest<{ Body: { query?: string, bookId?: string } }>} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function chatHandler(request, reply) {
  const startTime = Date.now();
  const body = request.body;

  if (!body || typeof body !== 'object') {
    return reply.status(400).send({
      success: false,
      error: 'Corpo da requisição inválido. Envie um JSON com o campo "query".',
    });
  }

  const { query, bookId } = body;

  if (!query || typeof query !== 'string' || query.trim() === '') {
    return reply.status(400).send({
      success: false,
      error: 'O campo "query" é obrigatório e deve ser uma string não vazia.',
    });
  }

  const cleanQuery = query.trim();
  if (cleanQuery.length > MAX_QUERY_CHARS) {
    return reply.status(400).send({
      success: false,
      error: `A pergunta excede o limite máximo permitido de ${MAX_QUERY_CHARS} caracteres.`,
    });
  }

  if (bookId !== undefined && bookId !== null) {
    if (typeof bookId !== 'string' || !UUID_REGEX.test(bookId)) {
      return reply.status(400).send({
        success: false,
        error: 'O campo "bookId" fornecido deve ser um UUID válido.',
      });
    }
  }

  try {
    const result = await executeRagChat(cleanQuery, {
      bookId: bookId || null,
    });

    const durationMs = Date.now() - startTime;
    request.log.info({
      event: 'rag_chat_completed',
      bookId: bookId || null,
      queryLength: cleanQuery.length,
      sourcesCount: result.sources.length,
      durationMs,
    });

    return reply.status(200).send({
      success: true,
      query: result.query,
      answer: result.answer,
      sources: result.sources,
    });
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error.message || 'Erro interno ao processar a conversa.';

    request.log.error({
      event: 'rag_chat_error',
      bookId: bookId || null,
      durationMs,
      error: errorMessage,
    });

    if (errorMessage.includes('não encontrado')) {
      return reply.status(404).send({
        success: false,
        error: errorMessage,
      });
    }

    if (
      errorMessage.includes('não pode ser vazia') ||
      errorMessage.includes('excede o limite') ||
      errorMessage.includes('inválido')
    ) {
      return reply.status(400).send({
        success: false,
        error: errorMessage,
      });
    }

    return reply.status(500).send({
      success: false,
      error: 'Falha interna ao processar a resposta do chatbot.',
    });
  }
}

/**
 * Controller para busca de chunks relevantes (Retrieval do RAG para diagnóstico: POST /chat/search).
 *
 * @param {import('fastify').FastifyRequest<{ Body: { query?: string, bookId?: string } }>} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function searchRelevantChunksHandler(request, reply) {
  const body = request.body;

  if (!body || typeof body !== 'object') {
    return reply.status(400).send({
      success: false,
      error: 'Corpo da requisição inválido. Envie um JSON com o campo "query".',
    });
  }

  const { query, bookId } = body;

  if (!query || typeof query !== 'string' || query.trim() === '') {
    return reply.status(400).send({
      success: false,
      error: 'O campo "query" é obrigatório e deve ser uma string não vazia.',
    });
  }

  if (bookId !== undefined && bookId !== null) {
    if (typeof bookId !== 'string' || !UUID_REGEX.test(bookId)) {
      return reply.status(400).send({
        success: false,
        error: 'O campo "bookId" fornecido deve ser um UUID válido.',
      });
    }
  }

  try {
    const retrievalResult = await retrieveRelevantChunks(query, {
      bookId: bookId || null,
    });

    return reply.status(200).send({
      success: true,
      query: retrievalResult.query,
      results: retrievalResult.results,
      totalResults: retrievalResult.totalResults,
    });
  } catch (error) {
    const errorMessage = error.message || 'Erro interno ao realizar busca semântica.';

    if (errorMessage.includes('não encontrado')) {
      return reply.status(404).send({
        success: false,
        error: errorMessage,
      });
    }

    if (
      errorMessage.includes('não pode ser vazia') ||
      errorMessage.includes('excede o limite') ||
      errorMessage.includes('inválido')
    ) {
      return reply.status(400).send({
        success: false,
        error: errorMessage,
      });
    }

    request.log.error(error);
    return reply.status(500).send({
      success: false,
      error: 'Falha interna ao processar a recuperação vetorial.',
    });
  }
}
