# LogForge architecture

## Runtime pieces

- `apps/web` is a React application built and served by Vite.
- `apps/api` is an Express application. It owns HTTP middleware, authentication, and project-scoped API modules.
- `apps/api/src/worker-server.ts` is a separate BullMQ worker process; it streams verified objects from R2 and writes normalized events to PostgreSQL.
- `packages/shared` defines Zod request/response schemas shared by packages.
- PostgreSQL and Redis run as Compose-managed local dependencies.
- Prisma defines the database schema, generates the client, and applies version-controlled migrations.

Uploads are initiated and verified by the API but transferred directly from the browser to private Cloudflare R2 storage. The worker parses supported log lines into project-scoped events; broader analytics remain out of scope.

## Startup versus request handling

Starting the API is a one-time process lifecycle:

1. `server.ts` loads the root `.env` file, then `config/env.ts` validates the effective environment. Invalid configuration is printed as a clear fatal startup message and the process exits before listening.
2. The API creates its logger and BullMQ queue, starts an outbox relay, composes the Express app, and binds the configured port. Creating the Prisma client does not require an active database connection.
3. On `SIGINT` or `SIGTERM`, the API stops the relay and HTTP listener, closes its queue, and disconnects Prisma.

Each HTTP request follows a separate path:

1. `request-id.ts` validates an incoming `X-Request-ID` or creates a UUID, then returns it in the response header.
2. `request-logger.ts` records method, path, status, duration, and request ID as structured JSON. Query strings, headers, bodies, tokens, and raw error details are omitted.
3. Express's JSON parser runs before routes.
4. `/health` calls the health service, which asks Prisma to execute a small `SELECT 1` query. It returns `200` when PostgreSQL responds or `503` when it does not.
5. `/api/auth` handles registration/login and revocable sessions. Authenticated routes resolve a bearer token to a non-expired, non-revoked session before executing their feature logic.
6. Project and log queries filter by the authenticated user's project ownership. Job lookup filters by the owning user through the related project. A missing and another user's resource both return the same `404`.
7. `GET /api/projects/:id/jobs` verifies project ownership and lists persisted job metadata using the same bounded, cursor-based pagination convention as log search. Cursor IDs are checked against that project before use.
8. Upload initialization checks ownership, validates metadata, creates or reuses a `created` job with a server-generated object key, and signs a short-lived `PUT` URL. The browser sends the file to R2 directly and reports byte progress using XHR.
9. The authenticated completion endpoint checks the same project/job ownership and uses R2 `HeadObject` against the recorded key. It verifies actual content length and media type, then transactionally changes status to `queued` and creates a processing outbox record. A repeat completion checks the object again and returns the current job state.
10. Errors reach the final error middleware, which returns a consistent JSON shape with a safe message and request ID. Upload URLs and request bodies are not included in structured logs.
11. API and worker relays send pending outbox rows to BullMQ with the ingestion-job ID as a stable queue ID. The worker streams the R2 object, caps individual line buffering, parses `.log` or `.jsonl`, and inserts bounded batches. Unique `(ingestion_job_id, line_number)` records make replays idempotent; progress and safe failure details are persisted.
12. `POST /api/jobs/:id/cancel` requires authentication and checks ownership through the job's project. It takes a row lock on the job before deciding the transition. Queued jobs become `cancelled`; processing jobs retain `processing` and receive `cancel_requested_at` until the worker acknowledges cancellation. Repeated requests return the current state. Completed and failed jobs are returned unchanged, and other non-processing states reject cancellation.
13. `POST /api/jobs/:id/retry` is owner-scoped and permits only `cancelled` and `failed` jobs. Under the job row lock it verifies the original R2 object, counts already persisted events, increments `processing_attempt`, clears stale cancellation/failure state, resets progress, and resets the existing outbox row for dispatch. It does not create a new job or delete events.
14. `GET /api/projects/:id/logs` requires authentication, resolves project ownership before querying events, validates all filters and pagination parameters, and returns no more than the requested page size. Its `AND` filters cover normalized severity, inclusive timestamp bounds, exact service, HTTP status/request ID JSON attributes, and ingestion job ID. The case-insensitive literal substring query matches message or service with SQL LIKE wildcards escaped. Results sort by timestamp descending and UUID descending; a validated project-local event ID is used as the cursor anchor.
15. `GET /api/metrics/runtime` is authenticated. It reports API process memory at request time and reads a recent worker-process memory snapshot from Redis. The worker samples process memory once per second and tracks sampled RSS/heap peaks while processing; Redis expiry and a five-second freshness limit ensure stopped workers are not represented as live. This is transient telemetry, not historical metrics storage.

Log-search responses include `databaseQueryDurationMs`, measured around the Prisma event `findMany` call with a monotonic clock. This is database-call round-trip duration (including driver/network overhead), not PostgreSQL executor-only time. Ingestion duration can be derived from the persisted processing start/completion timestamps; the UI shows a live elapsed interval for active jobs. `events_persisted` is refreshed from a database count after each committed processing batch, making it the number of unique stored events even when replayed lines are skipped. The dashboard memory card shows RSS and V8 heap separately; worker peak values are sampled and can miss short-lived spikes.

The health check remains a readiness/dependency check, not merely proof that the Node process exists. It is separate from authenticated API routes.

## Web-to-API flow

The dashboard calls `/api/health`. Vite's development proxy rewrites only that route to `/health`; other `/api/...` requests preserve the prefix and reach their matching Express route. This keeps the browser on one origin during local development and avoids introducing CORS configuration. The browser validates the health response against the shared Zod schema before displaying it.

The web app uses React Router for public `/login` and `/register` pages and protected `/dashboard`, `/projects`, and `/projects/:id/logs` pages. On startup, `AuthProvider` reads a tab-scoped bearer token and calls `/api/auth/me` before rendering protected content. A `401` from an authenticated API call clears the token and user state centrally. Login and registration save the returned token in `sessionStorage`; logout calls the API, then clears local authentication state even if revocation cannot be confirmed. The current backend has no HttpOnly-cookie flow, so this is a practical refresh-persistence choice, not protection against XSS.

The Projects page reads upload bounds from `/api/uploads/limits`, creates a job through `/api/projects/:id/uploads`, and uploads the selected file directly to the returned R2 URL with XHR. It then calls `/api/jobs/:id/complete` and reads the job again before showing success. The project UI lists persisted jobs from `/api/projects/:id/jobs`, including after page refresh, and reloads the list after a successful upload. It polls while any job remains queued or processing and displays persisted progress, counts, and failure reasons. API calls use the existing bearer-token client; the direct R2 PUT does not receive the API authorization header. Failed transfers renew the URL for the same job. The client-generated idempotency key makes repeated initialization idempotent within a project.

The project page links to the Log Explorer. The explorer submits filters explicitly, translates browser-local date/time inputs to UTC ISO timestamps, and resets its cursor when filters change. It renders events returned by the API, exposes stored JSON attributes in a disclosure panel, and only displays a page count rather than running an exact count query. It uses message/service substring search and exact filters for service, severity, job, and selected JSON attributes; no full-text or typo-tolerant search is claimed.

## Prisma and migrations

Prisma's client is a process-level singleton. It manages a connection pool and acquires connections when queries are made; the API does not need a one-off connection for every request. Database uniqueness constraints enforce unique normalized emails and unique project names per owner, including under concurrent requests. Foreign keys prevent orphan sessions, projects, jobs, and events. User creation and session creation happen in one database transaction.

`schema.prisma` is the declarative model. The checked-in SQL migration is the actual ordered database change. Versioning migrations makes schema evolution reviewable and lets each developer or deployment apply the same changes. Local development uses `prisma migrate dev`; deployment uses `prisma migrate deploy`.

The data relationships are:

```text
User 1 ── * Session
User 1 ── * Project
Project 1 ── * IngestionJob
Project 1 ── * LogEvent
```

A job's authorization owner is obtained through its project; it does not duplicate `userId`. The Phase 2 migration adds the required project foreign key to `log_events`. It first checks that the existing table has no rows; if it finds unowned events, it aborts before modifying the schema so existing data is not silently lost or assigned to an arbitrary owner.

The Phase 3 migration adds the `uploaded` state and nullable per-job upload metadata (`object_key`, original filename, declared byte count, media type, completion time, and cleanup flag). Nullable columns preserve existing metadata-only jobs. A scoped unique upload request ID makes repeated initialization return the same job. Object keys are unique, generated by the API, and never derived from a filename. The job API omits the internal object key from responses.

The Phase 4 migration adds processing progress/timing/failure fields and a `processing_outbox`. Previously verified `uploaded` jobs are moved to `queued` and get outbox rows. This lets the system recover if PostgreSQL commits a queue request while Redis is unavailable. Relays retry delivery; the BullMQ job ID is stable, while worker database writes are independently idempotent because queue execution is at-least-once. The cancellation migration adds the `cancelled` status and nullable `cancel_requested_at` timestamp. The retry migration adds a generation counter to jobs and outbox rows. A relay dispatches with a generation-specific BullMQ ID and payload, preventing retained queue entries or stale workers from affecting a later retry.

The `log_events` table has a UUID primary key, required project ID, optional ingestion-job ID and timestamp, source line number, level, message, optional source, JSON attributes, and indexes for project/time, project/level/time, and project/source/time queries. The additional service index supports the Explorer's service filter alongside timestamp ordering. Unique ingestion-job/line provenance prevents duplicate events on worker retries and user-requested reprocessing. Retry starts the original object from line one, recalculates the persisted event count from the database, and uses the stable job/line key with `skipDuplicates`; previously written lines remain unchanged, while later lines can be inserted. Line/byte/malformed progress resets for a new generation. Each worker batch locks the job row and checks its attempt generation and cancellation in the same transaction as event insertion and progress updates. The cancellation endpoint takes the same row lock; therefore a batch either commits before cancellation is recorded or observes cancellation and inserts nothing. A completed transition also takes the lock and checks cancellation, so terminal completion and cancellation cannot overwrite each other. Cancellation retains events committed by earlier batches and reports their count; it does not perform event or R2 cleanup. Retry verifies the stored object through R2 `HeadObject`; if the object is missing or its size/type differ from the recorded metadata, the API returns a conflict and leaves the job unchanged. Only cancelled and failed statuses are retryable.

Message/service substring matching and JSON-attribute predicates are not covered by dedicated indexes; the service index only supports the exact service filter. No performance improvement is claimed without measured plans on representative data. For large production tables, plan index creation (including the service index) using `CREATE INDEX CONCURRENTLY` in an appropriate migration process that does not wrap the statement in a transaction; the checked-in local migration uses a normal index creation.

## Authentication and authorization

Passwords use Node's built-in scrypt password hashing with a random salt. Login and registration create a 256-bit random opaque bearer token. PostgreSQL stores only its SHA-256 hash, expiry, and revocation time. Every protected request hashes the presented token and looks up the active session. This requires a database lookup but permits immediate logout/revocation and avoids signing-key management.

Authentication proves which user is making a request; it does not grant access to every project or job. Project creation stores the authenticated user's ID as owner. Project listing filters by that owner. Job creation first checks the user's ownership of the requested project inside a transaction; job reads query through `job.project.ownerId`. Logs queries likewise verify project ownership and include the project ID in every log query. The API never trusts a submitted owner ID.

The API returns a bearer token once to the client. Do not place it in logs or source control. The browser stores it in tab-scoped `sessionStorage` to restore the session after refresh; this remains accessible to JavaScript and is not protection against XSS. Auth endpoints have a process-local rate limit; a horizontally scaled deployment needs a shared store and TLS.

## Docker networking

Compose publishes PostgreSQL on `127.0.0.1:15432` because the default PostgreSQL ports `5432` and `5433` were already occupied on the development machine. The host-run API uses that host port in `DATABASE_URL`; the database still listens on `5432` inside the container. If the API itself later runs in Compose, `localhost` would mean the API container; it would instead connect to the database using the Compose DNS service name, `postgres`, on container port `5432`. The named volume retains database data across a normal container stop/restart.

## Cloudflare R2 upload boundary

The API uses AWS SDK v3's S3 client and presigner against the Cloudflare R2 endpoint. Configure `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET_NAME` only in the API environment; the endpoint defaults to `https://<account-id>.r2.cloudflarestorage.com` and region defaults to `auto`. `R2_PRESIGNED_URL_TTL_SECONDS` defaults to 300 and is capped at 900 seconds. With no R2 credentials the API still supports Phase 1/2 and reports `storage_unavailable` when upload initialization is attempted; partial credential configuration fails startup validation.

The R2 bucket must stay private. Its CORS policy must list exact app origins and allow the `PUT` method and `Content-Type` header; a sample for the local Vite origins is in `infra/cloudflare-r2-cors.json`. Replace those entries with the exact production origin(s); never configure `*`. CORS is enforced by browsers and does not make the bucket public or replace project authorization.

The accepted size range is decimal MB: 10,000,000 to at most 100,000,000 bytes. Operators can lower the maximum with `MAX_UPLOAD_SIZE_BYTES`; `/api/uploads/limits` keeps frontend validation aligned with that value. A single PUT is sufficient for the 100 MB product limit and avoids multipart state/cleanup complexity. The API signs the expected media type but does not rely on a presigned-URL size restriction: completion checks the actual `HeadObject` length and content type after the transfer. Therefore a leaked PUT URL could temporarily store an oversized object until the API rejects and deletes it or the URL expires. The PUT capability also remains valid for its configured TTL after completion and can overwrite the same key; keep it secret and short-lived.

If R2 accepts a PUT but the database update fails, the job remains `created` and completion is safely retryable. If validation fails, the job moves to `failed` with `cleanup_pending`; the owner can retry the delete through `/api/jobs/:id/cleanup`. If a browser exits after a successful PUT but before completion, the job also remains `created` and can be completed later. There is no automatic stale-job/orphan sweeper in this phase; operators must monitor old created jobs and the object keys held in PostgreSQL. Checksums, virus scanning, multipart uploads, log parsing, and workers are not included.

## Environment and logging safety

The committed `.env.example` contains local-only sample values. The real `.env` is ignored. The sample database port is bound only to the host loopback interface. API logs avoid request bodies, query strings, authorization headers, and raw database exceptions. Health payloads intentionally expose availability, not credentials or internal database errors.
