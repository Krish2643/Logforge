import { Link } from "react-router-dom";
import { useAuth } from "../../auth/context/AuthContext.js";
import { HealthCard } from "../components/HealthCard.js";
import { useHealth } from "../hooks/use-health.js";
import { RuntimeMetricsCard } from "../components/RuntimeMetricsCard.js";

export function DashboardPage() {
  const { user } = useAuth();
  const healthState = useHealth();

  return (
      <section className="page-content" aria-labelledby="page-title">
        <p className="eyebrow">Observability workspace</p>
        <h1 id="page-title">Welcome, {user?.email.split("@")[0]}.</h1>
        <p className="page-intro">
          Your workspace is ready. Check service health or open a project to continue.
        </p>
        <div className="dashboard-grid">
          <HealthCard {...healthState} onRefresh={() => void healthState.refresh()} />
          <section className="content-card dashboard-project-card" aria-labelledby="dashboard-projects-title">
            <span className="project-icon project-icon--large" aria-hidden="true">▤</span>
            <p className="eyebrow">Workspace</p>
            <h2 id="dashboard-projects-title">Your projects</h2>
            <p className="muted-copy">View and organize the projects you own.</p>
            <Link className="primary-button button-link" to="/projects">Open projects</Link>
          </section>
        </div>
        <RuntimeMetricsCard />
      </section>
  );
}
