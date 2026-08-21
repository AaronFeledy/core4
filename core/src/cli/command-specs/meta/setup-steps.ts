/**
 * `meta:setup` stateful readiness recording and the file-sync setup step.
 *
 * `makeSetupReadinessRecorder` owns the accumulating readiness-step list and the
 * runtime-service snapshot, persisting the readiness summary after every record.
 * `runFileSyncSetupStep` runs the provider-dependent file-sync provisioning
 * (deferred / installed / unavailable / satisfied) and returns the resulting
 * status. These are the side-effecting "steps" the command orchestration drives.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Data, Effect, Layer, Option } from "effect";

import { Downloader, FileSyncEngine, type FileSyncError, PathsService } from "@lando/sdk/services";

import { NetworkTrust } from "@lando/http-client/network-trust";
import { type ResolvedSetupNetworkTrust, networkTrustFromResolved } from "../../commands/setup-network-trust";
import {
  type SetupReadinessRuntimeService,
  type SetupReadinessStep,
  setupFailureEvidence,
  setupFailureRemediation,
  writeSetupReadiness,
} from "../../commands/setup-readiness";
import { SetupFileSyncEngineLive } from "./setup-file-sync-engine";
import { type FileSyncStatus, inputSkipFileSync } from "./setup-inputs";

interface RuntimeServiceStatusForReadiness {
  readonly running: boolean;
  readonly socketPath?: string;
  readonly pid?: number;
}

interface RuntimeServiceReadinessProvider {
  readonly getRuntimeServiceStatus?: Effect.Effect<RuntimeServiceStatusForReadiness, unknown>;
}

export const runtimeServiceReadinessFor = (provider: {
  readonly getVersions: Effect.Effect<{ readonly runtime?: string }, unknown>;
}): Effect.Effect<SetupReadinessRuntimeService | null | undefined, never> => {
  const statusEffect = (provider as RuntimeServiceReadinessProvider).getRuntimeServiceStatus;
  if (statusEffect === undefined) return Effect.succeed(undefined);

  return Effect.gen(function* () {
    const status = yield* statusEffect;
    if (status.socketPath === undefined || status.socketPath.length === 0) return null;

    const versions = yield* provider.getVersions.pipe(Effect.catchAllCause(() => Effect.succeed(undefined)));
    return {
      running: status.running,
      socketPath: status.socketPath,
      ...(status.pid === undefined ? {} : { pid: status.pid }),
      ...(versions?.runtime === undefined ? {} : { runtimeVersion: versions.runtime }),
    };
  }).pipe(Effect.catchAllCause(() => Effect.succeed(null)));
};

export class ShellProfileIntegrationError extends Data.TaggedError("ShellProfileIntegrationError")<{
  readonly message: string;
  readonly stderr: string;
}> {}

export class SetupStepFailedError extends Data.TaggedError("SetupStepFailedError")<{
  readonly message: string;
  readonly stepId: string;
  readonly remediation: string;
}> {}

export const setupDeferredFileSyncPath = (userDataRoot: string): string =>
  join(userDataRoot, "setup", "file-sync-deferred.json");

const recordDeferredFileSyncSetup = (userDataRoot: string): Effect.Effect<void, never> =>
  Effect.promise(async () => {
    const markerPath = setupDeferredFileSyncPath(userDataRoot);
    await mkdir(join(userDataRoot, "setup"), { recursive: true });
    await writeFile(
      markerPath,
      `${JSON.stringify({ status: "deferred", engineId: "mutagen", resumeCommand: "lando start" })}\n`,
      "utf-8",
    );
  }).pipe(Effect.catchAll(() => Effect.void));

export interface SetupReadinessRecorder {
  readonly record: (step: SetupReadinessStep) => Effect.Effect<void, never>;
  readonly recordFailure: (id: string, cause: unknown) => Effect.Effect<void, never>;
  readonly recordUnavailable: (id: string, serviceName: string) => Effect.Effect<void, never>;
  readonly setRuntimeService: (value: SetupReadinessRuntimeService | null | undefined) => void;
}

export interface AccumulatingSetupReadinessRecorder extends SetupReadinessRecorder {
  readonly firstFailedStep: () => SetupReadinessStep | undefined;
}

export const makeSetupReadinessRecorder = (
  userDataRoot: string | undefined,
  selectedProviderId: string,
): AccumulatingSetupReadinessRecorder => {
  const readinessSteps: SetupReadinessStep[] = [];
  let runtimeServiceReadiness: SetupReadinessRuntimeService | null | undefined;
  const record = (step: SetupReadinessStep): Effect.Effect<void, never> => {
    const existingIndex = readinessSteps.findIndex((candidate) => candidate.id === step.id);
    if (existingIndex === -1) readinessSteps.push(step);
    else readinessSteps[existingIndex] = step;
    return writeSetupReadiness(userDataRoot, selectedProviderId, readinessSteps, runtimeServiceReadiness);
  };
  const recordFailure = (id: string, cause: unknown): Effect.Effect<void, never> =>
    record({
      id,
      status: "failed",
      evidence: setupFailureEvidence(id, cause),
      remediation: setupFailureRemediation(id, cause),
    });
  const recordUnavailable = (id: string, serviceName: string): Effect.Effect<void, never> => {
    const message = `${serviceName} setup service is not available.`;
    return record({
      id,
      status: "unavailable",
      evidence: message,
      remediation: setupFailureRemediation(id, message),
    });
  };
  return {
    record,
    recordFailure,
    recordUnavailable,
    firstFailedStep: () => readinessSteps.find((step) => step.status === "failed"),
    setRuntimeService: (value) => {
      runtimeServiceReadiness = value;
    },
  };
};

interface FileSyncSetupStepContext {
  readonly provider: { readonly capabilities: { readonly bindMountPerformance: string } };
  readonly input: unknown;
  readonly userDataRoot: string | undefined;
  readonly network: ResolvedSetupNetworkTrust;
  readonly recorder: SetupReadinessRecorder;
}

export const runFileSyncSetupStep = (
  ctx: FileSyncSetupStepContext,
): Effect.Effect<FileSyncStatus, FileSyncError> =>
  Effect.gen(function* () {
    const { provider, input, userDataRoot, network, recorder } = ctx;
    let fileSyncStatus: FileSyncStatus = "satisfied";

    if (provider.capabilities.bindMountPerformance === "slow" && inputSkipFileSync(input)) {
      fileSyncStatus = "deferred";
      if (userDataRoot !== undefined) yield* recordDeferredFileSyncSetup(userDataRoot);
      yield* recorder.record({
        id: "file-sync",
        status: "deferred",
        evidence: "File-sync setup deferred until first accelerated app:start.",
        remediation: "Run `lando start` to finish deferred file-sync setup for accelerated mounts.",
      });
    } else if (provider.capabilities.bindMountPerformance === "slow") {
      const recordInstalledFileSync = (evidence: string) =>
        Effect.sync(() => {
          fileSyncStatus = "installed";
        }).pipe(
          Effect.zipRight(
            recorder.record({
              id: "file-sync",
              status: "installed",
              evidence,
            }),
          ),
        );

      let fileSync = yield* Effect.serviceOption(FileSyncEngine);
      if (fileSync._tag === "None") {
        const paths = yield* Effect.serviceOption(PathsService);
        const downloader = yield* Effect.serviceOption(Downloader);
        if (paths._tag === "Some" && downloader._tag === "Some") {
          const dependencies = Layer.merge(
            Layer.succeed(PathsService, paths.value),
            Layer.succeed(Downloader, downloader.value),
          );
          fileSync = yield* Effect.serviceOption(FileSyncEngine).pipe(
            Effect.provide(SetupFileSyncEngineLive.pipe(Layer.provide(dependencies))),
            Effect.catchAllCause(() => Effect.succeed(Option.none())),
          );
        }
      }
      if (fileSync._tag === "Some") {
        yield* Effect.scoped(fileSync.value.setup({ force: false, network })).pipe(
          Effect.provideService(NetworkTrust, networkTrustFromResolved(network)),
          Effect.tapError((cause) => recorder.recordFailure("file-sync", cause)),
          Effect.tap(() => recordInstalledFileSync("File-sync setup installed Mutagen acceleration.")),
        );
      } else {
        fileSyncStatus = "unavailable";
        yield* recorder.recordUnavailable("file-sync", "File-sync engine");
      }
    } else {
      yield* recorder.record({
        id: "file-sync",
        status: "satisfied",
        evidence: "Native bind mounts satisfy file-sync setup.",
      });
    }

    return fileSyncStatus;
  });
