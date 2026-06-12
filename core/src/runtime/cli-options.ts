import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { envOverlay, resolveConfigFileRoot } from "../config/overlay.ts";
import { resolveUserConfRoot } from "../config/roots.ts";
import { parseMinimalYaml } from "../config/yaml-min.ts";
import { loadGlobalConfigSync } from "../services/config.ts";
import type { BootstrapLevel } from "./bootstrap.ts";
import type { LandoRuntimeOptions } from "./layer.ts";

const telemetryEnabledFromEnvOverlay = (): boolean | undefined => {
  const telemetry = envOverlay().telemetry;
  if (typeof telemetry !== "object" || telemetry === null || Array.isArray(telemetry)) return undefined;
  const enabled = (telemetry as { readonly enabled?: unknown }).enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
};

const telemetryEnabledFromConfigFile = (): boolean | undefined => {
  const overlay = envOverlay();
  const userConfRoot = resolveConfigFileRoot(resolveUserConfRoot(), overlay);
  const path = join(userConfRoot, "config.yml");
  if (!existsSync(path)) return undefined;

  const config = parseMinimalYaml(readFileSync(path, "utf8"));
  const telemetry = config.telemetry;
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
    try {
      return telemetryEnabledFromConfigFile() ?? true;
    } catch {
      return true;
    }
  }
};

export const cliRuntimeOptions = <TBootstrap extends BootstrapLevel>(
  options: LandoRuntimeOptions & { readonly bootstrap: TBootstrap },
): LandoRuntimeOptions & { readonly bootstrap: TBootstrap; readonly telemetry: boolean } => ({
  ...options,
  telemetry: options.telemetry ?? (options.bootstrap === "none" ? false : resolveCliTelemetryEnabled()),
});
