import { describe, expect, test } from "bun:test";
import { Cause, type Context, DateTime, Effect, Exit, Layer } from "effect";

import { NoProviderInstalledError } from "@lando/core/errors";
import { ConfigService, RuntimeProviderRegistry } from "@lando/core/services";
import { AbsolutePath, AppId, type AppPlan, type GlobalConfig, ProviderId } from "@lando/sdk/schema";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { RuntimeProviderRegistryLive } from "../../src/providers/registry.ts";

const appPlan: AppPlan = {
  id: AppId.make("myapp"),
  name: "My App",
  slug: "myapp",
  root: AbsolutePath.make("/srv/apps/myapp"),
  provider: ProviderId.make("lando"),
  services: {},
  routes: [],
  networks: [],
  stores: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-05-14T00:00:00Z"),
    source: "runtime-provider-registry.test",
    runtime: 4,
  },
  extensions: {},
};

const dockerAppPlan: AppPlan = {
  ...appPlan,
  provider: ProviderId.make("docker"),
};

const registryLayer = (defaultProviderId: "lando" | "docker" | "missing") => {
  const config: GlobalConfig = {
    defaultProviderId: ProviderId.make(defaultProviderId),
    telemetry: { enabled: false },
  };
  const load = Effect.succeed(config);
  const configService: Context.Tag.Service<typeof ConfigService> = {
    load,
    get: (key) => Effect.map(load, (loadedConfig) => loadedConfig[key]),
  };

  return RuntimeProviderRegistryLive.pipe(
    Layer.provideMerge(PluginRegistryLive),
    Layer.provideMerge(Layer.succeed(ConfigService, configService)),
  );
};

const runWithRegistry = <A, E>(
  defaultProviderId: "lando" | "docker" | "missing",
  effect: Effect.Effect<A, E, RuntimeProviderRegistry>,
) => Effect.runPromise(effect.pipe(Effect.provide(registryLayer(defaultProviderId))));

describe("RuntimeProviderRegistryLive", () => {
  test("LANDO_PROVIDER overrides the configured default provider", async () => {
    const previous = process.env.LANDO_PROVIDER;
    process.env.LANDO_PROVIDER = "docker";
    try {
      const provider = await runWithRegistry(
        "lando",
        Effect.flatMap(RuntimeProviderRegistry, (registry) => registry.select()),
      );

      expect(provider.id).toBe("docker");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_PROVIDER");
      else process.env.LANDO_PROVIDER = previous;
    }
  });

  test("selects the configured provider-lando RuntimeProvider", async () => {
    const provider = await runWithRegistry(
      "lando",
      Effect.flatMap(RuntimeProviderRegistry, (registry) => registry.select(appPlan)),
    );

    expect(provider.id).toBe("lando");
    expect(provider.displayName).toBe("Lando Runtime Provider");
  });

  test("selects the configured provider-docker RuntimeProvider", async () => {
    const provider = await runWithRegistry(
      "docker",
      Effect.flatMap(RuntimeProviderRegistry, (registry) => registry.select()),
    );

    expect(provider.id).toBe("docker");
    expect(provider.displayName).toBe("Docker Runtime Provider");
  });

  test("selects the provider encoded in an AppPlan over the configured default", async () => {
    const provider = await runWithRegistry(
      "lando",
      Effect.flatMap(RuntimeProviderRegistry, (registry) => registry.select(dockerAppPlan)),
    );

    expect(provider.id).toBe("docker");
    expect(provider.displayName).toBe("Docker Runtime Provider");
  });

  test("fails with NoProviderInstalledError for missing providers", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(RuntimeProviderRegistry, (registry) => registry.select()).pipe(
        Effect.provide(registryLayer("missing")),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(NoProviderInstalledError);
      }
    }
  });

  test("returns the active provider capabilities", async () => {
    const capabilities = await runWithRegistry(
      "lando",
      Effect.flatMap(RuntimeProviderRegistry, (registry) => registry.capabilities),
    );

    expect(capabilities.serviceExec).toBe(true);
    expect(capabilities.composeSpec).toBe("portable");
  });

  test("lists provider ids from PluginRegistry contributions", async () => {
    const providers = await runWithRegistry(
      "lando",
      Effect.flatMap(RuntimeProviderRegistry, (registry) => registry.list),
    );

    expect(providers.map(String)).toEqual(["lando", "docker", "podman"]);
  });
});
