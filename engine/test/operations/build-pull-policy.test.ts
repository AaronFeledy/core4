import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { type BuildOptions, BuildOrchestrator } from "@lando/sdk/services";

import { rebuildApp } from "../../src/operations/rebuild.ts";
import { startApp } from "../../src/operations/start.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

const target = { plan, root: plan.root, app: { kind: "user" as const, id: plan.id, root: plan.root } };

const recordingBuilder = (calls: Array<BuildOptions | undefined>) =>
  BuildOrchestrator.of({
    build: (builtPlan, options) =>
      Effect.sync(() => {
        calls.push(options);
        return builtPlan;
      }),
    buildApp: () => Effect.void,
  });

test("start builds with the default policy so local images are reused", async () => {
  // Given
  const calls: Array<BuildOptions | undefined> = [];
  const harness = makeHarness();

  // When
  await Effect.runPromise(
    startApp({}, target).pipe(
      Effect.provide(Layer.merge(harness.layer, Layer.succeed(BuildOrchestrator, recordingBuilder(calls)))),
    ),
  );

  // Then
  expect(calls).toEqual([undefined]);
});

test.each([{ services: undefined }, { services: [web.name] }])(
  "rebuild refreshes referenced images when selected services are %j",
  async ({ services }) => {
    // Given
    const calls: Array<BuildOptions | undefined> = [];
    const harness = makeHarness();

    // When
    await Effect.runPromise(
      rebuildApp(services === undefined ? {} : { services }, target).pipe(
        Effect.provide(Layer.merge(harness.layer, Layer.succeed(BuildOrchestrator, recordingBuilder(calls)))),
      ),
    );

    // Then
    expect(calls).toEqual([{ refresh: true }]);
  },
);
