import { describe, expect, test } from "bun:test";
import { type Context, Effect, Schema } from "effect";

import { PluginLoadError } from "@lando/sdk/errors";
import { LandofileShape, type ProviderCapabilities } from "@lando/sdk/schema";
import type { PluginRegistry, ServiceType, ServiceTypeInput } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { planApp } from "../../src/planner/assemble.ts";
import { resolveHostFacts } from "../../src/planner/service-types.ts";

const missingPlugin = (id: string) =>
  new PluginLoadError({ message: `Plugin ${id} is not registered.`, pluginName: id });

describe("service type resolve input", () => {
  test("Given host facts, when resolved, then arch matches process.arch", () => {
    // Given / When
    const host = resolveHostFacts();

    // Then
    expect(host?.arch).toBe(process.arch);
  });

  test("Given a recording service type, when assembling, then resolve receives host.arch and provider capabilities", async () => {
    // Given
    const captured: ServiceTypeInput[] = [];
    const recordingType: ServiceType = {
      id: "probe",
      name: "probe",
      base: "l337",
      schema: Schema.Unknown,
      resolve: (input) => {
        captured.push(input);
        return Effect.succeed({
          base: "l337",
          normalizedConfig: input.service,
          features: [],
        });
      },
    };
    const pluginRegistry: Context.Tag.Service<typeof PluginRegistry> = {
      list: Effect.succeed([]),
      load: (pluginName) => Effect.fail(missingPlugin(pluginName)),
      loadServiceType: (id) =>
        id === "probe" ? Effect.succeed(recordingType) : Effect.fail(missingPlugin(id)),
      loadServiceFeature: (id) => Effect.fail(missingPlugin(id)),
      loadAppFeature: (id) => Effect.fail(missingPlugin(id)),
    };
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "probe-app",
      services: { web: { type: "probe", image: "alpine:3" } },
    });
    const capabilities: ProviderCapabilities = TestRuntimeProvider.capabilities;

    // When
    await Effect.runPromise(
      planApp(pluginRegistry, undefined, undefined, undefined, undefined, undefined, landofile, capabilities),
    );

    // Then
    expect(captured).toHaveLength(1);
    expect(captured[0]?.host?.arch).toBe(process.arch);
    expect(captured[0]?.capabilities).toBe(capabilities);
  });
});
