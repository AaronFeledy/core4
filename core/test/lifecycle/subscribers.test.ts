import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Schema } from "effect";

import { ConfigError, PluginLoadError, PluginManifestError } from "@lando/sdk/errors";
import { MessageInfoEvent } from "@lando/sdk/events";
import { AbsolutePath, GlobalConfig, PluginManifest } from "@lando/sdk/schema";
import type { RegisteredCommand } from "@lando/sdk/services";

import { resolveNotifyConfig } from "../../src/lifecycle/subscriber-config.ts";
import { makeSubscriberRegistrationClosure } from "../../src/lifecycle/subscriber-index.ts";
import { makeCachedSubscriberHandler } from "../../src/lifecycle/subscriber-loader.ts";
import { canonicalSubscriberCommandIds } from "../../src/lifecycle/subscribers.ts";
import { makeLandoPluginContext } from "../../src/plugins/context.ts";
import { makeStateStore } from "../../src/state/service.ts";
import { makeTestManagedFileStore } from "../../src/testing/managed-file.ts";

const manifest = (subscribers: ReadonlyArray<Record<string, unknown>>) =>
  Schema.decodeUnknownSync(PluginManifest)({
    name: "@example/subscribers",
    version: "1.0.0",
    api: 4,
    subscribers,
  });

describe("subscriber runtime", () => {
  test("includes the final resolved CommandRegistry entries before selector closure", () => {
    // Given: an app tooling command that exists only in the final command registry.
    const commands: ReadonlyArray<RegisteredCommand> = [
      { id: "app:custom-tool", summary: "custom", hidden: false },
    ];

    // When: canonical subscriber command ids are resolved.
    const ids = canonicalSubscriberCommandIds([], commands);

    // Then: the Landofile/script command participates in family expansion and config validation.
    expect(ids).toContain("app:custom-tool");
  });

  test("expands terminal selectors only when registration closes", async () => {
    // Given: a family subscriber parsed before the complete command registry exists.
    const closure = makeSubscriberRegistrationClosure([
      manifest([
        {
          id: "terminal",
          selectors: [{ family: "cli-command-terminal" }],
          module: "./terminal.ts",
        },
      ]),
    ]);

    // When: registration closes with the complete canonical command registry.
    const before = closure.current();
    const index = await Effect.runPromise(closure.close(["app:start", "plugin:command"]));

    // Then: no partial index was visible and run/error (never init) are indexed.
    expect(before).toBeUndefined();
    expect([...index.keys()]).toEqual([
      "cli-app:start-run",
      "cli-app:start-error",
      "cli-plugin:command-run",
      "cli-plugin:command-error",
    ]);
    expect(closure.current()).toBe(index);
  });

  test("sorts exact and family subscribers stably by priority", async () => {
    // Given: subscribers with equal and different priorities targeting one event.
    const closure = makeSubscriberRegistrationClosure([
      manifest([
        { id: "second", selectors: [{ event: "cli-app:start-run" }], module: "./b.ts", priority: 200 },
        { id: "first", selectors: [{ family: "cli-command-terminal" }], module: "./a.ts", priority: 100 },
        { id: "third", selectors: [{ event: "cli-app:start-run" }], module: "./c.ts", priority: 200 },
      ]),
    ]);

    // When: the index is closed.
    const index = await Effect.runPromise(closure.close(["app:start"]));

    // Then: lower priority runs first and equal priorities retain declaration order.
    expect(index.get("cli-app:start-run")?.map((subscriber) => subscriber.entry.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("deduplicates a subscriber selected by both family and exact selectors", async () => {
    // Given: one subscriber overlaps family and exact selectors around another equal-priority subscriber.
    const closure = makeSubscriberRegistrationClosure([
      manifest([
        {
          id: "overlap",
          selectors: [{ family: "cli-command-terminal" }, { event: "cli-app:start-run" }],
          module: "./overlap.ts",
          priority: 100,
        },
        { id: "next", selectors: [{ event: "cli-app:start-run" }], module: "./next.ts", priority: 100 },
      ]),
    ]);

    // When: selector expansion closes against the final command ordering.
    const index = await Effect.runPromise(closure.close(["app:start"]));

    // Then: each subscriber/event pair occurs once and declaration order remains stable.
    expect(index.get("cli-app:start-run")?.map((subscriber) => subscriber.entry.id)).toEqual([
      "overlap",
      "next",
    ]);
  });

  test("rejects an unknown exact CLI lifecycle selector", async () => {
    // Given: an exact lifecycle selector whose command is absent from the closed registry.
    const closure = makeSubscriberRegistrationClosure([
      manifest([
        {
          id: "plugin-command",
          selectors: [{ event: "cli-app:plugin-command-run" }],
          module: "./plugin-command.ts",
        },
      ]),
    ]);

    // When: registration closes against the canonical command set.
    const exit = await Effect.runPromiseExit(closure.close(["app:start"]));

    // Then: strict membership validation rejects the selector without publishing an index.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(PluginManifestError);
        expect(failure.value.message).toContain("cli-app:plugin-command-run");
      }
    }
    expect(closure.current()).toBeUndefined();
  });

  test("rejects an invented non-CLI exact selector", async () => {
    // Given: one valid selector followed by an unknown exact selector.
    const closure = makeSubscriberRegistrationClosure([
      manifest([
        { id: "known", selectors: [{ event: "pre-start" }], module: "./known.ts" },
        { id: "unknown", selectors: [{ event: "invented-event" }], module: "./unknown.ts" },
      ]),
    ]);

    // When: registration attempts to close.
    const exit = await Effect.runPromiseExit(closure.close(["app:start"]));

    // Then: the tagged manifest failure identifies the subscriber and no index becomes visible.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(PluginManifestError);
        expect(failure.value.message).toContain("unknown");
        expect(failure.value.message).toContain("invented-event");
      }
    }
    expect(closure.current()).toBeUndefined();
  });

  test("rejects an unknown notify.commands id at its exact config path", async () => {
    // Given: decoded notify config containing an unknown canonical command id.
    const config = Schema.decodeUnknownSync(GlobalConfig)({ notify: { commands: ["app:start", "bad:id"] } });

    // When: the closed command registry validates the config projection.
    const exit = await Effect.runPromiseExit(resolveNotifyConfig(config, new Set(["app:start"])));

    // Then: the existing ConfigError identifies the offending array entry.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ConfigError);
        expect(failure.value.path).toBe("notify.commands[1]");
        expect(failure.value.message).toContain("bad:id");
      }
    }
  });

  test("loads a subscriber factory lazily and caches its handler exactly once", async () => {
    // Given: a factory loader that records module and factory evaluation.
    let loads = 0;
    let calls = 0;
    const managedFileService = (await Effect.runPromise(Effect.scoped(makeTestManagedFileStore()))).service;
    const context = makeLandoPluginContext({
      id: "@example/subscriber",
      managedFileService,
      stateStore: makeStateStore(),
      pluginStateRoot: Schema.decodeUnknownSync(AbsolutePath)("/tmp/lando-subscriber-test"),
      publishRender: () => Effect.void,
    });
    const event = Schema.decodeUnknownSync(MessageInfoEvent)({
      _tag: "message.info",
      body: "message",
      timestamp: "2026-07-18T00:00:00.000Z",
    });
    const load = Effect.sync(() => {
      loads += 1;
      return () => () =>
        Effect.sync(() => {
          calls += 1;
        });
    }).pipe(
      Effect.mapError(() => new PluginLoadError({ pluginName: "@example/subscriber", message: "load" })),
    );

    // When: the cached handler is requested and invoked twice.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const getHandler = yield* makeCachedSubscriberHandler(load, context, undefined);
          const first = yield* getHandler;
          const second = yield* getHandler;
          yield* first(event);
          yield* second(event);
        }),
      ),
    );

    // Then: loading/factory creation happened once while the handler served both events.
    expect(loads).toBe(1);
    expect(calls).toBe(2);
  });
});
