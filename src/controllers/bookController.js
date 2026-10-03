import { ingestBook } from '../services/ingestionService.js';

// Regex simples para validação de UUID v4 / UUID padrão
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Controller responsável pela ingestão e indexação vetorial de um livro.
 *
 * @param {import('fastify').FastifyRequest<{ Params: { id: string } }>} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function ingestBookHandler(request, reply) {
  const { id } = request.params;

  if (!id || !UUID_REGEX.test(id)) {
    return reply.status(400).send({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'ID de livro inválido. Deve ser um UUID válido.',
      },
    });
  }

  try {
    const result = await ingestBook(id);

    return reply.status(200).send({
      success: true,
      bookId: result.bookId,
      chunksCount: result.chunksCount,
      status: result.status,
      message: 'Livro ingerido e indexado com sucesso no RAG.',
    });
  } catch (error) {
    const errorMessage = error.message || 'Erro interno ao processar a ingestão do livro.';

    // Lock de ingestão concorrente em andamento (409 Conflict)
    if (
      error.code === 'INGESTION_IN_PROGRESS' ||
      error.statusCode === 409 ||
      errorMessage.includes('já está em andamento')
    ) {
      return reply.status(409).send({
        success: false,
        error: {
          code: 'INGESTION_IN_PROGRESS',
          message: 'A ingestão deste livro já está em andamento.',
        },
      });
    }

    if (errorMessage.includes('não encontrado')) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'BOOK_NOT_FOUND',
          message: errorMessage,
        },
      });
    }

    if (
      errorMessage.includes('Acesso negado') ||
      errorMessage.includes('não possui conteúdo') ||
      errorMessage.includes('excede o limite') ||
      errorMessage.includes('está vazio')
    ) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'BAD_REQUEST',
          message: errorMessage,
        },
      });
    }

    request.log.error(error);
    return reply.status(500).send({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Falha ao processar a ingestão do livro.',
      },
    });
  }
}
