import { makeLandoPaths } from "@lando/paths";
import { PathsService, PluginRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer } from "effect";

export const globalPolicyFixture = Layer.mergeAll(
  Layer.succeed(PathsService, makeLandoPaths()),
  Layer.succeed(
    PluginRegistry,
    PluginRegistry.of({
      list: Effect.succeed([]),
      load: () => Effect.die("No contribution modules are used by this fixture."),
      loadServiceType: () => Effect.die("Service types are supplied separately."),
      loadServiceFeature: () => Effect.die("No service features are used by this fixture."),
      loadAppFeature: () => Effect.die("No app features are used by this fixture."),
      declaredProviderCapabilities: () => TestRuntimeProvider.capabilities,
    }),
  ),
);
