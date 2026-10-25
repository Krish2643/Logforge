ALTER TABLE "ingestion_jobs"
ADD COLUMN "processing_attempt" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "processing_outbox"
ADD COLUMN "processing_attempt" INTEGER NOT NULL DEFAULT 0;
