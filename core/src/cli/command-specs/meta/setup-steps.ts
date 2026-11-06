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

import {
  RedactionService,
  type RedactionServiceShape,
  createStandaloneRedactor,
} from "@lando/redaction/service";
import { Effect, Option, Result, Schema } from "effect";

import { type FileSyncEngineShape, type FileSyncError, PathsService } from "@lando/sdk/services";

import { fileSyncSelectionInput } from "@lando/engine/plugins/file-sync-policy";
import { FileSyncResolver } from "@lando/engine/plugins/file-sync-resolver";
import { NetworkTrust } from "@lando/http-client/network-trust";
import { type ResolvedSetupNetworkTrust, networkTrustFromResolved } from "../../commands/setup-network-trust";
import {
  type SetupReadinessRuntimeService,
  type SetupReadinessStep,
  setupFailureEvidence,
  setupFailureRemediation,
  writeSetupReadiness,
} from "../../commands/setup-readiness";
import { type FileSyncStatus, inputSkipFileSync } from "./setup-inputs";

interface RuntimeServiceStatusForReadiness {
  readonly running: boolean;
  readonly socketPath?: string;
  readonly pid?: number;
}

interface RuntimeServiceReadinessProvider {
  readonly getRuntimeServiceStatus?: Effect.Effect<RuntimeServiceStatusForReadiness, unknown>;
}

export const runtimeServiceReadinessFor = Effect.fnUntraced(
  function* (provider: {
    readonly getVersions: Effect.Effect<{ readonly runtime?: string }, unknown>;
  }): Effect.fn.Return<SetupReadinessRuntimeService | null | undefined, unknown> {
    const statusEffect = (provider as RuntimeServiceReadinessProvider).getRuntimeServiceStatus;
    if (statusEffect === undefined) return undefined;

    const status = yield* statusEffect;
    if (status.socketPath === undefined || status.socketPath.length === 0) return null;

    const versions = yield* provider.getVersions.pipe(Effect.catchCause(() => Effect.succeed(undefined)));
    return {
      running: status.running,
      socketPath: status.socketPath,
      ...(status.pid === undefined ? {} : { pid: status.pid }),
      ...(versions?.runtime === undefined ? {} : { runtimeVersion: versions.runtime }),
    };
  },
  Effect.catchCause(() => Effect.succeed(null)),
);

export class ShellProfileIntegrationError extends Schema.TaggedError<ShellProfileIntegrationError>()(
  "ShellProfileIntegrationError",
  {
    message: Schema.String,
    stderr: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}

export class SetupStepFailedError extends Schema.TaggedError<SetupStepFailedError>()("SetupStepFailedError", {
  message: Schema.String,
  stepId: Schema.String,
  remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
}) {}

export const setupDeferredFileSyncPath = (userDataRoot: string): string =>
  join(userDataRoot, "setup", "file-sync-deferred.json");

const recordDeferredFileSyncSetup = (userDataRoot: string, engineId?: string): Effect.Effect<void, never> =>
  Effect.promise(async () => {
    const markerPath = setupDeferredFileSyncPath(userDataRoot);
    await mkdir(join(userDataRoot, "setup"), { recursive: true });
    await writeFile(
      markerPath,
      `${JSON.stringify({ status: "deferred", engineId, resumeCommand: "lando setup" })}\n`,
      "utf-8",
    );
  }).pipe(Effect.catch(() => Effect.void));

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
  redaction?: RedactionServiceShape,
): AccumulatingSetupReadinessRecorder => {
  const sourceEnv = { ...process.env };
  const readinessSteps: SetupReadinessStep[] = [];
  let runtimeServiceReadiness: SetupReadinessRuntimeService | null | undefined;
  const record = Effect.fnUntraced(function* (step: SetupReadinessStep): Effect.fn.Return<void> {
    const inherited = yield* Effect.serviceOption(RedactionService);
    const service = redaction ?? Option.getOrUndefined(inherited);
    const redactor =
      service === undefined
        ? createStandaloneRedactor("secrets", { sourceEnv })
        : yield* service.forProfile("secrets", { sourceEnv });
    const safeStep = {
      ...step,
      evidence: redactor.redactString(step.evidence),
      ...(step.remediation === undefined ? {} : { remediation: redactor.redactString(step.remediation) }),
    };
    const existingIndex = readinessSteps.findIndex((candidate) => candidate.id === step.id);
    if (existingIndex === -1) readinessSteps.push(safeStep);
    else readinessSteps[existingIndex] = safeStep;
    const write = writeSetupReadiness(
      userDataRoot,
      selectedProviderId,
      readinessSteps,
      runtimeServiceReadiness,
    );
    yield* service === undefined ? write : write.pipe(Effect.provideService(RedactionService, service));
  });
  const recordFailure = Effect.fnUntraced(function* (id: string, cause: unknown) {
    const inherited = yield* Effect.serviceOption(RedactionService);
    const service = redaction ?? Option.getOrUndefined(inherited);
    const redactor =
      service === undefined
        ? createStandaloneRedactor("secrets", { sourceEnv })
        : yield* service.forProfile("secrets", { sourceEnv });
    yield* record({
      id,
      status: "failed",
      evidence: setupFailureEvidence(id, cause, redactor),
      remediation: setupFailureRemediation(id, cause, redactor),
    });
  });
  const recordUnavailable = Effect.fnUntraced(function* (id: string, serviceName: string) {
    const inherited = yield* Effect.serviceOption(RedactionService);
    const service = redaction ?? Option.getOrUndefined(inherited);
    const redactor =
      service === undefined
        ? createStandaloneRedactor("secrets", { sourceEnv })
        : yield* service.forProfile("secrets", { sourceEnv });
    const message = `${serviceName} setup service is not available.`;
    yield* record({
      id,
      status: "unavailable",
      evidence: message,
      remediation: setupFailureRemediation(id, message, redactor),
    });
  });
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
  readonly provider: {
    readonly capabilities: {
      readonly bindMountPerformance: "native" | "slow" | "none";
      readonly fileSyncTargets?: "prepared-volume";
    };
  };
  readonly input: unknown;
  readonly userDataRoot: string | undefined;
  readonly network: ResolvedSetupNetworkTrust;
  readonly recorder: SetupReadinessRecorder;
  readonly defaultEngine?: string | undefined;
}

export const runFileSyncSetupStep = Effect.fn("SetupCommand.runFileSyncSetupStep")(function* (
  ctx: FileSyncSetupStepContext,
): Effect.fn.Return<FileSyncStatus, FileSyncError> {
  const { provider, input, userDataRoot, network, recorder, defaultEngine } = ctx;
  let fileSyncStatus: FileSyncStatus = "satisfied";

  const bindMountPerformance =
    provider.capabilities.bindMountPerformance === "slow" ? ("slow" as const) : ("native" as const);
  if (inputSkipFileSync(input) && bindMountPerformance === "slow" && defaultEngine !== "passthrough") {
    if (userDataRoot !== undefined) yield* recordDeferredFileSyncSetup(userDataRoot, defaultEngine);
    yield* recorder.record({
      id: "file-sync",
      status: "deferred",
      evidence: "File-sync engine installation skipped on this slow-mount host.",
      remediation:
        "Run `lando setup` without `--skip-file-sync` before starting accelerated mounts, or explicitly disable acceleration for ordinary binds.",
    });
    return "deferred";
  }
  const paths = yield* Effect.serviceOption(PathsService);
  const resolver = yield* Effect.serviceOption(FileSyncResolver);
  const platform = paths._tag === "Some" ? paths.value.platform : undefined;
  const selectionPolicy =
    platform === undefined
      ? undefined
      : fileSyncSelectionInput(platform, {
          capabilities: provider.capabilities,
          defaultEngine,
        });
  const select =
    resolver._tag === "Some" && selectionPolicy !== undefined
      ? yield* Effect.cached(Effect.suspend(() => resolver.value.select(selectionPolicy)))
      : undefined;
  if (defaultEngine !== undefined && defaultEngine !== "passthrough" && select !== undefined) {
    const validation = yield* Effect.result(select);
    if (Result.isFailure(validation)) {
      yield* recorder.recordFailure("file-sync", validation.failure);
      return "unavailable";
    }
  }

  // Native binds and the reserved passthrough policy never acquire an engine.
  if (bindMountPerformance === "native" || defaultEngine === "passthrough") {
    yield* recorder.record({
      id: "file-sync",
      status: "satisfied",
      evidence:
        defaultEngine === "passthrough"
          ? "defaultFileSyncEngine is passthrough; ordinary binds are used without a file-sync engine."
          : "Native bind mounts satisfy file-sync setup.",
    });
    return fileSyncStatus;
  }

  const recordInstalledFileSync = (evidence: string) =>
    Effect.sync(() => {
      fileSyncStatus = "installed";
    }).pipe(
      Effect.andThen(
        recorder.record({
          id: "file-sync",
          status: "installed",
          evidence,
        }),
      ),
    );

  let fileSync = Option.none<FileSyncEngineShape>();
  if (resolver._tag === "Some" && select !== undefined) {
    const selection = yield* Effect.result(select);
    if (Result.isFailure(selection)) {
      fileSyncStatus = "unavailable";
      yield* recorder.recordFailure("file-sync", selection.failure);
      return fileSyncStatus;
    }
    const selected = selection.success;
    if (selected === undefined) {
      fileSyncStatus = "satisfied";
      yield* recorder.record({
        id: "file-sync",
        status: "satisfied",
        evidence:
          "No compatible file-sync engine is available; ordinary bind mounts satisfy project-file access.",
      });
      return fileSyncStatus;
    }
    const acquisition = yield* Effect.result(resolver.value.acquire(selected.id));
    if (Result.isFailure(acquisition)) {
      fileSyncStatus = "unavailable";
      yield* recorder.recordFailure("file-sync", acquisition.failure);
      return fileSyncStatus;
    }
    fileSync = Option.some(acquisition.success);
  }

  if (fileSync._tag === "Some") {
    yield* Effect.scoped(fileSync.value.setup({ force: false, network })).pipe(
      Effect.provideService(NetworkTrust, networkTrustFromResolved(network)),
      Effect.tapError((cause) => recorder.recordFailure("file-sync", cause)),
    );
    const liveClientAvailable = yield* fileSync.value.isAvailable.pipe(
      Effect.catch(() => Effect.succeed(false)),
    );
    if (liveClientAvailable) {
      yield* recordInstalledFileSync(
        `File-sync setup installed ${fileSync.value.id} and the live client is available.`,
      );
    } else {
      fileSyncStatus = "unavailable";
      yield* recorder.record({
        id: "file-sync",
        status: "skipped",
        evidence: `File-sync engine ${fileSync.value.id} is installed, but this build has no live file-sync session client.`,
        remediation: "Continue with ordinary mounts; accelerated file sync is unavailable in this build.",
      });
    }
  } else {
    fileSyncStatus = "unavailable";
    yield* recorder.record({
      id: "file-sync",
      status: "skipped",
      evidence: "No live file-sync engine is available; ordinary mounts remain available.",
      remediation: "Continue with ordinary mounts; accelerated file sync is unavailable in this build.",
    });
  }

  return fileSyncStatus;
});
