import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomicViaRename } from "@lando/engine/cache/atomic";

import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { causeMessage } from "@lando/sdk/errors";
import type { Redactor } from "@lando/sdk/secrets";
import { DateTime, Effect, Option, Schema } from "effect";
import { CliInvocation } from "../../runtime/invocation-context";

export const SetupReadinessStep = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["deferred", "failed", "installed", "satisfied", "skipped", "unavailable"]),
  evidence: Schema.String,
  remediation: Schema.optionalKey(Schema.String),
});
export type SetupReadinessStep = typeof SetupReadinessStep.Type;
export type SetupReadinessStepStatus = SetupReadinessStep["status"];

export const SetupReadinessRuntimeService = Schema.Struct({
  running: Schema.Boolean,
  socketPath: Schema.String,
  pid: Schema.optionalKey(Schema.Number),
  runtimeVersion: Schema.optionalKey(Schema.String),
});
export type SetupReadinessRuntimeService = typeof SetupReadinessRuntimeService.Type;

export const completedSetupReadinessStatus = (steps: ReadonlyArray<SetupReadinessStep>) => {
  if (steps.some((step) => step.status === "failed" || step.status === "unavailable")) return "failed";
  if (steps.some((step) => step.status === "deferred")) return "deferred";
  return "ready";
};

export const SetupReadinessSummary = Schema.Struct({
  status: Schema.Literals(["in-progress", "deferred", "failed", "ready"]),
  providerId: Schema.String,
  updatedAt: Schema.String,
  steps: Schema.Array(SetupReadinessStep),
  runtimeService: Schema.optionalKey(SetupReadinessRuntimeService),
}).check(
  Schema.makeFilter(
    (summary) =>
      summary.status === "in-progress" ||
      summary.status === "failed" ||
      summary.status === completedSetupReadinessStatus(summary.steps),
  ),
);
export type SetupReadinessSummary = typeof SetupReadinessSummary.Type;

export const setupReadinessPath = (userDataRoot: string): string =>
  join(userDataRoot, "setup", "readiness.json");

export const writeSetupReadiness = Effect.fnUntraced(function* (
  userDataRoot: string | undefined,
  providerId: string,
  snapshot: {
    readonly status: SetupReadinessSummary["status"];
    readonly steps: ReadonlyArray<SetupReadinessStep>;
    readonly runtimeService?: SetupReadinessRuntimeService | null | undefined;
  },
): Effect.fn.Return<void, never> {
  if (userDataRoot === undefined) return;
  const { status, steps, runtimeService } = snapshot;
  const service = yield* Effect.serviceOption(RedactionService);
  const sourceEnv = (yield* CliInvocation).env;
  const redactor = Option.isSome(service)
    ? yield* service.value.forProfile("secrets", { sourceEnv })
    : createStandaloneRedactor("secrets", { sourceEnv });
  const existing = yield* readSetupReadinessRaw(userDataRoot);
  const runtimeServiceBlock =
    runtimeService === undefined
      ? existing?.runtimeService === undefined
        ? {}
        : { runtimeService: existing.runtimeService }
      : runtimeService === null
        ? {}
        : { runtimeService };
  const summary: SetupReadinessSummary = {
    status,
    providerId,
    updatedAt: DateTime.formatIso(yield* DateTime.now),
    steps: steps.map((step) => ({
      ...step,
      evidence: redactor.redactString(step.evidence),
      ...(step.remediation === undefined ? {} : { remediation: redactor.redactString(step.remediation) }),
    })),
    ...runtimeServiceBlock,
  };
  yield* Effect.promise(() =>
    writeFileAtomicViaRename(setupReadinessPath(userDataRoot), `${JSON.stringify(summary, null, 2)}\n`),
  ).pipe(Effect.catch(() => Effect.void));
});

export const readSetupReadiness = (
  userDataRoot: string | undefined,
): Effect.Effect<SetupReadinessSummary | undefined, never> => {
  if (userDataRoot === undefined) return Effect.succeed(undefined);
  return readSetupReadinessRaw(userDataRoot).pipe(
    Effect.flatMap((summary) =>
      Effect.gen(function* () {
        if (summary === undefined) return undefined;
        const service = yield* Effect.serviceOption(RedactionService);
        const sourceEnv = (yield* CliInvocation).env;
        const redactor = Option.isSome(service)
          ? yield* service.value.forProfile("secrets", { sourceEnv })
          : createStandaloneRedactor("secrets", { sourceEnv });
        return redactSetupReadinessSummary(summary, redactor);
      }),
    ),
  );
};

const readSetupReadinessRaw = (
  userDataRoot: string | undefined,
): Effect.Effect<SetupReadinessSummary | undefined, never> => {
  if (userDataRoot === undefined) return Effect.succeed(undefined);
  // Missing, unreadable, malformed, and schema-invalid records are all absent evidence.
  return Effect.tryPromise({
    try: () => readFile(setupReadinessPath(userDataRoot), "utf-8"),
    catch: () => undefined,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SetupReadinessSummary))),
    Effect.catch(() => Effect.succeed(undefined)),
  );
};

const redactSetupReadinessSummary = (
  summary: SetupReadinessSummary,
  redactor: Redactor,
): SetupReadinessSummary => ({
  ...summary,
  providerId: redactor.redactString(summary.providerId),
  ...(summary.runtimeService === undefined
    ? {}
    : {
        runtimeService: {
          ...summary.runtimeService,
          socketPath: redactor.redactString(summary.runtimeService.socketPath),
          ...(summary.runtimeService.runtimeVersion === undefined
            ? {}
            : { runtimeVersion: redactor.redactString(summary.runtimeService.runtimeVersion) }),
        },
      }),
  steps: summary.steps.map((step) => ({
    ...step,
    id: redactor.redactString(step.id),
    evidence: redactor.redactString(step.evidence),
    ...(step.remediation === undefined ? {} : { remediation: redactor.redactString(step.remediation) }),
  })),
});

export const setupFailureEvidence = (stepId: string, cause: unknown, redactor: Redactor): string => {
  const message = causeMessage(cause);
  return redactor.redactString(`${stepId} setup failed: ${message}`);
};

const setupFailurePlatformHint = (stepId: string): string => {
  switch (process.platform) {
    case "darwin":
      return `On ${process.platform}, verify the Lando helper binaries, shell profile, and trust prompts are allowed, then rerun \`lando setup\`.`;
    case "win32":
      return `On ${process.platform}, rerun from an elevated shell only when the failing ${stepId} step requires host changes, then rerun \`lando setup\`.`;
    default:
      return `On ${process.platform}, verify sudo/askpass access and host integration prerequisites for the failing ${stepId} step, then rerun \`lando setup\`.`;
  }
};

export const setupFailureRemediation = (
  stepId: string,
  cause: unknown,
  redactor: Pick<Redactor, "redactString">,
): string =>
  redactor.redactString(`${setupFailurePlatformHint(stepId)} Last failure: ${causeMessage(cause)}`);
