import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import type { LogEventResponse, LogSearchQuery } from "@logforge/shared";
import { ApiError } from "../../../lib/api-client.js";
import { searchProjectLogs } from "../api/logs-client.js";

interface FilterForm {
  q: string;
  level: string;
  service: string;
  from: string;
  to: string;
  httpStatus: string;
  requestId: string;
  jobId: string;
}

const emptyFilters: FilterForm = {
  q: "",
  level: "",
  service: "",
  from: "",
  to: "",
  httpStatus: "",
  requestId: "",
  jobId: ""
};

const logLevels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

function toUtc(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Enter a valid date and time.");
  return date.toISOString();
}

function attributeText(attributes: unknown, key: string): string {
  if (typeof attributes !== "object" || attributes === null || Array.isArray(attributes)) return "—";
  const value = (attributes as Record<string, unknown>)[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "—";
}

function displayTimestamp(timestamp: string | null): string {
  return timestamp ? new Date(timestamp).toLocaleString() : "No timestamp";
}

export function LogExplorerPage() {
  const { id: projectId = "" } = useParams();
  const [filters, setFilters] = useState<FilterForm>(emptyFilters);
  const [appliedQuery, setAppliedQuery] = useState<LogSearchQuery>({ limit: 50 });
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [events, setEvents] = useState<LogEventResponse[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [databaseQueryDurationMs, setDatabaseQueryDurationMs] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  const currentCursor = cursorStack[cursorStack.length - 1];
  const query: LogSearchQuery = {
    ...appliedQuery,
    ...(currentCursor ? { cursor: currentCursor } : {})
  };

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    void searchProjectLogs(projectId, query, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setEvents(response.logs);
        setNextCursor(response.nextCursor);
        setDatabaseQueryDurationMs(response.databaseQueryDurationMs);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof ApiError || cause instanceof Error
          ? cause.message
          : "Unable to load log events.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [projectId, appliedQuery, currentCursor, retryKey]);

  function updateFilter(field: keyof FilterForm, value: string) {
    setFilters((current) => ({ ...current, [field]: value }));
  }

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilterError(null);
    try {
      const from = toUtc(filters.from);
      const to = toUtc(filters.to);
      if (from && to && Date.parse(from) > Date.parse(to)) {
        setFilterError("Start time must be earlier than or equal to end time.");
        return;
      }
      const nextQuery: LogSearchQuery = {
        limit: 50,
        ...(filters.q.trim() ? { q: filters.q.trim() } : {}),
        ...(filters.level ? { level: filters.level as LogSearchQuery["level"] } : {}),
        ...(filters.service.trim() ? { service: filters.service.trim() } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(filters.httpStatus ? { httpStatus: Number(filters.httpStatus) } : {}),
        ...(filters.requestId.trim() ? { requestId: filters.requestId.trim() } : {}),
        ...(filters.jobId.trim() ? { jobId: filters.jobId.trim() } : {})
      };
      setCursorStack([]);
      setAppliedQuery(nextQuery);
    } catch (cause) {
      setFilterError(cause instanceof Error ? cause.message : "Enter a valid date and time.");
    }
  }

  function clearFilters() {
    setFilters(emptyFilters);
    setFilterError(null);
    setCursorStack([]);
    setAppliedQuery({ limit: 50 });
  }

  return (
    <section className="page-content log-explorer" aria-labelledby="log-explorer-title">
      <Link className="back-link" to="/projects">Back to projects</Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Project logs</p>
          <h1 id="log-explorer-title">Log Explorer</h1>
          <p className="page-intro">Search and inspect persisted events for this project.</p>
        </div>
      </div>

      <form className="content-card log-filter-form" onSubmit={(event) => void applyFilters(event)}>
        <label className="log-filter log-filter--search">
          <span className="field-label">Search messages and services</span>
          <input
            className="text-input"
            value={filters.q}
            maxLength={256}
            onChange={(event) => updateFilter("q", event.target.value)}
            placeholder="Search text"
          />
        </label>
        <label className="log-filter">
          <span className="field-label">Severity</span>
          <select className="text-input" value={filters.level} onChange={(event) => updateFilter("level", event.target.value)}>
            <option value="">All severities</option>
            {logLevels.map((level) => <option key={level} value={level}>{level.toUpperCase()}</option>)}
          </select>
        </label>
        <label className="log-filter">
          <span className="field-label">Service</span>
          <input className="text-input" value={filters.service} maxLength={255} onChange={(event) => updateFilter("service", event.target.value)} />
        </label>
        <label className="log-filter">
          <span className="field-label">From (local time)</span>
          <input className="text-input" type="datetime-local" value={filters.from} onChange={(event) => updateFilter("from", event.target.value)} />
        </label>
        <label className="log-filter">
          <span className="field-label">To (local time)</span>
          <input className="text-input" type="datetime-local" value={filters.to} onChange={(event) => updateFilter("to", event.target.value)} />
        </label>
        <label className="log-filter">
          <span className="field-label">HTTP status</span>
          <input className="text-input" type="number" min={100} max={599} value={filters.httpStatus} onChange={(event) => updateFilter("httpStatus", event.target.value)} />
        </label>
        <label className="log-filter">
          <span className="field-label">Request ID</span>
          <input className="text-input" value={filters.requestId} maxLength={256} onChange={(event) => updateFilter("requestId", event.target.value)} />
        </label>
        <label className="log-filter">
          <span className="field-label">Ingestion job ID</span>
          <input className="text-input" value={filters.jobId} onChange={(event) => updateFilter("jobId", event.target.value)} />
        </label>
        {filterError && <p className="form-error log-filter-error" role="alert">{filterError}</p>}
        <div className="log-filter-actions">
          <button className="primary-button" type="submit">Search logs</button>
          <button className="secondary-button" type="button" onClick={clearFilters}>Clear filters</button>
        </div>
      </form>

      <section className="content-card log-results-card" aria-label="Log search results" aria-live="polite">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Results</p>
            <h2>Persisted events</h2>
          </div>
          {!isLoading && !error && (
            <div className="log-result-metrics">
              <span className="count-badge">{events.length} on this page</span>
              {databaseQueryDurationMs !== null && (
                <span className="query-duration" title="Time spent waiting for the PostgreSQL query via Prisma">
                  Database round trip {databaseQueryDurationMs.toFixed(3)} ms
                </span>
              )}
            </div>
          )}
        </div>
        {isLoading ? (
          <p className="muted-copy" role="status">Loading log events…</p>
        ) : error ? (
          <div className="empty-state">
            <p className="form-error" role="alert">{error}</p>
            <button className="secondary-button" type="button" onClick={() => setRetryKey((value) => value + 1)}>Retry</button>
          </div>
        ) : events.length === 0 ? (
          <div className="empty-state">
            <h3>No matching events</h3>
            <p className="muted-copy">Try changing or clearing your filters.</p>
          </div>
        ) : (
          <>
            <div className="log-table-scroll">
              <table className="log-table">
                <thead>
                  <tr>
                    <th scope="col">Timestamp</th>
                    <th scope="col">Severity</th>
                    <th scope="col">Service</th>
                    <th scope="col">Message</th>
                    <th scope="col">Request ID</th>
                    <th scope="col">HTTP</th>
                    <th scope="col">Latency</th>
                    <th scope="col">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((log) => (
                    <tr key={log.id}>
                      <td>{displayTimestamp(log.timestamp)}</td>
                      <td><span className={`severity-badge severity-badge--${log.level}`}>{log.level.toUpperCase()}</span></td>
                      <td>{log.source ?? "—"}</td>
                      <td className="log-message" title={log.message}>{log.message}</td>
                      <td>{attributeText(log.attributes, "request_id")}</td>
                      <td>{attributeText(log.attributes, "status")}</td>
                      <td>{attributeText(log.attributes, "latency_ms")}</td>
                      <td>
                        <details className="log-event-details">
                          <summary>Inspect</summary>
                          <p><strong>Job:</strong> {log.ingestionJobId ?? "—"}</p>
                          <p><strong>Message:</strong> {log.message}</p>
                          <pre>{JSON.stringify(log.attributes, null, 2)}</pre>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <nav className="log-pagination" aria-label="Log results pages">
              <button
                className="secondary-button"
                type="button"
                disabled={cursorStack.length === 0}
                onClick={() => setCursorStack((stack) => stack.slice(0, -1))}
              >
                Previous
              </button>
              <span>Page {cursorStack.length + 1}</span>
              <button
                className="secondary-button"
                type="button"
                disabled={!nextCursor}
                onClick={() => nextCursor && setCursorStack((stack) => [...stack, nextCursor])}
              >
                Next
              </button>
            </nav>
          </>
        )}
      </section>
    </section>
  );
}
