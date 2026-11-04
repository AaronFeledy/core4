import * as HostFileSystem from "@lando/engine/services/file-system";
import * as HostProcessRunner from "@lando/engine/services/process-runner";
import {
  type DebuggerHostDiscovery,
  discoverWindowsDebuggerHost,
} from "@lando/engine/subsystems/debugger-host";
import { normalizeHostPlatform } from "@lando/paths";
import { DebuggerHostUnavailableError } from "@lando/sdk/errors";
import { ProbeTimeoutError, runProbe } from "@lando/sdk/probe";
import { DEBUGGER_HOST_ALIAS } from "@lando/sdk/schema";
import { ConfigService, FileSystem, PathsService, ProcessRunner } from "@lando/sdk/services";
import { Duration, Effect, Option } from "effect";
import { passCheckNamed, warnCheck } from "./doctor-check-builders";
import type { SubsystemDoctorResult } from "./doctor-subsystems";

export const debuggerHostDoctor = Effect.fn("Doctor.debuggerHost")(function* (
  redact: (text: string) => string,
  budgetMs: number,
  platform?: string,
  discovery?: DebuggerHostDiscovery,
) {
  const config = yield* Effect.serviceOption(ConfigService);
  const paths = yield* Effect.serviceOption(PathsService);
  const hostPlatform =
    discovery?.platform ??
    (platform === undefined
      ? Option.isSome(paths)
        ? paths.value.platform
        : normalizeHostPlatform()
      : normalizeHostPlatform({ platform, env: {} }));
  const configured = Option.isSome(config) ? (yield* config.value.get("debugger"))?.host : undefined;
  if (hostPlatform !== "wsl" && configured === undefined) {
    return {
      checks: [],
      skipped: [
        {
          section: "debugger-host",
          status: "skipped",
          reason: "Not on WSL and debugger.host is unset; no debugger discovery was performed.",
        },
      ],
    } satisfies SubsystemDoctorResult;
  }
  const base = {
    subsystem: "debugger-host",
    platform: hostPlatform,
    alias: DEBUGGER_HOST_ALIAS,
    configuredHost: configured ?? "unset",
    effectiveHost: configured === "windows" ? "unresolved" : (configured ?? "host-gateway"),
    ideReachability: "unobserved",
    note: "Configuration/discovery only; no TCP connection was attempted.",
  };
  const context = (extra: Readonly<Record<string, string>> = {}) =>
    Object.fromEntries(Object.entries({ ...base, ...extra }).map(([key, value]) => [key, redact(value)]));
  if (configured !== undefined && configured !== "windows") {
    return {
      checks: [
        passCheckNamed({
          name: "debugger-host",
          recovery: "manual",
          context: context({ source: "configured-address", networkingMode: "unobserved" }),
        }),
      ],
    } satisfies SubsystemDoctorResult;
  }
  const providedRunner = yield* Effect.serviceOption(ProcessRunner);
  const providedFs = yield* Effect.serviceOption(FileSystem);
  const runner =
    discovery?.runner ??
    (Option.isSome(providedRunner)
      ? providedRunner.value
      : yield* ProcessRunner.pipe(Effect.provide(HostProcessRunner.layer)));
  const fs = Option.isSome(providedFs)
    ? providedFs.value
    : yield* FileSystem.pipe(Effect.provide(HostFileSystem.layer));
  let address: string | undefined;
  const result = yield* runProbe(
    {
      id: "doctor.debugger-host",
      policy: { maxAttempts: 1, timeout: Duration.millis(Math.min(3000, Math.max(1, budgetMs - 100))) },
    },
    discoverWindowsDebuggerHost(
      discovery ?? {
        platform: hostPlatform,
        runner,
        readFile: (path) => Effect.runPromise(fs.readText(path)),
      },
    ).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          address = value;
        }),
      ),
    ),
  );
  if (result.outcome === "green" && address !== undefined) {
    return {
      checks: [
        passCheckNamed({
          name: "debugger-host",
          recovery: "manual",
          context: context({
            source: configured === "windows" ? "windows-discovery" : "default",
            effectiveHost: configured === "windows" ? address : "host-gateway",
            windowsHost: address,
            networkingMode: "nat",
          }),
        }),
      ],
    } satisfies SubsystemDoctorResult;
  }
  const error = result.lastError;
  const typed = error instanceof DebuggerHostUnavailableError ? error : undefined;
  const remediation =
    typed?.remediation ??
    "Windows debugger discovery exceeded its diagnostic budget. Rerun lando doctor, set debugger.host to an explicit IDE address, or unset debugger.host to use the host gateway.";
  const failureContext = context({
    source: configured === "windows" ? "windows-discovery" : "default",
    failure: typed?._tag ?? (error instanceof ProbeTimeoutError ? error._tag : "ProbeError"),
    reason: typed?.reason ?? "timeout",
    networkingMode: typed?.networkingMode ?? "unobserved",
    message: typed?.message ?? "Windows debugger discovery did not complete within its diagnostic budget.",
    remediation,
    ...(configured === undefined
      ? {
          note: "The host gateway remains selected. Windows discovery is an optional observation while debugger.host is unset; no configuration change is required.",
        }
      : {}),
  });
  return {
    checks: [
      configured === undefined
        ? passCheckNamed({
            name: "debugger-host",
            recovery: "manual",
            context: failureContext,
          })
        : warnCheck({
            name: "debugger-host",
            recovery: "manual",
            context: failureContext,
            solutions: [{ kind: "manual", description: redact(remediation) }],
          }),
    ],
  } satisfies SubsystemDoctorResult;
});
