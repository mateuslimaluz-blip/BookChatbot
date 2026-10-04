import {
  enqueueBookIngestion,
  getIngestionJob,
} from '../services/ingestionQueueService.js';

// Regex simples para validação de UUID v4 / UUID padrão
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Controller responsável pelo enfileiramento assíncrono de ingestão de um livro.
 * Responde rapidamente com HTTP 202 Accepted, liberando o cliente HTTP.
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
    const result = await enqueueBookIngestion(id);

    return reply.status(202).send({
      success: true,
      jobId: result.job.id,
      bookId: result.job.bookId,
      status: result.job.status,
      message: result.isExisting
        ? 'Já existe um trabalho de ingestão em andamento para este livro.'
        : 'Trabalho de ingestão enfileirado com sucesso.',
    });
  } catch (error) {
    const errorMessage = error.message || 'Erro interno ao enfileirar a ingestão do livro.';

    if (error.code === 'BOOK_NOT_FOUND' || errorMessage.includes('não encontrado')) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'BOOK_NOT_FOUND',
          message: errorMessage,
        },
      });
    }

    if (
      error.code === 'BAD_REQUEST' ||
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
        message: 'Falha ao processar o enfileiramento da ingestão do livro.',
      },
    });
  }
}

/**
 * Controller responsável por consultar o status e progresso de um trabalho de ingestão.
 *
 * @param {import('fastify').FastifyRequest<{ Params: { jobId: string } }>} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function getIngestionJobHandler(request, reply) {
  const { jobId } = request.params;

  if (!jobId || !UUID_REGEX.test(jobId)) {
    return reply.status(400).send({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'ID de trabalho inválido. Deve ser um UUID válido.',
      },
    });
  }

  try {
    const job = await getIngestionJob(jobId);

    if (!job) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'JOB_NOT_FOUND',
          message: `Trabalho de ingestão com ID ${jobId} não foi encontrado.`,
        },
      });
    }

    return reply.status(200).send({
      success: true,
      job,
    });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Falha ao consultar status do trabalho de ingestão.',
      },
    });
  }
}
