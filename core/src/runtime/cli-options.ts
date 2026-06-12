import { envOverlay } from "../config/overlay.ts";
import { loadGlobalConfigSync } from "../services/config.ts";
import type { BootstrapLevel } from "./bootstrap.ts";
import type { LandoRuntimeOptions } from "./layer.ts";

const telemetryEnabledFromEnvOverlay = (): boolean | undefined => {
  const telemetry = envOverlay().telemetry;
  if (typeof telemetry !== "object" || telemetry === null || Array.isArray(telemetry)) return undefined;
  const enabled = (telemetry as { readonly enabled?: unknown }).enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
};

export const resolveCliTelemetryEnabled = (): boolean => {
  const envEnabled = telemetryEnabledFromEnvOverlay();
  if (envEnabled !== undefined) return envEnabled;

  try {
    return loadGlobalConfigSync().telemetry.enabled;
  } catch {
    return false;
  }
};

export const cliRuntimeOptions = <TBootstrap extends BootstrapLevel>(
  options: LandoRuntimeOptions & { readonly bootstrap: TBootstrap },
): LandoRuntimeOptions & { readonly bootstrap: TBootstrap; readonly telemetry: boolean } => ({
  ...options,
  telemetry: resolveCliTelemetryEnabled(),
});
