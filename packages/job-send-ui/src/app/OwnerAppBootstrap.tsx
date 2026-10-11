import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { isOwnerAppConfig, type OwnerAppConfig } from "./config";

type LoadState = { status: "loading" } | { status: "failed" } | { status: "ready"; config: OwnerAppConfig };
type LoadRequest = { controller: AbortController; timeout: ReturnType<typeof setTimeout> };

/** Mounts the owner app only after its settings load; a failed GET can be retried explicitly. */
export function OwnerAppBootstrap({ children, fetcher = fetch }: { children: (config: OwnerAppConfig) => ReactNode; fetcher?: typeof fetch }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const inFlight = useRef<LoadRequest | null>(null);
  const load = useCallback(async () => {
    if (inFlight.current) return;
    const request: LoadRequest = {
      controller: new AbortController(),
      timeout: setTimeout(() => {
        if (inFlight.current !== request) return;
        inFlight.current = null;
        request.controller.abort();
        setState({ status: "failed" });
      }, 15_000),
    };
    inFlight.current = request;
    setState({ status: "loading" });
    try {
      const response = await fetcher("/owner-app/config.json", {
        method: "GET",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        signal: request.controller.signal,
      });
      if (!response.ok) throw new Error("config unavailable");
      const config: unknown = await response.json();
      if (!isOwnerAppConfig(config)) throw new Error("config unavailable");
      if (inFlight.current === request) setState({ status: "ready", config });
    } catch {
      // Remote response bodies, config values and exception messages never become UI or diagnostics.
      if (inFlight.current === request) setState({ status: "failed" });
    } finally {
      clearTimeout(request.timeout);
      if (inFlight.current === request) inFlight.current = null;
    }
  }, [fetcher]);

  useEffect(() => {
    void load();
    return () => {
      if (inFlight.current) {
        clearTimeout(inFlight.current.timeout);
        inFlight.current.controller.abort();
      }
      inFlight.current = null;
    };
  }, [load]);

  if (state.status === "ready") return children(state.config);
  return (
    <main aria-labelledby="owner-app-loading-title">
      <h1 id="owner-app-loading-title">SpeedWrit</h1>
      {state.status === "loading" ? (
        <p role="status">Loading SpeedWrit…</p>
      ) : (
        <>
          <p role="alert">SpeedWrit could not load. Try again in a moment.</p>
          <button type="button" onClick={() => void load()}>Try again</button>
        </>
      )}
    </main>
  );
}
