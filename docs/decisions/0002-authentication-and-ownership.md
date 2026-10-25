# ADR 0002: Authentication and project ownership

- Status: Accepted
- Date: 2026-10-21

## Context

Phase 2 needs user registration/login, durable project ownership, revocable access, and isolation of jobs/logs between users before file ingestion exists.

## Decisions

- Normalize email by trimming and lowercasing it before persistence; enforce uniqueness in PostgreSQL.
- Hash passwords with Node's built-in scrypt implementation and a per-password random salt.
- Use opaque, random bearer session tokens. Store only a SHA-256 token hash, expiry, and revocation timestamp in PostgreSQL.
- Keep project ownership on `Project.ownerId`. Jobs and logs refer to their project and do not duplicate a user ID.
- Filter all project/job/log reads and writes by the authenticated user's ownership. Return the same not-found response for a missing or foreign-owned resource.
- Enforce relationships and uniqueness in the database, not only with application prechecks. Create a user and initial session in one transaction.
- Restrict deletion of projects that have jobs/logs; Phase 2 has no delete endpoint or retention policy.
- Use a process-local registration/login rate limit for the local single-process API.

## Consequences

- Every authenticated request makes a session lookup, but sessions can be revoked immediately without signing-key rotation.
- Password hashing adds CPU/memory work, and authentication endpoints are rate-limited.
- Opaque bearer tokens are returned once and must not be persisted in browser local storage by default.
- Project ownership is represented in one authoritative place, so resource authorization must join/filter through the project.
- The local in-memory limiter is not sufficient for multiple API instances.
- Existing unowned `log_events` prevent the Phase 2 migration from proceeding. The migration aborts before schema changes rather than discarding or guessing ownership.

## Alternatives considered

- **JWT access tokens:** reduce database lookups, but complicate immediate revocation and key rotation.
- **HttpOnly cookie sessions:** reduce JavaScript token access, but require explicit cookie and CSRF policy; the current phase is an API-first bearer-token design.
- **Argon2id package:** a strong password-hashing standard, but adds a native/runtime dependency; scrypt is available in Node without another package.
- **Cascade project deletion:** simpler, but risks deleting durable logs/jobs; restrictive foreign keys are safer until retention behavior is designed.
