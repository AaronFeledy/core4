import { expect, test } from "bun:test";
import { AbsolutePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import {
  BuildOrchestrator,
  type RuntimeProviderShape,
  type ServiceRuntimeInfo,
  StateStore,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Deferred, Effect, Stream } from "effect";
import { withActivationObservations } from "../../src/services/build-app-observation.ts";
import { withBuildProvider } from "../../src/services/build-orchestrator.ts";
import { BuildOwner } from "../../src/services/build-owner.ts";
import { openAppBuildResults } from "../../src/services/build-results.ts";
import { makeLayer, planWith, providerId, withTempRoots } from "./build-app-runner-test-support.ts";

const plan = planWith({
  web: [
    { id: "prepare", phase: "app", command: { command: ["prepare"] } },
    { id: "install", phase: "app", command: { command: ["install"] } },
  ],
});
const info = (containerId?: string): ServiceRuntimeInfo => ({
  app: plan.id,
  service: ServiceName.make("web"),
  providerId,
  status: "running",
  publications: { status: "unknown" },
  ...(containerId === undefined ? {} : { containerId }),
});

for (const identity of ["activation-A", undefined, ""] as const) {
  test(`activation entry ${String(identity)} is authoritative over a reusable provider identity`, async () => {
    await withTempRoots(async () => {
      let inspectedId = identity === "activation-A" ? "activation-A" : "provider-B";
      let inspections = 0;
      const commands: string[] = [];
      const provider = {
        ...TestRuntimeProvider,
        inspect: () =>
          Effect.sync(() => {
            inspections += 1;
            return info(inspectedId);
          }),
        execStream: (_target, command) => {
          commands.push(command.command[0] ?? "");
          return Stream.make({ exitCode: 0 });
        },
      } satisfies RuntimeProviderShape;
      const entries = await Effect.runPromise(
        Effect.gen(function* () {
          const builds = yield* BuildOrchestrator;
          yield* builds.buildApp(plan);
          inspections = 0;
          commands.length = 0;
          inspectedId = "provider-B";
          yield* withActivationObservations(builds.buildApp(plan), new Map([["web", info(identity)]]));
          return yield* (yield* openAppBuildResults(yield* StateStore, BuildOwner.fromPlan(plan))).get;
        }).pipe(Effect.provide(makeLayer(provider))),
      );

      expect(inspections).toBe(0);
      expect(commands).toEqual(identity === "activation-A" ? [] : ["prepare", "install"]);
      expect(entries?.map((entry) => entry.containerId)).toEqual(
        identity === "activation-A" ? ["activation-A", "activation-A"] : [undefined, undefined],
      );
    });
  });
}

test("missing activation entries and standalone phases inspect once per service and observe fresh identities", async () => {
  await withTempRoots(async () => {
    let generation = 0;
    let inspections = 0;
    let commands = 0;
    const provider = {
      ...TestRuntimeProvider,
      inspect: () =>
        Effect.sync(() => {
          inspections += 1;
          return info(`web-${generation}`);
        }),
      execStream: () => {
        commands += 1;
        return Stream.make({ exitCode: 0 });
      },
    } satisfies RuntimeProviderShape;
    const counts = await Effect.runPromise(
      Effect.gen(function* () {
        const builds = yield* BuildOrchestrator;
        const counts = [];
        yield* withActivationObservations(builds.buildApp(plan), new Map());
        counts.push([inspections, commands]);
        generation = 1;
        yield* builds.buildApp(plan);
        counts.push([inspections, commands]);
        yield* builds.buildApp(plan);
        counts.push([inspections, commands]);
        return counts;
      }).pipe(Effect.provide(makeLayer(provider))),
    );
    expect(counts).toEqual([
      [1, 2],
      [2, 4],
      [3, 4],
    ]);
  });
});

test("concurrent owners and providers keep separate snapshots and restore standalone observation", async () => {
  await withTempRoots(async () => {
    const bothEntered = await Effect.runPromise(Deferred.make<void>());
    let entered = 0;
    const inspections: string[] = [];
    const providers = ["one", "two"].map(
      (name) =>
        ({
          ...TestRuntimeProvider,
          id: ProviderId.make(name),
          inspect: () =>
            Effect.sync(() => {
              inspections.push(name);
              return info(`standalone-${name}`);
            }),
          execStream: () =>
            Stream.fromEffect(
              Effect.gen(function* () {
                entered += 1;
                if (entered === 2) yield* Deferred.succeed(bothEntered, undefined);
                yield* Deferred.await(bothEntered);
                return { exitCode: 0 };
              }),
            ),
        }) satisfies RuntimeProviderShape,
    );
    const records = await Effect.runPromise(
      Effect.gen(function* () {
        const builds = yield* BuildOrchestrator;
        return yield* Effect.forEach(
          providers,
          (provider) =>
            Effect.gen(function* () {
              const ownPlan = {
                ...plan,
                root: AbsolutePath.make(`/tmp/observation-${provider.id}`),
                provider: provider.id,
              };
              yield* withBuildProvider(
                withActivationObservations(
                  builds.buildApp(ownPlan),
                  new Map([["web", { ...info(`activation-${provider.id}`), providerId: provider.id }]]),
                ),
                provider,
              );
              const bucket = yield* openAppBuildResults(yield* StateStore, BuildOwner.fromPlan(ownPlan));
              const activated = yield* bucket.get;
              yield* withBuildProvider(builds.buildApp(ownPlan), provider);
              return {
                activated: activated?.map((entry) => entry.containerId),
                standalone: (yield* bucket.get)?.map((entry) => entry.containerId),
              };
            }),
          { concurrency: "unbounded" },
        );
      }).pipe(Effect.provide(makeLayer(TestRuntimeProvider))),
    );
    expect(records).toEqual([
      { activated: ["activation-one", "activation-one"], standalone: ["standalone-one", "standalone-one"] },
      { activated: ["activation-two", "activation-two"], standalone: ["standalone-two", "standalone-two"] },
    ]);
    expect(inspections.toSorted()).toEqual(["one", "two"]);
  });
});
