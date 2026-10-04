import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../config/db.js';
import { env } from '../config/env.js';
import {
  books,
  bookEmbeddings,
  ingestionJobs,
  ingestionJobChunks,
  EMBEDDING_DIMENSION,
} from '../db/schema.js';
import {
  generateAdvisoryLockKey,
  extractBookContent,
  splitIntoChunks,
} from './ingestionService.js';
import { generateChunkEmbedding } from './aiService.js';
import {
  getNextPendingJob,
  recoverOrphanedJobs,
} from './ingestionQueueService.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Worker em segundo plano responsável pelo processamento assíncrono e resiliente
 * da fila de jobs de ingestão de livros.
 */
export class IngestionWorker {
  constructor({
    pollIntervalMs = env.INGESTION_WORKER_POLL_INTERVAL_MS || 2_000,
    embeddingFn = generateChunkEmbedding,
  } = {}) {
    this.pollIntervalMs = pollIntervalMs;
    this.embeddingFn = embeddingFn;
    this.isRunning = false;
    this.isStopping = false;
    this.currentJobPromise = null;
    this.timer = null;
  }

  /**
   * Inicia o worker e agenda a primeira iteração após recuperar jobs órfãos.
   */
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isStopping = false;

    try {
      const recovered = await recoverOrphanedJobs();
      if (recovered > 0) {
        console.log(
          `[IngestionWorker] ${recovered} job(s) deixado(s) em execução foram recolocados na fila.`
        );
      }
    } catch (err) {
      console.error('[IngestionWorker] Falha ao recuperar jobs órfãos no startup:', err.message);
    }

    this._scheduleNext(100);
  }

  /**
   * Agenda a próxima verificação da fila.
   *
   * @private
   * @param {number} delayMs
   */
  _scheduleNext(delayMs = this.pollIntervalMs) {
    if (!this.isRunning || this.isStopping) return;
    this.timer = setTimeout(async () => {
      await this._tick();
    }, delayMs);
  }

  /**
   * Ciclo de trabalho unitário do worker.
   *
   * @private
   */
  async _tick() {
    if (!this.isRunning || this.isStopping) return;

    try {
      const job = await getNextPendingJob();
      if (job) {
        this.currentJobPromise = this.processJob(job.id);
        await this.currentJobPromise;
        this.currentJobPromise = null;
      }
    } catch (err) {
      console.error('[IngestionWorker] Erro no ciclo de polling do worker:', err.message);
    } finally {
      // Agenda a próxima verificação
      this._scheduleNext();
    }
  }

  /**
   * Processa um job de ingestão de forma segura, com suporte a retomada e persistência em staging.
   *
   * @param {string} jobId - UUID do job a processar
   */
  async processJob(jobId) {
    // 1. Busca os dados mais recentes do job
    const [job] = await db
      .select()
      .from(ingestionJobs)
      .where(eq(ingestionJobs.id, jobId));

    if (!job || job.status === 'completed' || job.status === 'failed') {
      return;
    }

    const lockKey = generateAdvisoryLockKey(job.bookId);
    let client = null;
    let hasLock = false;

    try {
      // 2. Conecta e adquire o PostgreSQL Advisory Lock para o livro
      client = await pool.connect();
      const lockResult = await client.query(
        'SELECT pg_try_advisory_lock($1::bigint) AS locked',
        [lockKey]
      );

      hasLock = Boolean(lockResult.rows?.[0]?.locked);

      if (!hasLock) {
        // Outro worker ou processo já está trabalhando neste livro
        return;
      }

      // 3. Atualiza o status do job para 'running'
      await db
        .update(ingestionJobs)
        .set({
          status: 'running',
          updatedAt: sql`now()`,
          errorMessage: null,
        })
        .where(eq(ingestionJobs.id, job.id));

      // 4. Busca o registro do livro
      const [book] = await db.select().from(books).where(eq(books.id, job.bookId));
      if (!book) {
        throw new Error(`Livro com ID ${job.bookId} não foi encontrado.`);
      }

      // 5. Extrai e valida o conteúdo do livro
      const { rawContent } = await extractBookContent(book);

      // 6. Validação de fingerprint/conteúdo para retomada segura
      const currentContentHash = crypto.createHash('sha256').update(rawContent).digest('hex');
      if (job.contentHash && job.contentHash !== currentContentHash) {
        const error = new Error(
          'O conteúdo do arquivo do livro foi modificado após o enfileiramento inicial. Por segurança, os chunks prévios foram invalidados.'
        );
        error.isPermanent = true;
        throw error;
      }

      // 7. Divide em chunks
      const chunks = splitIntoChunks(rawContent);
      if (!chunks || chunks.length === 0) {
        throw new Error('Não foi possível gerar chunks textuais válidos a partir do conteúdo do livro.');
      }

      // 8. Consulta chunks que já foram processados anteriormente neste job (staging)
      const existingChunks = await db
        .select({ chunkIndex: ingestionJobChunks.chunkIndex })
        .from(ingestionJobChunks)
        .where(eq(ingestionJobChunks.jobId, job.id));

      const processedIndices = new Set(existingChunks.map((c) => c.chunkIndex));

      // Atualiza o progresso atual no banco
      await db
        .update(ingestionJobs)
        .set({
          totalChunks: chunks.length,
          completedChunks: processedIndices.size,
          updatedAt: sql`now()`,
        })
        .where(eq(ingestionJobs.id, job.id));

      // 9. Processa os chunks pendentes serializadamente para respeitar o orçamento de TPM
      for (let i = 0; i < chunks.length; i++) {
        // Se o worker recebeu sinal de encerramento gracioso, para ordenadamente
        if (this.isStopping) {
          console.log(`[IngestionWorker] Encerramento solicitado. Pausando job ${job.id} no chunk ${i}.`);
          return;
        }

        // Pula chunks já salvos no staging
        if (processedIndices.has(i)) {
          continue;
        }

        const chunkText = chunks[i];

        // Gera embedding (respeitando o limitador de tokens da API)
        const embedding = await this.embeddingFn(book.title, chunkText);

        if (!embedding || !Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSION) {
          throw new Error(
            `Embedding gerado para o chunk ${i} é inválido ou não possui ${EMBEDDING_DIMENSION} dimensões.`
          );
        }

        // Salva chunk no staging temporário
        await db
          .insert(ingestionJobChunks)
          .values({
            jobId: job.id,
            chunkIndex: i,
            content: chunkText,
            embedding,
            metadata: {
              chunk_index: i,
              char_count: chunkText.length,
              title: book.title,
            },
          })
          .onConflictDoNothing();

        processedIndices.add(i);

        // Atualiza progresso no job
        await db
          .update(ingestionJobs)
          .set({
            completedChunks: processedIndices.size,
            updatedAt: sql`now()`,
          })
          .where(eq(ingestionJobs.id, job.id));
      }

      // 10. Todos os chunks foram processados com sucesso!
      // Promove atômica e seguramente os chunks de staging para `book_embeddings`
      await db.transaction(async (tx) => {
        // Busca todos os chunks prontos deste job
        const stagedChunks = await tx
          .select()
          .from(ingestionJobChunks)
          .where(eq(ingestionJobChunks.jobId, job.id))
          .orderBy(ingestionJobChunks.chunkIndex);

        if (stagedChunks.length !== chunks.length) {
          throw new Error(
            `Discrepância na contagem de chunks: esperado ${chunks.length}, encontrado ${stagedChunks.length}.`
          );
        }

        // Substitui os embeddings antigos pelos novos
        await tx.delete(bookEmbeddings).where(eq(bookEmbeddings.bookId, book.id));

        const newEmbeddings = stagedChunks.map((c) => ({
          bookId: book.id,
          chunkIndex: c.chunkIndex,
          content: c.content,
          embedding: c.embedding,
          metadata: c.metadata,
        }));

        if (newEmbeddings.length > 0) {
          await tx.insert(bookEmbeddings).values(newEmbeddings);
        }

        // Marca job como concluído
        await tx
          .update(ingestionJobs)
          .set({
            status: 'completed',
            completedChunks: chunks.length,
            totalChunks: chunks.length,
            updatedAt: sql`now()`,
            errorMessage: null,
          })
          .where(eq(ingestionJobs.id, job.id));

        // Limpa os dados temporários de staging
        await tx.delete(ingestionJobChunks).where(eq(ingestionJobChunks.jobId, job.id));
      });

      console.log(
        `[IngestionWorker] Job ${job.id} concluído com sucesso. ${chunks.length} chunks promovidos para o livro "${book.title}".`
      );
    } catch (err) {
      console.error(`[IngestionWorker] Falha ao processar job ${job.id}:`, err.message);

      // Tratamento de erro 429 / Rate Limit
      if (err.isRateLimit) {
        const backoffMs = err.retryAfterMs || 60_000;
        const nextAttemptAt = new Date(Date.now() + backoffMs);

        await db
          .update(ingestionJobs)
          .set({
            status: 'waiting_retry',
            attempts: sql`${ingestionJobs.attempts} + 1`,
            nextAttemptAt,
            updatedAt: sql`now()`,
            errorMessage: `Aguardando recuperação de limite de taxa Gemini (429 RESOURCE_EXHAUSTED). Retentativa agendada para ${nextAttemptAt.toISOString()}.`,
          })
          .where(eq(ingestionJobs.id, job.id));

        return;
      }

      // Verifica se excedeu tentativas máximas ou se é erro permanente
      const newAttempts = (job.attempts || 0) + 1;
      const isExhausted = newAttempts >= (job.maxAttempts || env.INGESTION_JOB_MAX_ATTEMPTS);
      const isPermanent = err.isPermanent || isExhausted;

      // Sanitiza mensagem de erro
      const safeMessage = (err.message || 'Erro interno durante processamento.')
        .replace(/key=[^&\s]+/gi, 'key=REDACTED')
        .replace(/postgresql:\/\/[^@]+@/gi, 'postgresql://REDACTED@');

      await db
        .update(ingestionJobs)
        .set({
          status: isPermanent ? 'failed' : 'waiting_retry',
          attempts: newAttempts,
          nextAttemptAt: isPermanent ? null : new Date(Date.now() + 30_000),
          updatedAt: sql`now()`,
          errorMessage: safeMessage,
        })
        .where(eq(ingestionJobs.id, job.id));
    } finally {
      // 11. Libera garantidamente o advisory lock e conexão
      if (hasLock && client) {
        try {
          await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]);
        } catch (unlockErr) {
          console.error('[IngestionWorker] Falha ao liberar advisory lock:', unlockErr.message);
        }
      }
      if (client) {
        client.release();
      }
    }
  }

  /**
   * Encerra o worker de forma graciosa aguardando a finalização da tarefa em curso.
   */
  async stop() {
    this.isStopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.currentJobPromise) {
      console.log('[IngestionWorker] Aguardando término do job em processamento...');
      try {
        await this.currentJobPromise;
      } catch {
        // Ignora erro no shutdown
      }
    }

    this.isRunning = false;
    console.log('[IngestionWorker] Worker encerrado graciosamente.');
  }
}

/**
 * Instância singleton do worker para a aplicação.
 */
export const ingestionWorker = new IngestionWorker();
