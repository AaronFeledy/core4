/**
 * Deterministic plugin selection for one app root.
 *
 * `resolvePluginSelection` resolves the manifest selection a contribution graph builds from
 * (bundled, explicit, system, user, and the app's `.lando/plugins` registry) and fingerprints
 * every input that selection read: registry bytes (a missing registry is an explicit input, so
 * creating one invalidates an empty selection), each registered package's realpath and
 * `package.json` bytes, each selected package's stat identity, and the discovery policy. It
 * never imports a plugin module.
 */
import { join } from "node:path";
import type { PluginLoadError } from "@lando/sdk/errors";
import type { LandoPluginModule } from "@lando/sdk/plugins";
import type { ResolvedPluginInput } from "@lando/sdk/schema";
import { Effect } from "effect";

import { canonicalAppRoot } from "../operations/app-root-identity.ts";
import { type PluginImplementation, pluginImplementationIdentity } from "./implementation-identity.ts";
import { inspectInstalledPluginRegistry } from "./installed-registry.ts";
import { type ResolvedPluginManifests, resolvePluginManifests } from "./manifest-resolution.ts";
import type { PluginManifestSource } from "./manifest-selection.ts";

export interface PluginSelectionPolicy {
  readonly discovery: {
    readonly bundled: boolean;
    readonly system: boolean;
    readonly user: boolean;
    readonly app: boolean;
    readonly disable: ReadonlyArray<string>;
  };
  readonly manifests: ReadonlyArray<ResolvedPluginInput>;
  readonly externalImports: boolean;
}

export interface PluginSelectionDirectory {
  readonly source: PluginManifestSource;
  readonly path: string;
}

/** The installed-plugin directories a policy reads, in selection order. */
export const pluginSelectionDirectories = (
  policy: PluginSelectionPolicy,
  roots: { readonly systemPluginsDir: string; readonly pluginsDir: string },
  appRoot: string | undefined,
): ReadonlyArray<PluginSelectionDirectory> =>
  policy.externalImports
    ? [
        ...(policy.discovery.system ? [{ source: "system" as const, path: roots.systemPluginsDir }] : []),
        ...(policy.discovery.user ? [{ source: "user" as const, path: roots.pluginsDir }] : []),
        ...(policy.discovery.app && appRoot !== undefined
          ? [{ source: "app" as const, path: join(appRoot, ".lando", "plugins") }]
          : []),
      ]
    : [];

export interface PluginSelection {
  readonly resolution: ResolvedPluginManifests;
  readonly fingerprint: string;
  readonly implementations: readonly PluginImplementation[];
}

/** Fingerprint reads are independent; bound them like other host file scans. */
const READ_CONCURRENCY = 8;

const digestOrMissing = (path: string): Effect.Effect<string> =>
  Effect.tryPromise(() => Bun.file(path).bytes()).pipe(
    Effect.map((bytes) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")),
    Effect.orElseSucceed(() => "missing"),
  );

const directoryInputs = Effect.fnUntraced(function* (directory: PluginSelectionDirectory) {
  const registry = yield* digestOrMissing(join(directory.path, "registry.json"));
  const inspection = yield* Effect.tryPromise(() => inspectInstalledPluginRegistry(directory.path)).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  const packages = yield* Effect.forEach(
    Object.values(inspection?.registry ?? {}),
    (entry) =>
      Effect.all({
        name: Effect.succeed(entry.name),
        realpath: canonicalAppRoot(entry.path).pipe(Effect.orElseSucceed(() => "missing")),
        packageJson: digestOrMissing(join(entry.path, "package.json")),
      }),
    { concurrency: READ_CONCURRENCY },
  );
  return { source: directory.source, path: directory.path, registry, packages };
});

/**
 * Resolve and fingerprint the plugin selection for `appRoot` (or the global selection when it is
 * undefined), without evaluating executable code.
 */
export const resolvePluginSelection = Effect.fn("PluginSelection.resolve")(function* (input: {
  readonly policy: PluginSelectionPolicy;
  readonly roots: { readonly systemPluginsDir: string; readonly pluginsDir: string };
  readonly modules: ReadonlyArray<LandoPluginModule>;
  readonly appRoot: string | undefined;
}): Effect.fn.Return<PluginSelection, PluginLoadError> {
  const { policy, appRoot } = input;
  const directories = pluginSelectionDirectories(policy, input.roots, appRoot);
  const resolution = yield* resolvePluginManifests({
    bundled: policy.discovery.bundled
      ? input.modules.map((module) => ({ manifest: module.manifest, source: "bundled" as const }))
      : [],
    explicit: policy.manifests.map((manifest) => ({
      manifest: manifest.manifest,
      source: "explicit" as const,
    })),
    directories: directories.filter((directory) => directory.source !== "app"),
    ...(policy.externalImports && policy.discovery.app && appRoot !== undefined ? { cwd: appRoot } : {}),
    disable: policy.discovery.disable,
  });
  const selected = [...new Set([...resolution.plugins, ...resolution.globalPlugins])];
  const entries = yield* Effect.forEach(
    selected.flatMap((plugin) => (plugin.path === undefined ? [] : [{ plugin, path: plugin.path }])),
    ({ plugin, path }) =>
      Effect.tryPromise(() => pluginImplementationIdentity(path)).pipe(
        Effect.map((implementation) => ({ plugin, implementation })),
        // An unresolvable entry is still a deterministic input; the graph reports the load failure.
        Effect.orElseSucceed(() => ({
          plugin,
          implementation: undefined,
        })),
      ),
    { concurrency: READ_CONCURRENCY },
  );
  const inputs = yield* Effect.forEach(directories, directoryInputs, { concurrency: READ_CONCURRENCY });
  const fingerprint = new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        appRoot: appRoot ?? null,
        discovery: policy.discovery,
        externalImports: policy.externalImports,
        bundled: input.modules.map((module) => [module.manifest.name, module.manifest.version]),
        explicit: policy.manifests.map((manifest) => manifest.manifest),
        directories: inputs,
        entries: entries.map((entry) => [
          entry.plugin.source,
          entry.plugin.manifest.name,
          entry.implementation,
        ]),
        selected: selected.map((plugin) => [plugin.source, plugin.manifest]),
      }),
    )
    .digest("hex");
  return {
    resolution,
    fingerprint,
    implementations: entries.flatMap((entry) =>
      entry.implementation === undefined ? [] : [entry.implementation],
    ),
  };
});
