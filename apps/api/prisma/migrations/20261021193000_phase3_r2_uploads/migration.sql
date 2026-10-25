ALTER TYPE "IngestionJobStatus" ADD VALUE 'uploaded';

ALTER TABLE "ingestion_jobs"
ADD COLUMN "upload_request_id" UUID,
ADD COLUMN "object_key" VARCHAR(512),
ADD COLUMN "original_filename" VARCHAR(255),
ADD COLUMN "file_size_bytes" INTEGER,
ADD COLUMN "content_type" VARCHAR(128),
ADD COLUMN "upload_completed_at" TIMESTAMPTZ(6),
ADD COLUMN "cleanup_pending" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "ingestion_jobs_object_key_key"
ON "ingestion_jobs"("object_key");

CREATE UNIQUE INDEX "ingestion_jobs_project_id_upload_request_id_key"
ON "ingestion_jobs"("project_id", "upload_request_id");
