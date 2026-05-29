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

import type { Layer } from "effect";

import type { PluginManifest } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import * as plugin5 from "@lando/file-sync-mutagen";
import * as plugin4 from "@lando/logger-pretty";
import * as plugin1 from "@lando/provider-docker";
import * as plugin0 from "@lando/provider-lando";
import * as plugin2 from "@lando/provider-podman";
import * as plugin3 from "@lando/service-lando";
interface BundledPluginModule {
  readonly [key: string]: unknown;
}

type BundledLayer = Layer.Layer<never, unknown, unknown>;

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
    layer: plugin0.provider,
    manifest: plugin0.manifest,
    ...serviceTypesFrom({ ...plugin0 }),
  },
  {
    name: "@lando/provider-docker",
    layer: plugin1.provider,
    manifest: plugin1.manifest,
    ...serviceTypesFrom({ ...plugin1 }),
  },
  {
    name: "@lando/provider-podman",
    layer: plugin2.provider,
    manifest: plugin2.manifest,
    ...serviceTypesFrom({ ...plugin2 }),
  },
  {
    name: "@lando/service-lando",
    layer: plugin3.services,
    manifest: plugin3.manifest,
    ...serviceTypesFrom({ ...plugin3 }),
  },
  {
    name: "@lando/logger-pretty",
    layer: plugin4.logger,
    manifest: plugin4.manifest,
    ...serviceTypesFrom({ ...plugin4 }),
  },
  {
    name: "@lando/file-sync-mutagen",
    layer: plugin5.engine,
    manifest: plugin5.manifest,
    ...serviceTypesFrom({ ...plugin5 }),
  },
];
