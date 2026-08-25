import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { deepMerge, envOverlay, resolveConfigFileRoot } from "@lando/paths/overlay";
import { parseMinimalYaml } from "@lando/paths/yaml-min";
import type { LogLevel } from "@lando/sdk/schema";

import { resolveUserConfRoot } from "../config/roots.ts";
import type { BootstrapLevel } from "./bootstrap.ts";
import type { LandoRuntimeOptions, LibraryRendererMode } from "./runtime-options.ts";

export type CliTelemetrySource = "flag" | "env" | "config" | "default";

export interface CliTelemetryState {
  readonly enabled: boolean;
  readonly source: CliTelemetrySource;
}

export let activeLogLevel: LogLevel = "none";

export const setActiveLogLevel = (level: LogLevel): void => {
  activeLogLevel = level;
};

export let activeRendererMode: LibraryRendererMode = "lando";

export const setActiveRendererMode = (mode: LibraryRendererMode): void => {
  activeRendererMode = mode;
};

const DEFAULT_LOWER_TIER_NOTIFY_COMMANDS = new Set(["meta:update"]);

/**
 * Commands whose declared bootstrap level is load-bearing and must never be
 * promoted. `meta:doctor` declares `none` and builds its own runtime so a
 * bootstrap failure is reported rather than fatal; promoting it would rebuild
 * that fallible runtime eagerly and defeat the guarantee.
 */
const BOOTSTRAP_PROMOTION_EXEMPT_COMMANDS = new Set(["meta:doctor"]);

export const effectiveBootstrapForCommand = (
  commandId: string,
  declared: BootstrapLevel,
  configuredCommands: ReadonlyArray<string>,
): BootstrapLevel => {
  if (BOOTSTRAP_PROMOTION_EXEMPT_COMMANDS.has(commandId)) return declared;
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
  if (("enabled" in notify && notify.enabled === false) || !("commands" in notify)) return [];
  if (!Array.isArray(notify.commands)) return [];
  return notify.commands.filter((entry): entry is string => typeof entry === "string");
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
  logLevel: options.logLevel ?? activeLogLevel,
  renderer: options.renderer ?? activeRendererMode,
});
