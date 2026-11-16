import { expect, test } from "bun:test";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { makeProviderDataPlane } from "../src/data-plane.ts";
import { ephemeralDataHelperLabels } from "../src/ephemeral-data-helpers.ts";
import {
  type HelperOwnerIdentity,
  type HelperReclaimOptions,
  registerActiveHelper,
  releaseActiveHelper,
} from "../src/helper-owner.ts";
import { sweepStaleDataHelpers } from "../src/stale-data-helpers.ts";
import { FakeEngine } from "./support/fake-engine.ts";
import {
  NOW,
  freshTime,
  helperEngine,
  helperLabels,
  redactor,
  staleTime,
} from "./support/stale-helper-engine.ts";

const spec = { image: "alpine:3.20", command: ["true"], remove: true } as const;

const SELF: HelperOwnerIdentity = {
  machine: "a".repeat(32),
  pidDomain: "pid:[4026531836]",
  pid: 100,
  boot: "boot-1",
  start: "500",
};

const OWNER: HelperOwnerIdentity = { ...SELF, pid: 200, start: "700" };

const ownerLabels = (owner: HelperOwnerIdentity, remove = true) =>
  ephemeralDataHelperLabels({ providerId: "test", owner, remove });

const reclaim = (
  probe: HelperReclaimOptions["probe"] = () => ({ state: "absent" }),
): HelperReclaimOptions => ({ identity: Effect.succeed(SELF), probe });

const planeFor = (engine: ReturnType<typeof helperEngine> | FakeEngine, helperReclaim = reclaim()) =>
  makeProviderDataPlane({
    providerId: "test",
    capabilities: { volumeSnapshot: "none" },
    redactor,
    api: engine.api,
    helperReclaim,
  });

const runWithSweep = async (engine: ReturnType<typeof helperEngine>, helperReclaim = reclaim()) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* Effect.scoped(planeFor(engine, helperReclaim).run(spec));
    }).pipe(Effect.provide(TestClock.layer())),
  );

test("created helpers carry the creator lifecycle and owner labels", async () => {
  const engine = new FakeEngine();
  await Effect.runPromise(Effect.scoped(planeFor(engine).run(spec)));
  const create = engine.httpRequests.find((request) => request.path.startsWith("/containers/create?name="));
  if (create?.body === undefined) throw new Error("missing create request");
  expect(create.body).toMatchObject({
    Labels: {
      "dev.lando.role": "data-helper",
      "dev.lando.provider": "test",
      "dev.lando.helper-lifecycle": "process",
      "dev.lando.helper-owner-machine": SELF.machine,
      "dev.lando.helper-owner-pid-domain": SELF.pidDomain,
      "dev.lando.helper-owner-pid": String(SELF.pid),
      "dev.lando.helper-owner-boot": SELF.boot,
      "dev.lando.helper-owner-start": SELF.start,
    },
  });
});

test("a helper created with remove:false is retained instead of process-owned", async () => {
  const engine = new FakeEngine();
  await Effect.runPromise(Effect.scoped(planeFor(engine).run({ ...spec, remove: false })));
  const create = engine.httpRequests.find((request) => request.path.startsWith("/containers/create?name="));
  if (create?.body === undefined) throw new Error("missing create request");
  expect(create.body).toMatchObject({
    Labels: {
      "dev.lando.helper-lifecycle": "retain",
      "dev.lando.helper-owner-machine": SELF.machine,
    },
  });
});

test("the sweep removes a dead owner's helper even while it is running", async () => {
  const engine = helperEngine([
    {
      id: "dead-owner",
      state: "running",
      running: true,
      labels: ownerLabels(OWNER),
      finishedAt: freshTime,
    },
  ]);
  await runWithSweep(engine);
  expect(engine.containers.get("dead-owner")).toBeUndefined();
});

test("the sweep keeps a live owner's helper whose finish time is hours old", async () => {
  const engine = helperEngine([
    {
      id: "live-owner",
      state: "exited",
      labels: ownerLabels(OWNER),
      finishedAt: new Date(NOW - 6 * 60 * 60 * 1000).toISOString(),
    },
  ]);
  await runWithSweep(
    engine,
    reclaim(() => ({ state: "present", start: "700" })),
  );
  expect(engine.containers.get("live-owner")).toBeDefined();
});

test("the sweep removes this process's idle helper but keeps one that is active", async () => {
  const engine = helperEngine([
    { id: "idle", state: "exited", labels: ownerLabels(SELF), finishedAt: freshTime },
    { id: "active", state: "running", running: true, labels: ownerLabels(SELF) },
  ]);
  registerActiveHelper("active");
  try {
    await runWithSweep(engine);
  } finally {
    releaseActiveHelper("active");
  }
  expect(engine.containers.get("idle")).toBeUndefined();
  expect(engine.containers.get("active")).toBeDefined();
});

test("the sweep keeps legacy unlabeled helpers until they are stopped long enough", async () => {
  const engine = helperEngine([
    { id: "legacy-stale", state: "exited", labels: helperLabels(), finishedAt: staleTime },
    { id: "legacy-fresh", state: "exited", labels: helperLabels(), finishedAt: freshTime },
  ]);
  await runWithSweep(engine);
  expect(engine.containers.get("legacy-stale")).toBeUndefined();
  expect(engine.containers.get("legacy-fresh")).toBeDefined();
});

test("a sweep that runs while a helper is being created keeps that helper", async () => {
  const engine = new FakeEngine();
  const survivedConcurrentSweep: boolean[] = [];
  const request = engine.api.request;
  if (request === undefined) throw new Error("missing fake engine request client");
  const api = {
    ...engine.api,
    request: (input: Parameters<typeof request>[0]) =>
      request(input).pipe(
        Effect.tap((response) => {
          if (!input.path.startsWith("/containers/create?name=")) return Effect.void;
          const { Id } = JSON.parse(response.body) as { Id: string };
          // Another fiber in this process sweeps after the engine created the helper but before
          // the create response reaches the data plane.
          return sweepStaleDataHelpers(request, {
            providerId: "test",
            redactor,
            helperReclaim: reclaim(),
          }).pipe(
            Effect.andThen(
              Effect.sync(() => survivedConcurrentSweep.push(engine.containers.get(Id) !== undefined)),
            ),
          );
        }),
      ),
  };
  await Effect.runPromise(
    Effect.scoped(
      makeProviderDataPlane({
        providerId: "test",
        capabilities: { volumeSnapshot: "none" },
        redactor,
        api,
        helperReclaim: reclaim(),
      }).run(spec),
    ),
  );
  expect(survivedConcurrentSweep).toEqual([true]);
});
