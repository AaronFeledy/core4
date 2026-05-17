import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { ProviderCapabilities, ProviderId } from "@lando/sdk/schema";
import { doctor, renderDoctorResult } from "../../src/cli/commands/doctor.ts";

describe("meta:doctor command", () => {
  test("renders the selected provider and every ProviderCapabilities field", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const registry = {
      list: Effect.succeed([ProviderId.make("lando")]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    };

    const result = await Effect.runPromise(
      doctor().pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, registry))),
    );
    const output = renderDoctorResult(result);

    expect(output).toContain("selected-provider: pass");
    expect(output).toContain("provider: lando");
    for (const field of Object.keys(ProviderCapabilities.fields)) {
      expect(output).toContain(`${field}:`);
    }
  });

  test("renders array-valued capabilities as JSON, not [object Object]", async () => {
    const provider = {
      ...TestRuntimeProvider,
      id: "lando",
      capabilities: { ...TestRuntimeProvider.capabilities, providerExtensions: ["compose", "exec"] },
    };
    const registry = {
      list: Effect.succeed([ProviderId.make("lando")]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    };

    const result = await Effect.runPromise(
      doctor().pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, registry))),
    );
    const output = renderDoctorResult(result);

    expect(output).toContain('providerExtensions: ["compose","exec"]');
    expect(output).not.toContain("[object Object]");
  });

  test("renders empty array capabilities as []", async () => {
    const provider = { ...TestRuntimeProvider, id: "lando" };
    const registry = {
      list: Effect.succeed([ProviderId.make("lando")]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    };

    const result = await Effect.runPromise(
      doctor().pipe(Effect.provide(Layer.succeed(RuntimeProviderRegistry, registry))),
    );
    const output = renderDoctorResult(result);

    expect(output).toContain("providerExtensions: []");
    expect(output).not.toContain("[object Object]");
  });
});
