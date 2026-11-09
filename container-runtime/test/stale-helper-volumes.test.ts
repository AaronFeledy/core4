import { expect, test } from "bun:test";
import { AppId, type AppPlan } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { TestClock } from "effect/testing";
import { makeProviderDataPlane } from "../src/data-plane.ts";
import { dockerLifecycleDialect } from "../src/dialect.ts";
import { bringDown } from "../src/podman/bring-down.ts";
import { volumeOwnershipLabels } from "../src/volume-ownership.ts";
import { networkPlan } from "./authored-network-fixture.ts";
import {
  NOW,
  freshTime,
  generation,
  helperEngine,
  helperLabels,
  redactor,
  staleHelper,
} from "./support/stale-helper-engine.ts";

test("volume removal reclaims stale holders and retries once", async () => {
  const engine = helperEngine([staleHelper("first"), staleHelper("second")]);
  const plane = makeProviderDataPlane({
    providerId: "test",
    capabilities: { volumeSnapshot: "none" },
    redactor,
    api: engine.api,
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      yield* plane.removeVolume({ app: AppId.make("app"), store: "data" }, generation);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect([...engine.containers.keys()]).toEqual([]);
  expect([...engine.volumes.keys()]).toEqual([]);
  expect(
    engine.calls.filter((call) => call.method === "DELETE" && call.path === "/volumes/data"),
  ).toHaveLength(2);
});

test.each([
  { ...staleHelper("remaining"), finishedAt: freshTime },
  { ...staleHelper("remaining"), state: "running" },
  { ...staleHelper("remaining"), labels: helperLabels("other") },
  { ...staleHelper("remaining"), labels: {} },
])("volume removal preserves all holders when one does not qualify: %j", async (remaining) => {
  const engine = helperEngine([staleHelper("stale"), remaining]);
  const plane = makeProviderDataPlane({
    providerId: "test",
    capabilities: { volumeSnapshot: "none" },
    redactor,
    api: engine.api,
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      return yield* plane
        .removeVolume({ app: AppId.make("app"), store: "data" }, generation)
        .pipe(Effect.result);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "VolumeOperationError", operation: "removeVolume" },
  });
  if (!Result.isFailure(result)) return;
  expect(result.failure.message).toContain("remaining (remaining)");
  expect([...engine.containers.keys()]).toEqual(["stale", "remaining"]);
  expect([...engine.volumes.keys()]).toEqual(["data"]);
  expect(engine.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
});

test("volume removal does not retry endlessly when the engine still reports in-use", async () => {
  const engine = helperEngine([staleHelper("stale")]);
  const plane = makeProviderDataPlane({
    providerId: "test",
    capabilities: { volumeSnapshot: "none" },
    redactor,
    api: {
      request: (input) => {
        if (input.method === "DELETE" && input.path === "/volumes/data") {
          return Effect.sync(() => {
            engine.calls.push(input);
            return { status: 409, body: "volume is in use" };
          });
        }
        return engine.api.request(input);
      },
    },
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      return yield* plane
        .removeVolume({ app: AppId.make("app"), store: "data" }, generation)
        .pipe(Effect.result);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "VolumeOperationError", operation: "removeVolume" },
  });
  expect([...engine.containers.keys()]).toEqual([]);
  expect([...engine.volumes.keys()]).toEqual(["data"]);
  expect(
    engine.calls.filter((call) => call.method === "DELETE" && call.path === "/volumes/data"),
  ).toHaveLength(2);
});

test("bringDown reclaims stale holders before retrying its selected volume", async () => {
  const store = { name: "data", scope: "app", kind: "data" } as const;
  const plan = { ...networkPlan, services: {}, stores: [store] } satisfies AppPlan;
  const engine = helperEngine([staleHelper("stale")]);
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      return yield* bringDown(plan, {
        api: {
          request: (input) => {
            if (input.path.startsWith("/networks/")) return Effect.succeed({ status: 404, body: "" });
            if (
              input.path.startsWith("/containers/json?") &&
              !decodeURIComponent(input.path).includes('"volume"')
            ) {
              return Effect.succeed({ status: 200, body: "[]" });
            }
            if (input.method === "GET" && input.path === "/volumes/data")
              return Effect.succeed({
                status: 200,
                body: JSON.stringify({ Labels: volumeOwnershipLabels(plan, store) }),
              });
            // This scenario injects no engine failures, so any failure here is a broken fixture.
            return engine.api.request(input).pipe(Effect.orDie);
          },
        },
        ctx: { providerId: "test", remediation: "Retry.", env: {}, redactor },
        dialect: dockerLifecycleDialect,
        volumes: true,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(result.changed).toBe(true);
  expect([...engine.containers.keys()]).toEqual([]);
  expect([...engine.volumes.keys()]).toEqual([]);
  expect(
    engine.calls.filter((call) => call.method === "DELETE" && call.path === "/volumes/data"),
  ).toHaveLength(2);
});
