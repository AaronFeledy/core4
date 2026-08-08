/**
 * Bundled-first global-service module loader.
 *
 * `GlobalServiceContribution.module` is a relative specifier (e.g.
 * `./src/global-services/traefik.ts`) that the default dynamic-`import()` loader
 * cannot resolve from `global-services.ts`, and that a `bun build --compile`
 * binary cannot import at all. Bundled plugins therefore expose their global
 * services as a STATIC `globalServices` map (id → `Effect<ServiceConfig>`)
 * captured on each `LandoPluginModule` in the generated `BUNDLED_PLUGIN_MODULES`
 * descriptor table.
 *
 * This loader prefers that static map for any bundled plugin (compiled-binary
 * safe, no dynamic import). A bundled plugin that is missing the requested
 * static entry fails loudly with a `GlobalAppError` rather than silently
 * falling back to a dynamic import that would fail in the compiled binary.
 * Non-bundled (future, dynamically discovered) plugins fall back to the default
 * dynamic-import loader.
 */
import { Effect, Schema } from "effect";

import { GlobalAppError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import { ServiceConfig } from "@lando/sdk/schema";

import { bundledPluginModules } from "../composition.ts";
import {
  type GlobalServiceModuleLoader,
  type PendingGlobalServiceContribution,
  defaultGlobalServiceModuleLoader,
} from "./global-services.ts";

interface BundledGlobalServiceLoaderDeps {
  readonly modules: ReadonlyArray<LandoPluginModule>;
  readonly fallback?: GlobalServiceModuleLoader;
}

const loaderError = (message: string, remediation: string, cause?: unknown): GlobalAppError =>
  new GlobalAppError({
    message,
    operation: "regenerateDist",
    remediation,
    ...(cause === undefined ? {} : { cause }),
  });

export const makeBundledFirstGlobalServiceLoader = (
  deps: BundledGlobalServiceLoaderDeps,
): GlobalServiceModuleLoader => {
  const modules = deps.modules;
  const fallback = deps.fallback ?? defaultGlobalServiceModuleLoader;

  return {
    load: (entry: PendingGlobalServiceContribution) => {
      const descriptor = modules.find((plugin) => plugin.name === entry.plugin);
      if (descriptor === undefined) {
        return fallback.load(entry);
      }

      const effect = descriptor.globalServices?.get(entry.contribution.id);
      if (effect === undefined) {
        return Effect.fail(
          loaderError(
            `Bundled plugin ${entry.plugin} does not export a static global service for ${entry.contribution.id}.`,
            `Ensure ${entry.plugin} exports a \`globalServices\` map entry for ${entry.contribution.id} and regenerate the BUNDLED_PLUGIN_MODULES descriptor table.`,
          ),
        );
      }

      return effect.pipe(
        Effect.mapError((cause) =>
          loaderError(
            `Bundled global service ${entry.contribution.id} from plugin ${entry.plugin} failed.`,
            `Fix the global service module in ${entry.plugin}.`,
            cause,
          ),
        ),
        Effect.flatMap((value) =>
          Schema.decodeUnknown(ServiceConfig)(value).pipe(
            Effect.mapError((cause) =>
              loaderError(
                `Bundled global service ${entry.contribution.id} from plugin ${entry.plugin} did not return a valid ServiceConfig.`,
                `Update ${entry.plugin} so global service ${entry.contribution.id} returns a valid ServiceConfig.`,
                cause,
              ),
            ),
          ),
        ),
      );
    },
  };
};

/** Production loader: real bundled plugin descriptors + dynamic-import fallback. */
export const bundledFirstGlobalServiceLoader: GlobalServiceModuleLoader = {
  load: (entry) => makeBundledFirstGlobalServiceLoader({ modules: bundledPluginModules() }).load(entry),
};
