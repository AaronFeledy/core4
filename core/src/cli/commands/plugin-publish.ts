import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Data, Effect } from "effect";

import { type NotImplementedError, PluginManifestError } from "@lando/sdk/errors";
import { EventService } from "@lando/sdk/services";

import { makeLandoPaths } from "../../config/paths.ts";
import { resolveUserDataRoot } from "../../config/roots.ts";
import { type BunSelfSpawner, bunSelfRun } from "./bun-self-runner.ts";
import { validatePluginManifest } from "./plugin-add.ts";
import { type PluginBuildMixedTreeError, listOutputs, outputDirectoryExists } from "./plugin-build-files.ts";
import { type PackageJson, entriesFromExports, readPackageJson } from "./plugin-build-package.ts";
import { pluginBuild } from "./plugin-build.ts";
import { findNearestPluginPackageRoot } from "./plugin-package-root.ts";
import { pluginTest } from "./plugin-test.ts";

const DEFAULT_PLUGIN_REGISTRY = "https://registry.npmjs.org/";

/** A publish artifact failed manifest, registry, or tag validation. */
export class PluginPublishValidationError extends Data.TaggedError("PluginPublishValidationError")<{
  readonly message: string;
  readonly remediation: string;
}> {}

/** Registry auth is missing for the resolved publish registry. */
export class PluginPublishAuthError extends Data.TaggedError("PluginPublishAuthError")<{
  readonly message: string;
  readonly remediation: string;
  readonly registry: string;
}> {}

export interface PluginRegistryAuth {
  readonly registries?: Readonly<Record<string, { readonly token?: unknown } | undefined>>;
}

export type PluginAuthReader = (authPath: string) => Promise<PluginRegistryAuth | undefined>;

export interface PluginPublishOptions {
  readonly cwd?: string;
  readonly tag?: string;
  readonly registry?: string;
  readonly dryRun?: boolean;
  readonly noTest?: boolean;
  readonly nonInteractive?: boolean;
  readonly spawner?: BunSelfSpawner;
  readonly execPath?: string;
  readonly userDataRoot?: string;
  readonly authReader?: PluginAuthReader;
}

export interface PluginPublishResult {
  readonly pluginName: string;
  readonly pluginRoot: string;
  readonly registry: string;
  readonly tag: string;
  readonly packageContents: ReadonlyArray<string>;
  readonly dryRun: boolean;
  readonly rebuilt: boolean;
  readonly tested: boolean;
  readonly published: boolean;
  readonly exitCode: number;
}

type PluginPublishError =
  | NotImplementedError
  | PluginManifestError
  | PluginBuildMixedTreeError
  | PluginPublishValidationError
  | PluginPublishAuthError;

const publishPluginPublishEvent = (event: Readonly<Record<string, unknown>>) =>
  Effect.serviceOption(EventService).pipe(
    Effect.flatMap((events) =>
      events._tag === "Some" ? events.value.publish(event as never).pipe(Effect.ignore) : Effect.void,
    ),
  );

const fileMtime = async (path: string): Promise<number | undefined> =>
  stat(path).then(
    (entry) => entry.mtimeMs,
    () => undefined,
  );

/**
 * An artifact is stale when `dist/package.json` (written last by the build) is
 * missing, or when package metadata or any source entrypoint is newer than that
 * marker.
 */
const isArtifactStale = async (pluginRoot: string, sources: ReadonlyArray<string>): Promise<boolean> => {
  const distMarker = await fileMtime(join(pluginRoot, "dist", "package.json"));
  if (distMarker === undefined) return true;
  const packageJsonMtime = await fileMtime(join(pluginRoot, "package.json"));
  if (packageJsonMtime !== undefined && packageJsonMtime > distMarker) return true;
  for (const source of sources) {
    const sourceMtime = await fileMtime(resolve(pluginRoot, source));
    if (sourceMtime !== undefined && sourceMtime > distMarker) return true;
  }
  return false;
};

const normalizeRegistry = (registry: string): string => registry.replace(/\/+$/, "");

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

const publishConfigRegistry = (pkg: PackageJson): string | undefined => {
  const config = (pkg as { readonly publishConfig?: unknown }).publishConfig;
  if (typeof config !== "object" || config === null || Array.isArray(config)) return undefined;
  const registry = (config as { readonly registry?: unknown }).registry;
  return typeof registry === "string" ? registry : undefined;
};

const defaultAuthReader: PluginAuthReader = async (authPath) => {
  let raw: string;
  try {
    raw = await readFile(authPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as PluginRegistryAuth;
  } catch {
    return undefined;
  }
};

const registryToken = (auth: PluginRegistryAuth | undefined, registry: string): string | undefined => {
  const registries = auth?.registries;
  if (typeof registries !== "object" || registries === null) return undefined;
  const target = normalizeRegistry(registry);
  for (const [key, value] of Object.entries(registries)) {
    if (normalizeRegistry(key) !== target) continue;
    const token = value?.token;
    if (typeof token !== "string") continue;
    const trimmed = token.trim();
    if (trimmed !== "") return trimmed;
  }
  return undefined;
};

export const pluginPublish = (
  options: PluginPublishOptions = {},
): Effect.Effect<PluginPublishResult, PluginPublishError> =>
  Effect.gen(function* () {
    const cwd = options.cwd ?? process.cwd();
    const dryRun = options.dryRun === true;
    const tag = options.tag ?? "latest";

    const pluginRoot = yield* Effect.tryPromise({
      try: () => findNearestPluginPackageRoot(cwd, "meta:plugin:publish"),
      catch: (cause) =>
        cause instanceof PluginManifestError
          ? cause
          : new PluginManifestError({
              message: `Unable to locate plugin root from ${resolve(cwd)}.`,
              issues: [String(cause)],
            }),
    });
    const { manifest } = yield* Effect.tryPromise({
      try: () => validatePluginManifest(pluginRoot),
      catch: (cause) =>
        cause instanceof PluginManifestError
          ? cause
          : new PluginManifestError({
              message: `Plugin manifest validation failed in ${pluginRoot}.`,
              issues: [String(cause)],
            }),
    });
    const pkg = yield* Effect.tryPromise({
      try: () => readPackageJson(pluginRoot),
      catch: (cause) =>
        cause instanceof PluginManifestError
          ? cause
          : new PluginManifestError({
              message: `Unable to read package.json in ${pluginRoot}.`,
              issues: [String(cause)],
            }),
    });
    const entries = yield* Effect.try({
      try: () => entriesFromExports(pluginRoot, pkg.exports),
      catch: (cause) =>
        cause instanceof PluginManifestError
          ? cause
          : new PluginManifestError({
              message: `Invalid package exports in ${pluginRoot}.`,
              issues: [String(cause)],
            }),
    });
    const bunOptions = {
      ...(options.spawner === undefined ? {} : { spawner: options.spawner }),
      ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
    };

    const registry = options.registry ?? publishConfigRegistry(pkg) ?? DEFAULT_PLUGIN_REGISTRY;
    yield* publishPluginPublishEvent({
      _tag: "cli-meta:plugin:publish-start",
      pluginName: manifest.name,
      pluginRoot,
      registry,
      tag,
      dryRun,
      timestamp: new Date().toISOString(),
    });

    const publishCompleteEvent = (published: boolean, exitCode: number) =>
      publishPluginPublishEvent({
        _tag: "cli-meta:plugin:publish-complete",
        pluginName: manifest.name,
        pluginRoot,
        registry,
        tag,
        dryRun,
        published,
        exitCode,
        timestamp: new Date().toISOString(),
      });

    return yield* Effect.gen(function* () {
      if (tag.trim() === "" || /\s/.test(tag)) {
        return yield* Effect.fail(
          new PluginPublishValidationError({
            message: `Invalid publish tag ${JSON.stringify(tag)} for ${manifest.name}.`,
            remediation: "Pass a non-empty `--tag` value without whitespace, e.g. `--tag=latest`.",
          }),
        );
      }
      if (!isHttpUrl(registry)) {
        return yield* Effect.fail(
          new PluginPublishValidationError({
            message: `Invalid publish registry ${JSON.stringify(registry)} for ${manifest.name}.`,
            remediation: "Pass an http(s) registry via `--registry` or package.json#publishConfig.registry.",
          }),
        );
      }

      const sources = entries.map((entry) => entry.source);
      const stale = yield* Effect.promise(() => isArtifactStale(pluginRoot, sources));
      let rebuilt = false;
      if (stale) {
        const build = yield* pluginBuild({
          cwd: pluginRoot,
          ...bunOptions,
        });
        rebuilt = true;
        if (build.exitCode !== 0) {
          return yield* Effect.fail(
            new PluginPublishValidationError({
              message: `Plugin build failed for ${manifest.name} (exit ${build.exitCode}).`,
              remediation: "Fix the build errors reported above and re-run `lando plugin:publish`.",
            }),
          );
        }
      }

      let tested = false;
      if (options.noTest !== true) {
        const test = yield* pluginTest({
          cwd: pluginRoot,
          ...bunOptions,
        });
        tested = true;
        if (test.exitCode !== 0) {
          return yield* Effect.fail(
            new PluginPublishValidationError({
              message: `Plugin tests failed for ${manifest.name} (exit ${test.exitCode}).`,
              remediation: "Fix the failing tests or pass `--no-test` to publish without retesting.",
            }),
          );
        }
      }

      const packageContents = (yield* Effect.promise(() => outputDirectoryExists(pluginRoot)))
        ? yield* Effect.promise(() => listOutputs(pluginRoot))
        : [];

      let published = false;
      let exitCode = 0;
      if (!dryRun) {
        const userDataRoot = options.userDataRoot ?? resolveUserDataRoot();
        const authPath = makeLandoPaths({ userDataRoot }).pluginAuthFile;
        const auth = yield* Effect.promise(() => (options.authReader ?? defaultAuthReader)(authPath));
        const token = registryToken(auth, registry);
        if (token === undefined) {
          return yield* Effect.fail(
            new PluginPublishAuthError({
              message: `No registry auth for ${registry} in ${authPath}.`,
              remediation: `Run \`lando plugin:login --registry ${registry}\` to store a publish token, then retry.`,
              registry,
            }),
          );
        }
        const publish = yield* bunSelfRun({
          argv: ["publish", "--tag", tag, "--registry", registry],
          cwd: join(pluginRoot, "dist"),
          env: { BUN_AUTH_TOKEN: token },
          verb: "publish",
          callerSubsystem: `plugin-authoring:meta:plugin:publish:${manifest.name}`,
          ...bunOptions,
        });
        exitCode = publish.exitCode;
        published = exitCode === 0;
      }

      yield* publishCompleteEvent(published, exitCode);

      return {
        pluginName: manifest.name,
        pluginRoot,
        registry,
        tag,
        packageContents,
        dryRun,
        rebuilt,
        tested,
        published,
        exitCode,
      };
    }).pipe(Effect.tapError(() => publishCompleteEvent(false, 1)));
  });

export const renderPluginPublishResult = (result: PluginPublishResult): string => {
  const outcome = result.dryRun
    ? "dry-run (no publish)"
    : result.published
      ? "published"
      : `failed (exit ${result.exitCode})`;
  return [
    `plugin-publish: ${result.pluginName}`,
    `registry: ${result.registry}`,
    `tag: ${result.tag}`,
    `contents: ${result.packageContents.join(", ")}`,
    "validation: ok",
    `result: ${outcome}`,
  ].join("\n");
};
