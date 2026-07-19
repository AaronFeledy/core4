import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect";

import { ConfigError } from "@lando/sdk/errors";
import { CliCommandRunEvent } from "@lando/sdk/events";
import { AbsolutePath } from "@lando/sdk/schema";
import { EventService, PluginRegistry } from "@lando/sdk/services";

import { runCommandLifecycle } from "../../src/cli/command-lifecycle.ts";
import { versionSpec } from "../../src/cli/oclif/commands/meta/version.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import {
  McpRuntimeConfig,
  type McpRuntimeConfigShape,
  McpService,
  McpServiceLive,
} from "../../src/mcp/service.ts";
import { McpTransport, makeInMemoryTransport } from "../../src/mcp/transport.ts";
import { RedactionService } from "../../src/redaction/service.ts";
import { makeBootstrapLifecycleTracker } from "../../src/runtime/bootstrap-lifecycle.ts";
import { makeCommandsBootstrapLayer } from "../../src/runtime/generated/layers/commands.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";

const roots: string[] = [];
const repoRoot = resolve(import.meta.dirname, "../../..");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const runtime = async (
  disable: ReadonlyArray<string> = [],
  config?: string,
  discovery: { readonly user: boolean; readonly app: boolean } = { user: false, app: false },
) => {
  const root = await mkdtemp(join(tmpdir(), "lando-subscriber-runtime-"));
  roots.push(root);
  const absolute = (suffix: string) => Schema.decodeUnknownSync(AbsolutePath)(join(root, suffix));
  if (config !== undefined) {
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "config", "config.yml"), config);
  }
  const makeLayer = () =>
    makeCommandsBootstrapLayer({
      lifecycle: makeBootstrapLifecycleTracker(),
      loggerMode: "silent",
      rendererMode: "plain",
      telemetryEnabled: false,
      pluginDiscovery: { bundled: true, ...discovery, disable },
      rootOverrides: {
        userDataRoot: absolute("data"),
        userConfRoot: absolute("config"),
        userCacheRoot: absolute("cache"),
        systemPluginRoot: absolute("system"),
      },
    });
  return {
    root,
    layer: makeLayer(),
    makeLayer,
  };
};

const writeCommandSubscriberPlugin = async (
  pluginsRoot: string,
  plugin: {
    readonly name: string;
    readonly version: string;
    readonly commandId: string;
    readonly markerPath: string;
    readonly markerValue: string;
  },
) => {
  const packageRoot = join(pluginsRoot, plugin.name, plugin.version);
  await mkdir(join(packageRoot, "src"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: plugin.name,
      version: plugin.version,
      landoPlugin: {
        name: plugin.name,
        version: plugin.version,
        api: 4,
        entry: "index.js",
        contributes: { commands: [plugin.commandId] },
        subscribers: [
          {
            id: "terminal-marker",
            selectors: [{ family: "cli-command-terminal" }],
            module: "./src/subscriber.mjs",
          },
        ],
      },
    })}\n`,
  );
  await writeFile(join(packageRoot, "index.js"), "export {};\n");
  const effectModuleUrl = pathToFileURL(join(repoRoot, "node_modules/effect/dist/esm/index.js")).href;
  await writeFile(
    join(packageRoot, "src", "subscriber.mjs"),
    [
      `import { Effect } from ${JSON.stringify(effectModuleUrl)};`,
      'import { writeFileSync } from "node:fs";',
      `export default () => () => Effect.sync(() => writeFileSync(${JSON.stringify(plugin.markerPath)}, ${JSON.stringify(plugin.markerValue)}));`,
      "",
    ].join("\n"),
  );
  await mkdir(pluginsRoot, { recursive: true });
  await writeFile(
    join(pluginsRoot, "registry.json"),
    `${JSON.stringify({
      [plugin.name]: { name: plugin.name, version: plugin.version, path: packageRoot },
    })}\n`,
  );
};

const writeToolingBootstrapSubscriberPlugin = async (
  pluginsRoot: string,
  markerPath: string,
): Promise<void> => {
  const name = "@example/tooling-bootstrap-subscriber";
  const version = "1.0.0";
  const packageRoot = join(pluginsRoot, name, version);
  await mkdir(join(packageRoot, "src"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({
      name,
      version,
      landoPlugin: {
        name,
        version,
        api: 4,
        entry: "index.js",
        bootstrap: "tooling",
        subscribers: [
          {
            id: "tooling-bootstrap-marker",
            selectors: [{ event: "pre-bootstrap-tooling" }, { event: "post-bootstrap-tooling" }],
            module: "./src/subscriber.mjs",
          },
        ],
      },
    })}\n`,
  );
  await writeFile(join(packageRoot, "index.js"), "export {};\n");
  const effectModuleUrl = pathToFileURL(join(repoRoot, "node_modules/effect/dist/esm/index.js")).href;
  await writeFile(
    join(packageRoot, "src", "subscriber.mjs"),
    [
      `import { Effect } from ${JSON.stringify(effectModuleUrl)};`,
      'import { appendFileSync } from "node:fs";',
      `export default () => (event) => Effect.sync(() => appendFileSync(${JSON.stringify(markerPath)}, \`${"${event._tag}"}\\n\`));`,
      "",
    ].join("\n"),
  );
  await mkdir(pluginsRoot, { recursive: true });
  await writeFile(
    join(pluginsRoot, "registry.json"),
    `${JSON.stringify({ [name]: { name, version, path: packageRoot } })}\n`,
  );
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

const versionTerminal = (cwd: string) =>
  Schema.decodeUnknownSync(CliCommandRunEvent)({
    _tag: "cli-meta:version-run",
    commandId: "meta:version",
    argv: [],
    args: {},
    flags: {},
    cwd,
    invocationId: "outer",
    timestamp: "2026-07-18T00:00:00.000Z",
    durationMs: 15_000,
    exitCode: 0,
  });

describe("subscriber runtime integration", () => {
  test("delivers tooling bootstrap events to a tooling-declared plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-tooling-bootstrap-subscriber-"));
    roots.push(root);
    const absolute = (suffix: string) => Schema.decodeUnknownSync(AbsolutePath)(join(root, suffix));
    const markerPath = join(root, "tooling-bootstrap-events.txt");
    await writeToolingBootstrapSubscriberPlugin(join(root, "data", "plugins"), markerPath);
    const layer = makeLandoRuntime({
      bootstrap: "tooling",
      plugins: { discovery: { bundled: false, user: true, app: false } },
      config: {
        userDataRoot: absolute("data"),
        userConfRoot: absolute("config"),
        userCacheRoot: absolute("cache"),
        systemPluginRoot: absolute("system"),
      },
    });
    const previousConfigRoot = process.env.LANDO_USER_CONF_ROOT;
    const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
    process.env.LANDO_USER_CONF_ROOT = join(root, "config");
    process.env.LANDO_USER_DATA_ROOT = join(root, "data");

    try {
      await Effect.runPromise(EventService.pipe(Effect.provide(layer)));
    } finally {
      if (previousConfigRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CONF_ROOT");
      else process.env.LANDO_USER_CONF_ROOT = previousConfigRoot;
      if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
      else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
    }

    expect((await readFile(markerPath, "utf8")).trim().split("\n")).toEqual([
      "pre-bootstrap-tooling",
      "post-bootstrap-tooling",
    ]);
  });

  test("rejects a Landofile-derived global notify id outside an app", async () => {
    // Given: global notification policy references a Landofile-derived id.
    const { layer, root } = await runtime(
      [],
      "notify:\n  thresholdMs: 0\n  commands:\n    - app:project-release\n",
    );
    const previousCwd = process.cwd();
    const previousConfigRoot = process.env.LANDO_USER_CONF_ROOT;

    // When: subscriber registration closes from a directory with no app.
    let exit: Exit.Exit<unknown, unknown>;
    try {
      process.chdir(root);
      process.env.LANDO_USER_CONF_ROOT = join(root, "config");
      exit = await Effect.runPromiseExit(EventService.pipe(Effect.provide(layer)));
    } finally {
      process.chdir(previousCwd);
      if (previousConfigRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CONF_ROOT");
      else process.env.LANDO_USER_CONF_ROOT = previousConfigRoot;
    }

    // Then: cwd-independent validation identifies the entry and its remediation.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ConfigError);
        if (failure.value instanceof ConfigError) {
          expect(failure.value.path).toBe("notify.commands[0]");
          expect(failure.value.message).toContain("app:project-release");
          expect(failure.value.message).toContain("install and enable the plugin");
        }
      }
    }
  });

  test("rejects a Landofile-derived global notify id inside its app", async () => {
    // Given: an app whose global notify config selects its Landofile-derived tooling command.
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
    const previousCwd = process.cwd();
    const previousConfigRoot = process.env.LANDO_USER_CONF_ROOT;

    // When: the commands-tier runtime is acquired from the app cwd.
    let exit: Exit.Exit<unknown, unknown>;
    try {
      process.env.LANDO_USER_CONF_ROOT = join(root, "config");
      process.chdir(appRoot);
      exit = await Effect.runPromiseExit(EventService.pipe(Effect.provide(layer)));
    } finally {
      process.chdir(previousCwd);
      if (previousConfigRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CONF_ROOT");
      else process.env.LANDO_USER_CONF_ROOT = previousConfigRoot;
    }

    // Then: validation fails identically despite app discovery finding that tooling id.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ConfigError);
        if (failure.value instanceof ConfigError) {
          expect(failure.value.path).toBe("notify.commands[0]");
          expect(failure.value.message).toContain("app:notify-release");
          expect(failure.value.message).toContain("install and enable the plugin");
        }
      }
    }
  });

  test("keeps global notify validity when an app plugin shadows the global plugin manifest", async () => {
    // Given: same-name global and app plugins contribute different commands and subscriber behavior.
    const pluginName = "@example/shadowed-commands";
    const globalCommandId = "example:global-release";
    const appCommandId = "example:app-release";
    const { layer, makeLayer, root } = await runtime(
      [],
      `notify:\n  thresholdMs: 0\n  commands:\n    - ${globalCommandId}\n`,
      { user: true, app: true },
    );
    const appRoot = join(root, "app");
    const markerPath = join(root, "effective-subscriber.txt");
    await mkdir(appRoot, { recursive: true });
    await writeFile(join(appRoot, ".lando.yml"), "name: subscriber-fixture\n");
    await writeCommandSubscriberPlugin(join(root, "data", "plugins"), {
      name: pluginName,
      version: "1.0.0",
      commandId: globalCommandId,
      markerPath,
      markerValue: "global",
    });
    await writeCommandSubscriberPlugin(join(appRoot, ".lando", "plugins"), {
      name: pluginName,
      version: "2.0.0",
      commandId: appCommandId,
      markerPath,
      markerValue: "app",
    });
    const previousCwd = process.cwd();
    const previousConfigRoot = process.env.LANDO_USER_CONF_ROOT;
    const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;

    // When: the real subscriber runtime closes once with the global id, then with the app-only id.
    const observed = await (async () => {
      try {
        process.chdir(appRoot);
        process.env.LANDO_USER_CONF_ROOT = join(root, "config");
        process.env.LANDO_USER_DATA_ROOT = join(root, "data");
        const effectiveManifest = await Effect.runPromise(
          Effect.gen(function* () {
            const plugins = yield* PluginRegistry;
            const manifests = yield* plugins.list;
            const events = yield* EventService;
            yield* events.publish(
              Schema.decodeUnknownSync(CliCommandRunEvent)({
                _tag: `cli-${appCommandId}-run`,
                commandId: appCommandId,
                argv: [],
                args: {},
                flags: {},
                cwd: appRoot,
                invocationId: "app-shadow",
                timestamp: "2026-07-18T00:00:00.000Z",
                durationMs: 1,
                exitCode: 0,
              }),
            );
            return manifests.find((manifest) => manifest.name === pluginName);
          }).pipe(Effect.provide(layer)),
        );
        const markerValue = await readFile(markerPath, "utf8");
        await writeFile(
          join(root, "config", "config.yml"),
          `notify:\n  thresholdMs: 0\n  commands:\n    - ${appCommandId}\n`,
        );
        const invalidExit = await Effect.runPromiseExit(EventService.pipe(Effect.provide(makeLayer())));
        return { effectiveManifest, markerValue, invalidExit };
      } finally {
        process.chdir(previousCwd);
        if (previousConfigRoot === undefined) {
          Reflect.deleteProperty(process.env, "LANDO_USER_CONF_ROOT");
        } else {
          process.env.LANDO_USER_CONF_ROOT = previousConfigRoot;
        }
        if (previousDataRoot === undefined) {
          Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
        } else {
          process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
        }
      }
    })();

    // Then: app behavior wins selector expansion, while only the global command remains notify-valid.
    expect(observed.effectiveManifest).toMatchObject({
      version: "2.0.0",
      contributes: { commands: [appCommandId] },
    });
    expect(observed.markerValue).toBe("app");
    expect(Exit.isFailure(observed.invalidExit)).toBe(true);
    if (Exit.isFailure(observed.invalidExit)) {
      const failure = Cause.failureOption(observed.invalidExit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ConfigError);
        if (failure.value instanceof ConfigError) {
          expect(failure.value.path).toBe("notify.commands[0]");
          expect(failure.value.message).toContain(appCommandId);
          expect(failure.value.message).toContain("install and enable the plugin");
        }
      }
    }
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

  test("rejects an unknown global notify id inside an app before subscriber registration", async () => {
    // Given: active notify policy naming an id absent from the cwd-independent global registry.
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

    // When: the commands-tier layer acquires its event service from an app cwd.
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

    // Then: registration reports the exact invalid entry and remediation.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        const value: unknown = failure.value;
        expect(value).toBeInstanceOf(ConfigError);
        if (value instanceof ConfigError) {
          expect(value.path).toBe("notify.commands[0]");
          expect(value.message).toContain("app:missing-command");
          expect(value.message).toContain("install and enable the plugin");
        }
      }
    }
  });

  test("rejects an unknown global notify id identically in an app with no tooling", async () => {
    // Given: a valid app with no Landofile-derived tooling entries.
    const { layer, root } = await runtime([], "notify:\n  commands:\n    - app:missing-command\n");
    const appRoot = join(root, "app-without-tooling");
    await mkdir(appRoot, { recursive: true });
    await writeFile(join(appRoot, ".lando.yml"), "name: subscriber-fixture\n");
    const previousCwd = process.cwd();
    const previousConfigRoot = process.env.LANDO_USER_CONF_ROOT;

    // When: subscriber registration validates from that app cwd.
    let exit: Exit.Exit<unknown, unknown>;
    try {
      process.chdir(appRoot);
      process.env.LANDO_USER_CONF_ROOT = join(root, "config");
      exit = await Effect.runPromiseExit(EventService.pipe(Effect.provide(layer)));
    } finally {
      process.chdir(previousCwd);
      if (previousConfigRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CONF_ROOT");
      else process.env.LANDO_USER_CONF_ROOT = previousConfigRoot;
    }

    // Then: absence of tooling reports the same exact entry and remediation.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(ConfigError);
        if (failure.value instanceof ConfigError) {
          expect(failure.value.path).toBe("notify.commands[0]");
          expect(failure.value.message).toContain("app:missing-command");
          expect(failure.value.message).toContain("install and enable the plugin");
        }
      }
    }
  });

  test("accepts a compiled built-in notify id outside an app", async () => {
    // Given: active notify policy naming a compiled built-in from a directory with no app.
    const { layer, root } = await runtime([], "notify:\n  thresholdMs: 0\n  commands:\n    - meta:version\n");
    const previousCwd = process.cwd();
    const previousConfigRoot = process.env.LANDO_USER_CONF_ROOT;

    // When: the runtime validates and publishes the built-in terminal event outside an app.
    let notifications: ReadonlyArray<unknown>;
    try {
      process.chdir(root);
      process.env.LANDO_USER_CONF_ROOT = join(root, "config");
      notifications = await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* EventService;
          yield* events.publish(versionTerminal(root));
          return yield* events.query("notify.desktop");
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      process.chdir(previousCwd);
      if (previousConfigRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CONF_ROOT");
      else process.env.LANDO_USER_CONF_ROOT = previousConfigRoot;
    }

    // Then: the built-in remains notification-eligible outside an app.
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ _tag: "notify.desktop", urgency: "success" });
  });

  test("accepts a compiled built-in notify id inside an app", async () => {
    // Given: active notify policy naming a compiled built-in from a valid app cwd.
    const { layer, root } = await runtime([], "notify:\n  thresholdMs: 0\n  commands:\n    - meta:version\n");
    const appRoot = join(root, "app");
    await mkdir(appRoot, { recursive: true });
    await writeFile(join(appRoot, ".lando.yml"), "name: subscriber-fixture\n");
    const previousCwd = process.cwd();
    const previousConfigRoot = process.env.LANDO_USER_CONF_ROOT;

    // When: the runtime validates and publishes the built-in terminal event inside the app.
    let notifications: ReadonlyArray<unknown>;
    try {
      process.chdir(appRoot);
      process.env.LANDO_USER_CONF_ROOT = join(root, "config");
      notifications = await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* EventService;
          yield* events.publish(versionTerminal(appRoot));
          return yield* events.query("notify.desktop");
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      process.chdir(previousCwd);
      if (previousConfigRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CONF_ROOT");
      else process.env.LANDO_USER_CONF_ROOT = previousConfigRoot;
    }

    // Then: the built-in remains notification-eligible inside an app.
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ _tag: "notify.desktop", urgency: "success" });
  });

  test("publishes nested MCP lifecycle events while notifying only for the outer invocation", async () => {
    // Given: one runtime where both outer meta:mcp and nested meta:version are notification-eligible.
    const { layer, root } = await runtime(
      [],
      "notify:\n  thresholdMs: 0\n  commands:\n    - meta:mcp\n    - meta:version\n",
    );
    const previousCwd = process.cwd();
    const previousConfigRoot = process.env.LANDO_USER_CONF_ROOT;

    // When: MCP dispatches meta:version beneath the outer meta:mcp lifecycle.
    let observed: {
      readonly replies: ReadonlyArray<unknown>;
      readonly nested: ReadonlyArray<unknown>;
      readonly notifications: ReadonlyArray<unknown>;
    };
    try {
      process.chdir(root);
      process.env.LANDO_USER_CONF_ROOT = join(root, "config");
      observed = await Effect.runPromise(
        Effect.gen(function* () {
          const events = yield* EventService;
          const redaction = yield* RedactionService;
          const config: McpRuntimeConfigShape = {
            commandEntries: [{ spec: versionSpec }],
            defaultAllowlist: [versionSpec.id],
            runtimeLayer: Layer.succeed(EventService, events),
          };
          const mcpLayer = McpServiceLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(McpRuntimeConfig, config),
                Layer.succeed(RedactionService, redaction),
              ),
            ),
          );
          const replies = yield* Effect.gen(function* () {
            const inMemory = yield* makeInMemoryTransport();
            const service = yield* McpService;
            const fiber = yield* runCommandLifecycle(
              service
                .serve({ transport: "stdio" })
                .pipe(Effect.provideService(McpTransport, inMemory.transport)),
              {
                invocation: {
                  commandId: "meta:mcp",
                  argv: [],
                  args: {},
                  flags: {},
                  cwd: root,
                  invocationId: "outer-id",
                },
              },
            ).pipe(Effect.forkScoped);
            yield* inMemory.push({ toolId: versionSpec.id });
            while ((yield* inMemory.replies).length < 1) yield* Effect.sleep("10 millis");
            const result = yield* inMemory.replies;
            yield* inMemory.close;
            yield* Fiber.join(fiber);
            return result;
          }).pipe(Effect.scoped, Effect.provide(mcpLayer));
          return {
            replies,
            nested: yield* events.query("cli-meta:version-run"),
            notifications: yield* events.query("notify.desktop"),
          };
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      process.chdir(previousCwd);
      if (previousConfigRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CONF_ROOT");
      else process.env.LANDO_USER_CONF_ROOT = previousConfigRoot;
    }

    // Then: the subscriber sees correlated child publication but suppresses its desktop notification.
    expect(observed.replies[0]).toMatchObject({ ok: true });
    expect(observed.nested).toHaveLength(1);
    expect(observed.nested[0]).toMatchObject({
      _tag: "cli-meta:version-run",
      parentInvocationId: "outer-id",
    });
    expect(observed.notifications).toEqual([
      expect.objectContaining({
        _tag: "notify.desktop",
        title: "Lando meta:mcp completed",
      }),
    ]);
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
