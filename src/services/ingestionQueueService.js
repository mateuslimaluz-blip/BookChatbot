import crypto from 'node:crypto';
import { eq, and, inArray, or, lte, isNull, sql } from 'drizzle-orm';
import { db } from '../config/db.js';
import { env } from '../config/env.js';
import { books, ingestionJobs } from '../db/schema.js';
import {
  extractBookContent,
  splitIntoChunks,
  MAX_CONTENT_CHARS,
} from './ingestionService.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Enfileira um trabalho de ingestão em segundo plano para um livro previamente cadastrado.
 * Se já houver um job ativo para o livro, retorna o job existente sem duplicar tarefas.
 *
 * @param {string} bookId - UUID do livro
 * @returns {Promise<{ job: object, isExisting: boolean }>}
 */
export async function enqueueBookIngestion(bookId) {
  if (!bookId || !UUID_REGEX.test(bookId)) {
    const error = new Error('ID de livro inválido. Deve ser um UUID válido.');
    error.code = 'VALIDATION_ERROR';
    error.statusCode = 400;
    throw error;
  }

  // 1. Busca o livro no banco de dados
  const [book] = await db.select().from(books).where(eq(books.id, bookId));
  if (!book) {
    const error = new Error(`Livro com ID ${bookId} não encontrado.`);
    error.code = 'BOOK_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }

  // 2. Extrai e valida o conteúdo do livro
  const { rawContent } = await extractBookContent(book);

  if (rawContent.length > MAX_CONTENT_CHARS) {
    const error = new Error(
      `Conteúdo do livro excede o limite máximo permitido de ${MAX_CONTENT_CHARS} caracteres.`
    );
    error.code = 'BAD_REQUEST';
    error.statusCode = 400;
    throw error;
  }

  // 3. Verifica se já existe job ativo em andamento para este livro
  const [existingActiveJob] = await db
    .select()
    .from(ingestionJobs)
    .where(
      and(
        eq(ingestionJobs.bookId, book.id),
        inArray(ingestionJobs.status, ['queued', 'running', 'waiting_retry'])
      )
    )
    .limit(1);

  if (existingActiveJob) {
    return {
      job: existingActiveJob,
      isExisting: true,
    };
  }

  // 4. Calcula o fingerprint do conteúdo para validação antes de retomadas
  const contentHash = crypto.createHash('sha256').update(rawContent).digest('hex');

  // 5. Calcula o total de chunks necessários
  const chunks = splitIntoChunks(rawContent);
  if (!chunks || chunks.length === 0) {
    const error = new Error(
      'Não foi possível gerar chunks textuais válidos a partir do conteúdo do livro.'
    );
    error.code = 'BAD_REQUEST';
    error.statusCode = 400;
    throw error;
  }

  // 6. Insere o job na fila persistente
  const [newJob] = await db
    .insert(ingestionJobs)
    .values({
      bookId: book.id,
      status: 'queued',
      totalChunks: chunks.length,
      completedChunks: 0,
      attempts: 0,
      maxAttempts: env.INGESTION_JOB_MAX_ATTEMPTS,
      contentHash,
      errorMessage: null,
      nextAttemptAt: null,
    })
    .returning();

  return {
    job: newJob,
    isExisting: false,
  };
}

/**
 * Consulta o status e progresso de um job de ingestão.
 * Sanitiza o retorno para nunca expor dados internos sensíveis, paths ou stack traces.
 *
 * @param {string} jobId - UUID do job
 * @returns {Promise<object|null>} Dados seguros do job ou null
 */
export async function getIngestionJob(jobId) {
  if (!jobId || !UUID_REGEX.test(jobId)) {
    const error = new Error('ID do job inválido. Deve ser um UUID válido.');
    error.code = 'VALIDATION_ERROR';
    error.statusCode = 400;
    throw error;
  }

  const [job] = await db
    .select()
    .from(ingestionJobs)
    .where(eq(ingestionJobs.id, jobId));

  if (!job) {
    return null;
  }

  const total = job.totalChunks || 0;
  const completed = job.completedChunks || 0;
  const progressPercentage =
    total > 0 ? Number(Math.min(100, (completed / total) * 100).toFixed(1)) : 0;

  return {
    id: job.id,
    bookId: job.bookId,
    status: job.status,
    totalChunks: total,
    completedChunks: completed,
    progressPercentage,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    nextAttemptAt: job.nextAttemptAt,
  };
}

/**
 * Recupera jobs que ficaram no estado 'running' após um reinício ou queda inesperada do processo,
 * recolocando-os em 'queued' para retomada segura.
 *
 * @returns {Promise<number>} Quantidade de jobs recuperados
 */
export async function recoverOrphanedJobs() {
  const result = await db
    .update(ingestionJobs)
    .set({
      status: 'queued',
      updatedAt: sql`now()`,
      errorMessage: 'Job recuperado automaticamente após reinício do servidor.',
    })
    .where(eq(ingestionJobs.status, 'running'))
    .returning();

  return result.length;
}

/**
 * Busca o próximo job disponível para processamento (queued ou waiting_retry com nextAttemptAt vencido).
 *
 * @returns {Promise<object|null>}
 */
export async function getNextPendingJob() {
  const now = new Date();

  const [job] = await db
    .select()
    .from(ingestionJobs)
    .where(
      or(
        eq(ingestionJobs.status, 'queued'),
        and(
          eq(ingestionJobs.status, 'waiting_retry'),
          or(
            isNull(ingestionJobs.nextAttemptAt),
            lte(ingestionJobs.nextAttemptAt, now)
          )
        )
      )
    )
    .orderBy(ingestionJobs.createdAt)
    .limit(1);

  return job || null;
}
