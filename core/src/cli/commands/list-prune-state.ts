import { join } from "node:path";
import {
  APPLIED_STATE_VERSION,
  appliedStateInspectError,
  classifyAppliedStateStoreError,
  openAppliedPlansRecord,
} from "@lando/container-runtime/applied-state";
import { mapFailures } from "@lando/sdk/command-result";
import { StateStoreError } from "@lando/sdk/errors";
import { AbsolutePath, AppId } from "@lando/sdk/schema";
import type { LandoPaths, StateStoreShape } from "@lando/sdk/services";
import { FileSystem } from "@lando/sdk/services";
import { Effect, Option, Schema } from "effect";

import type { AppsListEntry } from "./list-discovery";

const APPLIED_PLAN_NAMESPACE = "applied-plans";
const APPLIED_PLANS_RECORD_KEY = "applied-plans.json";
const AppliedPlanIdentity = Schema.Struct({
  id: AppId,
  root: AbsolutePath,
});
const LegacyAppliedPlan = Schema.Struct({
  version: Schema.Literal(1),
  providerId: Schema.optionalKey(Schema.String),
  plan: Schema.Struct({
    id: AppId,
    root: AbsolutePath,
    provider: Schema.optionalKey(Schema.String),
  }),
});

const pluginIdForProvider = (providerId: string): string | undefined => {
  switch (providerId) {
    case "lando":
    case "docker":
    case "podman":
      return `@lando/provider-${providerId}`;
    default:
      return undefined;
  }
};

/** Structured prune skip for a record this Lando must not delete. */
export interface AppsListPruneFailure {
  readonly reason: "newer-version";
  readonly providerId: string;
  readonly path: string;
  readonly appId?: string;
  readonly storedVersion: number;
  readonly supportedVersion: number;
  readonly writtenBy?: string;
  readonly message: string;
  readonly remediation: string;
}

export type PruneAppliedPlanOutcome =
  | { readonly status: "removed" }
  | { readonly status: "kept" }
  | { readonly status: "protected"; readonly failure: AppsListPruneFailure };

const protectOrFail = (
  error: StateStoreError,
  meta: {
    readonly providerId: string;
    readonly layout: "per-app" | "record";
    readonly appId?: string;
  },
): Effect.Effect<PruneAppliedPlanOutcome, StateStoreError> => {
  const root = meta.layout === "record" ? "apps" : "plan";
  const fallbackPath =
    error.path ??
    (meta.layout === "record"
      ? APPLIED_PLANS_RECORD_KEY
      : `${APPLIED_PLAN_NAMESPACE}/${meta.appId ?? "app"}.json`);
  const read = classifyAppliedStateStoreError(error, root, fallbackPath);

  if (read.status === "newer-version") {
    return Effect.succeed({
      status: "protected",
      failure: {
        reason: "newer-version",
        providerId: meta.providerId,
        path: read.path,
        ...(meta.appId === undefined ? {} : { appId: meta.appId }),
        storedVersion: read.storedVersion,
        supportedVersion: read.supportedVersion,
        ...(read.writtenBy === undefined ? {} : { writtenBy: read.writtenBy }),
        message: error.message,
        remediation: error.remediation,
      },
    });
  }

  // Podman shared-map corrupt recovery: keep move-aside remediation on decode/version damage.
  const isCorrupt = error.reason === "decode" || error.reason === "version";
  if (meta.layout === "record" && isCorrupt) {
    const cause = appliedStateInspectError({
      providerId: meta.providerId,
      layout: "record",
      operation: "remove",
      read,
      ...(meta.appId === undefined ? {} : { appId: meta.appId }),
      cause: error,
    });
    return Effect.fail(
      new StateStoreError({
        reason: error.reason,
        operation: error.operation,
        path: read.path,
        remediation: cause.remediation,
        cause,
      }),
    );
  }

  return Effect.fail(error);
};

/**
 * Remove applied-plan inventory for one stale list entry. Modern (plugin) state is
 * inspected under one lock before any legacy delete, and a record is removed only when its
 * stored id and root both match the entry. A newer-format modern record is never removed:
 * it is a protected skip when it alone backs the entry, and when a legacy row also claims the
 * root its unreadable root cannot prove they are one candidate, so both are kept unreported.
 */
export const pruneAppliedPlanState = Effect.fnUntraced(function* (
  paths: LandoPaths,
  stateStore: StateStoreShape,
  entry: AppsListEntry,
): Effect.fn.Return<PruneAppliedPlanOutcome, StateStoreError, FileSystem> {
  const { appId, providerId } = entry;
  const pluginId = pluginIdForProvider(providerId);
  if (pluginId === undefined) return { status: "kept" };
  const root = { path: AbsolutePath.make(paths.pluginStateDir(pluginId)) };
  const id = AppId.make(appId);

  if (providerId === "podman") {
    const bucket = yield* openAppliedPlansRecord({ open: (spec) => stateStore.open({ ...spec, root }) });
    return yield* bucket
      .mutate<boolean>((current) => {
        if (current === null || !Object.hasOwn(current, id) || current[id]?.root !== entry.appRoot) {
          return Effect.succeed({ _tag: "Keep", result: false });
        }
        const { [id]: _removed, ...remaining } = current;
        return Effect.succeed({ _tag: "Set", value: remaining, result: true });
      })
      .pipe(
        Effect.map(
          (removed): PruneAppliedPlanOutcome => (removed ? { status: "removed" } : { status: "kept" }),
        ),
        Effect.catchTag("StateStoreError", (error) =>
          protectOrFail(error, { providerId, layout: "record", appId }),
        ),
      );
  }

  // Modern per-app record first: locked compare-and-remove, never get-then-remove.
  const modernOutcome = yield* stateStore
    .open({
      root,
      namespace: APPLIED_PLAN_NAMESPACE,
      key: `${id}.json`,
      schema: AppliedPlanIdentity,
      version: APPLIED_STATE_VERSION,
      codec: "json",
      mode: 0o600,
      lock: "advisory",
      onCorrupt: "discard",
      // Only older stamps reach the migrator; newer frames fail as reason newer-version first.
      onVersionMismatch: (raw, _fromVersion) =>
        Option.getOrNull(Schema.decodeUnknownOption(AppliedPlanIdentity)(raw)),
    })
    .pipe(
      Effect.flatMap((bucket) =>
        bucket
          .mutate<boolean>((plan) => {
            if (plan === null || plan.id !== id || plan.root !== entry.appRoot) {
              return Effect.succeed({ _tag: "Keep", result: false });
            }
            return Effect.succeed({ _tag: "Remove", result: true });
          })
          .pipe(
            Effect.map(
              (removed): PruneAppliedPlanOutcome => (removed ? { status: "removed" } : { status: "kept" }),
            ),
            Effect.catchTag("StateStoreError", (error) =>
              protectOrFail(error, { providerId, layout: "per-app", appId }),
            ),
          ),
      ),
      Effect.catchTag("StateStoreError", (error) =>
        protectOrFail(error, { providerId, layout: "per-app", appId }),
      ),
    );

  const fs = yield* FileSystem;
  const namespace = `providers/provider-${providerId}/apps`;
  const directory = join(paths.roots.userDataRoot, namespace);
  const names = yield* fs.readDir(directory).pipe(
    Effect.catchTag("FileNotFoundError", () => Effect.succeed([])),
    mapFailures(
      (cause) =>
        new StateStoreError({
          reason: "io",
          operation: "readDir",
          path: directory,
          cause,
          remediation: `Fix permissions on ${directory} so Lando can list legacy app state.`,
        }),
    ),
  );
  const matches = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const bucket = yield* stateStore.open({
      root: { path: AbsolutePath.make(directory) },
      key: name,
      schema: LegacyAppliedPlan,
      version: APPLIED_STATE_VERSION,
      codec: {
        encode: JSON.stringify,
        decode: (raw) =>
          Schema.decodeUnknownSync(Schema.fromJsonString(LegacyAppliedPlan))(new TextDecoder().decode(raw)),
      },
      lock: "advisory",
      onCorrupt: "fail",
    });
    const record = yield* bucket.get;
    if (record === null || record.plan.id !== id) continue;
    // Another checkout may hold the same app id at a different root; that record is not this
    // candidate and must not turn the prune into a conflict.
    if (record.plan.root !== entry.appRoot) continue;
    const conflicting =
      (record.providerId !== undefined && record.providerId.replace(/^provider-/u, "") !== providerId) ||
      (record.plan.provider !== undefined && record.plan.provider.replace(/^provider-/u, "") !== providerId);
    matches.push({ bucket, conflicting });
  }
  if (modernOutcome.status === "protected")
    // The newer record's root is unreadable here, so a legacy row at this root may belong to another
    // checkout: keep every byte without claiming the protected record is this candidate.
    return matches.length === 0 ? modernOutcome : { status: "kept" };
  const conflict = matches.find((match) => match.conflicting);
  if (conflict !== undefined)
    return yield* Effect.fail(
      new StateStoreError({
        reason: "decode",
        operation: "prune",
        path: conflict.bucket.path,
        remediation: "Resolve the conflicting app root or provider in legacy inventory before pruning.",
      }),
    );
  for (const { bucket } of matches) yield* bucket.remove;
  if (modernOutcome.status === "removed" || matches.length > 0) return { status: "removed" };
  return { status: "kept" };
});
