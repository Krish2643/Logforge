# LogForge

LogForge is a local-first foundation for a log ingestion and analytics platform. The React/Vite dashboard uses an Express API backed by PostgreSQL and Prisma. Phase 2 adds accounts, revocable sessions, owner-scoped projects, ingestion-job metadata, and project-scoped log search. Phase 3 adds direct, verified uploads of `.log` and `.jsonl` files into private Cloudflare R2 storage. Phase 4 adds a Redis/BullMQ processing pipeline that parses uploaded logs into project-scoped events. Phase 5 provides a PostgreSQL-backed Log Explorer for searching and filtering those events.

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- Docker Desktop with Docker Compose

## Local setup

From the repository root, copy `.env.example` to `.env`, then run:

```powershell
npm install
npm run db:up
npm run db:migrate
```

Start the API and web app in separate terminals:

```powershell
npm run dev:api
npm run dev:worker
npm run dev:web
```

Open <http://localhost:5173>. The API is available at <http://localhost:3001/health>. The dashboard requests `/api/health`; Vite forwards that request to the API during local development.
Use the **Projects** link in the sidebar to manage owned projects. The app also provides `/login` and `/register` routes; successful registration signs the new user in automatically.
The Projects page shows the newest projects first. The newest project opens by default; use **Collapse** or **Expand** to control each project's upload and ingestion-job details.

## Connect with pgAdmin

The Compose database is published on host port `15432` because ports `5432` and `5433` were already occupied on this development machine. In pgAdmin, register a server with host `127.0.0.1`, port `15432`, maintenance database `logforge`, username `logforge`, and the password in your local `.env`. The container itself still listens on port `5432`.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Type-check the shared package and both applications |
| `npm test` | Run API and dashboard tests |
| `npm run build` | Build all workspaces |
| `npm run db:validate` | Validate the Prisma schema |
| `npm run db:down` | Stop PostgreSQL without deleting its data |
| `npm run db:up` | Start or restart PostgreSQL |
| `npm run dev:worker` | Run the separate ingestion worker |

The PostgreSQL data is stored in a named Docker volume. `npm run db:down` preserves that volume; deleting it with `docker compose down -v` permanently removes the local database and is not part of the normal stop/restart workflow.

## Configuration

`.env.example` documents the local settings. Copy it to `.env` and adjust values if the PostgreSQL port or credentials conflict with your machine. The real `.env` is ignored by Git.

The API validates its required `DATABASE_URL` and optional `PORT`, `LOG_LEVEL`, and `NODE_ENV` before binding its HTTP port. The frontend uses `VITE_API_BASE_URL` (default `/api`) as the API base URL; local development routes that prefix through the Vite proxy. For a deployed frontend, configure the URL to the API origin and ensure the API's deployment has an appropriate same-origin/reverse-proxy setup. The current API does not enable cross-origin CORS.

R2 credentials are optional while developing the Phase 1/2 features. To enable uploads, set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET_NAME` in the API's `.env`; the account ID derives the default `R2_ENDPOINT`, and the S3 region defaults to `auto`. `R2_PRESIGNED_URL_TTL_SECONDS` defaults to 300 and is capped at 900 seconds. `MAX_UPLOAD_SIZE_BYTES` defaults to `100000000` and may be lowered, but not below 10,000,000 bytes. Supplying only some R2 credentials is a startup configuration error. These settings are API-only and must never use a `VITE_` prefix.

Create a **private** R2 bucket and an R2 API token scoped to that bucket with object read/write permissions. Paste the token's access key ID and secret into the API environment; do not commit them or print presigned URLs. Configure the bucket's CORS policy using [cloudflare-r2-cors.json](./infra/cloudflare-r2-cors.json). For production, replace its local development origins with the exact deployed frontend origin(s); do not use `*`. CORS enables browser PUT requests but is not authorization—the short-lived, single-object presigned URL is the upload capability.

To verify the API startup error for invalid configuration in PowerShell:

```powershell
$env:DATABASE_URL = "not-a-postgres-url"
npm run dev:api
$env:DATABASE_URL = $null
```

The process should exit with a readable configuration error. Environment variables set in the shell take precedence over `.env`.

## Phase 2 API

All protected routes require an `Authorization: Bearer <accessToken>` header. Registering or logging in returns an opaque, randomly generated token; only its SHA-256 hash is stored in PostgreSQL. Sessions expire after seven days and can be revoked with logout. Passwords are hashed with Node's built-in scrypt implementation. Keep access tokens out of source control and logs, and do not store them in long-lived browser storage such as `localStorage`.

The browser stores the bearer token only in tab-scoped `sessionStorage` so refresh can restore the session through `/api/auth/me`; logout and expired/invalid-session responses clear it. `sessionStorage` is still accessible to JavaScript, so it is not protection against XSS. The API currently returns bearer tokens rather than setting HttpOnly cookies; do not add untrusted scripts to this frontend. The Phase 2 UI has public registration because the backend exposes public registration.

Browser verification:

1. Start the database, API, and Vite app as shown above.
2. Visit `http://localhost:5173/register`, create an account with a valid email and a 12–128-character password, and confirm the dashboard opens.
3. Open **Projects**, create a project, and confirm it appears in the list.
4. Refresh the page; confirm the dashboard loads only after session restoration.
5. Log out, confirm the login screen appears, then sign in again. Open the same browser origin in a private/incognito window to confirm its session is separate.
6. Try a bad password and a blank project name to see the error states. Use the API tests for cross-user project/job isolation.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Create a user and session |
| `POST` | `/api/auth/login` | Verify credentials and create a session |
| `POST` | `/api/auth/logout` | Revoke the current session |
| `GET` | `/api/auth/me` | Return the authenticated user |
| `POST` | `/api/projects` | Create a project owned by the current user |
| `GET` | `/api/projects` | List only the current user's projects |
| `POST` | `/api/projects/:id/jobs` | Create a metadata-only job in an owned project |
| `GET` | `/api/projects/:id/jobs` | List owner-scoped jobs with cursor pagination |
| `POST` | `/api/projects/:id/uploads` | Initialize or reuse an upload job and presign a PUT |
| `GET` | `/api/jobs/:id` | Read job status only through its project owner |
| `POST` | `/api/jobs/:id/upload-url` | Renew the URL for a still-created job |
| `POST` | `/api/jobs/:id/complete` | Verify the stored object and mark the job uploaded |
| `POST` | `/api/jobs/:id/cleanup` | Retry deletion of an invalid object |
| `GET` | `/api/uploads/limits` | Return the supported upload bounds |
| `GET` | `/api/projects/:id/logs` | Search logs belonging to an owned project |

For example, in PowerShell:

```powershell
$registerBody = @{
  email = "you@example.test"
  password = "choose-a-long-local-password"
} | ConvertTo-Json
$session = Invoke-RestMethod -Method Post `
  -Uri "http://localhost:3001/api/auth/register" `
  -ContentType "application/json" -Body $registerBody
$headers = @{ Authorization = "Bearer $($session.accessToken)" }
$project = Invoke-RestMethod -Method Post `
  -Uri "http://localhost:3001/api/projects" `
  -Headers $headers -ContentType "application/json" `
  -Body (@{ name = "My first project" } | ConvertTo-Json)
$job = Invoke-RestMethod -Method Post `
  -Uri "http://localhost:3001/api/projects/$($project.project.id)/jobs" `
  -Headers $headers -ContentType "application/json" -Body "{}"
Invoke-RestMethod -Method Get `
  -Uri "http://localhost:3001/api/jobs/$($job.job.id)" -Headers $headers
```

Metadata-only jobs remain in `created` status. File uploads transition a job from `created` to `uploaded` after the API confirms the R2 object; `uploaded` means ready for later processing, not processed. The browser creates one job, uploads directly to R2, and calls completion. The API verifies project/job ownership, object existence, actual byte length and content type before changing status. The Log Explorer uses the same owner-scoped endpoint and supports case-insensitive substring `q` across message and service, severity, exact service, inclusive ISO `from`/`to` timestamps, HTTP status and request ID from JSON attributes, ingestion job ID, and bounded cursor pagination. Until Phase 4 writes events, authorized searches return an empty list.

Errors use a common JSON shape with `error.code`, a safe `error.message`, and `error.requestId`. Validation failures are `400`, missing/invalid sessions `401`, uniqueness conflicts `409`, and missing or inaccessible projects/jobs `404`. Responses include `X-Request-ID`; a syntactically valid incoming ID is preserved, otherwise the API generates a UUID. Authentication endpoints are rate-limited per process; a multi-instance deployment will need a shared rate-limit store.

## Database changes and tests

The Phase 2 migration adds `users`, `sessions`, `projects`, and `ingestion_jobs`, and requires each `log_events` row to belong to a project. The Phase 3 migration adds upload metadata. The Phase 4 migration adds processing progress and failure fields, event provenance and deduplication, and a transactional outbox. It queues already completed uploads for processing when deployed. The Phase 5 migration adds a `(project_id, source, timestamp DESC)` index for project-scoped service filtering and ordering. Schema changes belong in version-controlled Prisma migrations. Use `npm run db:migrate` for local development and `npm run db:deploy` to apply committed migrations without creating new ones.

The API tests use unique `phase2-...@example.test` fixture accounts and remove only their own records. Start PostgreSQL and apply migrations before running the full test suite:

```powershell
npm run db:up
npm run db:migrate
npm test
```

To regenerate the Prisma client after changing the schema, run `npm run db:generate`. Generation is explicit rather than automatic during every build/test so a running Windows API process does not lock Prisma's native query engine file.

## Recovery check

With the API running, stop PostgreSQL using `npm run db:down` and load or refresh the dashboard. The health endpoint should report `503` and a database-unavailable state. Restart PostgreSQL using `npm run db:up`; once its Compose health check passes, refresh the dashboard. Prisma should reconnect on a later database query and the health endpoint should return `200`.

## Phase 3 uploads

File sizes use **decimal MB**: the supported range is 10,000,000 through the configured maximum, which defaults to 100,000,000 bytes (100 MB). `.log` uploads use `text/plain`; `.jsonl` uploads use `application/x-ndjson`. The backend limit is authoritative, and the authenticated `/api/uploads/limits` endpoint gives the frontend the same configured bounds.

The API creates a unique key that never contains the client filename. The frontend sends file bytes directly to the presigned R2 URL using XHR for byte-based progress; the API does not proxy large request bodies. R2 credentials stay on the server. Presigned URLs are bearer capabilities and must not be copied into tickets, logs, or chat. The PUT capability remains usable until it expires, including briefly after completion, and could overwrite that object's key if exposed. A repeated initialization with the same client idempotency key reuses the same job; after a failed/interrupted PUT, the UI requests a fresh URL for that job and retries.

Cloudflare's documented presigned PUT workflow can bind the content type, but this implementation does **not** claim the size limit is enforced at the storage boundary. A leaked URL may be used to store more data until expiry. Completion checks the actual R2 object size and media type; invalid objects are rejected, marked `failed`, and deleted. If deletion fails, `cleanup_pending` remains set and the authenticated cleanup endpoint can retry it. Database failures after R2 accepts a PUT leave the job `created`; completion can safely be retried. An object uploaded just before a browser closes can be completed later by retrying; this phase does not yet run an automated stale-job/orphan sweeper, so operators must monitor old `created` jobs and their recorded object keys.

Single PUT is used for the 100 MB maximum; multipart upload, checksums, ETag verification, and virus scanning are out of scope. A completed upload enters `queued`, then `processing`, and only becomes `completed` after its events are persisted. Do not treat `uploaded` as processed; it is a legacy/pre-processing state.

## Phase 4 processing

Start PostgreSQL and Redis with `docker compose up -d postgres redis`, apply migrations, then run `npm run dev:api`, `npm run dev:worker`, and `npm run dev:web` in separate terminals. `REDIS_URL` defaults to `redis://127.0.0.1:16379`; `PROCESSING_BATCH_SIZE` and `MAX_LOG_LINE_BYTES` bound database batches and individual line buffering.

The API changes a verified upload to `queued` and inserts a `processing_outbox` row in the same PostgreSQL transaction. The API and worker relay outbox rows into BullMQ using the ingestion job ID as a stable queue ID. This closes the database/Redis dual-write gap through retries; it does not claim a distributed transaction or exactly-once execution. The worker can safely retry from the start because each event is unique by ingestion job and source line. `.log` key/value lines and `.jsonl` records are parsed into `log_events`; missing timestamps remain null and malformed lines are counted. The project uploads view polls while jobs are queued or processing and shows persisted progress and failure details.

Queued or processing jobs can be cancelled from the project job list. Cancellation uses a persisted request timestamp and status transition, not BullMQ job deletion. A queued job is marked `cancelled` immediately; an active worker observes the request at its next bounded batch boundary and stops. The worker and cancellation API serialize batch writes and cancellation on the ingestion-job row, so a batch already committed before cancellation remains, but no later batch is inserted. The UI reports the number of retained events for cancelled jobs; cancellation does not delete those partial events or the original R2 object. A completed job remains completed if cancellation arrives after completion.

Cancelled and failed jobs can be retried from the same project job list. Retry verifies the original R2 object, reuses the ingestion-job ID and object key, clears cancellation/failure state, resets line/byte/malformed progress, and initializes the event count from rows already persisted. The job's `processing_attempt` is incremented atomically with the queued transition and outbox reset. The relay uses the job ID plus attempt generation as the BullMQ ID, so a retained old BullMQ job cannot block a retry and stale workers cannot modify a newer attempt. Processing starts from line one; PostgreSQL uniqueness on `(ingestion_job_id, line_number)` and `skipDuplicates` preserve existing events without duplicating them. A missing or mismatched R2 object returns a conflict and leaves the job unchanged. Retry is only available for `cancelled` and `failed`; active or completed jobs are not reprocessed.

### Test a real R2 upload

1. Create a private bucket and a bucket-scoped API token. Configure the API environment variables above and restart the API.
2. Apply [cloudflare-r2-cors.json](./infra/cloudflare-r2-cors.json) in the bucket's CORS settings. Use the actual local origin while testing; for deployment, allow only the exact app origin and the `PUT` method with the `Content-Type` header.
3. Apply migrations (`npm run db:deploy`), run `npm run dev:api` and `npm run dev:web`, then register or sign in.
4. Create a project, select a `.log` or `.jsonl` file between 10 MB and 100 MB, and upload it. Confirm byte progress reaches 100% and success appears only after backend verification.
5. In the R2 dashboard confirm the bucket remains private and the object is stored under a generated `projects/<project-id>/jobs/<uuid>` key. In PostgreSQL confirm the job progresses from `queued` to `processing` and `completed`, with filename, byte count, progress, and completion timestamp.
6. Test a wrong extension, a file under 10 MB, an expired URL (wait past TTL), and an interrupted upload. The frontend should show an error and allow a safe retry where possible.

The ordinary automated tests use a fake storage adapter and do not need Cloudflare credentials.

## Measuring search, ingestion, and memory

- **Search latency:** the Log Explorer shows `Database round trip` for each search. This is the elapsed time around Prisma's PostgreSQL `findMany` call, including driver/network overhead, but excluding project authorization, cursor validation, and response rendering. It is not PostgreSQL's internal execution-only time; use `EXPLAIN (ANALYZE, BUFFERS)` in pgAdmin for that, noting that `ANALYZE` executes the query.
- **Processing duration:** each ingestion job shows duration from persisted `processing_started_at` to `processing_completed_at`. For an active job, the duration is live and based on the current clock. It excludes time waiting in the queue. Failed/cancelled jobs include their persisted terminal timestamp when available; retries start a new timing interval.
- **Stored event count:** job progress displays `stored events` from `events_persisted`. The worker counts database rows after each committed batch, so duplicate source lines skipped during retries are not counted twice. For an independent read-only cross-check in pgAdmin, query `SELECT count(*) FROM log_events WHERE ingestion_job_id = '<job UUID>'::uuid;` and compare with `ingestion_jobs.events_persisted`.
- **Memory:** the Dashboard's **Runtime resources** card polls authenticated `GET /api/metrics/runtime` every two seconds. API RSS/heap are snapshots when each endpoint request is handled. The worker publishes RSS/heap once per second to Redis, and the card shows the latest snapshot plus the sampled peak during processing. Memory values are process-level and include more than the specific job; periodic peaks may miss spikes between samples. Worker metrics are reported as unavailable if the worker has not published in the last five seconds.

The worker/API memory endpoint is local operational telemetry, not a long-term metrics store. The browser only retains live snapshots while the Dashboard is open; restarting a process or closing the browser does not preserve a history. For repeatable comparisons, record file size, job ID, query filters/page size, the displayed timings, event count, and memory snapshots for each run. Avoid comparing runs made under different system load or with different data/index state.

## Phase 5 Log Explorer

Open **Projects** and choose **Explore logs** for a project. The page reads persisted events from `GET /api/projects/:id/logs`; it does not access R2 or use mock records. Search is submitted explicitly and performs case-insensitive literal substring matching against the stored message and service (`source`); SQL LIKE wildcard characters are escaped. It is not PostgreSQL full-text search and does not provide fuzzy or typo-tolerant matching. Severity uses the parser's normalized values (`trace`, `debug`, `info`, `warn`, `error`, `fatal`). Service is an exact text filter. HTTP status and request ID are exact filters over the `status` and `request_id` JSON attributes. Time inputs are converted from browser-local time to UTC ISO strings; `from` and `to` are both inclusive. Filters combine with AND semantics.

Results are ordered by timestamp descending and UUID descending and fetched in pages of at most 100 records (the UI requests 50). The API returns a next cursor, not an exact total count; the UI reports the number on the current page. Existing indexes support project/time and project/severity/time ordering. The Phase 5 service index supports exact project/service/time queries. Message/service substring and JSON attribute filtering do not have dedicated indexes; measure representative workloads before adding PostgreSQL trigram/full-text or JSON expression indexes. The current migration creates a normal index and is intended for this local development schema; on a large production table, plan an appropriate concurrent-index migration outside a transaction to avoid a long write-blocking lock.

Run API and frontend tests with `npm test`, type-check with `npm run typecheck`, and build with `npm run build`. These automated tests use PostgreSQL test fixtures and mocked browser API responses; they do not benchmark production-sized data. To manually verify the UI, start the database/API/web app, process a log file, open its project's **Explore logs** link, search for known message text, combine filters, expand an event's details, and use Next/Previous to navigate.

## Architecture

See [docs/architecture.md](docs/architecture.md) for the startup/request flow, middleware order, Prisma behavior, and Docker networking. The local topology decision and its alternatives are recorded in [docs/decisions/0001-local-development.md](docs/decisions/0001-local-development.md).
Authentication and ownership trade-offs are recorded in [docs/decisions/0002-authentication-and-ownership.md](docs/decisions/0002-authentication-and-ownership.md).
