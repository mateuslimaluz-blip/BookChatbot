import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  jsonb,
  vector,
  index,
  unique,
  check,
} from 'drizzle-orm/pg-core';
import { sql, relations } from 'drizzle-orm';

/**
 * Dimensão dos vetores de embedding.
 * Configurada para 768 dimensões, mantendo total compatibilidade com o modelo
 * estável Google Gemini (gemini-embedding-2) com outputDimensionality: 768.
 */
export const EMBEDDING_DIMENSION = 768;

/**
 * Tabela: books
 * Armazena os livros cadastrados no sistema.
 * Integridade:
 * - Exige conteúdo efetivo em pelo menos um dos campos `content` ou `content_path`.
 * - Rejeita NULL, strings vazias e strings compostas apenas por espaços em branco.
 */
export const books = pgTable(
  'books',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    title: varchar('title', { length: 255 }).notNull(),
    author: varchar('author', { length: 255 }).notNull(),
    content: text('content'),
    contentPath: text('content_path'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      'books_content_or_path_check',
      sql`(${table.content} IS NOT NULL AND length(trim(${table.content})) > 0) OR (${table.contentPath} IS NOT NULL AND length(trim(${table.contentPath})) > 0)`
    ),
    index('books_title_idx').on(table.title),
  ]
);

/**
 * Tabela: book_embeddings
 * Armazena os chunks textuais e os respectivos embeddings semânticos dos livros.
 * Integridade:
 * - Foreign key para `books.id` com deleção em cascata (ON DELETE CASCADE)
 * - Restrição de unicidade para (book_id, chunk_index) evitando chunks duplicados
 * - Índice HNSW na coluna `embedding` com operador de distância cosseno (vector_cosine_ops)
 */
export const bookEmbeddings = pgTable(
  'book_embeddings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSION }).notNull(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('book_embeddings_book_id_idx').on(table.bookId),
    unique('book_embeddings_book_id_chunk_index_unique').on(
      table.bookId,
      table.chunkIndex
    ),
    index('book_embeddings_embedding_hnsw_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops')
    ),
  ]
);

/**
 * Tabela: ingestion_jobs
 * Gerencia a fila persistente de trabalhos assíncronos de ingestão de livros.
 * Suporta acompanhamento de progresso, retentativas e recuperação pós-falha.
 */
export const ingestionJobs = pgTable(
  'ingestion_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    bookId: uuid('book_id')
      .notNull()
      .references(() => books.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 32 }).notNull().default('queued'),
    totalChunks: integer('total_chunks').notNull().default(0),
    completedChunks: integer('completed_chunks').notNull().default(0),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    errorMessage: text('error_message'),
    contentHash: varchar('content_hash', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  },
  (table) => [
    index('ingestion_jobs_book_id_idx').on(table.bookId),
    index('ingestion_jobs_status_idx').on(table.status),
    index('ingestion_jobs_next_attempt_idx').on(table.nextAttemptAt),
  ]
);

/**
 * Tabela: ingestion_job_chunks
 * Staging persistente temporário para chunks e embeddings em processamento.
 * Permite retomada segura sem perder chunks já processados nem corromper
 * os embeddings ativos em caso de reinício ou 429 temporário.
 */
export const ingestionJobChunks = pgTable(
  'ingestion_job_chunks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => ingestionJobs.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSION }).notNull(),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('ingestion_job_chunks_job_id_idx').on(table.jobId),
    unique('ingestion_job_chunks_job_chunk_unique').on(
      table.jobId,
      table.chunkIndex
    ),
  ]
);

/**
 * Relacionamentos (Drizzle Relations API)
 * Permite queries relacionais no Drizzle:
 * - 1 book -> N embeddings
 * - 1 book -> N ingestionJobs
 * - 1 job -> N chunks temporários
 */
export const booksRelations = relations(books, ({ many }) => ({
  embeddings: many(bookEmbeddings),
  ingestionJobs: many(ingestionJobs),
}));

export const bookEmbeddingsRelations = relations(bookEmbeddings, ({ one }) => ({
  book: one(books, {
    fields: [bookEmbeddings.bookId],
    references: [books.id],
  }),
}));

export const ingestionJobsRelations = relations(ingestionJobs, ({ one, many }) => ({
  book: one(books, {
    fields: [ingestionJobs.bookId],
    references: [books.id],
  }),
  chunks: many(ingestionJobChunks),
}));

export const ingestionJobChunksRelations = relations(ingestionJobChunks, ({ one }) => ({
  job: one(ingestionJobs, {
    fields: [ingestionJobChunks.jobId],
    references: [ingestionJobs.id],
  }),
}));
