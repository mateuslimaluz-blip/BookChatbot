CREATE TABLE "ingestion_job_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingestion_job_chunks_job_chunk_unique" UNIQUE("job_id","chunk_index")
);
--> statement-breakpoint
CREATE TABLE "ingestion_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"status" varchar(32) DEFAULT 'queued' NOT NULL,
	"total_chunks" integer DEFAULT 0 NOT NULL,
	"completed_chunks" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"error_message" text,
	"content_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_attempt_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ingestion_job_chunks" ADD CONSTRAINT "ingestion_job_chunks_job_id_ingestion_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ingestion_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingestion_job_chunks_job_id_idx" ON "ingestion_job_chunks" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_book_id_idx" ON "ingestion_jobs" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_status_idx" ON "ingestion_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_next_attempt_idx" ON "ingestion_jobs" USING btree ("next_attempt_at");