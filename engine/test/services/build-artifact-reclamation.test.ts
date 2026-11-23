import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, type ArtifactListing, ProviderId, ServiceName } from "@lando/sdk/schema";
import {
  EventService,
  PathsService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { makeTestRuntimeProvider, makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { DateTime, Deferred, Effect, Fiber, Layer, Queue } from "effect";
import { CommandWarnings, makeCommandWarnings } from "../../src/landofile/command-warnings.ts";
import { withBuiltArtifactsLock } from "../../src/services/build-artifact-lock.ts";
import { artifactBuildStoreKey } from "../../src/services/build-artifact-name.ts";
import { sweepBuiltArtifacts } from "../../src/services/build-artifact-reclamation.ts";
import {
  type ArtifactBuildResult,
  openArtifactBuildResults,
  useArtifactBuildResult,
} from "../../src/services/build-artifact-results.ts";
import * as Events from "../../src/services/event-service.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const now = DateTime.makeUnsafe("2026-11-14T00:00:00Z");
const entry = (ref: string, providerId = "test"): ArtifactBuildResult => ({
  owner: "root-owner",
  providerId,
  phase: "artifact",
  service: ServiceName.make("web"),
  buildKey: ref,
  artifactRef: ref,
  artifactOrigin: "build",
  outcome: "complete",
  durationMs: 1,
  transcriptPath: AbsolutePath.make("/tmp/build.log"),
  completedAt: now,
});
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-built-images-"));
  const paths = makeLandoPaths({ env: {}, userDataRoot: root, userCacheRoot: join(root, "cache") });
  const storeKey = await Effect.runPromise(artifactBuildStoreKey(paths.roots.userCacheRoot));
  const ref = (name: string) => `lando-build-${storeKey}-${name}`;
  const store = makeTestStateStore();
  const warnings = makeCommandWarnings(true);
  const removed: Array<Parameters<RuntimeProviderShape["removeArtifact"]>[0]> = [];
  let images: readonly ArtifactListing[] = [];
  const base = makeTestRuntimeProvider();
  const provider: RuntimeProviderShape = {
    ...base,
    listArtifacts: () => Effect.succeed(images),
    removeArtifact: (request) =>
      Effect.sync(() => {
        removed.push(request);
        return { kind: "removed" as const };
      }),
  };
  const registry = makeTestRuntimeProviderRegistry({
    list: Effect.succeed([ProviderId.make("test")]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  });
  const layer = Layer.mergeAll(
    store.layer,
    Events.layer,
    Layer.succeed(CommandWarnings, warnings),
    Layer.succeed(RuntimeProviderRegistry, registry),
    Layer.succeed(PathsService, paths),
  );
  const bucket = await Effect.runPromise(openArtifactBuildResults(store.service));
  return {
    bucket,
    ref,
    provider,
    registry,
    removed,
    warnings,
    layer,
    setImages: (next: readonly ArtifactListing[]) => {
      images = next;
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
};

test("sweep preserves store-wide named refs, foreign tags and named bare IDs across two providers", async () => {
  const f = await fixture();
  try {
    const named = f.ref("named");
    f.setImages([
      { id: "shared", refs: [`localhost/${named}:latest`] },
      { id: "foreign", refs: [f.ref("retagged"), "custom:1"] },
      { id: "sha256:bare", refs: [] },
      { id: "unused", refs: [f.ref("unused-a"), f.ref("unused-b")] },
    ]);
    await Effect.runPromise(f.bucket.set({ results: [entry(named, "other"), entry("bare")], claims: [] }));
    const result = await Effect.runPromise(
      sweepBuiltArtifacts(["test", "other"]).pipe(Effect.provide(f.layer)),
    );
    expect(f.removed.map((item) => item.ref)).toEqual([
      f.ref("unused-a"),
      f.ref("unused-b"),
      f.ref("unused-a"),
      f.ref("unused-b"),
    ]);
    expect(f.removed.every((item) => item.pruneParents === true)).toBe(true);
    expect(result).toEqual({ removed: 1, inUse: [] });
  } finally {
    await f.close();
  }
});

test.each([false, true])(
  "a live claim on any provider protects dangling images and disables parent pruning (live=%s)",
  async (live) => {
    const f = await fixture();
    try {
      f.setImages([
        { id: "dangling", refs: [] },
        { id: "tagged", refs: [f.ref("unused")] },
        { id: "claimed", refs: [f.ref("claimed")] },
      ]);
      await Effect.runPromise(
        f.bucket.set({
          results: [],
          claims: [
            {
              id: "claim",
              providerId: "other",
              artifactRef: f.ref("claimed"),
              pid: live ? process.pid : 2_147_483_647,
              claimedAt: now,
            },
          ],
        }),
      );
      const result = await Effect.runPromise(sweepBuiltArtifacts(["test"]).pipe(Effect.provide(f.layer)));
      expect(f.removed.map((item) => item.ref)).toEqual(
        live ? [f.ref("unused")] : ["dangling", f.ref("unused"), f.ref("claimed")],
      );
      expect(f.removed.map((item) => item.pruneParents)).toEqual(live ? [false] : [true, true, true]);
      expect(result.removed).toBe(live ? 1 : 3);
    } finally {
      await f.close();
    }
  },
);

test("in-use images return container evidence without command warnings", async () => {
  const f = await fixture();
  try {
    f.setImages([{ id: "used", refs: [f.ref("used")] }]);
    const registry = {
      ...f.registry,
      select: () =>
        Effect.succeed({
          ...f.provider,
          removeArtifact: () =>
            Effect.succeed({
              kind: "in-use" as const,
              containers: ["web", "worker"],
              reason: "active containers",
            }),
        }),
    };
    const result = await Effect.runPromise(
      sweepBuiltArtifacts(["test"]).pipe(
        Effect.provideService(RuntimeProviderRegistry, registry),
        Effect.provide(f.layer),
      ),
    );
    expect(result).toEqual({
      removed: 0,
      inUse: [{ ref: f.ref("used"), containers: ["web", "worker"], reason: "active containers" }],
    });
    expect(await Effect.runPromise(f.warnings.list)).toEqual([]);
  } finally {
    await f.close();
  }
});

test.each(["selection", "listing", "removal"] as const)(
  "%s failure warns once per provider and promises next-build cleanup",
  async (failure) => {
    const f = await fixture();
    try {
      f.setImages([
        { id: "a", refs: [f.ref("a")] },
        { id: "b", refs: [f.ref("b")] },
      ]);
      const error = new ProviderUnavailableError({
        providerId: "test",
        operation: "listArtifacts",
        message: "unavailable",
        remediation: "Start the provider.",
      });
      const provider = {
        ...f.provider,
        ...(failure === "listing" ? { listArtifacts: () => Effect.fail(error) } : {}),
        ...(failure === "removal" ? { removeArtifact: () => Effect.fail(error) } : {}),
      };
      const registry = {
        ...f.registry,
        select: () => (failure === "selection" ? Effect.fail(error) : Effect.succeed(provider)),
      };
      await Effect.runPromise(
        sweepBuiltArtifacts(["test", "test", "other"]).pipe(
          Effect.provideService(RuntimeProviderRegistry, registry),
          Effect.provide(f.layer),
        ),
      );
      const warnings = await Effect.runPromise(f.warnings.list);
      expect(warnings.map((warning) => [warning.code, warning.context?.provider])).toEqual([
        ["LANDO_BUILT_IMAGE_CLEANUP_FAILED", "test"],
        ["LANDO_BUILT_IMAGE_CLEANUP_FAILED", "other"],
      ]);
      expect(warnings[0]?.message).toContain("next build on that provider removes");
    } finally {
      await f.close();
    }
  },
);

test("adoption waits for a sweep's operation lock and the image named by its source survives", async () => {
  const f = await fixture();
  const entered = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  try {
    const source = entry(f.ref("shared"));
    await Effect.runPromise(f.bucket.set({ results: [source], claims: [] }));
    const registry = {
      ...f.registry,
      select: () =>
        Effect.succeed({
          ...f.provider,
          listArtifacts: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as([{ id: "shared", refs: [source.artifactRef] }]),
            ),
        }),
    };
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          const queue = yield* events.subscribeQueue;
          const sweep = yield* sweepBuiltArtifacts(["test"]).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const adoption = yield* withBuiltArtifactsLock(
            useArtifactBuildResult(f.bucket, { ...source, owner: "requester" }),
          ).pipe(Effect.forkChild);
          let event = yield* Queue.take(queue);
          while (event._tag !== "lock.wait") event = yield* Queue.take(queue);
          const whileLocked = yield* f.bucket.get;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(sweep);
          const hit = yield* Fiber.join(adoption);
          return { whileLocked, hit };
        }),
      ).pipe(
        Effect.provideService(RuntimeProviderRegistry, registry),
        Effect.provide(f.layer),
        Effect.timeout("5 seconds"),
      ),
    );
    expect(result.whileLocked?.results.map((item) => item.owner)).toEqual(["root-owner"]);
    expect(result.hit?.entry.owner).toBe("requester");
    expect(f.removed).toEqual([]);
  } finally {
    await f.close();
  }
});
