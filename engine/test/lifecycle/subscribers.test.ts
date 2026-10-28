import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandoEvent } from "@lando/sdk/events";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { PluginManifest, type SubscriberManifestEntry } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";

import type { RuntimeSubscriberFactory } from "../../src/lifecycle/subscriber-loader.ts";
import { subscriberRuntime } from "./subscriber-runtime-fixture.ts";

const observer = (subscribers: ReadonlyArray<typeof SubscriberManifestEntry.Encoded>) => {
  const deliveries: string[] = [];
  const loads: string[] = [];
  const factories: string[] = [];
  const manifest = Schema.decodeUnknownSync(PluginManifest)({
    name: "@example/observer",
    version: "1.0.0",
    api: 4,
    contributes: { commands: ["example:release", { id: "example:inspect", module: "./inspect.ts" }] },
    subscribers,
  });
  const module: LandoPluginModule = {
    name: String(manifest.name),
    manifest,
    subscriberFactoryLoaders: new Map(
      (manifest.subscribers ?? []).map((subscriber) => [
        subscriber.id,
        async (): Promise<RuntimeSubscriberFactory> => {
          loads.push(subscriber.id);
          return () => {
            factories.push(subscriber.id);
            return (event) =>
              Effect.sync(() => {
                deliveries.push(`${subscriber.id}/${event._tag}`);
              });
          };
        },
      ]),
    ),
  };
  return { deliveries, loads, factories, layer: subscriberRuntime([module]) };
};

const cliEvent = (commandId: string, phase: "init" | "run" | "error") =>
  Schema.decodeUnknownSync(LandoEvent)({
    _tag: `cli-${commandId}-${phase}`,
    commandId,
    argv: [],
    args: {},
    flags: {},
    cwd: "/observer-test",
    invocationId: "observer-invocation",
    timestamp: "2026-07-18T00:00:00.000Z",
    exitCode: phase === "error" ? 1 : 0,
    durationMs: 1,
    failureTag: "TestFailure",
  });

describe("metadata-only subscriber runtime", () => {
  test.each(["app:db_reset", "app:123", "app:_private:123_reset", "app:Release.v2"])(
    "delivers retained run/error family events for %s",
    async (commandId) => {
      // Given: a terminal observer registered before this app command is known.
      const fixture = observer([
        { id: "terminal", selectors: [{ family: "cli-command-terminal" }], module: "./terminal.ts" },
      ]);
      // When: a retained event service publishes the command's lifecycle.
      await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* EventService;
          for (const phase of ["init", "run", "error"] as const) {
            yield* events.publish(cliEvent(commandId, phase));
          }
        }).pipe(Effect.provide(fixture.layer)),
      );
      // Then: both terminal phases deliver, init does not, and the factory is reused.
      expect(fixture.deliveries).toEqual([
        `terminal/cli-${commandId}-run`,
        `terminal/cli-${commandId}-error`,
      ]);
      expect(fixture.loads).toEqual(["terminal"]);
      expect(fixture.factories).toEqual(["terminal"]);
    },
  );

  test.each(["app:db_reset", "app:123", "app:_private:123_reset", "app:Release.v2"])(
    "delivers deferred exact init/run/error events for %s",
    async (commandId) => {
      // Given: exact observers without any app inventory or handler acquisition.
      const fixture = observer([
        {
          id: "exact",
          selectors: ["init", "run", "error"].map((phase) => ({ event: `cli-${commandId}-${phase}` })),
          module: "./exact.ts",
        },
      ]);
      await Effect.runPromise(Effect.void.pipe(Effect.provide(fixture.layer)));
      expect(fixture.loads).toEqual([]);
      // When: one retained runtime publishes matching phases and an unrelated command.
      await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* EventService;
          yield* events.publish(cliEvent("app:unrelated", "run"));
          for (const phase of ["init", "run", "error"] as const) {
            yield* events.publish(cliEvent(commandId, phase));
          }
        }).pipe(Effect.provide(fixture.layer)),
      );
      // Then: only exact matches deliver, including init, with one lazy factory.
      expect(fixture.deliveries).toEqual([
        `exact/cli-${commandId}-init`,
        `exact/cli-${commandId}-run`,
        `exact/cli-${commandId}-error`,
      ]);
      expect(fixture.loads).toEqual(["exact"]);
      expect(fixture.factories).toEqual(["exact"]);
    },
  );

  test("registers static and deferred observers without app acquisition or factory loading", async () => {
    // Given: exact selectors from built-in and both plugin metadata forms, plus an unknown app target.
    const fixture = observer([
      { id: "builtin", selectors: [{ event: "cli-meta:version-run" }], module: "./builtin.ts" },
      { id: "plugin", selectors: [{ event: "cli-example:release-run" }], module: "./plugin.ts" },
      { id: "descriptor", selectors: [{ event: "cli-example:inspect-error" }], module: "./descriptor.ts" },
      { id: "app", selectors: [{ event: "cli-app:future-run" }], module: "./app.ts" },
      { id: "terminal", selectors: [{ family: "cli-command-terminal" }], module: "./terminal.ts" },
    ]);

    // When: only observer setup runs, with command listing and Landofile discovery set to die.
    await Effect.runPromise(Effect.void.pipe(Effect.provide(fixture.layer)));

    // Then: setup succeeded without importing a handler or invoking its factory.
    expect(fixture.loads).toEqual([]);
    expect(fixture.factories).toEqual([]);
    expect(fixture.deliveries).toEqual([]);
  });

  test("dispatches later app terminal events once per subscriber in stable priority order", async () => {
    // Given: overlapping exact/family selectors and a second observer sharing the same priority.
    const fixture = observer([
      { id: "late", selectors: [{ event: "cli-app:future-run" }], priority: 200, module: "./late.ts" },
      {
        id: "overlap",
        selectors: [{ family: "cli-command-terminal" }, { event: "cli-app:future-run" }],
        priority: 100,
        module: "./overlap.ts",
      },
      { id: "peer", selectors: [{ event: "cli-app:future-run" }], priority: 100, module: "./peer.ts" },
    ]);

    // When: one retained runtime publishes invocations absent from registration metadata.
    await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventService;
        yield* events.publish(cliEvent("app:future", "run"));
        yield* events.publish(cliEvent("app:other", "error"));
        yield* events.publish(cliEvent("app:future", "run"));
      }).pipe(Effect.provide(fixture.layer)),
    );

    // Then: exact/family overlap is deduplicated, ordering is stable, and handlers are reused.
    expect(fixture.deliveries).toEqual([
      "overlap/cli-app:future-run",
      "peer/cli-app:future-run",
      "late/cli-app:future-run",
      "overlap/cli-app:other-error",
      "overlap/cli-app:future-run",
      "peer/cli-app:future-run",
      "late/cli-app:future-run",
    ]);
    expect(fixture.loads).toEqual(["overlap", "peer", "late"]);
    expect(fixture.factories).toEqual(["overlap", "peer", "late"]);
  });

  test("loads only an exact init observer when a CLI init event is published", async () => {
    // Given: init is explicitly selected alongside a terminal-only family observer.
    const fixture = observer([
      { id: "init", selectors: [{ event: "cli-app:future-init" }], module: "./init.ts" },
      { id: "terminal", selectors: [{ family: "cli-command-terminal" }], module: "./terminal.ts" },
    ]);

    // When: the real event service publishes a deferred app init event.
    await Effect.runPromise(
      Effect.flatMap(EventService, (events) => events.publish(cliEvent("app:future", "init"))).pipe(
        Effect.provide(fixture.layer),
      ),
    );

    // Then: init does not activate the terminal family or its lazy factory.
    expect(fixture.deliveries).toEqual(["init/cli-app:future-init"]);
    expect(fixture.loads).toEqual(["init"]);
    expect(fixture.factories).toEqual(["init"]);
  });
});
