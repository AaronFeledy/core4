import { Context, type Layer } from "effect";

import type { ConfigError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import type { PathsService, RuntimeProviderRegistry } from "@lando/sdk/services";
import type { LandoRuntimeOptions } from "./runtime-options.ts";

export type RuntimeLayer =
  | Layer.Layer<never>
  | Layer.Layer<unknown, ConfigError | LandoRuntimeBootstrapError>;
export type ProviderRuntimeLayer = Layer.Layer<
  PathsService | RuntimeProviderRegistry,
  ConfigError | LandoRuntimeBootstrapError
>;

type ProviderRuntimeOptions = LandoRuntimeOptions & { readonly bootstrap: "provider" };

export class RuntimeLayerFactory extends Context.Tag("@lando/engine/RuntimeLayerFactory")<
  RuntimeLayerFactory,
  {
    readonly make: {
      (options: ProviderRuntimeOptions): ProviderRuntimeLayer;
      (options: LandoRuntimeOptions): RuntimeLayer;
    };
  }
>() {}
