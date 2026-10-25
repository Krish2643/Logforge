import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppLayout } from "./AppLayout.js";
import { ProtectedRoute } from "./ProtectedRoute.js";
import { AuthProvider, useAuth } from "../features/auth/context/AuthContext.js";
import { AuthPage } from "../features/auth/pages/AuthPage.js";
import { DashboardPage } from "../features/dashboard/pages/DashboardPage.js";
import { ProjectsPage } from "../features/projects/pages/ProjectsPage.js";
import { LogExplorerPage } from "../features/logs/pages/LogExplorerPage.js";

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}

export function AppRoutes() {
  const { status } = useAuth();

  return (
    <Routes>
      <Route
        path="/"
        element={
          <Navigate
            to={status === "authenticated" ? "/dashboard" : status === "unauthenticated" ? "/login" : "/dashboard"}
            replace
          />
        }
      />
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:id/logs" element={<LogExplorerPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
