import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LandoRuntime, openLandoRuntime } from "@lando/core";
import { AbsolutePath, AppId, ServiceName } from "@lando/core/schema";
import { EventService, RouterService, RuntimeProvider } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { MessageInfoEvent } from "@lando/sdk/events";
import type { LandoEvent, ProviderError } from "@lando/sdk/services";
import { TestRouterService } from "@lando/sdk/test";
import { Effect, Layer, Queue, Schema } from "effect";
import { makeScenarioProvider } from "../../src/testing/scenario-provider.ts";

type ScenarioProvider = ReturnType<typeof makeScenarioProvider>;

const appName = "lifecycle-sequence";
const selectedService = ServiceName.make("app");
const removedService = ServiceName.make("db");

const OPERATIONS = ["start", "stop", "restart", "rebuild", "rebuild-selected"] as const;
type Operation = (typeof OPERATIONS)[number];
type Step = Operation | "remove" | "add";

const serviceBlock = (name: string, lines: ReadonlyArray<string>): string =>
  [`  ${name}:`, ...lines.map((line) => `    ${line}`)].join("\n");

const landofileYaml = (hasDatabase: boolean): string =>
  [
    `name: ${appName}`,
    "runtime: 4",
    `provider: ${TestRuntimeProvider.id}`,
    "services:",
    serviceBlock("app", ["type: redis", "primary: true"]),
    ...(hasDatabase ? [serviceBlock("db", ["type: mariadb"])] : []),
    "",
  ].join("\n");

const layers = (provider: ScenarioProvider) => [
  Layer.succeed(RuntimeProvider, provider.provider),
  provider.layer,
  Layer.succeed(RouterService, RouterService.of(TestRouterService)),
];

interface Observation {
  readonly containers: ReadonlyArray<{
    readonly service: string;
    readonly status: string;
    readonly containerId?: string;
  }>;
  readonly record: ReadonlyArray<string>;
}

interface Harness {
  readonly runtime: LandoRuntime;
  readonly provider: ScenarioProvider;
  readonly root: string;
  readonly appId: AppId;
  readonly subscription: { readonly queue: Queue.Dequeue<LandoEvent> };
  readonly desired: { current: ReadonlyArray<string> };
}

const runningServices = (observation: Observation): ReadonlyArray<string> =>
  observation.containers
    .filter((container) => container.status === "running")
    .map((container) => container.service)
    .sort();

const containerIds = (observation: Observation): ReadonlyMap<string, string | undefined> =>
  new Map(observation.containers.map((container) => [container.service, container.containerId]));

const observe = (harness: Harness): Effect.Effect<Observation, ProviderError> =>
  Effect.gen(function* () {
    const containers = yield* harness.provider.provider.list({ app: harness.appId });
    const records = yield* harness.provider.appliedPlans;
    const record = records.find((candidate) => candidate.id === harness.appId);
    return {
      containers: containers.map((container) => ({
        service: String(container.service),
        status: container.status,
        ...(container.containerId === undefined ? {} : { containerId: container.containerId }),
      })),
      record: Object.keys(record?.services ?? {}).sort(),
    };
  });

const removalNotices = (events: ReadonlyArray<LandoEvent>): ReadonlyArray<string> =>
  events.flatMap((event) =>
    Schema.is(MessageInfoEvent)(event) && event.body.includes("no longer defined") ? [event.body] : [],
  );

const runOperation = (
  harness: Harness,
  operation: Operation,
): Effect.Effect<{ readonly removed: ReadonlyArray<string> | undefined }, unknown> =>
  Effect.gen(function* () {
    const app = yield* harness.runtime.app();
    switch (operation) {
      case "start":
        return { removed: (yield* app.start()).servicesRemoved };
      case "stop":
        yield* app.stop();
        return { removed: undefined };
      case "restart":
        return { removed: (yield* app.restart()).servicesRemoved };
      case "rebuild":
        return { removed: (yield* app.rebuild()).servicesRemoved };
      case "rebuild-selected":
        return { removed: (yield* app.rebuild({ services: [selectedService] })).servicesRemoved };
      default: {
        const exhaustive: never = operation;
        return yield* Effect.die(new TypeError(`Unhandled operation: ${exhaustive}`));
      }
    }
  });

const undefinedContainers = (
  observation: Observation,
  desired: ReadonlyArray<string>,
): ReadonlyArray<Observation["containers"][number]> =>
  observation.containers.filter(
    (container) => container.containerId !== undefined && !desired.includes(container.service),
  );

const checkWholeApp = (harness: Harness, observation: Observation): void => {
  expect(runningServices(observation)).toEqual([...harness.desired.current].sort());
  expect([...observation.record].sort()).toEqual([...harness.desired.current].sort());
};

const checkStopped = (observation: Observation): void => {
  expect(runningServices(observation)).toEqual([]);
};

const checkSelected = (
  before: Observation,
  after: Observation,
  selected: string,
  desired: ReadonlyArray<string>,
): void => {
  expect(runningServices(after)).toContain(selected);
  const afterIds = containerIds(after);
  for (const container of undefinedContainers(before, desired)) {
    expect(afterIds.get(container.service)).toBe(container.containerId);
  }
  for (const service of before.record) {
    if (runningServices(after).includes(service)) expect(after.record).toContain(service);
  }
};

const writeLandofile = (harness: Harness, hasDatabase: boolean): Effect.Effect<void> =>
  Effect.promise(() => Bun.write(join(harness.root, ".lando.yml"), landofileYaml(hasDatabase))).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        harness.desired.current = hasDatabase ? ["app", "db"] : ["app"];
      }),
    ),
    Effect.asVoid,
  );

const runStep = (harness: Harness, operation: Operation): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    yield* Queue.clear(harness.subscription.queue);
    const before = yield* observe(harness);
    const missingBefore = undefinedContainers(before, harness.desired.current)
      .filter((container) => container.status === "running")
      .map((container) => container.service)
      .sort();

    const { removed } = yield* runOperation(harness, operation);

    const events = yield* Queue.clear(harness.subscription.queue);
    const after = yield* observe(harness);
    const notices = removalNotices(events);

    switch (operation) {
      case "start":
      case "restart":
      case "rebuild":
        expect(removed).toEqual(missingBefore);
        if (missingBefore.length > 0) {
          expect(notices).toHaveLength(1);
          for (const service of missingBefore) expect(notices[0]).toContain(service);
        } else {
          expect(notices).toEqual([]);
        }
        checkWholeApp(harness, after);
        return;
      case "stop":
        expect(removed).toBeUndefined();
        checkStopped(after);
        return;
      case "rebuild-selected":
        expect(removed).toBeUndefined();
        checkSelected(before, after, String(selectedService), harness.desired.current);
        return;
      default: {
        const exhaustive: never = operation;
        return exhaustive;
      }
    }
  });

const runSequence = (harness: Harness, steps: ReadonlyArray<Step>): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    for (const step of steps) {
      if (step === "remove" || step === "add") {
        const before = yield* observe(harness);
        yield* writeLandofile(harness, step === "add");
        const after = yield* observe(harness);
        expect(runningServices(after)).toEqual(runningServices(before));
        expect(after.record).toEqual(before.record);
        continue;
      }
      yield* runStep(harness, step);
    }
  });

const withHarness = async (run: (harness: Harness) => Effect.Effect<void, unknown>): Promise<void> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-lifecycle-sequence-")));
  await Bun.write(join(root, ".lando.yml"), landofileYaml(true));
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = makeScenarioProvider();
          const runtime = yield* openLandoRuntime({
            cwd: AbsolutePath.make(root),
            plugins: { policy: "bundled-only", layers: layers(provider) },
          });
          const events = yield* runtime.run(EventService);
          const subscription = yield* events.subscribeWithHistory({ capacity: 4096 });
          const app = yield* runtime.app();
          const plan = yield* app.plan;
          const database = plan.services[removedService];
          expect(plan.stores.length).toBeGreaterThan(0);
          expect(database?.mounts.some((mount) => mount.type === "volume")).toBe(true);
          yield* run({
            runtime,
            provider,
            root,
            appId: AppId.make(app.id),
            subscription,
            desired: { current: ["app", "db"] },
          });
        }),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("converges on the first start after a removal and stays quiet on the next start", async () => {
  await withHarness((harness) => runSequence(harness, ["start", "remove", "start", "start"]));
});

test("whole-app rebuild after a removal completes and converges", async () => {
  await withHarness((harness) => runSequence(harness, ["start", "remove", "rebuild"]));
});

test("whole-app restart after a removal converges on the new Landofile", async () => {
  await withHarness((harness) => runSequence(harness, ["start", "remove", "restart"]));
});

test("a selected rebuild keeps the removed service's container and record until stop", async () => {
  await withHarness((harness) =>
    runSequence(harness, ["start", "remove", "rebuild-selected", "stop", "start"]),
  );
});

test("stop after a removal tears down the recorded service and the next start converges", async () => {
  await withHarness((harness) => runSequence(harness, ["start", "remove", "stop", "start"]));
});

test("re-adding the removed service brings it back on the next start", async () => {
  await withHarness((harness) => runSequence(harness, ["start", "remove", "start", "add", "start"]));
});

for (const first of OPERATIONS) {
  for (const second of OPERATIONS) {
    test(`runs ${first} then ${second} after the removal edit`, async () => {
      await withHarness((harness) => runSequence(harness, ["start", "remove", first, second]));
    });
  }
}
