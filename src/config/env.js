import 'dotenv/config';
import path from 'node:path';

/**
 * Configuração centralizada e tipada das variáveis de ambiente da aplicação.
 * Fornece defaults seguros e validações de inicialização.
 */
export const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT) || 3000,
  HOST: process.env.HOST || '0.0.0.0',

  // Banco de Dados PostgreSQL
  DATABASE_URL:
    process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/bookchatbot',
  DB_POOL_MAX: Number(process.env.DB_POOL_MAX) || 10,
  DB_CONNECTION_TIMEOUT_MS: Number(process.env.DB_CONNECTION_TIMEOUT_MS) || 10_000,
  DB_IDLE_TIMEOUT_MS: Number(process.env.DB_IDLE_TIMEOUT_MS) || 30_000,

  // Google Gemini API
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_GENERATIVE_MODEL: process.env.GEMINI_GENERATIVE_MODEL || 'gemini-3.8-flash',
  GENERATION_TIMEOUT_MS: Number(process.env.GENERATION_TIMEOUT_MS) || 30_000,

  // Armazenamento Seguro de Livros
  BOOKS_STORAGE_DIR:
    process.env.BOOKS_STORAGE_DIR || path.resolve(process.cwd(), 'storage', 'books'),

  // Parâmetros de Pipeline RAG
  EMBEDDING_CONCURRENCY: Number(process.env.EMBEDDING_CONCURRENCY) || 3,
  RAG_CANDIDATE_K: Number(process.env.RAG_CANDIDATE_K) || 20,
  RAG_TOP_K: Number(process.env.RAG_TOP_K) || 8,
  RAG_MIN_SIMILARITY: Number(process.env.RAG_MIN_SIMILARITY) || 0.35,
  MAX_QUERY_CHARS: Number(process.env.MAX_QUERY_CHARS) || 4_000,
  MAX_CONTEXT_CHARS: Number(process.env.MAX_CONTEXT_CHARS) || 25_000,

  // Timeouts e Limites HTTP Fastify (connectionTimeout do socket Node.js)
  HTTP_HANDLER_TIMEOUT_MS: Number(process.env.HTTP_HANDLER_TIMEOUT_MS) || 45_000,
  HTTP_BODY_LIMIT_BYTES: Number(process.env.HTTP_BODY_LIMIT_BYTES) || 1_048_576, // 1MB global
  HTTP_JSON_BODY_LIMIT_BYTES: Number(process.env.HTTP_JSON_BODY_LIMIT_BYTES) || 65_536, // 64KB para rotas JSON

  // Rate Limiting (por minuto)
  RATE_LIMIT_GLOBAL_MAX: Number(process.env.RATE_LIMIT_GLOBAL_MAX) || 100,
  RATE_LIMIT_CHAT_MAX: Number(process.env.RATE_LIMIT_CHAT_MAX) || 30,
  RATE_LIMIT_SEARCH_MAX: Number(process.env.RATE_LIMIT_SEARCH_MAX) || 60,
  RATE_LIMIT_INGEST_MAX: Number(process.env.RATE_LIMIT_INGEST_MAX) || 5,

  // Controle de Taxa Gemini (TPM - Tokens Por Minuto) e Worker em Segundo Plano
  GEMINI_EMBEDDING_TPM_LIMIT: Number(process.env.GEMINI_EMBEDDING_TPM_LIMIT) || 20_000,
  INGESTION_WORKER_ENABLED: process.env.INGESTION_WORKER_ENABLED !== 'false',
  INGESTION_WORKER_POLL_INTERVAL_MS: Number(process.env.INGESTION_WORKER_POLL_INTERVAL_MS) || 2_000,
  INGESTION_JOB_MAX_ATTEMPTS: Number(process.env.INGESTION_JOB_MAX_ATTEMPTS) || 5,
};

/**
 * Validação de integridade do ambiente no startup da aplicação em produção.
 */
export function validateProductionEnv() {
  if (env.NODE_ENV === 'production') {
    const missing = [];
    if (!process.env.GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
    if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');

    if (missing.length > 0) {
      throw new Error(
        `[Startup Error] Variáveis obrigatórias ausentes em ambiente de produção: ${missing.join(', ')}`
      );
    }
  }
}
