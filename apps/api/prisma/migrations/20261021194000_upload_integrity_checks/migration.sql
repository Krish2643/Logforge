ALTER TABLE "ingestion_jobs"
ADD CONSTRAINT "ingestion_jobs_file_size_bytes_check"
CHECK ("file_size_bytes" IS NULL OR "file_size_bytes" BETWEEN 10000000 AND 100000000),
ADD CONSTRAINT "ingestion_jobs_uploaded_metadata_check"
CHECK (
  "status"::text <> 'uploaded'
  OR (
    "object_key" IS NOT NULL
    AND "original_filename" IS NOT NULL
    AND "file_size_bytes" IS NOT NULL
    AND "content_type" IS NOT NULL
    AND "upload_completed_at" IS NOT NULL
  )
),
ADD CONSTRAINT "ingestion_jobs_cleanup_pending_check"
CHECK (
  NOT "cleanup_pending"
  OR ("status"::text = 'failed' AND "object_key" IS NOT NULL)
);
