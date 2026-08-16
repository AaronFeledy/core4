import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer } from "effect";

import { LandofileEventStepFailedError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { EventService, RuntimeProviderRegistry, ToolingEngine } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { runAppEvent, runAppInitEvents } from "../../src/operations/events.ts";
import { attachEffectiveEvents } from "../../src/planner/effective-events.ts";
import { EventCommandExecutor } from "../../src/services/event-command-executor.ts";

const eventPlan = (): AppPlan => ({
  id: AppId.make("init-events"),
  name: "init-events",
  slug: "init-events",
  root: AbsolutePath.make("/tmp/init-events"),
  provider: ProviderId.make("test"),
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-08-16T00:00:00Z"),
    source: "test",
    runtime: 4,
  },
  extensions: {},
});

const eventRuntime = (
  executed: string[],
  published: string[] = [],
  failures: ReadonlySet<string> = new Set(),
) =>
  Layer.mergeAll(
    Layer.succeed(EventService, {
      publish: (event) => Effect.sync(() => void published.push(event._tag)),
      subscribe: () => Effect.die("not used"),
      subscribeQueue: Effect.die("not used"),
      waitFor: () => Effect.die("not used"),
      waitForAny: () => Effect.die("not used"),
      query: () => Effect.succeed([]),
    }),
    Layer.succeed(RedactionService, {
      forProfile: (profile, options) => Effect.succeed(createStandaloneRedactor(profile, options)),
    }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([ProviderId.make("test")]),
      capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
      select: () => Effect.succeed(TestRuntimeProvider),
    }),
    Layer.succeed(ToolingEngine, {
      id: "recording",
      run: (invocation) =>
        Effect.sync(() => {
          const command = invocation.commands[0]?.[2] ?? invocation.tool;
          const label = command.replace(/ "[$]@"$/u, "");
          executed.push(label);
          return {
            tool: invocation.tool,
            service: invocation.service ?? ":lando",
            exitCode: failures.has(label) ? 7 : 0,
            stdout: label,
            stderr: "",
          };
        }),
    }),
    Layer.succeed(EventCommandExecutor, {
      run: () => Effect.die("not used"),
    }),
  );

describe("app initialization lifecycle events", () => {
  test("runs pre-init then post-init before the operation-specific pre event", async () => {
    // Given
    const executed: string[] = [];
    const plan = attachEffectiveEvents(eventPlan(), {
      "pre-init": ["pre-init-one", "pre-init-two"],
      "post-init": ["post-init-one"],
      "pre-start": ["pre-start-one"],
    });

    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* runAppInitEvents(plan);
        yield* runAppEvent(plan, "pre-start");
      }).pipe(Effect.provide(eventRuntime(executed))),
    );

    // Then
    expect(executed).toEqual(["pre-init-one", "pre-init-two", "post-init-one", "pre-start-one"]);
  });

  test("fails closed when a pre-init step fails", async () => {
    // Given
    const executed: string[] = [];
    const plan = attachEffectiveEvents(eventPlan(), { "pre-init": ["fail-pre-init"] });

    // When
    const error = await Effect.runPromise(
      Effect.flip(
        runAppInitEvents(plan).pipe(Effect.provide(eventRuntime(executed, [], new Set(["fail-pre-init"])))),
      ),
    );

    // Then
    expect(error).toBeInstanceOf(LandofileEventStepFailedError);
  });

  test("warns and completes when a post-init step fails", async () => {
    // Given
    const executed: string[] = [];
    const published: string[] = [];
    let completed = false;
    const plan = attachEffectiveEvents(eventPlan(), { "post-init": ["fail-post-init"] });

    // When
    await Effect.runPromise(
      runAppInitEvents(plan).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            completed = true;
          }),
        ),
        Effect.provide(eventRuntime(executed, published, new Set(["fail-post-init"]))),
      ),
    );

    // Then
    expect(completed).toBe(true);
    expect(published).toContain("message.warn");
  });

  test("rebuild initializes once and passes one resolved target to stop and start", async () => {
    // Given
    const source = await Bun.file(new URL("../../src/operations/rebuild.ts", import.meta.url)).text();

    // When
    const initIndex = source.indexOf("yield* runAppInitEvents(plan)");
    const preRebuildIndex = source.indexOf("PreRebuildEvent.make");

    // Then
    expect(source.match(/runAppInitEvents\(plan\)/gu)).toHaveLength(1);
    expect(initIndex).toBeGreaterThan(-1);
    expect(initIndex).toBeLessThan(preRebuildIndex);
    expect(source).toContain("stopAppWithPlan({}, resolvedTarget)");
    expect(source).toContain("resolvedTarget,\n        managed,");
  });

  test("restart initializes once and passes one resolved target to stop and start", async () => {
    // Given
    const source = await Bun.file(new URL("../../src/operations/restart.ts", import.meta.url)).text();

    // When
    const initCalls = source.match(/runAppInitEvents\(plan\)/gu) ?? [];

    // Then
    expect(initCalls).toHaveLength(1);
    expect(source).toContain("stopAppWithPlan({}, resolvedTarget)");
    expect(source).toContain("resolvedTarget,\n        managed,");
  });
});
