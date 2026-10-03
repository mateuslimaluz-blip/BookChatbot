CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "book_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_embeddings_book_id_chunk_index_unique" UNIQUE("book_id","chunk_index")
);
--> statement-breakpoint
CREATE TABLE "books" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(255) NOT NULL,
	"author" varchar(255) NOT NULL,
	"content" text,
	"content_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "books_content_or_path_check" CHECK ("books"."content" IS NOT NULL OR "books"."content_path" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "book_embeddings" ADD CONSTRAINT "book_embeddings_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_embeddings_book_id_idx" ON "book_embeddings" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "book_embeddings_embedding_hnsw_idx" ON "book_embeddings" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "books_title_idx" ON "books" USING btree ("title");