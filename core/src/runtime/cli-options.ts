import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { deepMerge, envOverlay, resolveConfigFileRoot } from "../config/overlay.ts";
import { resolveUserConfRoot } from "../config/roots.ts";
import { parseMinimalYaml } from "../config/yaml-min.ts";
import type { BootstrapLevel } from "./bootstrap.ts";
import type { LandoRuntimeOptions } from "./layer.ts";

export type CliTelemetrySource = "flag" | "env" | "config" | "default";

export interface CliTelemetryState {
  readonly enabled: boolean;
  readonly source: CliTelemetrySource;
}

const DEFAULT_LOWER_TIER_NOTIFY_COMMANDS = new Set(["meta:update"]);

export const effectiveBootstrapForCommand = (
  commandId: string,
  declared: BootstrapLevel,
  configuredCommands: ReadonlyArray<string>,
): BootstrapLevel => {
  if (
    declared === "commands" ||
    declared === "tooling" ||
    declared === "provider" ||
    declared === "global" ||
    declared === "scratch" ||
    declared === "app"
  ) {
    return declared;
  }
  return DEFAULT_LOWER_TIER_NOTIFY_COMMANDS.has(commandId) || configuredCommands.includes(commandId)
    ? "commands"
    : declared;
};

const configuredNotifyCommands = (): ReadonlyArray<string> => {
  const overlay = envOverlay();
  const userConfRoot = resolveConfigFileRoot(resolveUserConfRoot(), overlay);
  const path = join(userConfRoot, "config.yml");
  const file = existsSync(path) ? parseMinimalYaml(readFileSync(path, "utf8")) : {};
  const config = deepMerge(file, overlay);
  const notify = config.notify;
  if (typeof notify !== "object" || notify === null || Array.isArray(notify)) return [];
  const value = notify as { readonly enabled?: unknown; readonly commands?: unknown };
  if (value.enabled === false || !Array.isArray(value.commands)) return [];
  return value.commands.filter((entry): entry is string => typeof entry === "string");
};

export const resolveEffectiveCliBootstrap = (commandId: string, declared: BootstrapLevel): BootstrapLevel => {
  try {
    return effectiveBootstrapForCommand(commandId, declared, configuredNotifyCommands());
  } catch {
    return DEFAULT_LOWER_TIER_NOTIFY_COMMANDS.has(commandId) ? "commands" : declared;
  }
};

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

export const resolveCliTelemetryState = (flagEnabled?: boolean): CliTelemetryState => {
  if (flagEnabled !== undefined) return { enabled: flagEnabled, source: "flag" };

  const envEnabled = telemetryEnabledFromEnvOverlay();
  if (envEnabled !== undefined) return { enabled: envEnabled, source: "env" };

  try {
    const configEnabled = telemetryEnabledFromConfigFile();
    if (configEnabled !== undefined) return { enabled: configEnabled, source: "config" };
  } catch {
    return { enabled: true, source: "default" };
  }

  return { enabled: true, source: "default" };
};

export const resolveCliTelemetryEnabled = (): boolean => resolveCliTelemetryState().enabled;

export const cliRuntimeOptions = <TBootstrap extends BootstrapLevel>(
  options: LandoRuntimeOptions & { readonly bootstrap: TBootstrap },
): LandoRuntimeOptions & {
  readonly bootstrap: TBootstrap;
  readonly interaction: NonNullable<LandoRuntimeOptions["interaction"]>;
  readonly telemetry: boolean;
} => ({
  ...options,
  interaction: options.interaction ?? "auto",
  telemetry:
    options.bootstrap === "none"
      ? (options.telemetry ?? false)
      : resolveCliTelemetryState(options.telemetry).enabled,
});
