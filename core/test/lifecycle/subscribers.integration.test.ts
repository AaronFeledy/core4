import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { CliCommandRunEvent } from "@lando/sdk/events";
import { AbsolutePath } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";

import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import { makePluginsBootstrapLayer } from "../../src/runtime/generated/layers/plugins.ts";

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
    layer: makePluginsBootstrapLayer({
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
  test("bundled notify factory publishes through the command event-service instance", async () => {
    // Given: plugin bootstrap with bundled subscriber discovery enabled.
    const { layer } = await runtime();

    // When: an eligible outer terminal event is published.
    const notifications = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventService;
        yield* events.publish(terminal);
        return yield* events.query("notify.desktop");
      }).pipe(Effect.provide(layer)),
    );

    // Then: the bundled factory emits exactly one notification before publish returns.
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

  test("provider-tier subscribers receive decoded notify config before CommandRegistry is available", async () => {
    // Given: active notify-lando policy with a provisional command id and zero threshold.
    const { layer, root } = await runtime(
      [],
      "notify:\n  thresholdMs: 0\n  commands:\n    - app:missing-command\n",
    );
    const quickTerminal = Schema.decodeUnknownSync(CliCommandRunEvent)({
      ...terminal,
      timestamp: "2026-07-18T00:00:00.000Z",
      durationMs: 1,
    });
    const previousConfigRoot = process.env.LANDO_USER_CONF_ROOT;
    process.env.LANDO_USER_CONF_ROOT = join(root, "config");

    // When: the provider-tier subscriber handles a quick terminal event.
    let notifications: ReadonlyArray<unknown>;
    try {
      notifications = await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* EventService;
          yield* events.publish(quickTerminal);
          return yield* events.query("notify.desktop");
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      if (previousConfigRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CONF_ROOT");
      else process.env.LANDO_USER_CONF_ROOT = previousConfigRoot;
    }

    // Then: decoded policy is projected without premature command membership validation.
    expect(notifications).toHaveLength(1);
  });

  test("renders the terminal lifecycle notification through the command runtime", async () => {
    // Given: the real plugin bootstrap and JSON renderer with a zero notification threshold.
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
