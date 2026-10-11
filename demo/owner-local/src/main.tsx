import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Engine } from "./domain/engine";
import { EngineContext } from "./engineContext";
import "./styles.css";

// One engine for the live demo, starting like the live host before setup: Gmail connected, no agent,
// no jobs. The provider takes ~0.6 s so in-flight states are visible.
const engine = new Engine({ latencyMs: 650, seed: "fresh" });

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <EngineContext.Provider value={engine}>
      <App />
    </EngineContext.Provider>
  </StrictMode>,
);
