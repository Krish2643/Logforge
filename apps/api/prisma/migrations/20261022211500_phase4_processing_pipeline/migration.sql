ALTER TABLE "ingestion_jobs"
ADD COLUMN "bytes_processed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lines_processed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "events_persisted" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "malformed_lines" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "failure_reason" TEXT,
ADD COLUMN "processing_started_at" TIMESTAMPTZ(6),
ADD COLUMN "processing_completed_at" TIMESTAMPTZ(6);

ALTER TABLE "log_events"
ALTER COLUMN "timestamp" DROP NOT NULL,
ALTER COLUMN "timestamp" DROP DEFAULT,
ADD COLUMN "ingestion_job_id" UUID,
ADD COLUMN "line_number" INTEGER;

ALTER TABLE "log_events"
ADD CONSTRAINT "log_events_ingestion_job_id_fkey"
FOREIGN KEY ("ingestion_job_id") REFERENCES "ingestion_jobs"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "log_events_ingestion_job_id_line_number_key"
ON "log_events"("ingestion_job_id", "line_number");

CREATE TABLE "processing_outbox" (
  "id" UUID NOT NULL,
  "ingestion_job_id" UUID NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dispatched_at" TIMESTAMPTZ(6),
  CONSTRAINT "processing_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "processing_outbox_ingestion_job_id_fkey"
    FOREIGN KEY ("ingestion_job_id") REFERENCES "ingestion_jobs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "processing_outbox_ingestion_job_id_key"
ON "processing_outbox"("ingestion_job_id");

CREATE INDEX "processing_outbox_dispatched_at_created_at_idx"
ON "processing_outbox"("dispatched_at", "created_at");

UPDATE "ingestion_jobs"
SET "status" = 'queued'
WHERE "status" = 'uploaded'
  AND "object_key" IS NOT NULL
  AND "original_filename" IS NOT NULL;

INSERT INTO "processing_outbox" ("id", "ingestion_job_id")
SELECT gen_random_uuid(), "id"
FROM "ingestion_jobs"
WHERE "status" = 'queued'
  AND "object_key" IS NOT NULL
  AND "original_filename" IS NOT NULL
ON CONFLICT ("ingestion_job_id") DO NOTHING;
