import { readdir } from "node:fs/promises";
import { ScratchAppError, isErrnoCode } from "@lando/sdk/errors";
import type { AbsolutePath, AppPlan } from "@lando/sdk/schema";
import { PathsService, RuntimeProviderRegistry, type ScratchAppPaths, StateStore } from "@lando/sdk/services";
import { Effect } from "effect";
import { withBuiltImageCleanupBatch } from "../services/build-image-cleanup.ts";
import { makeScratchBuildTranscriptDir } from "../services/build-transcript.ts";
import type { makeScratchReaper } from "./destroy.ts";
import { scratchGcCandidates } from "./gc-candidates.ts";
import type { makeScratchLifecycleLock } from "./lifecycle-lock.ts";
import { ScratchRegistry } from "./registry.ts";
import { ScratchResourceScanner, isCanonicalScratchId } from "./scanner.ts";

const directoryScratchIds = (base: string, accept: (id: string) => boolean) =>
  Effect.tryPromise({
    try: async () =>
      (await readdir(base, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && accept(entry.name))
        .map((entry) => entry.name),
    catch: (cause) =>
      new ScratchAppError({
        operation: "gc",
        message: `Unable to inspect scratch app directories under ${base}.`,
        cause,
        remediation: "Fix permissions under the scratch directory, then retry `lando apps:scratch:gc`.",
      }),
  }).pipe(
    Effect.catchIf(
      (error) => isErrnoCode(error.cause, "ENOENT"),
      () => Effect.succeed([]),
    ),
  );

export const makeScratchGc = Effect.fnUntraced(function* (services: {
  readonly paths: (id: string) => Effect.Effect<ScratchAppPaths, ScratchAppError>;
  readonly readCachedPlan: (path: AbsolutePath) => Effect.Effect<AppPlan | undefined>;
  readonly reap: Effect.Success<typeof makeScratchReaper>;
  readonly withLock: Effect.Success<typeof makeScratchLifecycleLock>;
  readonly isUnsafeId: (id: string) => boolean;
}) {
  const configuredPaths = yield* PathsService;
  const stateStore = yield* StateStore;
  const providers = yield* RuntimeProviderRegistry;
  const registry = yield* ScratchRegistry;
  const scanner = yield* ScratchResourceScanner;
  const candidatesNow = Effect.gen(function* () {
    return scratchGcCandidates(
      yield* registry.list(),
      // A non-canonical instance directory is reported as an error on prune; build output Lando never
      // wrote under a non-canonical id is not a candidate at all.
      yield* directoryScratchIds(configuredPaths.scratchDir, (id) => !services.isUnsafeId(id)),
      yield* scanner.listScratchIds,
      yield* directoryScratchIds(
        makeScratchBuildTranscriptDir(configuredPaths.roots.userDataRoot),
        isCanonicalScratchId,
      ),
    );
  });
  return Effect.fn("ScratchAppService.gc")(function* (options?: { readonly prune?: boolean }) {
    const { inspected, candidates } = yield* candidatesNow;
    if (options?.prune !== true) return { inspected, candidates, reaped: [], errors: [] };
    const reaped: string[] = [];
    const errors: string[] = [];
    // One built-image sweep after every reap, not one per scratch id.
    yield* withBuiltImageCleanupBatch(
      Effect.gen(function* () {
        for (const id of candidates) {
          if (!isCanonicalScratchId(id)) {
            errors.push(`${id}: unsafe scratch id`);
            continue;
          }
          const { instanceRoot, planCache } = yield* services.paths(id);
          const result = yield* services
            .withLock(
              { id, instanceRoot },
              Effect.gen(function* () {
                if (!(yield* candidatesNow).candidates.includes(id)) return false;
                const plan = yield* services.readCachedPlan(planCache);
                yield* services.reap({
                  id,
                  instanceRoot,
                  reason: "gc",
                  ...(plan === undefined ? {} : { plan }),
                });
                return true;
              }),
            )
            .pipe(Effect.result);
          if (result._tag === "Success") {
            if (result.success) reaped.push(id);
          } else errors.push(`${id}: ${result.failure.message}`);
        }
      }),
    ).pipe(
      Effect.provideService(PathsService, configuredPaths),
      Effect.provideService(StateStore, stateStore),
      Effect.provideService(RuntimeProviderRegistry, providers),
    );
    return { inspected, candidates, reaped, errors };
  });
});
