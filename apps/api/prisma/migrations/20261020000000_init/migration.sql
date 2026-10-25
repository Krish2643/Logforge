CREATE TABLE "log_events" (
    "id" UUID NOT NULL,
    "timestamp" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" VARCHAR(16) NOT NULL,
    "message" TEXT NOT NULL,
    "source" VARCHAR(255),
    "attributes" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "log_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "log_events_timestamp_idx"
    ON "log_events"("timestamp" DESC);

CREATE INDEX "log_events_level_timestamp_idx"
    ON "log_events"("level", "timestamp" DESC);
