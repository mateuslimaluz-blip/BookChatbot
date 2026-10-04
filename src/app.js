import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { env, validateProductionEnv } from './config/env.js';
import { closeDatabase } from './config/db.js';
import { apiRoutes } from './routes/api.js';
import { ingestionWorker } from './services/ingestionWorker.js';

// Valida variáveis obrigatórias no início
validateProductionEnv();

/**
 * Constrói e configura a instância do servidor Fastify com hardening de segurança.
 *
 * @param {object} [options] - Opções customizadas
 * @returns {import('fastify').FastifyInstance}
 */
export function buildApp(options = {}) {
  const app = Fastify({
    logger:
      process.env.NODE_ENV === 'test'
        ? false
        : {
            level: env.NODE_ENV === 'production' ? 'info' : 'debug',
            serializers: {
              req(req) {
                return {
                  id: req.id,
                  method: req.method,
                  url: req.url,
                  remoteAddress: req.ip,
                };
              },
            },
          },
    ajv: {
      customOptions: {
        removeAdditional: false, // Garante que additionalProperties: false rejeita com erro 400
      },
    },
    bodyLimit: env.HTTP_BODY_LIMIT_BYTES,
    connectionTimeout: env.HTTP_HANDLER_TIMEOUT_MS, // Configura Node.js server.connectionTimeout (inatividade no socket), não o tempo do handler
    ...options,
  });

  // 1. Headers de Segurança HTTP
  app.register(helmet, {
    contentSecurityPolicy: false, // Desabilitado para APIs puras JSON
    crossOriginEmbedderPolicy: false,
  });

  // 2. Rate Limiting Global
  app.register(rateLimit, {
    max: env.RATE_LIMIT_GLOBAL_MAX,
    timeWindow: '1 minute',
    errorResponseBuilder: (request, context) => ({
      success: false,
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Muitas requisições enviadas. Por favor, tente novamente mais tarde.',
        after: context.after,
      },
    }),
  });

  // 3. Tratamento Centralizado e Seguro de Erros Globais
  app.setErrorHandler((error, request, reply) => {
    // Erro de Validação de Schema do Fastify
    if (error.validation) {
      return reply.status(400).send({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message || 'Dados da requisição inválidos.',
        },
      });
    }

    // Erro de Payload / Body Limit excedido (FST_ERR_CTP_BODY_TOO_LARGE)
    if (error.statusCode === 413 || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send({
        success: false,
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'O tamanho do payload excede o limite máximo permitido pelo servidor.',
        },
      });
    }

    // Rate limit atingido
    if (error.statusCode === 429) {
      return reply.status(429).send({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Limite de requisições excedido.',
        },
      });
    }

    const statusCode = error.statusCode || 500;
    const isClientError = statusCode >= 400 && statusCode < 500;

    request.log.error({
      event: 'http_request_error',
      reqId: request.id,
      statusCode,
      errorCode: error.code || 'UNKNOWN',
      errorMessage: error.message,
    });

    if (isClientError) {
      return reply.status(statusCode).send({
        success: false,
        error: {
          code: error.code || 'BAD_REQUEST',
          message: error.message,
        },
      });
    }

    // Em produção, mascara erros internos para não vazar secrets, paths ou SQL
    return reply.status(500).send({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message:
          env.NODE_ENV === 'production'
            ? 'Ocorreu um erro interno ao processar a solicitação.'
            : error.message,
      },
    });
  });

  // 4. Tratamento de Rotas Não Encontradas (404)
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `A rota ${request.method} ${request.url} não foi encontrada.`,
      },
    });
  });

  // 5. Registro das Rotas da API
  app.register(apiRoutes, { prefix: '/api' });
  app.register(apiRoutes);

  // 6. Ciclo de Vida do Worker de Ingestão em Segundo Plano
  if (env.INGESTION_WORKER_ENABLED && env.NODE_ENV !== 'test') {
    app.addHook('onReady', async () => {
      app.log.info('[Worker] Inicializando IngestionWorker em segundo plano...');
      await ingestionWorker.start();
    });

    app.addHook('onClose', async () => {
      app.log.info('[Worker] Parando IngestionWorker...');
      await ingestionWorker.stop();
    });
  }

  return app;
}

const app = buildApp();

/**
 * Função de shutdown gracioso para garantir fechamento de conexões abertas
 */
export async function gracefulShutdown(signal) {
  app.log.info(`[Shutdown] Recebido sinal ${signal}. Encerrando servidor graciosamente...`);
  try {
    if (env.INGESTION_WORKER_ENABLED) {
      await ingestionWorker.stop();
    }
    await app.close();
    await closeDatabase();
    app.log.info('[Shutdown] Servidor e conexões de banco de dados encerrados com sucesso.');
    process.exit(0);
  } catch (err) {
    app.log.error('[Shutdown Error] Erro durante o encerramento:', err);
    process.exit(1);
  }
}

// Inicia o servidor apenas se for o arquivo principal
if (process.argv[1] && process.argv[1].endsWith('app.js')) {
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  app.listen({ port: env.PORT, host: env.HOST }, (err, address) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
    app.log.info(`BookChatbot backend rodando em ${address} [Ambiente: ${env.NODE_ENV}]`);
  });
}

export default app;
