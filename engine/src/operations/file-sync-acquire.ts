import { Effect, Option } from "effect";

import { FileSyncStartError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import type { FileSyncEngineShape, RuntimeProviderShape } from "@lando/sdk/services";

import { FileSyncResolver } from "../plugins/file-sync-resolver.ts";
import { fileSyncBundle } from "./file-sync-bundle.ts";
import type { FileSyncExecutionBundle } from "./file-sync-bundle.ts";

export const requireFileSyncProvider = Effect.fnUntraced(function* (
  bundle: FileSyncExecutionBundle,
  provider: RuntimeProviderShape,
) {
  if (bundle.kind === "ordinary") return;
  if (
    provider.prepareFileSyncTargets === undefined ||
    provider.inspectAppliedFileSync === undefined ||
    provider.capabilities.fileSyncTargets !== "prepared-volume"
  )
    return yield* Effect.fail(
      new FileSyncStartError({
        engineId: bundle.id,
        message:
          provider.inspectAppliedFileSync === undefined
            ? "The selected provider cannot verify previous accelerated mount state."
            : provider.prepareFileSyncTargets === undefined
              ? "The provider cannot prepare the planned accelerated targets."
              : "The selected provider cannot honor the planned accelerated target capability.",
        remediation:
          "Restore a provider with prepared-volume support, preparation, and applied-state inspection before retrying start.",
      }),
    );
});

/** Resolve an unbound engine by the recorded id, never by current selection. */
export const acquireFileSyncEngine = Effect.fnUntraced(function* (engineId: string) {
  const resolver = yield* Effect.serviceOption(FileSyncResolver);
  if (Option.isSome(resolver)) {
    return yield* resolver.value.acquire(engineId);
  }
  return yield* Effect.fail(
    new FileSyncStartError({
      engineId,
      message: `No file-sync resolver is provided for planned engine "${engineId}".`,
      remediation:
        "Select or restore the planned file-sync engine, or use ordinary bind mounts before retrying.",
    }),
  );
});

/** Fail closed when the acquired engine cannot honor required two-way-safe / exclusion intent. */
export const requireFileSyncPlanCapabilities = (
  engine: FileSyncEngineShape,
  plan: AppPlan,
): Effect.Effect<void, FileSyncStartError> => {
  for (const entry of plan.fileSync) {
    if (entry.engineId !== engine.id) {
      return Effect.fail(
        new FileSyncStartError({
          engineId: entry.engineId,
          message: `Planned file-sync engine "${entry.engineId}" does not match acquired engine "${engine.id}".`,
          remediation:
            "Select the planned file-sync engine or use ordinary bind mounts before retrying start.",
        }),
      );
    }
    if (!engine.capabilities.modes.includes(entry.session.mode)) {
      return Effect.fail(
        new FileSyncStartError({
          engineId: engine.id,
          sessionSpec: entry.session,
          message: `File-sync engine "${engine.id}" does not support required mode ${entry.session.mode}.`,
          remediation:
            "Choose a file-sync engine that supports two-way-safe, set defaultFileSyncEngine to passthrough, or set appMount.accelerate: false.",
        }),
      );
    }
    if (!engine.capabilities.exclusionPatterns) {
      return Effect.fail(
        new FileSyncStartError({
          engineId: engine.id,
          sessionSpec: entry.session,
          message: `File-sync engine "${engine.id}" does not support required exclusion patterns.`,
          remediation: "Choose a file-sync engine that supports exclusion patterns, or plan ordinary mounts.",
        }),
      );
    }
  }
  return Effect.void;
};

/** Acquire the sole planned engine id and prove it can run the plan before hooks or provider work. */
export const acquirePlannedFileSyncEngine = Effect.fnUntraced(function* (plan: AppPlan) {
  const bundle = yield* fileSyncBundle(plan);
  if (bundle.kind === "ordinary") {
    return yield* Effect.fail(
      new FileSyncStartError({
        engineId: "unknown",
        message: "No file-sync sessions are planned.",
        remediation: "Plan accelerated mounts before acquiring a file-sync engine.",
      }),
    );
  }
  const engine = yield* acquireFileSyncEngine(bundle.id);
  yield* requireFileSyncPlanCapabilities(engine, plan);
  return engine;
});

export const validateDesiredFileSyncEngine = Effect.fnUntraced(function* (plan: AppPlan) {
  const bundle = yield* fileSyncBundle(plan);
  if (bundle.kind === "ordinary") return;
  yield* acquirePlannedFileSyncEngine(plan);
});
