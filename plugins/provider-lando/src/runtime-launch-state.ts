import { readFile } from "node:fs/promises";
import { delimiter } from "node:path";
import { managedLaunchStatePath } from "@lando/container-runtime/podman/managed-invocation";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { writeFileAtomic } from "@lando/state-store/atomic";
import { Effect, Predicate } from "effect";

import type { ContainerCgroups } from "./delegated-scope.ts";
import type { PodmanServiceSpec } from "./podman-service-runner.ts";

interface RuntimeLaunchState {
  readonly pid: number;
  readonly env: Readonly<Record<string, string>>;
  readonly runtimeBundleVersion?: string;
  /** Observed after the service is ready; absent for a launch that predates the observation. */
  readonly containerCgroups?: ContainerCgroups;
}

export const launchStatePath = managedLaunchStatePath;

const parseRuntimeLaunchState = (raw: string): RuntimeLaunchState | undefined => {
  const parsed: unknown = JSON.parse(raw);
  if (
    !Predicate.isObject(parsed) ||
    typeof parsed.pid !== "number" ||
    !Number.isInteger(parsed.pid) ||
    !Predicate.isObject(parsed.env)
  ) {
    return undefined;
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.env)) {
    if (typeof value !== "string") return undefined;
    env[key] = value;
  }

  const runtimeBundleVersion = parsed.runtimeBundleVersion;
  if (runtimeBundleVersion !== undefined && typeof runtimeBundleVersion !== "string") return undefined;
  const containerCgroups = parsed.containerCgroups;
  if (containerCgroups !== undefined && containerCgroups !== "delegated" && containerCgroups !== "shared")
    return undefined;
  return {
    pid: parsed.pid,
    env,
    ...(runtimeBundleVersion === undefined ? {} : { runtimeBundleVersion }),
    ...(containerCgroups === undefined ? {} : { containerCgroups }),
  };
};

export const readLaunchState = (pidPath: string): Effect.Effect<RuntimeLaunchState | undefined> =>
  Effect.tryPromise({
    try: async () => parseRuntimeLaunchState(await readFile(launchStatePath(pidPath), "utf8")),
    catch: () => undefined,
  }).pipe(Effect.catch((state) => Effect.succeed(state)));

const pathPrefix = (value: string): string => value.split(delimiter)[0] ?? value;

const sameManagedPath = (recorded: string | undefined, expected: string | undefined): boolean => {
  if (recorded === undefined || expected === undefined) return recorded === expected;
  // Host PATH after runtime/bin is not identity: `lando start` from a different
  // shell would otherwise tear down a healthy service and relaunch it from a
  // disposable cwd (guide e2e temp dirs). nft only needs runtime/bin first.
  return pathPrefix(recorded) === pathPrefix(expected);
};

const sameSpecEnv = (
  recordedEnv: Readonly<Record<string, string>>,
  expectedEnv: Readonly<Record<string, string>> | undefined,
): boolean => {
  const expectedEntries = Object.entries(expectedEnv ?? {});
  return (
    Object.keys(recordedEnv).length === expectedEntries.length &&
    expectedEntries.every(([key, value]) =>
      key === "PATH" ? sameManagedPath(recordedEnv[key], value) : recordedEnv[key] === value,
    )
  );
};

export const recordedLaunchMatchesSpec = (
  pidPath: string,
  pid: number,
  spec: PodmanServiceSpec,
  runtimeBundleVersion?: string,
): Effect.Effect<boolean> =>
  readLaunchState(pidPath).pipe(
    Effect.map(
      (state) =>
        state !== undefined &&
        state.pid === pid &&
        sameSpecEnv(state.env, spec.env) &&
        (runtimeBundleVersion === undefined || state.runtimeBundleVersion === runtimeBundleVersion),
    ),
  );

export const writeLaunchState = (
  pidPath: string,
  pid: number,
  spec: PodmanServiceSpec,
  runtimeBundleVersion?: string,
): Effect.Effect<void, ProviderUnavailableError> =>
  Effect.tryPromise({
    try: async () => {
      const state: RuntimeLaunchState = {
        pid,
        env: spec.env ?? {},
        ...(runtimeBundleVersion === undefined ? {} : { runtimeBundleVersion }),
      };
      const path = launchStatePath(pidPath);
      await writeFileAtomic(path, JSON.stringify(state), { mode: 0o600, ownerOnly: "best-effort" });
    },
    catch: (cause) =>
      new ProviderUnavailableError({
        providerId: "lando",
        operation: "setup",
        message: "Failed to write the Lando runtime service launch state.",
        remediation: "Verify the Lando runtime directory is writable, then rerun the command.",
        details: { statePath: launchStatePath(pidPath) },
        cause,
      }),
  });

/** Container cgroup placement recorded for the service launched as `pid`, if it was observed. */
export const recordedContainerCgroups = (
  pidPath: string,
  pid: number,
): Effect.Effect<ContainerCgroups | undefined> =>
  readLaunchState(pidPath).pipe(
    Effect.map((state) => (state?.pid === pid ? state.containerCgroups : undefined)),
  );

/** Adds the observed placement to the launch record of the service launched as `pid`. */
export const recordServicePlacement = (
  pidPath: string,
  pid: number,
  containerCgroups: ContainerCgroups,
): Effect.Effect<void, ProviderUnavailableError> =>
  readLaunchState(pidPath).pipe(
    Effect.flatMap((state) =>
      Effect.tryPromise({
        try: async () => {
          if (state?.pid !== pid) throw new Error(`No launch record for runtime service PID ${pid}.`);
          await writeFileAtomic(launchStatePath(pidPath), JSON.stringify({ ...state, containerCgroups }), {
            mode: 0o600,
            ownerOnly: "best-effort",
          });
        },
        catch: (cause) =>
          new ProviderUnavailableError({
            providerId: "lando",
            operation: "setup",
            message: "Failed to record the Lando runtime service placement.",
            remediation: "Verify the Lando runtime directory is writable, then rerun the command.",
            details: { statePath: launchStatePath(pidPath) },
            cause,
          }),
      }),
    ),
  );
