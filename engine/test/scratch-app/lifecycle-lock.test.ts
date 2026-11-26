import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppId, ProviderId } from "@lando/sdk/schema";
import { type RuntimeProviderShape, ScratchAppService } from "@lando/sdk/services";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { withAppMutationLock } from "../../src/operations/app-mutation-lock.ts";
import { scratchGcCandidates } from "../../src/scratch-app/gc-candidates.ts";
import { BuildOwner } from "../../src/services/build-owner.ts";
import { makeBuildTranscriptAppDir } from "../../src/services/build-transcript.ts";
import { withStartupFixture } from "./startup-fixture.ts";

const ready = {
  inspect: (target) =>
    Effect.succeed({
      app: target.app,
      service: target.service,
      providerId: ProviderId.make("lando"),
      status: "running" as const,
      publications: { status: "unknown" as const },
      containerId: "scratch-web",
    }),
  exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
} satisfies Partial<RuntimeProviderShape>;

const acquire = (detached: boolean) =>
  Effect.flatMap(ScratchAppService, (service) =>
    service.acquire({ source: { kind: "fork" }, isolate: "none", detached }),
  );

test("#2292 discovers and prunes build-output-only scratch ids", async () => {
  await withStartupFixture(ready, async (f) => {
    const id = "scratch-output-123456";
    const directory = makeBuildTranscriptAppDir({
      userDataRoot: f.root,
      owner: BuildOwner.scratch(AppId.make(id)),
    });
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "old.log"), "old output");
    await mkdir(join(directory, "..", "not-canonical"), { recursive: true });
    expect(scratchGcCandidates([], [], [], [id])).toEqual({ inspected: 1, candidates: [id] });
    const report = await Effect.runPromise(
      Effect.flatMap(ScratchAppService, (s) => s.gc()).pipe(Effect.provide(f.layer)),
    );
    expect(report).toEqual({ inspected: 1, candidates: [id], reaped: [], errors: [] });
    expect(existsSync(directory)).toBe(true);
    const pruned = await Effect.runPromise(
      Effect.flatMap(ScratchAppService, (s) => s.gc({ prune: true })).pipe(Effect.provide(f.layer)),
    );
    expect(pruned).toEqual({ inspected: 1, candidates: [id], reaped: [id], errors: [] });
    expect(existsSync(directory)).toBe(false);
    expect(existsSync(join(directory, "..", "not-canonical"))).toBe(true);
  });
});

test("#2292 explicit destroy waits for acquisition through mark-running", async () => {
  const entered = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const waiting = Promise.withResolvers<void>();
  await withStartupFixture(
    ready,
    async (f) => {
      const acquisition = Effect.runFork(acquire(true).pipe(Effect.scoped, Effect.provide(f.layer)));
      await Effect.runPromise(Deferred.await(entered));
      const id = [...f.entries.keys()][0];
      if (id === undefined) throw new TypeError("Missing acquiring scratch id");
      const destruction = Effect.runFork(
        Effect.flatMap(ScratchAppService, (s) => s.destroy(id)).pipe(Effect.provide(f.layer)),
      );
      try {
        await Promise.race([
          waiting.promise,
          Effect.runPromise(Fiber.await(destruction)).then(() => {
            throw new TypeError("Destroy completed before acquisition released the lifecycle lock");
          }),
        ]);
        expect(f.destroyed).toEqual([]);
      } finally {
        await Effect.runPromise(Deferred.succeed(release, undefined));
        await Effect.runPromise(Fiber.await(acquisition));
        await Effect.runPromise(Fiber.await(destruction));
      }
      const handle = await Effect.runPromise(Fiber.join(acquisition));
      await Effect.runPromise(Fiber.join(destruction));
      expect(f.destroyed).toEqual([handle.id]);
      expect(f.entries.has(id)).toBe(false);
    },
    {
      registration: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      onEvent: (event) => {
        if (event._tag === "lock.wait" && event.subject === "app") waiting.resolve();
      },
    },
  );
});

test("#2292 gc rechecks a candidate that becomes running while waiting", async () => {
  const held = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const waiting = Promise.withResolvers<void>();
  await withStartupFixture(
    ready,
    async (f) => {
      const id = "scratch-racing-123456";
      const instanceRoot = join(f.root, "scratch", id);
      const holder = Effect.runFork(
        withAppMutationLock(
          { id, root: instanceRoot, kind: "scratch" },
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.provide(f.layer)),
      );
      await Effect.runPromise(Deferred.await(held));
      f.entries.set(id, {
        id,
        source: { kind: "fork" },
        isolate: "cwd",
        detached: true,
        rootPath: f.sourceRoot,
        layout: "legacy",
        status: "acquiring",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
      const gc = Effect.runFork(
        Effect.flatMap(ScratchAppService, (s) => s.gc({ prune: true })).pipe(Effect.provide(f.layer)),
      );
      await waiting.promise;
      await mkdir(instanceRoot, { recursive: true });
      const entry = f.entries.get(id);
      if (entry === undefined) throw new TypeError("Missing acquiring scratch id");
      f.entries.set(id, { ...entry, status: "running" });
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await Effect.runPromise(Fiber.join(holder));
      expect(await Effect.runPromise(Fiber.join(gc))).toEqual({
        inspected: 1,
        candidates: [id],
        reaped: [],
        errors: [],
      });
      expect(f.entries.get(id)?.status).toBe("running");
      expect(existsSync(instanceRoot)).toBe(true);
    },
    {
      onEvent: (event) => {
        if (event._tag === "lock.wait" && event.subject === "app") waiting.resolve();
      },
    },
  );
});

test("#2292 scope-close cleanup reacquires the scratch instance lock", async () => {
  const held = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const waiting = Promise.withResolvers<void>();
  await withStartupFixture(
    ready,
    async (f) => {
      const scope = await Effect.runPromise(Scope.make());
      const handle = await Effect.runPromise(
        acquire(false).pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(f.layer)),
      );
      const holder = Effect.runFork(
        withAppMutationLock(
          { id: handle.id, root: join(f.root, "scratch", handle.id), kind: "scratch" },
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ).pipe(Effect.provide(f.layer)),
      );
      await Effect.runPromise(Deferred.await(held));
      const closing = Effect.runFork(Scope.close(scope, Exit.void));
      try {
        await Promise.race([
          waiting.promise,
          Effect.runPromise(Fiber.await(closing)).then(() => {
            throw new TypeError("Scope cleanup completed while another caller held the lifecycle lock");
          }),
        ]);
        expect(f.destroyed).toEqual([]);
      } finally {
        await Effect.runPromise(Deferred.succeed(release, undefined));
        await Effect.runPromise(Fiber.join(holder));
        await Effect.runPromise(Fiber.join(closing));
      }
      expect(f.destroyed).toEqual([handle.id]);
      expect(f.entries.has(handle.id)).toBe(false);
    },
    {
      onEvent: (event) => {
        if (event._tag === "lock.wait" && event.subject === "app") waiting.resolve();
      },
    },
  );
});
