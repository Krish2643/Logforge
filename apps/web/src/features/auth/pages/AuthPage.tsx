import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { registerRequestSchema, loginRequestSchema } from "@logforge/shared";
import { ApiError } from "../../../lib/api-client.js";
import { Brand } from "../../../app/ProtectedRoute.js";
import { useAuth } from "../context/AuthContext.js";

interface AuthPageProps {
  mode: "login" | "register";
}

export function AuthPage({ mode }: AuthPageProps) {
  const { status, login, register, authError, authNotice, restoreSession } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isRegister = mode === "register";

  if (status === "loading") {
    return <main className="auth-screen"><div className="loading-panel" role="status">Checking your session…</div></main>;
  }
  if (status === "authenticated") return <Navigate to="/dashboard" replace />;
  if (status === "error") {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-labelledby="restore-auth-title">
          <Brand />
          <h1 id="restore-auth-title">Could not restore your session</h1>
          <p className="form-error" role="alert">{authError}</p>
          <button className="primary-button full-width" type="button" onClick={() => void restoreSession()}>
            Retry
          </button>
        </section>
      </main>
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    const schema = isRegister ? registerRequestSchema : loginRequestSchema;
    const result = schema.safeParse({ email, password });
    if (!result.success) {
      setFieldErrors(Object.fromEntries(result.error.issues.map((issue) => [String(issue.path[0]), issue.message])));
      return;
    }

    setIsSubmitting(true);
    try {
      if (isRegister) await register(result.data.email, result.data.password);
      else await login(result.data.email, result.data.password);
      const destination =
        typeof location.state === "object" &&
        location.state !== null &&
        "from" in location.state &&
        typeof location.state.from === "string"
          ? location.state.from
          : "/dashboard";
      navigate(destination, { replace: true });
    } catch (cause) {
      if (cause instanceof ApiError && cause.details.length > 0) {
        setFieldErrors(Object.fromEntries(cause.details.map((detail) => [detail.path, detail.message])));
      } else {
        setError(
          cause instanceof ApiError
            ? cause.message
            : "Something went wrong while contacting the API. Please retry."
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="auth-title">
        <Brand />
        <p className="eyebrow">{isRegister ? "Create your workspace account" : "Welcome back"}</p>
        <h1 id="auth-title">{isRegister ? "Create your account" : "Sign in to LogForge"}</h1>
        <p className="auth-description">
          {isRegister
            ? "Start organizing your logs with project-level access."
            : "Use your account to open your LogForge workspace."}
        </p>
        {authNotice && <p className="inline-notice auth-notice" role="status">{authNotice}</p>}
        {typeof location.state === "object" &&
          location.state !== null &&
          "notice" in location.state &&
          typeof location.state.notice === "string" && (
            <p className="inline-notice auth-notice" role="status">{location.state.notice}</p>
          )}

        <form className="auth-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
          <label className="field-label" htmlFor="email">Email address</label>
          <input
            autoComplete="email"
            className={`text-input${fieldErrors.email ? " text-input--invalid" : ""}`}
            id="email"
            name="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            aria-invalid={Boolean(fieldErrors.email)}
            aria-describedby={fieldErrors.email ? "email-error" : undefined}
          />
          {fieldErrors.email && <span className="field-error" id="email-error">{fieldErrors.email}</span>}

          <label className="field-label" htmlFor="password">Password</label>
          <input
            autoComplete={isRegister ? "new-password" : "current-password"}
            className={`text-input${fieldErrors.password ? " text-input--invalid" : ""}`}
            id="password"
            name="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            aria-invalid={Boolean(fieldErrors.password)}
            aria-describedby={fieldErrors.password ? "password-error" : undefined}
          />
          {fieldErrors.password && <span className="field-error" id="password-error">{fieldErrors.password}</span>}
          {isRegister && <span className="field-hint">Use 12–128 characters.</span>}

          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary-button full-width" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Please wait…" : isRegister ? "Create account" : "Sign in"}
          </button>
        </form>

        <p className="auth-switch">
          {isRegister ? "Already have an account?" : "New to LogForge?"}{" "}
          <Link to={isRegister ? "/login" : "/register"}>
            {isRegister ? "Sign in" : "Create an account"}
          </Link>
        </p>
      </section>
      <p className="auth-footnote">Your session is scoped to this browser tab.</p>
    </main>
  );
}
