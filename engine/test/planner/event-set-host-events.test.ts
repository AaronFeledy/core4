import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLandofileLayers } from "@lando/landofile/service";
import { ConfigError, LandofileValidationError, PluginLoadError } from "@lando/sdk/errors";
import { LandofileShape, type ProviderCapabilities } from "@lando/sdk/schema";
import { ConfigService, FileSystem, PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";

import { resolveKnownEventSet } from "../../src/planner/event-set.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as ConfigLayer from "../../src/services/config.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";
import { planApp } from "../plan-app.ts";

const missingPlugin = (id: string) =>
  new PluginLoadError({
    message: `Plugin ${id} is not registered.`,
    pluginName: id,
    remediation: "Install or register the plugin, then retry.",
  });

const pluginRegistry = PluginRegistry.of({
  list: Effect.succeed([]),
  load: (pluginName) => Effect.fail(missingPlugin(pluginName)),
  loadServiceType: (id) => Effect.fail(missingPlugin(id)),
  loadServiceFeature: (id) => Effect.fail(missingPlugin(id)),
  loadAppFeature: (id) => Effect.fail(missingPlugin(id)),
});

describe("event-set global config load failures", () => {
  test("keeps the real issue path instead of blaming network injection", async () => {
    const configLayer = ConfigLayer.layerWith({
      env: {},
      sources: { user: false, env: false },
      host: { hostEvents: { "pre-start": ["echo container"] } },
    });
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "path-fix",
      services: { web: { type: "node:22", image: "alpine:3", home: false } },
    });
    const capabilities: ProviderCapabilities = TestRuntimeProvider.capabilities;
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        return yield* planApp(
          { landofile: yield* compileTestLandofile(landofile), providerCapabilities: capabilities },
          Layer.mergeAll(
            Layer.succeed(PluginRegistry, pluginRegistry),
            Layer.succeed(ConfigService, yield* ConfigService),
          ),
        );
      }).pipe(Effect.provide(configLayer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected planner failure");
    const failure = Option.getOrThrow(Cause.findErrorOption(exit.cause));
    expect(failure).toBeInstanceOf(ConfigError);
    if (!(failure instanceof ConfigError)) throw failure;
    expect(failure.issues?.[0]?.source).toEqual({ layer: "host", path: ["hostEvents", "pre-start", 0] });
    expect(failure.issues?.[0]?.path).toEqual(["hostEvents", "pre-start", 0]);
    expect(failure.remediation).toContain("host config");
    expect(failure.message).toContain("hostEvents.pre-start[0]");
  });
});

describe("planning host shell dialect", () => {
  test("lifecycle host step fails planning; broken tooling does not", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-plan-host-shell-"));
    try {
      await writeFile(
        join(root, ".lando.yml"),
        [
          "name: planhost",
          "services:",
          "  web:",
          "    type: node:22",
          "    image: alpine:3",
          "    home: false",
          "tooling:",
          "  broken:",
          '    service: ":host"',
          '    cmd: "echo $${NOPE}"',
          "events:",
          "  post-start:",
          '    - service: ":host"',
          '      cmd: "echo $${NOPE}"',
          "",
        ].join("\n"),
      );
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const landofile = yield* loadLandofileLayers(root, join(root, ".lando.yml"));
          return yield* resolveKnownEventSet({
            landofile,
            pluginRegistry: yield* PluginRegistry,
            configService: undefined,
            fileSystem: yield* FileSystem,
            pathsService: undefined,
            appRoot: root,
            file: join(root, ".lando.yml"),
          });
        }).pipe(Effect.provide(PluginRegistryLayer.layer), Effect.provide(BunFileSystem.layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) throw new Error("expected failure");
      const failure = Option.getOrThrow(Cause.findErrorOption(exit.cause));
      expect(failure).toBeInstanceOf(LandofileValidationError);
      if (!(failure instanceof LandofileValidationError)) throw failure;
      const paths = failure.issues.map((i) => JSON.stringify(i.path));
      expect(paths).toContain(JSON.stringify(["events", "post-start", 0, "cmd"]));
      expect(paths.some((p) => p.includes('"tooling"'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
