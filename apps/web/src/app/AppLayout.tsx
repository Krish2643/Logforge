import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useState } from "react";
import { useAuth } from "../features/auth/context/AuthContext.js";

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  async function handleLogout() {
    setIsLoggingOut(true);
    try {
      await logout();
      navigate("/login", { replace: true });
    } finally {
      setIsLoggingOut(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand sidebar-brand" to="/dashboard">
          <span className="brand-mark" aria-hidden="true">LF</span>
          <span>LogForge</span>
        </Link>
        <p className="sidebar-label">Workspace</p>
        <nav className="sidebar-nav" aria-label="Main navigation">
          <NavLink to="/dashboard" className={({ isActive }) => `nav-link${isActive ? " nav-link--active" : ""}`}>
            <span aria-hidden="true">◫</span> Dashboard
          </NavLink>
          <NavLink to="/projects" className={({ isActive }) => `nav-link${isActive ? " nav-link--active" : ""}`}>
            <span aria-hidden="true">▤</span> Projects
          </NavLink>
        </nav>
        <div className="sidebar-account">
          <div className="account-avatar" aria-hidden="true">
            {user?.email.slice(0, 1).toUpperCase() ?? "U"}
          </div>
          <div className="account-details">
            <span className="account-label">Signed in as</span>
            <span className="account-email" title={user?.email}>{user?.email}</span>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={() => void handleLogout()}
            disabled={isLoggingOut}
            aria-label="Log out"
            title="Log out"
          >
            ↗
          </button>
        </div>
      </aside>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
