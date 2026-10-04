import {
  listBooksHandler,
  createBookHandler,
  getBookStatusHandler,
  ingestBookHandler,
  getIngestionJobHandler,
} from '../controllers/bookController.js';
import {
  chatHandler,
  searchRelevantChunksHandler,
} from '../controllers/chatController.js';
import { checkDatabaseHealth } from '../config/db.js';
import { env } from '../config/env.js';

/**
 * Schemas de validação JSON Schema do Fastify.
 */
const chatBodySchema = {
  body: {
    type: 'object',
    required: ['query'],
    additionalProperties: false,
    properties: {
      query: {
        type: 'string',
        minLength: 1,
        maxLength: env.MAX_QUERY_CHARS,
      },
      bookId: {
        type: 'string',
        pattern:
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
      },
    },
  },
};

const listBooksQuerySchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
  },
};

const bookIdParamsSchema = {
  params: {
    type: 'object',
    required: ['id'],
    additionalProperties: false,
    properties: {
      id: {
        type: 'string',
        pattern:
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
      },
    },
  },
};

const ingestRouteSchema = {
  params: {
    type: 'object',
    required: ['id'],
    additionalProperties: false,
    properties: {
      id: {
        type: 'string',
        pattern:
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
      },
    },
  },
  body: {
    type: 'object',
    additionalProperties: true,
  },
};

const jobParamsSchema = {
  params: {
    type: 'object',
    required: ['jobId'],
    additionalProperties: false,
    properties: {
      jobId: {
        type: 'string',
        pattern:
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
      },
    },
  },
};

/**
 * Registra as rotas da API no Fastify com validação de schemas, CORS e rate limiting granular.
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
export async function apiRoutes(fastify) {
  // 1. Listagem Paginada de Livros com Indicadores de Embedding e Último Job
  fastify.get(
    '/books',
    {
      schema: listBooksQuerySchema,
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_BOOKS_MAX,
          timeWindow: '1 minute',
        },
      },
    },
    listBooksHandler
  );

  // 2. Cadastro de Novo Livro com Upload de Arquivo TXT (Multipart/Form-Data)
  fastify.post(
    '/books',
    {
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_BOOKS_MAX,
          timeWindow: '1 minute',
        },
      },
    },
    createBookHandler
  );

  // 3. Consulta de Status Completo do Livro (Embeddings e Último Job de Ingestão)
  fastify.get(
    '/books/:id/status',
    {
      schema: bookIdParamsSchema,
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_BOOKS_MAX,
          timeWindow: '1 minute',
        },
      },
    },
    getBookStatusHandler
  );

  // 4. Enfileiramento de Ingestão RAG de Livro (Retorna HTTP 202 Accepted)
  fastify.post(
    '/books/:id/ingest',
    {
      schema: ingestRouteSchema,
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_INGEST_MAX,
          timeWindow: '1 minute',
        },
      },
    },
    ingestBookHandler
  );

  // 5. Consulta de Status e Progresso de Job de Ingestão por ID do Job
  fastify.get(
    '/ingestion-jobs/:jobId',
    {
      schema: jobParamsSchema,
    },
    getIngestionJobHandler
  );

  // 6. Rota Principal do Chatbot RAG
  fastify.post(
    '/chat',
    {
      schema: chatBodySchema,
      bodyLimit: env.HTTP_JSON_BODY_LIMIT_BYTES,
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_CHAT_MAX,
          timeWindow: '1 minute',
        },
      },
    },
    chatHandler
  );

  // 7. Rota de Recuperação Semântica do RAG (Diagnóstico / Search)
  fastify.post(
    '/chat/search',
    {
      schema: chatBodySchema,
      bodyLimit: env.HTTP_JSON_BODY_LIMIT_BYTES,
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_SEARCH_MAX,
          timeWindow: '1 minute',
        },
      },
    },
    searchRelevantChunksHandler
  );

  // 8. Liveness Probe (Verifica se o processo Fastify está ativo)
  fastify.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }));

  // 9. Readiness Probe (Verifica conectividade real com o PostgreSQL)
  fastify.get('/ready', async (request, reply) => {
    const isDbReady = await checkDatabaseHealth();
    if (!isDbReady) {
      return reply.status(503).send({
        status: 'unready',
        database: 'disconnected',
        timestamp: new Date().toISOString(),
      });
    }

    return reply.status(200).send({
      status: 'ready',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  });
}
