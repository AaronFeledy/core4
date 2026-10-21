import { Context, type Layer } from "effect";

import type { ConfigError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import type {
  ConfigService,
  PathsService,
  PluginRegistry,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import type { LandoRuntimeOptions } from "./runtime-options.ts";

export type RuntimeLayer =
  | Layer.Layer<never>
  | Layer.Layer<unknown, ConfigError | LandoRuntimeBootstrapError>;
export type ProviderRuntimeLayer = Layer.Layer<
  PathsService | RuntimeProviderRegistry | PluginRegistry,
  ConfigError | LandoRuntimeBootstrapError
>;

type ProviderRuntimeOptions = LandoRuntimeOptions & { readonly bootstrap: "provider" };

export class RuntimeLayerFactory extends Context.Service<
  RuntimeLayerFactory,
  {
    readonly make: {
      (options: ProviderRuntimeOptions): ProviderRuntimeLayer;
      (
        options: LandoRuntimeOptions & { readonly bootstrap: "minimal" },
      ): Layer.Layer<ConfigService | PathsService, ConfigError | LandoRuntimeBootstrapError>;
      (
        options: LandoRuntimeOptions & { readonly bootstrap: "plugins" },
      ): Layer.Layer<ConfigService | PathsService, ConfigError | LandoRuntimeBootstrapError>;
      (options: LandoRuntimeOptions): RuntimeLayer;
    };
  }
>()("@lando/engine/RuntimeLayerFactory") {}
