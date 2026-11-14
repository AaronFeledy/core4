import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { failureOutcomeFromCause } from "@lando/sdk/command-result";
import { ProviderInternalError } from "@lando/sdk/errors";
import { AppPlan, ProviderId } from "@lando/sdk/schema";
import {
  BuildOrchestrator,
  EventService,
  PathsService,
  RuntimeProviderRegistry,
  StateStore,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Exit, Layer, Queue, Schema } from "effect";
import * as Builder from "../../src/services/build-orchestrator.ts";
import * as Events from "../../src/services/event-service.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

test("queued skip publication defects remain cleanup diagnostics after task settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-finalization-"));
  const failure = new ProviderInternalError({
    providerId: "test",
    operation: "buildArtifact",
    message: "The image build failed.",
    remediation: "Fix the image build.",
  });
  const defect = { operation: "publish-build-skip", detail: "event publisher failed" };
  const plan = Schema.decodeUnknownSync(AppPlan)({
    id: "artifact-finalization",
    name: "Artifact finalization",
    slug: "artifact-finalization",
    root,
    provider: "test",
    services: Object.fromEntries(
      ["web", "queued"].map((name) => [
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
          metadata: { resolvedAt: "2026-11-14T00:00:00Z", source: "artifact-finalization", runtime: 4 },
          ...(name === "queued" ? { provenance: { clonedBy: { feature: "test.clone", from: "web" } } } : {}),
        },
      ]),
    ),
    routes: [],
    stores: [],
    fileSync: [],
    extensions: {},
    metadata: { resolvedAt: "2026-11-14T00:00:00Z", source: "artifact-finalization", runtime: 4 },
  });
  const provider = { ...TestRuntimeProvider, buildArtifact: () => Effect.fail(failure) };
  const eventLayer = Layer.effect(
    EventService,
    Effect.map(EventService, (events) =>
      EventService.of({
        ...events,
        publish: (event) => (event._tag === "build-step-skip" ? Effect.die(defect) : events.publish(event)),
      }),
    ),
  ).pipe(Layer.provide(Events.layer));
  const dependencies = Layer.mergeAll(
    eventLayer,
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
          const exit = yield* Effect.exit((yield* BuildOrchestrator).build(plan));
          return { exit, events: [...(yield* Queue.clear(queue))] };
        }),
      ).pipe(Effect.provide(layer)),
    );

    if (Exit.isSuccess(result.exit)) throw new TypeError("build failure unexpectedly recovered");
    expect(failureOutcomeFromCause(result.exit.cause)).toMatchObject({
      error: { _tag: "ProviderInternalError", operation: "buildArtifact", message: failure.message },
      additionalErrors: [{ role: "cleanup", error: defect }],
    });
    expect(
      result.events
        .filter((event) => event._tag === "task.fail")
        .map((event) => event.taskId)
        .sort(),
    ).toEqual(["queued", "web"]);
    expect(result.events.filter((event) => event._tag === "task.tree.complete")).toMatchObject([
      { outcome: "failure", succeeded: 0, failed: 2 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
