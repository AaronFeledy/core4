import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { AppPlan, ProviderId } from "@lando/sdk/schema";
import {
  BuildOrchestrator,
  EventService,
  PathsService,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Queue, Schema } from "effect";
import * as Builder from "../../src/services/build-orchestrator.ts";
import * as Events from "../../src/services/event-service.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

test("settles declared artifact tasks when interrupted after tree-start delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-publication-"));
  const delivered = Deferred.makeUnsafe<void>();
  const interruption = 7391;
  const calls: string[] = [];
  const plan = Schema.decodeUnknownSync(AppPlan)({
    id: "artifact-publication",
    name: "Artifact publication",
    slug: "artifact-publication",
    root,
    provider: "test",
    services: Object.fromEntries(
      ["web", "sibling", "queued"].map((name) => [
        name,
        {
          name,
          type: "test",
          provider: "test",
          primary: name === "web",
          environment: {},
          mounts: [],
          endpoints: [],
          routes: [],
          dependsOn: [],
          hostAliases: [],
          extensions: {},
          metadata: { resolvedAt: "2026-11-14T00:00:00Z", source: "artifact-publication", runtime: 4 },
          ...(name === "queued" ? { provenance: { clonedBy: { feature: "test.clone", from: "web" } } } : {}),
        },
      ]),
    ),
    routes: [],
    stores: [],
    fileSync: [],
    extensions: {},
    metadata: { resolvedAt: "2026-11-14T00:00:00Z", source: "artifact-publication", runtime: 4 },
  });
  const provider = {
    ...TestRuntimeProvider,
    buildArtifact: (spec: Parameters<typeof TestRuntimeProvider.buildArtifact>[0]) =>
      Effect.sync(() => {
        calls.push(String(spec.service));
      }).pipe(Effect.andThen(TestRuntimeProvider.buildArtifact(spec))),
  };
  const dependencies = Layer.mergeAll(
    Events.layer,
    Layer.succeed(PathsService, makeLandoPaths({ userDataRoot: root })),
    Layer.succeed(StateStore, makeTestStateStore().service),
    Layer.succeed(
      RuntimeProviderRegistry,
      RuntimeProviderRegistry.of({
        appliedPlansFor: () => Effect.succeed([]),
        resolveAppliedPlan: () => Effect.succeed(undefined),
        resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
        list: Effect.succeed([ProviderId.make(provider.id)]),
        capabilities: Effect.succeed(provider.capabilities),
        select: () => Effect.succeed(provider),
      }),
    ),
  );
  const layer = Layer.mergeAll(dependencies, Builder.layer.pipe(Layer.provide(dependencies)));
  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const queue = yield* (yield* EventService).subscribeQueue;
          const builder = yield* BuildOrchestrator;
          const fiber = yield* builder.build(plan).pipe(
            Effect.provideService(Events.EventPublicationObserver, (event) =>
              event._tag === "task.tree.start"
                ? Deferred.succeed(delivered, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.void,
            ),
            Effect.forkScoped,
          );
          yield* Deferred.await(delivered);
          yield* Fiber.interruptAs(fiber, interruption);
          const exit = yield* Fiber.await(fiber);
          return { exit, events: [...(yield* Queue.clear(queue))] };
        }),
      ).pipe(Effect.provide(layer)),
    );

    if (Exit.isSuccess(result.exit)) throw new TypeError("interrupted build unexpectedly succeeded");
    expect(Cause.hasInterruptsOnly(result.exit.cause)).toBe(true);
    expect(result.exit.cause.reasons).toMatchObject([{ _tag: "Interrupt", fiberId: interruption }]);
    expect(calls).toEqual([]);
    expect(result.events.filter((event) => event._tag === "task.tree.start")).toHaveLength(1);
    expect(
      result.events
        .filter((event) => event._tag === "task.start")
        .map((event) => event.taskId)
        .sort(),
    ).toEqual(["queued", "sibling", "web"]);
    const terminals = result.events.filter(
      (event) => event._tag === "task.fail" || event._tag === "task.complete",
    );
    expect(terminals.map((event) => [event.taskId, event._tag]).sort()).toEqual([
      ["queued", "task.fail"],
      ["sibling", "task.fail"],
      ["web", "task.fail"],
    ]);
    for (const terminal of terminals) expect(terminal).not.toHaveProperty("exitCode");
    expect(result.events.filter((event) => event._tag === "task.tree.complete")).toMatchObject([
      { outcome: "interrupted", succeeded: 0, failed: 3 },
    ]);
    expect(result.events.filter((event) => event._tag === "build-step-skip")).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
