import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import type { ProjectResponse, UploadLimitsResponse } from "@logforge/shared";
import { ApiError } from "../../../lib/api-client.js";
import { createProject, getProjects } from "../api/projects-client.js";
import { getUploadLimits } from "../api/upload-client.js";
import { ProjectUpload } from "../components/ProjectUpload.js";
import { ProjectJobs } from "../components/ProjectJobs.js";

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectResponse[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [uploadLimits, setUploadLimits] = useState<UploadLimitsResponse | null>(null);
  const [limitsError, setLimitsError] = useState<string | null>(null);
  const [jobsRefreshKey, setJobsRefreshKey] = useState(0);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(new Set());

  const loadProjects = useCallback(async (signal?: AbortSignal) => {
    setIsLoading(true);
    setLoadError(null);
    const [projectsResult, limitsResult] = await Promise.all([
      getProjects(signal).then((projects) => ({ projects }), (error: unknown) => ({ error })),
      getUploadLimits(signal).then((limits) => ({ limits }), (error: unknown) => ({ error }))
    ]);
    if (signal?.aborted) return;
    if ("projects" in projectsResult) {
      const orderedProjects = [...projectsResult.projects].sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
      );
      setProjects(orderedProjects);
      setExpandedProjectIds((current) =>
        current.size || !orderedProjects[0]
          ? current
          : new Set([orderedProjects[0].id])
      );
    } else {
      setLoadError(projectsResult.error instanceof Error ? projectsResult.error.message : "Unable to load projects.");
    }
    if ("limits" in limitsResult) {
      setUploadLimits(limitsResult.limits);
      setLimitsError(null);
    } else {
      setLimitsError(limitsResult.error instanceof Error ? limitsResult.error.message : "Unable to load upload limits.");
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadProjects(controller.signal);
    return () => controller.abort();
  }, [loadProjects]);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNameError(null);
    setCreateError(null);
    setSuccessMessage(null);
    const trimmedName = projectName.trim();

    if (!trimmedName) {
      setNameError("Enter a project name.");
      return;
    }
    if (trimmedName.length > 80) {
      setNameError("Project names must be 80 characters or fewer.");
      return;
    }
    if (projects.some((project) => project.name === trimmedName)) {
      setNameError("You already have a project with this name.");
      return;
    }

    setIsCreating(true);
    try {
      const createdProject = await createProject(trimmedName);
      await loadProjects();
      setExpandedProjectIds((current) => new Set(current).add(createdProject.id));
      setProjectName("");
      setSuccessMessage(`Project “${createdProject.name}” created.`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setNameError("You already have a project with this name.");
      } else {
        setCreateError(error instanceof Error ? error.message : "Unable to create the project.");
      }
    } finally {
      setIsCreating(false);
    }
  }

  function toggleProject(projectId: string) {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  return (
    <section className="page-content" aria-labelledby="projects-title">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1 id="projects-title">Projects</h1>
          <p className="page-intro">Projects keep your log data and ingestion jobs organized.</p>
        </div>
      </div>

      <div className="projects-grid">
        <section className="content-card project-create-card" aria-labelledby="create-project-title">
          <p className="eyebrow">New workspace</p>
          <h2 id="create-project-title">Create a project</h2>
          <p className="muted-copy">Choose a name, then upload .log or .jsonl files to this project.</p>
          <form className="project-form" onSubmit={(event) => void handleCreate(event)} noValidate>
            <label className="field-label" htmlFor="project-name">Project name</label>
            <input
              className={`text-input${nameError ? " text-input--invalid" : ""}`}
              id="project-name"
              name="projectName"
              value={projectName}
              maxLength={80}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="e.g. Production API"
              aria-invalid={Boolean(nameError)}
              aria-describedby={nameError ? "project-name-error" : "project-name-hint"}
            />
            {nameError ? (
              <span className="field-error" id="project-name-error">{nameError}</span>
            ) : (
              <span className="field-hint" id="project-name-hint">{projectName.trim().length}/80 characters</span>
            )}
            {createError && <p className="form-error" role="alert">{createError}</p>}
            {successMessage && <p className="success-message" role="status">{successMessage}</p>}
            <button className="primary-button" type="submit" disabled={isCreating}>
              {isCreating ? "Creating…" : "Create project"}
            </button>
          </form>
        </section>

        <section className="content-card projects-list-card" aria-labelledby="your-projects-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Your workspace</p>
              <h2 id="your-projects-title">Your projects</h2>
            </div>
            {!isLoading && !loadError && <span className="count-badge">{projects.length}</span>}
          </div>

          {isLoading ? (
            <p className="muted-copy" role="status">Loading your projects…</p>
          ) : loadError ? (
            <div className="empty-state">
              <p className="form-error" role="alert">{loadError}</p>
              <button className="secondary-button" type="button" onClick={() => void loadProjects()}>
                Retry
              </button>
            </div>
          ) : projects.length === 0 ? (
            <div className="empty-state">
              <span className="empty-state-icon" aria-hidden="true">▤</span>
              <h3>No projects yet</h3>
              <p className="muted-copy">Create your first project to start organizing your log workspace.</p>
            </div>
          ) : (
            <ul className="project-list">
              {projects.map((project) => (
                <li
                  className={`project-list-item${expandedProjectIds.has(project.id) ? " project-list-item--expanded" : ""}`}
                  id={`project-${project.id}`}
                  key={project.id}
                >
                  <div className="project-overview">
                    <span className="project-icon project-icon--large" aria-hidden="true">▤</span>
                    <div className="project-list-details">
                      <span className="project-name">{project.name}</span>
                      <span className="project-created">
                        Created {new Date(project.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    <span className="project-phase">Ready for logs</span>
                    <div className="project-actions">
                      <Link className="secondary-button project-logs-link" to={`/projects/${project.id}/logs`}>
                        Explore logs
                      </Link>
                      <button
                        className="project-expand-toggle"
                        type="button"
                        aria-expanded={expandedProjectIds.has(project.id)}
                        aria-controls={`project-details-${project.id}`}
                        onClick={() => toggleProject(project.id)}
                      >
                        <span>{expandedProjectIds.has(project.id) ? "Collapse" : "Expand"}</span>
                        <span className="project-expand-icon" aria-hidden="true">⌄</span>
                      </button>
                    </div>
                  </div>
                  <div
                    className="project-details"
                    id={`project-details-${project.id}`}
                    hidden={!expandedProjectIds.has(project.id)}
                  >
                    {uploadLimits ? (
                      <ProjectUpload
                        project={project}
                        limits={uploadLimits}
                        onUploadComplete={() => setJobsRefreshKey((current) => current + 1)}
                      />
                    ) : limitsError ? (
                      <p className="form-error upload-limit-error" role="alert">{limitsError}</p>
                    ) : null}
                    <ProjectJobs project={project} refreshKey={jobsRefreshKey} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <Link className="back-link" to="/dashboard">Back to dashboard</Link>
    </section>
  );
}
