DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "log_events") THEN
        RAISE EXCEPTION 'Phase 2 requires assigning existing log_events to a project before migration; no rows were changed';
    END IF;
END
$$;

CREATE TYPE "IngestionJobStatus" AS ENUM ('created', 'queued', 'processing', 'completed', 'failed');

CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ingestion_jobs" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "status" "IngestionJobStatus" NOT NULL DEFAULT 'created',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ingestion_jobs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "log_events"
    ADD COLUMN "project_id" UUID NOT NULL;

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");
CREATE INDEX "sessions_user_id_expires_at_idx" ON "sessions"("user_id", "expires_at");
CREATE UNIQUE INDEX "projects_owner_id_name_key" ON "projects"("owner_id", "name");
CREATE INDEX "projects_owner_id_created_at_idx" ON "projects"("owner_id", "created_at");
CREATE INDEX "ingestion_jobs_project_id_created_at_idx" ON "ingestion_jobs"("project_id", "created_at");

DROP INDEX "log_events_timestamp_idx";
DROP INDEX "log_events_level_timestamp_idx";
CREATE INDEX "log_events_project_id_timestamp_idx" ON "log_events"("project_id", "timestamp" DESC);
CREATE INDEX "log_events_project_id_level_timestamp_idx"
    ON "log_events"("project_id", "level", "timestamp" DESC);

ALTER TABLE "sessions"
    ADD CONSTRAINT "sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "projects"
    ADD CONSTRAINT "projects_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ingestion_jobs"
    ADD CONSTRAINT "ingestion_jobs_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "log_events"
    ADD CONSTRAINT "log_events_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
