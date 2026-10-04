import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sql, eq, desc } from 'drizzle-orm';
import { db } from '../config/db.js';
import { env } from '../config/env.js';
import { books, bookEmbeddings, ingestionJobs } from '../db/schema.js';
import { MAX_CONTENT_CHARS } from '../services/ingestionService.js';
import {
  enqueueBookIngestion,
  getIngestionJob,
} from '../services/ingestionQueueService.js';

// Regex simples para validação de UUID v4 / UUID padrão
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Controller responsável por listar livros com paginação, indicador de embeddings
 * e status do job mais recente, sem queries N+1 e sem expor dados internos sensíveis.
 *
 * @param {import('fastify').FastifyRequest<{ Querystring: { page?: number, limit?: number } }>} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function listBooksHandler(request, reply) {
  try {
    const rawPage = parseInt(request.query?.page, 10);
    const rawLimit = parseInt(request.query?.limit, 10);

    const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 1;
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 && rawLimit <= 100 ? rawLimit : 20;
    const offset = (page - 1) * limit;

    // 1. Contagem total de livros
    const countResult = await db.select({ total: sql`count(*)::int` }).from(books);
    const total = Number(countResult[0]?.total || 0);

    // 2. Consulta agregada atômica: livros + existência de embeddings + último job (Zero N+1)
    const result = await db.execute(sql`
      SELECT
        b.id,
        b.title,
        b.author,
        b.created_at AS "createdAt",
        EXISTS(SELECT 1 FROM book_embeddings be WHERE be.book_id = b.id) AS "hasEmbeddings",
        (
          SELECT json_build_object(
            'id', j.id,
            'status', j.status,
            'totalChunks', j.total_chunks,
            'completedChunks', j.completed_chunks,
            'progressPercentage', CASE WHEN j.total_chunks > 0 THEN ROUND((j.completed_chunks::numeric / j.total_chunks) * 100, 1) ELSE 0 END,
            'errorMessage', j.error_message,
            'createdAt', j.created_at,
            'updatedAt', j.updated_at
          )
          FROM ingestion_jobs j
          WHERE j.book_id = b.id
          ORDER BY j.created_at DESC
          LIMIT 1
        ) AS "latestJob"
      FROM books b
      ORDER BY b.created_at DESC
      LIMIT ${limit} OFFSET ${offset};
    `);

    const booksList = (result.rows || []).map((row) => ({
      id: row.id,
      title: row.title,
      author: row.author,
      createdAt: row.createdAt,
      hasEmbeddings: Boolean(row.hasEmbeddings),
      latestJob: row.latestJob || null,
    }));

    return reply.status(200).send({
      success: true,
      books: booksList,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Falha ao listar os livros cadastrados.',
      },
    });
  }
}

/**
 * Controller responsável por cadastrar um novo livro recebendo title, author e arquivo TXT via multipart/form-data.
 * Salva o arquivo com nome seguro em BOOKS_STORAGE_DIR e grava o caminho relativo no banco.
 * Se a gravação no banco falhar, o arquivo criado é removido imediatamente.
 *
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function createBookHandler(request, reply) {
  if (!request.isMultipart()) {
    return reply.status(400).send({
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'A requisição deve ser enviada como multipart/form-data com campos "title", "author" e arquivo "file".',
      },
    });
  }

  let title = '';
  let author = '';
  let fileBuffer = null;
  let originalFilename = '';

  try {
    const parts = request.parts();

    for await (const part of parts) {
      if (part.type === 'file') {
        originalFilename = part.filename || 'arquivo.txt';

        // Validação de extensão
        const lowerFilename = originalFilename.toLowerCase();
        if (!lowerFilename.endsWith('.txt')) {
          return reply.status(400).send({
            success: false,
            error: {
              code: 'INVALID_FILE_TYPE',
              message: 'Tipo de arquivo não permitido. Apenas arquivos com extensão .txt são aceitos.',
            },
          });
        }

        try {
          fileBuffer = await part.toBuffer();
        } catch (err) {
          if (err.code === 'FST_REQ_FILE_TOO_LARGE' || err.message?.includes('limit')) {
            return reply.status(400).send({
              success: false,
              error: {
                code: 'FILE_TOO_LARGE',
                message: `O arquivo enviado excede o limite máximo permitido de upload (${Math.round(env.MAX_UPLOAD_FILE_SIZE_BYTES / 1024 / 1024)}MB).`,
              },
            });
          }
          throw err;
        }
      } else {
        if (part.fieldname === 'title') {
          title = String(part.value || '').trim();
        } else if (part.fieldname === 'author') {
          author = String(part.value || '').trim();
        }
      }
    }
  } catch (parseError) {
    request.log.error(parseError);
    return reply.status(400).send({
      success: false,
      error: {
        code: 'MULTIPART_PARSE_ERROR',
        message: 'Falha ao processar o formulário multipart: ' + parseError.message,
      },
    });
  }

  // Validação dos campos obrigatórios
  if (!title || title.length > 255) {
    return reply.status(400).send({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'O campo "title" é obrigatório e deve ter entre 1 e 255 caracteres.',
      },
    });
  }

  if (!author || author.length > 255) {
    return reply.status(400).send({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'O campo "author" é obrigatório e deve ter entre 1 e 255 caracteres.',
      },
    });
  }

  if (!fileBuffer || fileBuffer.length === 0) {
    return reply.status(400).send({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Nenhum arquivo TXT válido foi enviado no campo "file" ou o arquivo está vazio.',
      },
    });
  }

  // Validação de conteúdo textual UTF-8 e tamanho máximo de caracteres
  const textContent = fileBuffer.toString('utf-8');
  if (textContent.trim().length === 0) {
    return reply.status(400).send({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'O arquivo TXT enviado não contém texto válido (está em branco).',
      },
    });
  }

  if (textContent.length > MAX_CONTENT_CHARS) {
    return reply.status(400).send({
      success: false,
      error: {
        code: 'CONTENT_TOO_LARGE',
        message: `O conteúdo do livro excede o limite máximo permitido de ${MAX_CONTENT_CHARS} caracteres.`,
      },
    });
  }

  // Gera nome seguro aleatório exclusivo para o arquivo (sem usar caminhos enviados pelo cliente)
  const safeFileName = `${Date.now()}_${crypto.randomUUID()}.txt`;
  const storageDir = path.resolve(env.BOOKS_STORAGE_DIR);
  const targetFilePath = path.join(storageDir, safeFileName);

  // Garante que o diretório de destino existe
  await fs.mkdir(storageDir, { recursive: true });

  // 1. Salva o arquivo no disco
  await fs.writeFile(targetFilePath, fileBuffer);

  // 2. Persiste o livro no banco de dados com caminho relativo
  try {
    const [newBook] = await db
      .insert(books)
      .values({
        title,
        author,
        contentPath: safeFileName, // Caminho relativo seguro compatível com extractBookContent
      })
      .returning({
        id: books.id,
        title: books.title,
        author: books.author,
        createdAt: books.createdAt,
      });

    return reply.status(201).send({
      success: true,
      book: newBook,
      message:
        'Livro cadastrado com sucesso. Para processar os embeddings e disponibilizá-lo para busca e chat, inicie a ingestão via POST /books/:id/ingest.',
    });
  } catch (dbError) {
    // Em caso de falha no banco de dados, remove o arquivo recém-criado para não deixar lixo no disco
    await fs.unlink(targetFilePath).catch(() => {});
    request.log.error(dbError);

    return reply.status(500).send({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Falha ao cadastrar o livro no banco de dados. O arquivo foi descartado.',
      },
    });
  }
}

/**
 * Controller responsável por consultar o status de um livro específico:
 * dados cadastrais, se possui embeddings e o status do job de ingestão mais recente ou ativo.
 * Permite que a interface web acompanhe a evolução mesmo após recarregar a página.
 *
 * @param {import('fastify').FastifyRequest<{ Params: { id: string } }>} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function getBookStatusHandler(request, reply) {
  const rawId = request.params?.id;
  const id = typeof rawId === 'string' ? rawId.trim().toLowerCase() : '';

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
    // 1. Busca os dados do livro
    const [book] = await db
      .select({
        id: books.id,
        title: books.title,
        author: books.author,
        createdAt: books.createdAt,
      })
      .from(books)
      .where(eq(books.id, id));

    if (!book) {
      return reply.status(404).send({
        success: false,
        error: {
          code: 'BOOK_NOT_FOUND',
          message: `Livro com ID ${id} não foi encontrado.`,
        },
      });
    }

    // 2. Verifica se o livro já possui embeddings ativos
    const [embeddingCheck] = await db
      .select({ count: sql`count(*)::int` })
      .from(bookEmbeddings)
      .where(eq(bookEmbeddings.bookId, id));

    const hasEmbeddings = Number(embeddingCheck?.count || 0) > 0;

    // 3. Busca o job de ingestão mais recente deste livro
    const [latestJob] = await db
      .select()
      .from(ingestionJobs)
      .where(eq(ingestionJobs.bookId, id))
      .orderBy(desc(ingestionJobs.createdAt))
      .limit(1);

    let sanitizedJob = null;
    if (latestJob) {
      const total = latestJob.totalChunks || 0;
      const completed = latestJob.completedChunks || 0;
      const progressPercentage =
        total > 0 ? Number(Math.min(100, (completed / total) * 100).toFixed(1)) : 0;

      sanitizedJob = {
        id: latestJob.id,
        status: latestJob.status,
        totalChunks: total,
        completedChunks: completed,
        progressPercentage,
        attempts: latestJob.attempts,
        maxAttempts: latestJob.maxAttempts,
        errorMessage: latestJob.errorMessage,
        createdAt: latestJob.createdAt,
        updatedAt: latestJob.updatedAt,
        nextAttemptAt: latestJob.nextAttemptAt,
      };
    }

    return reply.status(200).send({
      success: true,
      book,
      hasEmbeddings,
      latestJob: sanitizedJob,
    });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Falha ao consultar o status do livro.',
      },
    });
  }
}

/**
 * Controller responsável pelo enfileiramento assíncrono de ingestão de um livro.
 * Responde rapidamente com HTTP 202 Accepted, liberando o cliente HTTP.
 *
 * @param {import('fastify').FastifyRequest<{ Params: { id: string } }>} request
 * @param {import('fastify').FastifyReply} reply
 */
export async function ingestBookHandler(request, reply) {
  const rawId = request.params?.id;
  const id = typeof rawId === 'string' ? rawId.trim().toLowerCase() : '';

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
  const rawJobId = request.params?.jobId;
  const jobId = typeof rawJobId === 'string' ? rawJobId.trim().toLowerCase() : '';

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
