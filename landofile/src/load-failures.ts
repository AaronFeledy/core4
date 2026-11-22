import {
  type ComposeKeyRejectedError,
  LandofileLoadError,
  type LandofileLoadFailure,
  type NotImplementedError,
} from "@lando/sdk/errors";
import type { ValidationIssueSource } from "@lando/sdk/schema";
import { Effect } from "effect";
import { pathsOverlap } from "./validation-path.ts";

export interface DeferredLoadRefusal {
  readonly error: NotImplementedError;
  readonly source: ValidationIssueSource;
}

export interface LoadFailureRecorder {
  diagnostic: boolean;
  readonly entries: RecordedLoadFailure[];
  readonly effectiveChecks: Effect.Effect<unknown, ComposeKeyRejectedError | NotImplementedError>[];
  readonly deferredRefusals: DeferredLoadRefusal[];
  readonly failures: LandofileLoadFailure[];
  readonly blocked: ValidationIssueSource[];
  readonly prerequisites: Set<string>;
  recipeAvailable: boolean;
  readonly record: (error: LandofileLoadFailure, site?: LoadFailureSite) => void;
  readonly deferRefusal: (error: NotImplementedError, source: ValidationIssueSource) => void;
  /** Skips later load work under `source` without recording another failure. */
  readonly block: (source: ValidationIssueSource) => void;
}

type LoadFailureSite =
  | { readonly kind: "unpositioned" }
  | { readonly kind: "missing-content"; readonly source?: ValidationIssueSource }
  | {
      readonly kind: "local";
      readonly source: ValidationIssueSource;
      readonly normalizedContainer?: ValidationIssueSource;
      readonly block?: false;
    };

export type RecordedLoadFailure = LoadFailureSite & { readonly error: LandofileLoadFailure };

export const loadExpressionFailureKind = (path: ValidationIssueSource["path"]) =>
  path[0] === "includes" || path[0] === "include" || path[0] === "toolingIncludes"
    ? "missing-content"
    : "local";

export const createLoadFailureRecorder = (): LoadFailureRecorder => {
  const failures: LandofileLoadFailure[] = [];
  const entries: RecordedLoadFailure[] = [];
  const blocked: ValidationIssueSource[] = [];
  const effectiveChecks: LoadFailureRecorder["effectiveChecks"] = [];
  const deferredRefusals: DeferredLoadRefusal[] = [];
  return {
    diagnostic: false,
    entries,
    effectiveChecks,
    deferredRefusals,
    failures,
    blocked,
    prerequisites: new Set(),
    recipeAvailable: true,
    deferRefusal: (error, source) => {
      deferredRefusals.push({ error, source });
      effectiveChecks.push(Effect.fail(error));
    },
    record: (error, site = { kind: "unpositioned" }) => {
      failures.push(error);
      entries.push({ ...site, error });
      if (site.kind === "unpositioned" || (site.kind === "local" && site.block === false)) return;
      if (site.source !== undefined) blocked.push(site.source);
    },
    block: (source) => {
      blocked.push(source);
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
      pathsOverlap(source.path, blocked.path),
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
