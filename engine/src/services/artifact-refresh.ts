import { Effect, Result, Schema } from "effect";

import { sha256Hex } from "@lando/sdk/digest";
import type { StateStoreError } from "@lando/sdk/errors";
import { ARTIFACT_REFRESH_EXTENSION, ArtifactRefreshIntent } from "@lando/sdk/schema";
import type { ProviderExtensionConfig } from "@lando/sdk/schema";
import type { StateBucket, StateStore } from "@lando/sdk/services";

export const PULL_CHECK_VERSION = 1;

export const PullCheck = Schema.Struct({
  ref: Schema.String,
  platform: Schema.String,
  runtimeId: Schema.String,
  checkedAt: Schema.Number,
  afterMs: Schema.Number,
});
export type PullCheck = typeof PullCheck.Type;

export const PullChecks = Schema.Record(Schema.String, PullCheck);
export type PullChecks = typeof PullChecks.Type;

export const pullCheckBucketSpec = {
  root: "userData" as const,
  namespace: "artifact-pull-checks",
  key: "checks",
  schema: PullChecks,
  version: PULL_CHECK_VERSION,
  codec: "json" as const,
  mode: 0o600,
  lock: "advisory" as const,
  onCorrupt: "discard" as const,
  onVersionMismatch: "discard" as const,
  default: {} as PullChecks,
};

export const openPullChecks = (
  stateStore: ContextStore,
): Effect.Effect<StateBucket<PullChecks>, StateStoreError> => stateStore.open(pullCheckBucketSpec);

type ContextStore = Pick<StateStore["Service"], "open">;

export const pullCheckKey = (input: {
  readonly runtimeId: string;
  readonly platform: string;
  readonly ref: string;
}): string => sha256Hex(`${input.runtimeId}\0${input.platform}\0${input.ref}`);

export const readArtifactRefreshAfterMs = (extensions: ProviderExtensionConfig): number | undefined => {
  const decoded = Schema.decodeUnknownResult(ArtifactRefreshIntent)(extensions[ARTIFACT_REFRESH_EXTENSION]);
  return Result.isSuccess(decoded) ? decoded.success.afterMs : undefined;
};

export type ArtifactPullAction = "reuse-local" | "refresh" | "missing";

/** Choose a pull without treating a fresh record as proof the image is present. */
export const decideArtifactPull = (input: {
  readonly forced: boolean;
  readonly refreshAfterMs: number | undefined;
  readonly localPresent: boolean;
  readonly checkedAt: number | undefined;
  readonly now: number;
}): ArtifactPullAction => {
  if (input.forced) return "refresh";
  if (input.refreshAfterMs === undefined) return "missing";
  if (!input.localPresent) return "missing";
  if (input.checkedAt === undefined) return "refresh";
  if (input.now - input.checkedAt >= input.refreshAfterMs) return "refresh";
  return "reuse-local";
};

/** A later successful check wins. An older write must not erase it. */
export const nextPullChecks = (
  current: PullChecks,
  key: string,
  record: PullCheck,
): PullChecks | undefined => {
  const existing = current[key];
  if (existing !== undefined && existing.checkedAt >= record.checkedAt) return undefined;
  return { ...current, [key]: record };
};

export const overduePullChecks = (
  checks: PullChecks,
  input: { readonly runtimeId: string; readonly now: number },
): ReadonlyArray<PullCheck> =>
  Object.values(checks)
    .filter((check) => check.runtimeId === input.runtimeId && input.now - check.checkedAt >= check.afterMs)
    .sort((left, right) => left.checkedAt - right.checkedAt);

export const recordPullCheck = (
  bucket: StateBucket<PullChecks>,
  key: string,
  record: PullCheck,
): Effect.Effect<void, StateStoreError> =>
  bucket
    .mutate((current) => {
      const next = nextPullChecks(current ?? {}, key, record);
      return next === undefined
        ? Effect.succeed({ _tag: "Keep" as const, result: undefined })
        : Effect.succeed({ _tag: "Set" as const, value: next, result: undefined });
    })
    .pipe(Effect.asVoid);

export const acquireReferencedArtifact = Effect.fnUntraced(function* <A, E>(input: {
  readonly pull: (policy: "always" | "missing" | "never") => Effect.Effect<A, E>;
  readonly forced: boolean;
  readonly refreshAfterMs: number | undefined;
  readonly checkedAt: number | undefined;
  readonly now: number;
  readonly onChecked: Effect.Effect<void, unknown>;
  readonly onFallback: (error: E) => Effect.Effect<void, unknown>;
}) {
  if (!input.forced && input.refreshAfterMs === undefined) return yield* input.pull("missing");

  const refreshed = Effect.fnUntraced(function* (fallback?: A) {
    const pulled = yield* Effect.result(input.pull("always"));
    if (Result.isSuccess(pulled)) {
      yield* input.onChecked.pipe(Effect.catch(() => Effect.void));
      return pulled.success;
    }
    if (fallback !== undefined) {
      yield* input.onFallback(pulled.failure).pipe(Effect.catch(() => Effect.void));
      return fallback;
    }
    const local = yield* Effect.result(input.pull("never"));
    if (Result.isSuccess(local)) {
      yield* input.onFallback(pulled.failure).pipe(Effect.catch(() => Effect.void));
      return local.success;
    }
    return yield* Effect.fail(pulled.failure);
  });

  if (input.forced) return yield* refreshed();

  const local = yield* Effect.result(input.pull("never"));
  if (Result.isFailure(local)) {
    const pulled = yield* input.pull("missing");
    yield* input.onChecked.pipe(Effect.catch(() => Effect.void));
    return pulled;
  }
  const action = decideArtifactPull({
    forced: false,
    refreshAfterMs: input.refreshAfterMs,
    localPresent: true,
    checkedAt: input.checkedAt,
    now: input.now,
  });
  if (action === "reuse-local") return local.success;
  return yield* refreshed(local.success);
});
