import {
  type ComposeKeyRejectedError,
  LandofileLoadError,
  type LandofileLoadFailure,
  type NotImplementedError,
} from "@lando/sdk/errors";
import type { ValidationIssueSource } from "@lando/sdk/schema";
import { Effect } from "effect";

export interface LoadFailureRecorder {
  readonly effectiveChecks: Effect.Effect<unknown, ComposeKeyRejectedError | NotImplementedError>[];
  readonly failures: LandofileLoadFailure[];
  readonly blocked: ValidationIssueSource[];
  readonly prerequisites: Set<string>;
  recipeAvailable: boolean;
  readonly record: (error: LandofileLoadFailure, source?: ValidationIssueSource) => void;
}

export const createLoadFailureRecorder = (): LoadFailureRecorder => {
  const failures: LandofileLoadFailure[] = [];
  const blocked: ValidationIssueSource[] = [];
  return {
    effectiveChecks: [],
    failures,
    blocked,
    prerequisites: new Set(),
    recipeAvailable: true,
    record: (error, source) => {
      failures.push(error);
      if (source !== undefined) blocked.push(source);
    },
  };
};

export const loadPathBlocked = (
  recorder: LoadFailureRecorder | undefined,
  source: ValidationIssueSource,
): boolean => {
  if (recorder === undefined) return false;
  return recorder.blocked.some(
    (blocked) =>
      "file" in source &&
      "file" in blocked &&
      source.file === blocked.file &&
      source.layer === blocked.layer &&
      (source.path.every((part, index) => blocked.path[index] === part) ||
        blocked.path.every((part, index) => source.path[index] === part)),
  );
};

export const finishLoadStage = (file: string, recorder: LoadFailureRecorder) => {
  const [first, ...rest] = recorder.failures;
  if (first === undefined) return Effect.void;
  if (rest.length === 0) return Effect.fail(first);
  return Effect.fail(
    new LandofileLoadError({
      file,
      failures: [first, ...rest],
      message: `Landofile loading failed with ${recorder.failures.length} problems.`,
      remediation: "Fix each listed failure, then rerun the command.",
    }),
  );
};
