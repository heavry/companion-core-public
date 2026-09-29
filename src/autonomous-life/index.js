import { config } from "../config.js";
import { publishEvent } from "../events-bus.js";
import { AutonomousLifeStore } from "./state-store.js";

export const autonomousLife=new AutonomousLifeStore({
  file:config.autonomousLifeStatePath,enabled:config.autonomousLifeEnabled,
  activeWindowMs:config.autonomousLifeActiveWindowMs,
  reflectionEventThreshold:config.autonomousLifeReflectionEventThreshold,
  reflectionMinIntervalMs:config.autonomousLifeReflectionMinIntervalMs,
  onEvent:(type,data)=>publishEvent(type,data)
});

export { AutonomousLifeStore } from "./state-store.js";
export { decideUserRequest,inspectRequestSignals,REQUEST_OUTCOMES } from "./decision.js";
export { deriveReflection,shouldReflect } from "./reflection.js";
