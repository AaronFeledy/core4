import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";

import { writeFileAtomicViaRename } from "../../cache/atomic.ts";
import { redactString } from "../redact.ts";

export type SetupReadinessStepStatus =
  | "deferred"
  | "failed"
  | "installed"
  | "satisfied"
  | "skipped"
  | "unavailable";

export interface SetupReadinessStep {
  readonly id: string;
  readonly status: SetupReadinessStepStatus;
  readonly evidence: string;
  readonly remediation?: string;
}

export interface SetupReadinessRuntimeService {
  readonly running: boolean;
  readonly socketPath: string;
  readonly pid?: number;
  readonly runtimeVersion?: string;
}

export interface SetupReadinessSummary {
  readonly status: "deferred" | "failed" | "ready";
  readonly providerId: string;
  readonly updatedAt: string;
  readonly steps: ReadonlyArray<SetupReadinessStep>;
  readonly runtimeService?: SetupReadinessRuntimeService;
}

export const setupReadinessPath = (userDataRoot: string): string =>
  join(userDataRoot, "setup", "readiness.json");

const summaryStatus = (steps: ReadonlyArray<SetupReadinessStep>): SetupReadinessSummary["status"] => {
  if (steps.some((step) => step.status === "failed" || step.status === "unavailable")) return "failed";
  if (steps.some((step) => step.status === "deferred")) return "deferred";
  return "ready";
};

export const writeSetupReadiness = (
  userDataRoot: string | undefined,
  providerId: string,
  steps: ReadonlyArray<SetupReadinessStep>,
  runtimeService?: SetupReadinessRuntimeService,
): Effect.Effect<void, never> => {
  if (userDataRoot === undefined) return Effect.void;
  const summary: SetupReadinessSummary = {
    status: summaryStatus(steps),
    providerId,
    updatedAt: new Date().toISOString(),
    steps,
    ...(runtimeService === undefined ? {} : { runtimeService }),
  };
  return Effect.promise(() =>
    writeFileAtomicViaRename(setupReadinessPath(userDataRoot), `${JSON.stringify(summary, null, 2)}\n`),
  ).pipe(Effect.catchAll(() => Effect.void));
};

export const readSetupReadiness = (
  userDataRoot: string | undefined,
): Effect.Effect<SetupReadinessSummary | undefined, never> => {
  if (userDataRoot === undefined) return Effect.succeed(undefined);
  return Effect.tryPromise({
    try: async () =>
      redactSetupReadinessSummary(
        JSON.parse(await readFile(setupReadinessPath(userDataRoot), "utf-8")) as SetupReadinessSummary,
      ),
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
};

const redactSetupReadinessSummary = (summary: SetupReadinessSummary): SetupReadinessSummary => ({
  ...summary,
  ...(summary.runtimeService === undefined
    ? {}
    : {
        runtimeService: {
          ...summary.runtimeService,
          socketPath: redactString(summary.runtimeService.socketPath),
        },
      }),
  steps: summary.steps.map((step) => ({
    ...step,
    evidence: redactString(step.evidence),
    ...(step.remediation === undefined ? {} : { remediation: redactString(step.remediation) }),
  })),
});

export const setupFailureEvidence = (stepId: string, cause: unknown): string => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return redactString(`${stepId} setup failed: ${message}`);
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

export const setupFailureRemediation = (stepId: string, cause: unknown): string =>
  redactString(
    `${setupFailurePlatformHint(stepId)} Last failure: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
