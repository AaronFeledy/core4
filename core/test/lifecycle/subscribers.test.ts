import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Schema } from "effect";

import {
  ConfigError,
  PluginLoadError,
  PluginManifestError,
  SubscriberLevelMismatchError,
} from "@lando/sdk/errors";
import { MessageInfoEvent } from "@lando/sdk/events";
import { AbsolutePath, GlobalConfig, PluginManifest } from "@lando/sdk/schema";

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

const commandManifest = () =>
  Schema.decodeUnknownSync(PluginManifest)({
    name: "@example/commands",
    version: "1.0.0",
    api: 4,
    contributes: { commands: ["example:release"] },
  });

const bootstrapManifest = (bootstrap: "app" | "tooling" | undefined, selectors: ReadonlyArray<string>) =>
  Schema.decodeUnknownSync(PluginManifest)({
    name: "@example/bootstrap-subscribers",
    version: "1.0.0",
    api: 4,
    ...(bootstrap === undefined ? {} : { bootstrap }),
    subscribers: selectors.map((event, index) => ({
      id: `bootstrap-${index}`,
      selectors: [{ event }],
      module: `./bootstrap-${index}.ts`,
    })),
  });

describe("subscriber runtime", () => {
  test("builds global notify membership from compiled built-ins and plugin manifests", () => {
    // Given: an enabled global plugin contributing a canonical command.
    const plugin = commandManifest();

    // When: cwd-independent command membership is built.
    const ids = new Set(canonicalSubscriberCommandIds([plugin]));

    // Then: compiled built-ins and plugin-contributed commands are both present.
    expect(ids.has("meta:version")).toBe(true);
    expect(ids.has("example:release")).toBe(true);
  });

  test("excludes Landofile-derived ids from global notify membership", () => {
    // Given: only cwd-independent manifests contribute to global membership.
    const plugin = commandManifest();

    // When: global command membership is built without an app registry.
    const ids = new Set(canonicalSubscriberCommandIds([plugin]));

    // Then: an app-local-shaped id absent from global manifests is not admitted.
    expect(ids.has("app:landofile-command")).toBe(false);
  });

  test("closes exact and terminal selectors over a below-commands canonical id", async () => {
    // Given: exact and terminal selectors for a canonical command available before commands bootstrap.
    const closure = makeSubscriberRegistrationClosure([
      manifest([
        {
          id: "terminal",
          selectors: [{ family: "cli-command-terminal" }],
          module: "./terminal.ts",
        },
        {
          id: "version",
          selectors: [{ event: "cli-meta:version-run" }],
          module: "./version.ts",
        },
      ]),
    ]);

    // When: registration closes against the complete canonical taxonomy.
    const index = await Effect.runPromise(closure.close(canonicalSubscriberCommandIds([])));

    // Then: exact validation and family expansion both accept the canonical command lifecycle events.
    expect(index.get("cli-meta:version-run")?.map((subscriber) => subscriber.entry.id)).toEqual([
      "terminal",
      "version",
    ]);
    expect(index.get("cli-meta:version-error")?.map((subscriber) => subscriber.entry.id)).toEqual([
      "terminal",
    ]);
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

  test("app bootstrap covers minimal plugins commands provider and app paths", async () => {
    // Given: an app-level plugin selecting both phases of every covered bootstrap path.
    const covered = ["minimal", "plugins", "commands", "provider", "app"].flatMap((level) => [
      `pre-bootstrap-${level}`,
      `post-bootstrap-${level}`,
    ]);
    const closure = makeSubscriberRegistrationClosure([bootstrapManifest("app", covered)]);

    // When: subscriber registration closes.
    const exit = await Effect.runPromiseExit(closure.close([]));

    // Then: every covered event is indexed atomically.
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect([...exit.value.keys()]).toEqual(covered);
    expect(closure.current()).toEqual(Exit.isSuccess(exit) ? exit.value : undefined);
  });

  test("tooling bootstrap covers minimal plugins commands and tooling paths", async () => {
    // Given: a tooling-level plugin selecting both phases of every covered bootstrap path.
    const covered = ["minimal", "plugins", "commands", "tooling"].flatMap((level) => [
      `pre-bootstrap-${level}`,
      `post-bootstrap-${level}`,
    ]);
    const closure = makeSubscriberRegistrationClosure([bootstrapManifest("tooling", covered)]);

    // When: subscriber registration closes.
    const exit = await Effect.runPromiseExit(closure.close([]));

    // Then: tooling registration does not require provider or app paths.
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect([...exit.value.keys()]).toEqual(covered);
  });

  for (const event of ["pre-bootstrap-tooling", "post-bootstrap-tooling"] as const) {
    test(`default app bootstrap rejects ${event} with a fully populated mismatch error atomically`, async () => {
      // Given: an omitted declaration defaults to app and selects a tooling bootstrap event.
      const closure = makeSubscriberRegistrationClosure([
        bootstrapManifest(undefined, ["pre-bootstrap-minimal", event]),
      ]);

      // When: subscriber registration closes.
      const exit = await Effect.runPromiseExit(closure.close([]));

      // Then: the concrete tagged failure is complete and no partial index is published.
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(SubscriberLevelMismatchError);
          expect(failure.value).toMatchObject({
            _tag: "SubscriberLevelMismatchError",
            pluginName: "@example/bootstrap-subscribers",
            subscriberId: "bootstrap-1",
            selectedEvent: event,
            declaredLevel: "app",
            eventLevel: "tooling",
            message: `Subscriber "bootstrap-1" from @example/bootstrap-subscribers cannot select "${event}" at declared bootstrap level "app".`,
            remediation: 'Declare bootstrap: "tooling" or select an event covered by bootstrap level "app".',
          });
        }
      }
      expect(closure.current()).toBeUndefined();
    });
  }

  for (const event of ["pre-bootstrap-provider", "post-bootstrap-app"] as const) {
    test(`tooling bootstrap rejects uncovered ${event} atomically`, async () => {
      // Given: a tooling plugin selecting one covered event before an uncovered branch event.
      const closure = makeSubscriberRegistrationClosure([
        bootstrapManifest("tooling", ["post-bootstrap-commands", event]),
      ]);

      // When: subscriber registration closes.
      const exit = await Effect.runPromiseExit(closure.close([]));

      // Then: mismatch rejection leaves the registration closure unpublished.
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value).toMatchObject({
            _tag: "SubscriberLevelMismatchError",
            pluginName: "@example/bootstrap-subscribers",
            subscriberId: "bootstrap-1",
            selectedEvent: event,
            declaredLevel: "tooling",
            eventLevel: event.replace(/^pre-bootstrap-|^post-bootstrap-/, ""),
          });
          expect(failure.value).toHaveProperty("message");
          expect(failure.value).toHaveProperty("remediation");
        }
      }
      expect(closure.current()).toBeUndefined();
    });
  }

  test("cli-command-terminal remains limited to run and error for a tooling plugin", async () => {
    // Given: a tooling-level plugin using only the terminal command family.
    const plugin = Schema.decodeUnknownSync(PluginManifest)({
      name: "@example/tooling-terminal",
      version: "1.0.0",
      api: 4,
      bootstrap: "tooling",
      subscribers: [
        {
          id: "terminal",
          selectors: [{ family: "cli-command-terminal" }],
          module: "./terminal.ts",
        },
      ],
    });
    const closure = makeSubscriberRegistrationClosure([plugin]);

    // When: registration closes over one canonical command.
    const index = await Effect.runPromise(closure.close(["app:start"]));

    // Then: the family adds no init or bootstrap event entries.
    expect([...index.keys()]).toEqual(["cli-app:start-run", "cli-app:start-error"]);
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
        expect(failure.value.message).toContain("Unknown canonical command id");
        expect(failure.value.message).toContain("registered command");
      }
    }
  });

  test("rejects an app-local-shaped notify id without consulting an app registry", async () => {
    // Given: a defined cwd-independent registry and an app-local-shaped notify entry.
    const config = Schema.decodeUnknownSync(GlobalConfig)({
      notify: { commands: ["meta:version", "example:release", "app:myscript"] },
    });
    const globalCommandIds = new Set(canonicalSubscriberCommandIds([commandManifest()]));

    // When: subscriber configuration resolves with no app registry input.
    const exit = await Effect.runPromiseExit(resolveNotifyConfig(config, globalCommandIds));

    // Then: the offending index and remediation are reported as ConfigError.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ConfigError);
        if (failure.value instanceof ConfigError) {
          expect(failure.value.path).toBe("notify.commands[2]");
          expect(failure.value.message).toContain("app:myscript");
          expect(failure.value.message).toContain("install and enable the plugin");
        }
      }
    }
  });

  test("accepts compiled built-in and plugin-contributed notify ids", async () => {
    // Given: notify entries that both belong to the cwd-independent global registry.
    const config = Schema.decodeUnknownSync(GlobalConfig)({
      notify: { commands: ["meta:version", "example:release"] },
    });
    const globalCommandIds = new Set(canonicalSubscriberCommandIds([commandManifest()]));

    // When: subscriber configuration validates global command membership.
    const exit = await Effect.runPromiseExit(resolveNotifyConfig(config, globalCommandIds));

    // Then: both entries remain eligible.
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.commands).toEqual(["meta:version", "example:release"]);
    }
  });

  test("disabled notification policy bypasses command membership validation", async () => {
    // Given: the master switch is off and the dormant allowlist contains an unknown id.
    const config = Schema.decodeUnknownSync(GlobalConfig)({
      notify: { enabled: false, commands: ["bad:id"] },
    });

    // When: subscriber configuration is projected from the closed registry.
    const exit = await Effect.runPromiseExit(resolveNotifyConfig(config, new Set()));

    // Then: disabled policy configuration cannot block unrelated commands.
    expect(Exit.isSuccess(exit)).toBe(true);
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
