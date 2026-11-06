import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadLandofileLayers } from "@lando/landofile/service";
import { GlobalConfig, PluginManifest, ServiceName } from "@lando/sdk/schema";
import {
  type AppFeatureDefinition,
  ConfigService,
  FileSystem,
  PluginRegistry,
  type ServiceType,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import * as EnvSecretStore from "../../src/services/secret-store.ts";
import { resolvePlanEnvironment } from "../environment-values.ts";
import { planApp } from "../plan-app.ts";

const raw = "$${HOME} {{{{literal ${secret:TEST}";
const serviceType: ServiceType = {
  id: "binding-test",
  name: "binding-test",
  base: "l337",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "l337" as const,
      normalizedConfig: {
        ...input.service,
        environment: { PLUGIN: raw, ORDER: "plugin", ...input.service.environment },
      },
      features: [],
    }),
};
const config = Schema.decodeUnknownSync(GlobalConfig)({ appEnv: { GLOBAL: raw, ORDER: "global" } });
const configService = ConfigService.of({
  load: Effect.succeed(config),
  get: (key) => Effect.succeed(config[key]),
});
const planFile = (file: string, feature?: AppFeatureDefinition) =>
  Effect.gen(function* () {
    const loaded = yield* loadLandofileLayers(dirname(file), file);
    const registry = yield* PluginRegistry;
    const fileSystem = yield* FileSystem;
    return yield* planApp(
      { landofile: loaded, providerCapabilities: TestRuntimeProvider.capabilities },
      Layer.mergeAll(
        Layer.succeed(PluginRegistry, {
          ...registry,
          loadServiceType: () => Effect.succeed(serviceType),
          ...(feature === undefined
            ? {}
            : {
                list: Effect.succeed([
                  Schema.decodeUnknownSync(PluginManifest)({
                    name: "@test/bindings",
                    version: "1.0.0",
                    api: 4,
                    contributes: { appFeatures: [feature.id] },
                  }),
                ]),
                loadAppFeature: () => Effect.succeed(feature),
              }),
        }),
        Layer.succeed(ConfigService, configService),
        Layer.succeed(FileSystem, fileSystem),
      ),
    );
  }).pipe(
    Effect.provide(PluginRegistryLayer.layerWith({ bundled: false }, [])),
    Effect.provide(BunFileSystem.layer),
  );

test("preserves raw file, appEnv and plugin bytes below authored environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-raw-environment-"));
  try {
    await writeFile(
      join(root, "shared.env"),
      `SHARED=${raw}\nORDER=shared\nSHARED_WINS=shared\nESCAPED="\\\${secret:TEST}"\nQUOTED="{{ env.NOT_SET }}"\n`,
    );
    await writeFile(join(root, "service.env"), `LOCAL=${raw}\nORDER=service\nSERVICE_WINS=service\n`);
    const file = join(root, ".lando.yml");
    await writeFile(
      file,
      [
        "name: bindings",
        "env_file: shared.env",
        "services:",
        "  web:",
        "    type: binding-test",
        "    home: false",
        "    env_file: service.env",
        "    environment:",
        "      ORDER: authored",
      ].join("\n"),
    );
    const app = await Effect.runPromise(planFile(file));
    const resolved = await Effect.runPromise(
      resolvePlanEnvironment(app).pipe(Effect.provide(EnvSecretStore.layer)),
    );
    expect(app.services[ServiceName.make("web")]?.environment).toMatchObject({
      GLOBAL: raw,
      SHARED: raw,
      LOCAL: raw,
      PLUGIN: raw,
      ORDER: "authored",
      SHARED_WINS: "shared",
      ESCAPED: "${secret:TEST}",
      QUOTED: "{{ env.NOT_SET }}",
      SERVICE_WINS: "service",
    });
    expect(app.services[ServiceName.make("web")]?.environment).toEqual(resolved[ServiceName.make("web")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["${secret:TEST}", "plugin-replacement"])(
  "replaces the entire authored binding with app feature output %s",
  async (output) => {
    const root = await mkdtemp(join(tmpdir(), "lando-final-binding-"));
    try {
      const file = join(root, ".lando.yml");
      await writeFile(
        file,
        [
          "name: bindings",
          "services:",
          "  web:",
          "    type: binding-test",
          "    home: false",
          "    environment:",
          '      TOKEN: "${secret:TEST}"',
        ].join("\n"),
      );
      const feature: AppFeatureDefinition = {
        id: "test.binding",
        priority: 100,
        apply: (context) =>
          Effect.sync(() => {
            context.forEachSelected((service) => {
              service.addEnv("TOKEN", output);
              service.addEnv("INJECTED", "${secret:TEST}");
            });
          }),
      };
      const app = await Effect.runPromise(planFile(file, feature));
      expect(app.services[ServiceName.make("web")]?.environment).toMatchObject({
        TOKEN: output,
        INJECTED: "${secret:TEST}",
      });
      const resolved = await Effect.runPromise(
        resolvePlanEnvironment(app).pipe(Effect.provide(EnvSecretStore.layer)),
      );
      expect(resolved[ServiceName.make("web")]?.TOKEN).toBe(output);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each(['TOKEN: "$${secret:TEST}"', 'TOKEN: !reset "$${secret:TEST}"', "environment: !reset {}"])(
  "drops overwritten authored bindings after overlay composition: %s",
  async (replacement) => {
    const root = await mkdtemp(join(tmpdir(), "lando-binding-overlay-"));
    try {
      const file = join(root, ".lando.yml");
      await writeFile(
        file,
        'name: bindings\nservices:\n  web:\n    type: binding-test\n    home: false\n    environment:\n      TOKEN: "${secret:TEST}"\n',
      );
      await writeFile(
        join(root, ".lando.local.yml"),
        replacement.startsWith("environment:")
          ? `services:\n  web:\n    ${replacement}\n`
          : `services:\n  web:\n    environment:\n      ${replacement}\n`,
      );
      const app = await Effect.runPromise(planFile(file));
      const resolved = await Effect.runPromise(
        resolvePlanEnvironment(app).pipe(Effect.provide(EnvSecretStore.layer)),
      );
      expect(app.services[ServiceName.make("web")]?.environment).toEqual(resolved[ServiceName.make("web")]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
