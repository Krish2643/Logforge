ALTER TYPE "IngestionJobStatus" ADD VALUE 'cancelled';

ALTER TABLE "ingestion_jobs"
ADD COLUMN "cancel_requested_at" TIMESTAMPTZ(6);
