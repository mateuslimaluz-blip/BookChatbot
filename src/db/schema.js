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
 * Relacionamentos (Drizzle Relations API)
 * Permite queries relacionais no Drizzle:
 * - 1 book -> N embeddings
 * - 1 embedding -> 1 book
 */
export const booksRelations = relations(books, ({ many }) => ({
  embeddings: many(bookEmbeddings),
}));

export const bookEmbeddingsRelations = relations(bookEmbeddings, ({ one }) => ({
  book: one(books, {
    fields: [bookEmbeddings.bookId],
    references: [books.id],
  }),
}));
