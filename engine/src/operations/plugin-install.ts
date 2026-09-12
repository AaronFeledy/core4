import { lstat, readFile, realpath, rename, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { Effect, Either, Schema } from "effect";

import { NotImplementedError, PluginManifestError } from "@lando/sdk/errors";
import { PluginManifest, type PluginManifest as PluginManifestShape } from "@lando/sdk/schema";

import { invalidatePluginCommandCache } from "../cache/command-index-writer";
import {
  type InstalledPluginRegistryEntry,
  readInstalledPluginRegistry,
  recordInstalledPlugin,
} from "../plugins/installed-registry";
import { withPluginMutationLock } from "../plugins/mutation-lock.ts";

export interface PluginAddResult {
  readonly pluginName: string;
  readonly pluginVersion: string;
  readonly trustName: string;
  readonly pluginsRoot: string;
  readonly entry: string;
  readonly trusted: boolean;
  readonly trustSource: "flag" | "persistent" | "prompt" | "session" | "untrusted";
}

export const PluginAddResultSchema = Schema.Struct({
  pluginName: Schema.String,
  pluginVersion: Schema.String,
  trustName: Schema.String,
  pluginsRoot: Schema.String,
  entry: Schema.String,
  trusted: Schema.Boolean,
  trustSource: Schema.Literal("flag", "persistent", "prompt", "session", "untrusted"),
});

const decodePackageJson = (content: string, packageDir: string): PluginManifestShape => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    throw new PluginManifestError({
      message: `package.json in ${packageDir} is not valid JSON.`,
      issues: [cause instanceof Error ? cause.message : String(cause)],
    });
  }
  const candidate = (parsed as { landoPlugin?: unknown })?.landoPlugin ?? parsed;
  const decoded = Schema.decodeUnknownEither(PluginManifest)(candidate, { onExcessProperty: "error" });
  if (Either.isLeft(decoded)) {
    const nameField = (parsed as { name?: unknown })?.name;
    const name = typeof nameField === "string" ? nameField : undefined;
    throw new PluginManifestError({
      message: `Plugin manifest validation failed${name === undefined ? "" : ` for ${name}`}.`,
      ...(name === undefined ? {} : { pluginName: name }),
      issues: [String(decoded.left)],
    });
  }
  return decoded.right;
};

const verifyContainment = async (manifest: PluginManifestShape, packageDir: string): Promise<string> => {
  const entryRel = manifest.entry ?? "index.js";
  const entryAbs = resolve(packageDir, entryRel);
  const rel = relative(packageDir, entryAbs);
  if (rel.startsWith("..") || resolve(packageDir, rel) !== entryAbs) {
    throw new PluginManifestError({
      message: `Plugin ${manifest.name} declares an entry path that escapes its package directory.`,
      pluginName: manifest.name,
      issues: [`entry ${entryRel} resolves outside ${packageDir}`],
    });
  }
  try {
    const realRoot = await realpath(packageDir);
    const realEntry = await realpath(entryAbs).catch(() => entryAbs);
    const realRel = relative(realRoot, realEntry);
    if (realRel.startsWith("..")) {
      throw new PluginManifestError({
        message: `Plugin ${manifest.name} entry resolves through symlink outside its package directory.`,
        pluginName: manifest.name,
        issues: [`realpath of entry escapes ${realRoot}`],
      });
    }
  } catch (cause) {
    if (cause instanceof PluginManifestError) throw cause;
  }
  return entryAbs;
};

export const validatePluginManifest = async (
  packageDir: string,
): Promise<{ readonly manifest: PluginManifestShape; readonly entry: string }> => {
  const content = await readFile(join(packageDir, "package.json"), "utf8");
  const manifest = decodePackageJson(content, packageDir);
  const entry = await verifyContainment(manifest, packageDir);
  return { manifest, entry };
};

export interface FinalizePluginInstallOptions {
  readonly pluginsRoot: string;
  readonly entry: InstalledPluginRegistryEntry;
  readonly cacheRoot?: string;
  readonly expectedActivation?: InstalledPluginRegistryEntry;
  readonly mutationLockHeld?: boolean;
  readonly stagedPath?: string;
}

export const finalizePluginInstall = (
  options: FinalizePluginInstallOptions,
): Effect.Effect<void, NotImplementedError> => {
  const finalize = Effect.gen(function* () {
    if (options.expectedActivation !== undefined) {
      const registry = yield* Effect.promise(() => readInstalledPluginRegistry(options.pluginsRoot));
      const current = registry[options.entry.name];
      const expected = options.expectedActivation;
      if (
        current === undefined ||
        current.version !== expected.version ||
        current.source !== expected.source ||
        current.path !== expected.path ||
        current.requestedSelector !== expected.requestedSelector ||
        current.linkedPath !== expected.linkedPath ||
        current.name !== expected.name
      ) {
        return yield* Effect.fail(
          new NotImplementedError({
            message: `Plugin ${options.entry.name} changed after update planning; refusing an implicit re-plan.`,
            commandId: "meta:update",
            remediation: "Run lando update again against the current installed plugin state.",
          }),
        );
      }
    }
    if (options.stagedPath !== undefined) {
      const stagedPath = options.stagedPath;
      yield* Effect.tryPromise({
        try: async () => {
          const exists = await lstat(options.entry.path).then(
            () => true,
            (cause: unknown) => {
              if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
              throw cause;
            },
          );
          if (exists) throw new Error("Published plugin version directories are immutable.");
          await rename(stagedPath, options.entry.path);
        },
        catch: (cause) =>
          new NotImplementedError({
            message: `Could not publish plugin ${options.entry.name}: ${String(cause)}`,
            commandId: "meta:plugin:add",
            remediation:
              "Keep the existing version directory intact and inspect the installed plugin state before retrying.",
          }),
      });
    }
    yield* Effect.promise(() => recordInstalledPlugin(options.pluginsRoot, options.entry)).pipe(
      Effect.onError(() =>
        options.stagedPath === undefined
          ? Effect.void
          : Effect.promise(() => rm(options.entry.path, { recursive: true, force: true })),
      ),
    );
  }).pipe(
    Effect.zipRight(
      invalidatePluginCommandCache({
        ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
      }),
    ),
  );
  return options.mutationLockHeld === true
    ? finalize
    : withPluginMutationLock(options.pluginsRoot, "meta:plugin:add", finalize);
};
