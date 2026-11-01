import { rm } from "node:fs/promises";

import { Effect } from "effect";

import {
  InteractionRequiredError,
  NotImplementedError,
  PluginManifestError,
  PluginPackageOperationError,
} from "@lando/sdk/errors";
import { PluginTrustStore as PersistentPluginTrustStore } from "@lando/sdk/services";

import {
  type PluginAddResult,
  finalizePluginInstall,
  validatePluginManifest,
} from "@lando/engine/operations/plugin-install";
import { retainedRecipeSources } from "../../recipes/runtime-sources";
import { bunSelfInstall } from "./bun-self-runner";
import { failPluginNetworkPolicy, redactPluginPackageError } from "./plugin-package-error";
import { resolvePluginsRoot } from "./plugin-roots";

import { parseNpmPackageSpec } from "../../recipes/npm-source";
import type { PluginAddOptions } from "./plugin-add-options";
import { ensureTrust, globalTrustStore } from "./plugin-add-trust";
import {
  acquirePluginPackage,
  ensurePluginsRoot,
  packageDeclaresPostinstall,
} from "./plugin-package-acquisition";
export type { PluginAddOptions, PluginAddPrompter, PluginTrustStore } from "./plugin-add-options";
export { globalTrustStore } from "./plugin-add-trust";

const REGISTRY_NAME_RE = /^(@[^/]+\/)?[a-z0-9][a-z0-9._-]*(@[^/\s]+)?$/i;

const PLUGIN_ADD_COMMAND_ID = "meta:plugin:add" as const;

const equalRequirements = (
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined,
): boolean => {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
};

export const pluginAdd = Effect.fn("PluginAdd.add")(
  function* (inputOptions: PluginAddOptions) {
    const sources = yield* retainedRecipeSources(inputOptions.registryUrl);
    const options = {
      ...inputOptions,
      registryClient: inputOptions.registryClient ?? sources.npmRegistryClient,
      fetcher: inputOptions.fetcher ?? sources.tarballRecipeFetcher,
    };
    if (typeof options.spec !== "string" || options.spec.trim().length === 0) {
      return yield* Effect.fail(
        new NotImplementedError({
          message: "Plugin spec is required.",
          commandId: "meta:plugin:add",
          remediation: "Pass an npm package spec, e.g. `lando plugin:add @lando/plugin-php`.",
        }),
      );
    }
    if (!REGISTRY_NAME_RE.test(options.spec)) {
      return yield* Effect.fail(
        new NotImplementedError({
          message: `meta:plugin:add only supports npm registry specs (got ${options.spec}).`,
          commandId: "meta:plugin:add",
          remediation:
            "Git URL, tarball, and file: sources are not supported. Pass a registry spec like `@lando/plugin-php@1.0.0`.",
        }),
      );
    }

    const pluginsRoot = options.pluginsRoot ?? (yield* resolvePluginsRoot(options, "meta:plugin:add"));
    yield* Effect.promise(() => ensurePluginsRoot(pluginsRoot));

    const { name: packageName, version } = parseNpmPackageSpec(options.spec);
    const requestedSelector = options.requestedSelector ?? version ?? "latest";
    let createdPackageDir: string | undefined;
    let targetDir: string | undefined;
    const packageDir = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const installed = await acquirePluginPackage(options, pluginsRoot);
          if (installed.created) createdPackageDir = installed.stagingRoot;
          targetDir = installed.targetDir;
          return installed.packageDir;
        },
        catch: (cause) =>
          cause instanceof PluginManifestError || cause instanceof PluginPackageOperationError
            ? cause
            : new PluginPackageOperationError({
                message: "Could not prepare plugin acquisition.",
                commandId: PLUGIN_ADD_COMMAND_ID,
                operation: "resolve",
                packageSpec: options.spec,
                cwd: pluginsRoot,
                remediation: "Check the package specification and plugin directory permissions.",
              }),
      }),
      () =>
        Effect.promise(async () => {
          if (createdPackageDir !== undefined) await rm(createdPackageDir, { recursive: true, force: true });
        }),
    ).pipe(
      Effect.catchIf(
        (cause): cause is PluginPackageOperationError => cause instanceof PluginPackageOperationError,
        (cause) => redactPluginPackageError(cause).pipe(Effect.flip),
      ),
    );

    const { manifest } = yield* Effect.tryPromise({
      try: () => validatePluginManifest(packageDir),
      catch: (cause) =>
        cause instanceof PluginManifestError
          ? cause
          : new PluginManifestError({
              message: `Failed to validate plugin manifest: ${String(cause)}`,
              issues: [{ path: [], message: String(cause) }],
              remediation:
                "Check the plugin package.json and correct the reported manifest issues before adding it.",
            }),
    });
    if (
      options.expectedManifest !== undefined &&
      (manifest.name !== options.expectedManifest.name ||
        manifest.version !== options.expectedManifest.version ||
        !equalRequirements(manifest.requires, options.expectedManifest.requires))
    ) {
      const mismatchedPackageDir = createdPackageDir;
      if (mismatchedPackageDir !== undefined) {
        yield* Effect.promise(() => rm(mismatchedPackageDir, { recursive: true, force: true }));
      }
      return yield* Effect.fail(
        new PluginManifestError({
          message: `Extracted plugin manifest for ${manifest.name}@${manifest.version} does not match advertised npm metadata.`,
          pluginName: manifest.name,
          issues: [{ path: [], message: "name, version, and requires must match the registry packument" }],
          remediation: "Publish a package whose name, version, and requires match its npm registry metadata.",
        }),
      );
    }

    const hasPostinstall = yield* Effect.promise(() => packageDeclaresPostinstall(packageDir));
    const persistentStoreOption = yield* Effect.serviceOption(PersistentPluginTrustStore);
    const persistentStore = persistentStoreOption._tag === "Some" ? persistentStoreOption.value : undefined;
    const trustName = packageName;

    const trustStoreForRollback = options.trustStore ?? globalTrustStore;
    const hadTrustBefore = trustStoreForRollback.has(trustName);
    const trustSource = yield* Effect.tryPromise({
      try: async (): Promise<PluginAddResult["trustSource"]> => {
        if (hasPostinstall && options.trust !== true && options.expectedActivation === undefined) {
          if (trustStoreForRollback.has(trustName)) return "session";
          if (
            persistentStore !== undefined &&
            (await Effect.runPromise(persistentStore.isPluginTrusted(trustName)))
          ) {
            trustStoreForRollback.add(trustName);
            return "persistent";
          }
          return "untrusted";
        }
        return ensureTrust({ packageName: trustName, manifestName: manifest.name }, options, persistentStore);
      },
      catch: (cause) =>
        cause instanceof NotImplementedError || cause instanceof InteractionRequiredError
          ? cause
          : new NotImplementedError({
              message: `Unexpected trust failure: ${String(cause)}`,
              commandId: "meta:plugin:add",
              remediation: "Re-run with --trust to bypass the prompt.",
            }),
    });

    if (hasPostinstall && trustSource !== "untrusted" && createdPackageDir !== undefined) {
      const postinstallExit = yield* bunSelfInstall({
        cwd: packageDir,
        callerSubsystem: `plugin-install:meta:plugin:add:${manifest.name}`,
      }).pipe(
        Effect.tapError(() =>
          Effect.promise(async () => {
            if (createdPackageDir !== undefined)
              await rm(createdPackageDir, { recursive: true, force: true });
            if (!hadTrustBefore && trustSource !== "session") trustStoreForRollback.delete(trustName);
          }),
        ),
        Effect.catchTag("BunChildNetworkPolicyError", (error) =>
          failPluginNetworkPolicy(error, {
            commandId: PLUGIN_ADD_COMMAND_ID,
            packageSpec: options.spec,
            cwd: packageDir,
          }),
        ),
      );
      if (postinstallExit.exitCode !== 0) {
        const failedPackageDir = createdPackageDir;
        if (failedPackageDir !== undefined) {
          yield* Effect.promise(() => rm(failedPackageDir, { recursive: true, force: true }));
        }
        if (!hadTrustBefore && trustSource !== "session") trustStoreForRollback.delete(trustName);
        return yield* Effect.fail(
          yield* redactPluginPackageError(
            new PluginPackageOperationError({
              message: `Trusted plugin postinstall failed for ${options.spec}.`,
              remediation:
                "Resolve the underlying postinstall error and retry `lando plugin:add` with --trust.",
              commandId: PLUGIN_ADD_COMMAND_ID,
              operation: "postinstall",
              packageSpec: options.spec,
              cwd: packageDir,
              exitCode: postinstallExit.exitCode,
              ...(postinstallExit.mode === "collected"
                ? {}
                : { detail: "Child output was already shown above." }),
            }),
            postinstallExit.mode === "collected" ? postinstallExit : undefined,
          ),
        );
      }
    }

    yield* finalizePluginInstall({
      pluginsRoot,
      entry: {
        name: manifest.name,
        version: manifest.version,
        path: targetDir ?? packageDir,
        requestedSelector,
      },
      ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
      ...(options.expectedActivation === undefined ? {} : { expectedActivation: options.expectedActivation }),
      ...(options.expectedRegistry === undefined ? {} : { expectedRegistry: options.expectedRegistry }),
      expectedManifest: manifest,
      ...(targetDir === undefined ? {} : { stagedPath: packageDir }),
    }).pipe(
      Effect.tapCause(() =>
        Effect.promise(async () => {
          if (createdPackageDir !== undefined) await rm(createdPackageDir, { recursive: true, force: true });
          if (!hadTrustBefore && trustSource !== "session" && trustSource !== "untrusted") {
            trustStoreForRollback.delete(trustName);
          }
        }),
      ),
    );

    return {
      pluginName: manifest.name,
      pluginVersion: manifest.version,
      trustName,
      pluginsRoot,
      entry: targetDir ?? packageDir,
      trusted: trustSource !== "untrusted",
      trustSource,
    };
  },
  Effect.scoped,
  Effect.map((result): PluginAddResult => result),
);

export const renderPluginAddResult = (result: PluginAddResult): string =>
  `installed: ${result.pluginName}@${result.pluginVersion}\ntrusted: ${result.trustSource}\nplugins-root: ${result.pluginsRoot}${
    result.trusted
      ? ""
      : `\nremediation: run \`lando meta:plugin:trust ${result.trustName}\` to allow the plugin postinstall path.`
  }`;
