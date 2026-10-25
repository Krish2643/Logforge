import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../features/auth/context/AuthContext.js";

export function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <main className="auth-screen">
        <div className="loading-panel" role="status">Restoring your session…</div>
      </main>
    );
  }

  if (status === "error") {
    return <SessionRestoreError />;
  }

  if (status !== "authenticated") {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}

function SessionRestoreError() {
  const { authError, restoreSession, logout } = useAuth();
  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="restore-title">
        <Brand />
        <h1 id="restore-title">Could not restore your session</h1>
        <p className="form-error" role="alert">{authError}</p>
        <button className="primary-button full-width" type="button" onClick={() => void restoreSession()}>
          Retry
        </button>
        <button className="text-button" type="button" onClick={() => void logout()}>
          Clear this session and sign in
        </button>
      </section>
    </main>
  );
}

export function Brand() {
  return (
    <a className="brand auth-brand" href="/login">
      <span className="brand-mark" aria-hidden="true">LF</span>
      <span>LogForge</span>
    </a>
  );
}
