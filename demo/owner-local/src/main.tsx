import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { alertsEnabled } from "./alertSwitch";
import { startAlerts } from "./alerts";
import { Engine } from "./domain/engine";
import { EngineContext } from "./engineContext";
import "./styles.css";

// One engine for the live demo, starting like the live host before setup: Gmail connected, no agent,
// no jobs. The provider takes ~0.6 s so in-flight states are visible.
const engine = new Engine({ latencyMs: 650, seed: "fresh" });
// Phone alerts through the local Dial relay (npm run dial); off-switch in Connections.
startAlerts(engine, alertsEnabled);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <EngineContext.Provider value={engine}>
      <App />
    </EngineContext.Provider>
  </StrictMode>,
);
