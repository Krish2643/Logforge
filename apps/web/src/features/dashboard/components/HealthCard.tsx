import type { HealthResponse } from "@logforge/shared";

interface HealthCardProps {
  health: HealthResponse | null;
  error: string | null;
  isLoading: boolean;
  onRefresh: () => void;
}

export function HealthCard({ health, error, isLoading, onRefresh }: HealthCardProps) {
  const databaseIsAvailable = health?.dependencies.database === "connected";

  return (
    <section className="health-card" aria-labelledby="health-heading">
      <div className="health-card__header">
        <div>
          <p className="eyebrow">System status</p>
          <h2 id="health-heading">Service health</h2>
        </div>
        <span
          className={`status-indicator ${
            error ? "status-indicator--error" : databaseIsAvailable ? "status-indicator--ok" : ""
          }`}
          aria-hidden="true"
        />
      </div>

      {error ? (
        <p className="health-message health-message--error" role="alert">
          API unreachable: {error}
        </p>
      ) : isLoading && !health ? (
        <p className="health-message" role="status">
          Checking API and database…
        </p>
      ) : (
        <>
          <p className="health-message" role="status">
            {databaseIsAvailable ? "Database connected" : "Database unavailable"}
          </p>
          <p className="health-detail">
            {health?.status === "ok"
              ? "The API can query PostgreSQL."
              : "The API is running, but PostgreSQL did not respond."}
          </p>
          {health && (
            <p className="health-timestamp">
              Last checked: {new Date(health.checkedAt).toLocaleTimeString()}
            </p>
          )}
        </>
      )}

      <button className="refresh-button" type="button" onClick={onRefresh} disabled={isLoading}>
        {isLoading ? "Checking…" : "Refresh status"}
      </button>
    </section>
  );
}
