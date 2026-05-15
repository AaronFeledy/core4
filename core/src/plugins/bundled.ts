/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via `bun run scripts/build-bundled-plugins.ts`.
 *
 * Source of truth: `core/build.config.ts` (the "ship list").
 *
 * The default Lando v4 binary is built with `bun build --compile`.
 * Compiled binaries cannot dynamically `import()` arbitrary files at
 * runtime, so bundled plugins are statically imported here. Library consumers
 * do not receive bundled plugins by default — they must opt into bundled
 * discovery or contribute their own Layers.
 */

import { Layer } from "effect";
import { Schema } from "effect";

import { type PluginManifest, PluginManifest as PluginManifestSchema } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import * as plugin3 from "@lando/logger-pretty";
import * as plugin1 from "@lando/provider-docker";
import * as plugin0 from "@lando/provider-lando";
import * as plugin2 from "@lando/service-lando";
const makeManifest = (name: string, contributes?: PluginManifest["contributes"]): PluginManifest =>
  Schema.decodeSync(PluginManifestSchema)({
    name,
    version: "0.0.0",
    api: 4,
    bundled: true,
    ...(contributes === undefined ? {} : { contributes }),
  });

interface BundledPluginModule {
  readonly [key: string]: unknown;
}

type BundledLayer = Layer.Layer<unknown, unknown, unknown> | Layer.Layer<never, never, never>;

const isBundledLayer = (value: unknown): value is BundledLayer => Layer.isLayer(value);

const layerFrom = (module: BundledPluginModule): BundledLayer => {
  if (isBundledLayer(module.provider)) return module.provider;
  if (isBundledLayer(module.services)) return module.services;
  if (isBundledLayer(module.logger)) return module.logger;
  return Layer.empty;
};

const isServiceTypeShape = (value: unknown): value is ServiceTypeShape =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "string" &&
  "toServicePlan" in value &&
  typeof value.toServicePlan === "function";

const isServiceTypeMap = (value: unknown): value is ReadonlyMap<string, ServiceTypeShape> =>
  value instanceof Map && [...value.values()].every(isServiceTypeShape);

const serviceTypesFrom = (
  module: BundledPluginModule,
): { readonly serviceTypes?: ReadonlyMap<string, ServiceTypeShape> } =>
  isServiceTypeMap(module.serviceTypes) ? { serviceTypes: module.serviceTypes } : {};

export const BUNDLED_PLUGINS: ReadonlyArray<{
  readonly name: string;
  readonly layer: BundledLayer;
  readonly manifest: PluginManifest;
  readonly serviceTypes?: ReadonlyMap<string, ServiceTypeShape>;
}> = [
  {
    name: "@lando/provider-lando",
    layer: layerFrom({ ...plugin0 }),
    manifest: makeManifest("@lando/provider-lando", { providers: ["lando"] }),
    ...serviceTypesFrom({ ...plugin0 }),
  },
  {
    name: "@lando/provider-docker",
    layer: layerFrom({ ...plugin1 }),
    manifest: makeManifest("@lando/provider-docker", { providers: ["docker"] }),
    ...serviceTypesFrom({ ...plugin1 }),
  },
  {
    name: "@lando/service-lando",
    layer: layerFrom({ ...plugin2 }),
    manifest: makeManifest("@lando/service-lando", { serviceTypes: ["node:lts", "postgres"] }),
    ...serviceTypesFrom({ ...plugin2 }),
  },
  {
    name: "@lando/logger-pretty",
    layer: layerFrom({ ...plugin3 }),
    manifest: makeManifest("@lando/logger-pretty", { loggers: ["pretty"] }),
    ...serviceTypesFrom({ ...plugin3 }),
  },
];
