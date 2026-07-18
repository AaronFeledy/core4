import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Exit, Schema } from "effect";

import { ConfigError } from "@lando/sdk/errors";
import { CliCommandRunEvent } from "@lando/sdk/events";
import { AbsolutePath } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";

import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import { makeCommandsBootstrapLayer } from "../../src/runtime/generated/layers/commands.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const runtime = async (disable: ReadonlyArray<string> = [], config?: string) => {
  const root = await mkdtemp(join(tmpdir(), "lando-subscriber-runtime-"));
  roots.push(root);
  const absolute = (suffix: string) => Schema.decodeUnknownSync(AbsolutePath)(join(root, suffix));
  if (config !== undefined) {
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "config.yml"), config);
  }
  return {
    root,
    layer: makeCommandsBootstrapLayer({
      loggerMode: "silent",
      rendererMode: "plain",
      telemetryEnabled: false,
      pluginDiscovery: { bundled: true, user: false, app: false, disable },
      rootOverrides: {
        userDataRoot: absolute("data"),
        userConfRoot: absolute("config"),
        userCacheRoot: absolute("cache"),
        systemPluginRoot: absolute("system"),
      },
    }),
  };
};

const terminal = Schema.decodeUnknownSync(CliCommandRunEvent)({
  _tag: "cli-app:start-run",
  commandId: "app:start",
  argv: [],
  args: {},
  flags: {},
  cwd: "/app",
  invocationId: "outer",
  timestamp: "2026-07-18T00:00:00.000Z",
  durationMs: 15_000,
  exitCode: 0,
});

describe("subscriber runtime integration", () => {
  test("commands-tier accepts an app-derived notify command and publishes once", async () => {
    // Given: an isolated app whose notify config selects a Landofile-derived tooling command.
    const { layer, root } = await runtime(
      [],
      "notify:\n  thresholdMs: 0\n  commands:\n    - app:notify-release\n",
    );
    const appRoot = join(root, "app");
    await mkdir(appRoot, { recursive: true });
    await writeFile(
      join(appRoot, ".lando.yml"),
      ["name: subscriber-fixture", "tooling:", "  notify-release:", "    cmd: echo release", ""].join("\n"),
    );
    const appTerminal = Schema.decodeUnknownSync(CliCommandRunEvent)({
      _tag: "cli-app:notify-release-run",
      commandId: "app:notify-release",
      argv: [],
      args: {},
      flags: {},
      cwd: appRoot,
      invocationId: "outer",
      timestamp: "2026-07-18T00:00:00.000Z",
      durationMs: 1,
      exitCode: 0,
    });
    const previousCwd = process.cwd();
    const previousConfigRoot = process.env.LANDO_USER_CONF_ROOT;

    // When: the commands-tier runtime is acquired from the app cwd and publishes its terminal event.
    let notifications: ReadonlyArray<unknown>;
    try {
      process.env.LANDO_USER_CONF_ROOT = join(root, "config");
      process.chdir(appRoot);
      notifications = await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* EventService;
          yield* events.publish(appTerminal);
          return yield* events.query("notify.desktop");
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      process.chdir(previousCwd);
      if (previousConfigRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CONF_ROOT");
      else process.env.LANDO_USER_CONF_ROOT = previousConfigRoot;
    }

    // Then: final command membership accepts the app command and publishes exactly once.
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ _tag: "notify.desktop", urgency: "success" });
  });

  test("disabling the bundled plugin removes its subscriber", async () => {
    // Given: plugin bootstrap with notify-lando disabled by standard plugin policy.
    const { layer } = await runtime(["@lando/notify-lando"]);

    // When: an otherwise eligible terminal event is published.
    const notifications = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventService;
        yield* events.publish(terminal);
        return yield* events.query("notify.desktop");
      }).pipe(Effect.provide(layer)),
    );

    // Then: no notification is emitted.
    expect(notifications).toEqual([]);
  });

  test("disabled notify-lando bypasses notify command membership validation", async () => {
    // Given: notify-lando is disabled and notify.commands names a command absent from this tier.
    const { layer, root } = await runtime(
      ["@lando/notify-lando"],
      "notify:\n  commands:\n    - app:missing-command\n",
    );
    const previousConfigRoot = process.env.LANDO_USER_CONF_ROOT;
    process.env.LANDO_USER_CONF_ROOT = join(root, "config");

    // When: an otherwise eligible terminal event is published.
    let notifications: ReadonlyArray<unknown>;
    try {
      notifications = await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* EventService;
          yield* events.publish(terminal);
          return yield* events.query("notify.desktop");
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      if (previousConfigRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CONF_ROOT");
      else process.env.LANDO_USER_CONF_ROOT = previousConfigRoot;
    }

    // Then: disabled subscriber semantics do not reject unrelated global config loading.
    expect(notifications).toEqual([]);
  });

  test("commands-tier rejects an unknown notify command before subscriber registration", async () => {
    // Given: active notify-lando policy naming a command absent from the final commands-tier registry.
    const { layer, root } = await runtime(
      [],
      "notify:\n  thresholdMs: 0\n  commands:\n    - app:missing-command\n",
    );
    const appRoot = join(root, "app");
    await mkdir(appRoot, { recursive: true });
    await writeFile(
      join(appRoot, ".lando.yml"),
      ["name: subscriber-fixture", "tooling:", "  known-command:", "    cmd: echo known", ""].join("\n"),
    );
    const previousCwd = process.cwd();
    const previousConfigRoot = process.env.LANDO_USER_CONF_ROOT;

    // When: the commands-tier layer attempts to acquire its event service and close subscriber registration.
    const exit = await (async () => {
      try {
        process.env.LANDO_USER_CONF_ROOT = join(root, "config");
        process.chdir(appRoot);
        return await Effect.runPromiseExit(
          Effect.gen(function* () {
            return yield* EventService;
          }).pipe(Effect.provide(layer)),
        );
      } finally {
        process.chdir(previousCwd);
        if (previousConfigRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CONF_ROOT");
        else process.env.LANDO_USER_CONF_ROOT = previousConfigRoot;
      }
    })();

    // Then: registration fails with the exact invalid notify.commands entry.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        const value: unknown = failure.value;
        expect(value).toBeInstanceOf(ConfigError);
        if (value instanceof ConfigError) expect(value.path).toBe("notify.commands[0]");
      }
    }
  });

  test("commands-tier rejects a below-commands canonical notify command", async () => {
    // Given: active notify-lando policy naming a canonical command below commands bootstrap.
    const { layer, root } = await runtime([], "notify:\n  commands:\n    - meta:version\n");
    const previousConfigRoot = process.env.LANDO_USER_CONF_ROOT;
    process.env.LANDO_USER_CONF_ROOT = join(root, "config");

    // When: the commands-tier layer validates notification eligibility.
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* EventService;
      }).pipe(Effect.provide(layer)),
    );
    if (previousConfigRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CONF_ROOT");
    else process.env.LANDO_USER_CONF_ROOT = previousConfigRoot;

    // Then: canonical selector membership does not make the command notification-eligible.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        const value: unknown = failure.value;
        expect(value).toBeInstanceOf(ConfigError);
        if (value instanceof ConfigError) expect(value.path).toBe("notify.commands[0]");
      }
    }
  });

  test("renders the terminal lifecycle notification through the command runtime", async () => {
    // Given: the real commands bootstrap and JSON renderer with a zero notification threshold.
    const { layer, root } = await runtime([], "notify:\n  thresholdMs: 0\n");
    const io = createBufferedRendererIO();
    const previousConfigRoot = process.env.LANDO_USER_CONF_ROOT;
    process.env.LANDO_USER_CONF_ROOT = join(root, "config");

    // When: the renderer boundary wraps a successful eligible invocation.
    try {
      await runWithRendererHandling(Effect.succeed({}), {
        runtime: layer,
        rendererMode: "json",
        resultFormat: "json",
        io,
        command: "app:start",
        invocation: {
          commandId: "app:start",
          argv: ["start"],
          args: {},
          flags: {},
          cwd: "/app",
          invocationId: "outer",
        },
        resultSchema: Schema.Struct({}),
        render: () => undefined,
        formatError: () => "should not happen",
      });
    } finally {
      if (previousConfigRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CONF_ROOT");
      else process.env.LANDO_USER_CONF_ROOT = previousConfigRoot;
    }

    // Then: the subscriber and renderer observe the same EventService instance.
    expect(io.stderrLines().map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ _tag: "notify.desktop", urgency: "success" }),
    ]);
  });
});
