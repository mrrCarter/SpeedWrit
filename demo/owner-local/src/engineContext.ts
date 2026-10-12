import { createContext, useContext, useSyncExternalStore } from "react";
import { Engine } from "./domain/engine";
import type { State } from "./domain/types";

export const EngineContext = createContext<Engine | null>(null);

export function useEngine(): Engine {
  const engine = useContext(EngineContext);
  if (!engine) throw new Error("EngineContext missing");
  return engine;
}

export function useEngineState(): State {
  const engine = useEngine();
  return useSyncExternalStore(engine.subscribe, engine.getState);
}
