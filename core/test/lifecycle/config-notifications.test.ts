import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Subscribers from "@lando/engine/lifecycle/subscribers";
import * as Events from "@lando/engine/services/event-service";
import { CliCommandRunEvent } from "@lando/sdk/events";
import { CommandRegistry, EventService, LandofileService, PluginRegistry } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { BUILT_IN_COMMAND_IDS } from "../../src/cli/generated/command-ids.ts";
import { BUNDLED_PLUGIN_MODULES } from "../../src/plugins/generated/bundled.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";
import { lastEnvelope, makeFixture, runSource } from "../cli/subprocess-support.ts";

test("notify-enabled registration delivers configured events without listing commands or discovering an app", async () => {
  // Given: the real notifier and config decoder, with app acquisition forbidden.
  const modules = BUNDLED_PLUGIN_MODULES.filter((module) => module.name === "@lando/notify-lando");
  const base = Layer.mergeAll(
    makeLandoRuntime({
      bootstrap: "minimal",
      plugins: { policy: "bundled-only" },
      configSources: { user: false, env: false },
      config: { notify: { enabled: true, thresholdMs: 0, commands: ["app:config:set"] } },
    }),
    Events.layerRuntime,
    Layer.succeed(CommandRegistry, { list: Effect.die("CommandRegistry.list must not run") }),
    Layer.succeed(LandofileService, { discover: Effect.die("Landofile discovery must not run") }),
    Layer.succeed(PluginRegistry, {
      list: Effect.succeed(modules.map((module) => module.manifest)),
      load: () => Effect.die("Plugin load must not run"),
      loadServiceType: () => Effect.die("Service type load must not run"),
      loadServiceFeature: () => Effect.die("Service feature load must not run"),
      loadAppFeature: () => Effect.die("App feature load must not run"),
    }),
  );
  const runtime = Subscribers.layerWithPrivateFileAccess(modules, BUILT_IN_COMMAND_IDS).pipe(
    Layer.provideMerge(base),
  );
  // When: the retained event service publishes a configured terminal event.
  const notifications = await Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventService;
      yield* events.publish(
        Schema.decodeUnknownSync(CliCommandRunEvent)({
          _tag: "cli-app:config:set-run",
          commandId: "app:config:set",
          argv: [],
          args: {},
          flags: {},
          cwd: "/no-app",
          invocationId: "configured",
          timestamp: "2026-07-18T00:00:00.000Z",
          durationMs: 1,
          exitCode: 0,
        }),
      );
      return yield* events.query("notify.desktop");
    }).pipe(Effect.provide(runtime)),
  );
  // Then: notification delivery succeeded without either forbidden service.
  expect(notifications).toMatchObject([{ _tag: "notify.desktop", urgency: "success" }]);
});

test.each(["app:config:set", "meta:global:config:set"])(
  "%s emits configured notifications through the real source CLI",
  async (commandId) => {
    // Given: enabled notifications and a command outside the default notification family.
    const fixture = await makeFixture("configured-notify");
    try {
      const configRoot = fixture.env.LANDO_USER_CONF_ROOT;
      const dataRoot = fixture.env.LANDO_USER_DATA_ROOT;
      if (configRoot === undefined || dataRoot === undefined) throw new Error("Missing isolated roots");
      await mkdir(configRoot, { recursive: true });
      await mkdir(join(dataRoot, "global"), { recursive: true });
      await writeFile(join(dataRoot, "global", ".lando.yml"), "name: global\n");
      await writeFile(
        join(configRoot, "config.yml"),
        `notify:\n  thresholdMs: 0\n  commands: ["${commandId}"]\n`,
      );
      // When: config validation runs at the promoted observer tier.
      const result = await runSource(fixture, [
        commandId,
        "name",
        "candidate",
        "--dry-run",
        "--format=json",
        "--renderer=json",
      ]);
      // Then: the operation and configured desktop notification both complete.
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(lastEnvelope(result.stdout)).toMatchObject({ ok: true, result: { dryRun: true } });
      const emitted = result.stderr
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line));
      expect(emitted).toEqual(
        expect.arrayContaining([expect.objectContaining({ _tag: "notify.desktop", urgency: "success" })]),
      );
    } finally {
      await fixture.cleanup();
    }
  },
  30_000,
);

test.each(["app:config:set", "meta:global:config:edit", "meta:not-a-command"])(
  "config repair and runtime share metadata membership for %s",
  async (commandId) => {
    // Given: installation config naming either a feature command or an unknown static command.
    const fixture = await makeFixture("notify-catalog");
    try {
      const root = fixture.env.LANDO_USER_CONF_ROOT;
      if (root === undefined) throw new Error("Missing config root");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "config.yml"), `notify:\n  commands: ["${commandId}"]\n`);
      // When: repair validation and ordinary runtime validation consume the same config.
      const repair = await runSource(fixture, ["config", "validate", "--format=json"]);
      const runtime = await runSource(fixture, ["apps:list", "--format=json"]);
      // Then: feature commands are valid on both paths and unknown static ids fail on both.
      const expectedCode = commandId === "meta:not-a-command" ? 1 : 0;
      expect(repair.exitCode, repair.stdout + repair.stderr).toBe(expectedCode);
      expect(runtime.exitCode, runtime.stdout + runtime.stderr).toBe(expectedCode);
      if (expectedCode === 1) {
        expect(lastEnvelope(repair.stdout)).toMatchObject({ error: { _tag: "ConfigError" } });
        expect(lastEnvelope(runtime.stdout)).toMatchObject({ error: { _tag: "ConfigError" } });
      }
    } finally {
      await fixture.cleanup();
    }
  },
  30_000,
);
