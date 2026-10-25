import { useEffect, useState } from "react";
import type { RuntimeMetricsResponse } from "@logforge/shared";
import { getRuntimeMetrics } from "../api/runtime-metrics-client.js";

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function RuntimeMetricsCard() {
  const [metrics, setMetrics] = useState<RuntimeMetricsResponse | null>(null);
  const [apiPeak, setApiPeak] = useState<{ rssBytes: number; heapUsedBytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const refresh = async () => {
      try {
        const current = await getRuntimeMetrics(controller.signal);
        if (!active) return;
        setMetrics(current);
        setApiPeak((peak) => ({
          rssBytes: Math.max(peak?.rssBytes ?? 0, current.api.rssBytes),
          heapUsedBytes: Math.max(peak?.heapUsedBytes ?? 0, current.api.heapUsedBytes)
        }));
        setError(null);
      } catch (cause) {
        if (!active || (cause instanceof DOMException && cause.name === "AbortError")) return;
        setError(cause instanceof Error ? cause.message : "Unable to load runtime measurements.");
      } finally {
        if (active) setIsLoading(false);
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  return (
    <section className="content-card runtime-metrics-card" aria-labelledby="runtime-metrics-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Live measurements</p>
          <h2 id="runtime-metrics-title">Runtime resources</h2>
        </div>
        <span className="metrics-live-indicator">
          <span aria-hidden="true" />
          Live
        </span>
      </div>

      {error ? (
        <p className="form-error" role="alert">{error}</p>
      ) : isLoading && !metrics ? (
        <p className="muted-copy" role="status">Sampling API and worker memory…</p>
      ) : metrics ? (
        <div className="runtime-metrics-grid">
          <article className="runtime-metric">
            <span className="runtime-metric-label">API RSS</span>
            <strong>{formatMiB(metrics.api.rssBytes)}</strong>
            <span>Heap {formatMiB(metrics.api.heapUsedBytes)}</span>
            {apiPeak && (
              <small>
                Session sampled peak {formatMiB(apiPeak.rssBytes)} RSS · {formatMiB(apiPeak.heapUsedBytes)} heap
              </small>
            )}
            <small>Sampled {new Date(metrics.api.sampledAt).toLocaleTimeString()}</small>
          </article>
          <article className="runtime-metric">
            <span className="runtime-metric-label">Worker RSS</span>
            {metrics.worker ? (
              <>
                <strong>{formatMiB(metrics.worker.rssBytes)}</strong>
                <span>Heap {formatMiB(metrics.worker.heapUsedBytes)}</span>
                <small>
                  {metrics.worker.activeJobIds.length > 0
                    ? `Processing ${metrics.worker.activeJobIds.length} job(s)`
                    : "No active processing job"}
                </small>
                <small>Sampled {new Date(metrics.worker.sampledAt).toLocaleTimeString()}</small>
              </>
            ) : (
              <strong className="runtime-metric-unavailable">
                {metrics.workerStatus === "unavailable" ? "Metrics unavailable" : "Worker not reporting"}
              </strong>
            )}
          </article>
          {metrics.worker && (
            <article className="runtime-metric runtime-metric--peak">
              <span className="runtime-metric-label">Worker sampled peak during processing</span>
              <strong>{formatMiB(metrics.worker.peakRssBytesDuringProcessing)} RSS</strong>
              <span>Heap {formatMiB(metrics.worker.peakHeapUsedBytesDuringProcessing)}</span>
              <small>
                {metrics.worker.peakWindowEndedAt
                  ? `Peak window ended ${new Date(metrics.worker.peakWindowEndedAt).toLocaleTimeString()}`
                  : "Peak sampled across active worker jobs"}
              </small>
            </article>
          )}
        </div>
      ) : null}
      <p className="runtime-metrics-note">
        Memory values are process samples. Worker peaks are sampled every second while jobs run; brief spikes between samples may be missed.
      </p>
    </section>
  );
}
