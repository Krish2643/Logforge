CREATE INDEX "log_events_project_id_source_timestamp_idx"
ON "log_events"("project_id", "source", "timestamp" DESC);
