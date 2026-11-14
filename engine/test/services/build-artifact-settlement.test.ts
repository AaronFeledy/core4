import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { ProviderInternalError } from "@lando/sdk/errors";
import { AppPlan, ProviderId } from "@lando/sdk/schema";
import {
  BuildOrchestrator,
  EventService,
  PathsService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  StateStore,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Queue, Schema } from "effect";
import * as BuildLayer from "../../src/services/build-orchestrator.ts";
import * as Events from "../../src/services/event-service.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const plan = Schema.decodeUnknownSync(AppPlan)({
  id: "settlement",
  name: "Settlement",
  slug: "settlement",
  root: "/tmp/settlement",
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
        metadata: { resolvedAt: "2026-11-14T00:00:00Z", source: "settlement", runtime: 4 },
        ...(name === "queued" ? { provenance: { clonedBy: { feature: "test.clone", from: "web" } } } : {}),
      },
    ]),
  ),
  routes: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata: { resolvedAt: "2026-11-14T00:00:00Z", source: "settlement", runtime: 4 },
});
const failure = new ProviderInternalError({
  providerId: "test",
  operation: "buildArtifact",
  message: "injected failure",
  remediation: "Retry the build.",
});
const defect = new TypeError("injected defect");
const interruption = 2288;
const cases = [
  ["typed failure", Cause.fail(failure), "failure"],
  ["pure defect", Cause.die(defect), "failure"],
  ["pure interruption", Cause.interrupt(interruption), "interrupted"],
  [
    "failure and defect",
    Cause.fromReasons([Cause.makeFailReason(failure), Cause.makeDieReason(defect)]),
    "failure",
  ],
  [
    "failure and interruption",
    Cause.fromReasons([Cause.makeFailReason(failure), Cause.makeInterruptReason(interruption)]),
    "failure",
  ],
  [
    "all reasons",
    Cause.fromReasons([
      Cause.makeFailReason(failure),
      Cause.makeDieReason(defect),
      Cause.makeInterruptReason(interruption),
    ]),
    "failure",
  ],
] as const;

const dependencies = (provider: RuntimeProviderShape, root: string) => {
  const deps = Layer.mergeAll(
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
  return Layer.mergeAll(deps, BuildLayer.layer.pipe(Layer.provide(deps)));
};

test.each(cases)("settles every declared artifact task once for %s", async (_name, cause, outcome) => {
  const root = await mkdtemp(join(tmpdir(), "artifact-settlement-"));
  const siblingStarted = Deferred.makeUnsafe<void>();
  const calls: string[] = [];
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    buildArtifact: (spec) =>
      Effect.gen(function* () {
        calls.push(String(spec.service));
        if (String(spec.service) === "web") {
          yield* Deferred.await(siblingStarted);
          return yield* Effect.failCause(cause);
        }
        yield* Deferred.succeed(siblingStarted, undefined);
        return yield* Effect.never;
      }),
  };
  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          const queue = yield* events.subscribeQueue;
          const builder = yield* BuildOrchestrator;
          const exit = yield* Effect.exit(builder.build(plan));
          return { exit, events: [...(yield* Queue.clear(queue))] };
        }),
      ).pipe(Effect.provide(dependencies(provider, root))),
    );

    expect(Exit.isFailure(result.exit)).toBe(true);
    if (Exit.isFailure(result.exit)) {
      expect(result.exit.cause.reasons.slice(0, cause.reasons.length)).toMatchObject(cause.reasons);
      expect(result.exit.cause.reasons.slice(cause.reasons.length).every(Cause.isInterruptReason)).toBe(true);
    }
    expect(calls.sort()).toEqual(["sibling", "web"]);
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
      { succeeded: 0, failed: 3, outcome },
    ]);
    expect(
      result.events.filter((event) => event._tag === "build-step-skip").map((event) => event.serviceName),
    ).toEqual(cause.reasons.every(Cause.isFailReason) ? ["sibling", "queued"] : []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settles tasks and tree when the caller interrupts in-flight builds", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-interrupt-"));
  const started = Deferred.makeUnsafe<void>();
  const calls: string[] = [];
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    buildArtifact: (spec) =>
      Effect.gen(function* () {
        calls.push(String(spec.service));
        if (calls.length === 2) yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      }),
  };
  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          const queue = yield* events.subscribeQueue;
          const builder = yield* BuildOrchestrator;
          const fiber = yield* builder.build(plan).pipe(Effect.forkScoped);
          yield* Deferred.await(started);
          yield* Fiber.interrupt(fiber);
          const exit = yield* Fiber.await(fiber);
          return { exit, events: [...(yield* Queue.clear(queue))] };
        }),
      ).pipe(Effect.provide(dependencies(provider, root))),
    );
    expect(Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)).toBe(true);
    expect(calls.sort()).toEqual(["sibling", "web"]);
    expect(
      result.events
        .filter((event) => event._tag === "task.start")
        .map((event) => event.taskId)
        .sort(),
    ).toEqual(["queued", "sibling", "web"]);
    const terminals = result.events.filter((event) => event._tag === "task.fail");
    expect(terminals.map((event) => event.taskId).sort()).toEqual(["queued", "sibling", "web"]);
    for (const terminal of terminals) expect(terminal).not.toHaveProperty("exitCode");
    expect(result.events.filter((event) => event._tag === "task.tree.complete")).toMatchObject([
      { succeeded: 0, failed: 3, outcome: "interrupted" },
    ]);
    expect(result.events.filter((event) => event._tag === "build-step-skip")).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("success still publishes exactly one successful terminal per task and tree", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-success-"));
  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* EventService;
          const queue = yield* events.subscribeQueue;
          const builder = yield* BuildOrchestrator;
          const built = yield* builder.build(plan);
          return { built, events: [...(yield* Queue.clear(queue))] };
        }),
      ).pipe(Effect.provide(dependencies(TestRuntimeProvider, root))),
    );
    expect(Object.values(result.built.services).map((service) => service.artifact?.kind)).toEqual([
      "ref",
      "ref",
      "ref",
    ]);
    expect(result.events.filter((event) => event._tag === "task.start")).toHaveLength(3);
    expect(
      result.events
        .filter((event) => event._tag === "task.complete")
        .map((event) => event.taskId)
        .sort(),
    ).toEqual(["queued", "sibling", "web"]);
    expect(result.events.filter((event) => event._tag === "task.fail")).toEqual([]);
    expect(result.events.filter((event) => event._tag === "task.tree.complete")).toMatchObject([
      { succeeded: 3, failed: 0 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
