import { readFile, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { Effect, Either, Schema } from "effect";

import { PluginManifestError } from "@lando/sdk/errors";
import { PluginManifest, type PluginManifest as PluginManifestShape } from "@lando/sdk/schema";

import { invalidatePluginCommandCache } from "../cache/command-index-writer";
import { type InstalledPluginRegistryEntry, recordInstalledPlugin } from "../plugins/installed-registry";

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
}

export const finalizePluginInstall = (options: FinalizePluginInstallOptions): Effect.Effect<void, never> =>
  Effect.promise(() => recordInstalledPlugin(options.pluginsRoot, options.entry)).pipe(
    Effect.zipRight(
      invalidatePluginCommandCache({
        ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
      }),
    ),
  );
