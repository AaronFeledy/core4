import { readFile } from "node:fs/promises";

import { Duration, Effect } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { type RetryPolicy, runProbe } from "@lando/sdk/probe";

import {
  type LinuxRuntimeGenerationDeps,
  applyLinuxRuntimeGenerationState,
  readLinuxRuntimeGenerationState,
} from "./linux-runtime-generation.ts";
import { type PodmanServiceRunner, buildPodmanServiceArgs } from "./podman-service-runner.ts";

export interface LinuxRuntimeReaperDeps extends LinuxRuntimeGenerationDeps {
  readonly serviceRunner: PodmanServiceRunner;
  readonly podmanBin: string;
  readonly terminationPolicy?: RetryPolicy;
}

const defaultTerminationPolicy: RetryPolicy = {
  maxAttempts: 61,
  delay: Duration.millis(250),
  timeout: Duration.seconds(15),
};

const reaperError = (message: string, details: object, cause?: unknown) =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation: "setup",
    message,
    remediation: "Stop the managed runtime service, then retry the command.",
    details,
    ...(cause === undefined ? {} : { cause }),
  });

export const readRuntimePid = (pidPath: string): Effect.Effect<number | undefined> =>
  Effect.tryPromise({
    try: async () => {
      const raw = (await readFile(pidPath, "utf8")).trim();
      return /^\d+$/u.test(raw) ? Number(raw) : undefined;
    },
    catch: () => undefined,
  }).pipe(Effect.catchAll((pid) => Effect.succeed(pid)));

const servicePids = (deps: LinuxRuntimeReaperDeps): Effect.Effect<ReadonlyArray<number>> =>
  Effect.gen(function* () {
    const spec = buildPodmanServiceArgs(deps);
    const recordedPid = yield* readRuntimePid(deps.pidPath);
    const recordedOwned =
      recordedPid !== undefined &&
      (yield* deps.serviceRunner.isAlive(recordedPid)) &&
      (yield* deps.serviceRunner.isServiceProcess?.(recordedPid, spec) ?? Effect.succeed(false));
    const matching = yield* deps.serviceRunner.findMatchingServicePids?.(spec) ?? Effect.succeed([]);
    const managed = yield* deps.serviceRunner.findManagedServicePids?.(spec) ?? Effect.succeed([]);
    const candidates = new Set([...(recordedOwned ? [recordedPid] : []), ...matching, ...managed]);
    const alive: number[] = [];
    for (const pid of candidates) {
      if (yield* deps.serviceRunner.isAlive(pid)) alive.push(pid);
    }
    return alive;
  });

const terminateAndWait = (
  deps: LinuxRuntimeReaperDeps,
  pids: ReadonlyArray<number>,
): Effect.Effect<void, ProviderUnavailableError> => {
  const spec = buildPodmanServiceArgs(deps);
  return Effect.forEach(
    pids,
    (pid) =>
      deps.serviceRunner.terminate(pid).pipe(
        Effect.andThen(
          runProbe(
            {
              id: `provider-lando-runtime-terminate-${pid}`,
              policy: deps.terminationPolicy ?? defaultTerminationPolicy,
              classify: {
                success: (quiescent) => (quiescent ? "green" : "red"),
                failure: () => "red",
              },
            },
            Effect.gen(function* () {
              if (!(yield* deps.serviceRunner.isAlive(pid))) return true;
              const managed = yield* deps.serviceRunner.isServiceProcess?.(pid, spec) ??
                Effect.succeed(false);
              return !managed;
            }),
          ).pipe(
            Effect.mapError((cause) =>
              reaperError(`Failed to probe managed Lando runtime service PID ${pid}.`, { pid }, cause),
            ),
          ),
        ),
        Effect.flatMap((result) =>
          result.outcome === "green"
            ? Effect.void
            : Effect.fail(
                reaperError(
                  `Managed Lando runtime service PID ${pid} did not terminate.`,
                  { pid, attempts: result.attempts, elapsedMs: result.elapsedMs },
                  result.lastError,
                ),
              ),
        ),
      ),
    { concurrency: "unbounded", discard: true },
  );
};

export const reapStaleLinuxRuntime = (
  deps: LinuxRuntimeReaperDeps,
): Effect.Effect<void, ProviderUnavailableError> =>
  Effect.gen(function* () {
    const generationState = yield* readLinuxRuntimeGenerationState(deps);
    yield* terminateAndWait(deps, yield* servicePids(deps));
    yield* applyLinuxRuntimeGenerationState(deps, generationState);
  });
