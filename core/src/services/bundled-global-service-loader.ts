/**
 * Bundled-first global-service module loader.
 *
 * `GlobalServiceContribution.module` is a relative specifier (e.g.
 * `./src/global-services/traefik.ts`) that the default dynamic-`import()` loader
 * cannot resolve from `global-services.ts`, and that a `bun build --compile`
 * binary cannot import at all. Bundled plugins therefore expose their global
 * services as a STATIC `globalServices` map (id → `Effect<ServiceConfig>`)
 * captured in the generated `BUNDLED_PLUGINS` table.
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
import { ServiceConfig } from "@lando/sdk/schema";

import { BUNDLED_PLUGINS } from "../plugins/bundled.ts";
import {
  type GlobalServiceModuleLoader,
  type PendingGlobalServiceContribution,
  defaultGlobalServiceModuleLoader,
} from "./global-services.ts";

interface BundledGlobalServiceLoaderDeps {
  readonly bundled: ReadonlyArray<{
    readonly name: string;
    readonly globalServices?: ReadonlyMap<string, Effect.Effect<ServiceConfig, unknown, never>>;
  }>;
  readonly fallback: GlobalServiceModuleLoader;
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
): GlobalServiceModuleLoader => ({
  load: (entry: PendingGlobalServiceContribution) => {
    const bundled = deps.bundled.find((plugin) => plugin.name === entry.plugin);
    if (bundled === undefined) {
      return deps.fallback.load(entry);
    }

    const effect = bundled.globalServices?.get(entry.contribution.id);
    if (effect === undefined) {
      return Effect.fail(
        loaderError(
          `Bundled plugin ${entry.plugin} does not export a static global service for ${entry.contribution.id}.`,
          `Ensure ${entry.plugin} exports a \`globalServices\` map entry for ${entry.contribution.id} and regenerate core/src/plugins/bundled.ts.`,
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
});

/** Production loader: real bundled plugins + dynamic-import fallback. */
export const bundledFirstGlobalServiceLoader: GlobalServiceModuleLoader = makeBundledFirstGlobalServiceLoader(
  {
    bundled: BUNDLED_PLUGINS,
    fallback: defaultGlobalServiceModuleLoader,
  },
);
