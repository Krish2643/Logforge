# ADR 0001: Local development topology

- Status: Accepted
- Date: 2026-10-20

## Context

Phase 1 needs a repeatable local PostgreSQL dependency while keeping the web and API startup/request paths easy to inspect. A database restart should not require restarting the API process.

## Decision

Run PostgreSQL in Docker Compose and run the React/Vite web app and Express API as host Node processes. Publish PostgreSQL only on the host loopback interface, retain its data in a named volume, and have the API probe the database during each health request. Keep migrations in version control and invoke them explicitly.

## Consequences

- Developers can inspect and debug the web/API processes directly.
- Host-run services connect to PostgreSQL via `127.0.0.1:15432`; an API container would instead use the Compose service name `postgres` on port `5432`.
- Compose starts only the database, so the web/API commands are run separately.
- A database outage is visible as `503` health while the API remains up; a later request checks recovery.
- This topology does not claim to be a production deployment.

## Alternatives considered

- **Run all services in Compose:** provides one containerized topology, but requires app Dockerfiles and adds container build/network configuration before those concepts are needed.
- **Run PostgreSQL directly on the host:** avoids Compose, but makes the development environment less reproducible and does not teach service-name networking.
- **Fail API startup when PostgreSQL is down:** makes startup ordering more fragile and forces a process restart for a temporary database outage.
