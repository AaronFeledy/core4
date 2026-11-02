import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { ConfigError } from "@lando/sdk/errors";
import { LandofileShape, type ProviderCapabilities } from "@lando/sdk/schema";
import { ConfigService, PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Schema } from "effect";

import { PluginLoadError } from "@lando/sdk/errors";
import * as ConfigLayer from "../../src/services/config.ts";
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
import { compileTestLandofile } from "../compiled-landofile.ts";
