import { join } from "node:path";

import { DateTime, Effect, Schema } from "effect";

import { PluginManifestError } from "@lando/sdk/errors";

import { resolveUserDataRoot } from "@lando/engine/config/roots";
import { validatePluginManifest } from "@lando/engine/operations/plugin-install";
import { makeLandoPaths } from "@lando/paths";
import { bunSelfRun } from "./bun-self-runner";
import { publishOptionalEvent } from "./optional-event-publish";
import { pluginBuild } from "./plugin-build";
import { isArtifactStale, listOutputs, outputDirectoryExists } from "./plugin-build-files";
import { entriesFromExports, readPackageJson } from "./plugin-build-package";
import {
  type PluginAuthReader,
  defaultAuthReader,
  publishConfigRegistry,
  registryToken,
} from "./plugin-publish-auth";
export type { PluginAuthReader, PluginRegistryAuth } from "./plugin-publish-auth";
import { resolvePluginPackageRoot } from "./plugin-package-root";
import { pluginTest } from "./plugin-test";

const DEFAULT_PLUGIN_REGISTRY = "https://registry.npmjs.org/";

/** A publish artifact failed manifest, registry, or tag validation. */
export class PluginPublishValidationError extends Schema.TaggedError<PluginPublishValidationError>()(
  "PluginPublishValidationError",
  {
    message: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
  },
) {}

/** Registry auth is missing for the resolved publish registry. */
export class PluginPublishAuthError extends Schema.TaggedError<PluginPublishAuthError>()(
  "PluginPublishAuthError",
  {
    message: Schema.String,
    remediation: Schema.NonEmptyString.check(Schema.isPattern(/\S/u)),
    registry: Schema.String,
  },
) {}

export interface PluginPublishOptions {
  readonly cwd?: string;
  readonly tag?: string;
  readonly registry?: string;
  readonly dryRun?: boolean;
  readonly noTest?: boolean;
  readonly nonInteractive?: boolean;
  readonly execPath?: string;
  readonly userDataRoot?: string;
  readonly authReader?: PluginAuthReader;
}

export type PluginPublishResult = typeof PluginPublishResultSchema.Type;

export const PluginPublishResultSchema = Schema.Struct({
  pluginName: Schema.String,
  pluginRoot: Schema.String,
  registry: Schema.String,
  tag: Schema.String,
  packageContents: Schema.Array(Schema.String),
  dryRun: Schema.Boolean,
  rebuilt: Schema.Boolean,
  tested: Schema.Boolean,
  published: Schema.Boolean,
  exitCode: Schema.Number,
});

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

export const pluginPublish = Effect.fn("PluginPublish.publish")(function* (
  options: PluginPublishOptions = {},
) {
  const dryRun = options.dryRun === true;
  const tag = options.tag ?? "latest";

  const pluginRoot = yield* resolvePluginPackageRoot(options.cwd, "meta:plugin:publish");
  const { manifest } = yield* Effect.tryPromise({
    try: () => validatePluginManifest(pluginRoot),
    catch: (cause) =>
      cause instanceof PluginManifestError
        ? cause
        : new PluginManifestError({
            message: `Plugin manifest validation failed in ${pluginRoot}.`,
            issues: [{ path: [], message: String(cause) }],
            remediation: `Check package.json in ${pluginRoot} and correct the reported manifest issues.`,
          }),
  });
  const pkg = yield* Effect.tryPromise({
    try: () => readPackageJson(pluginRoot),
    catch: (cause) =>
      cause instanceof PluginManifestError
        ? cause
        : new PluginManifestError({
            message: `Unable to read package.json in ${pluginRoot}.`,
            issues: [{ path: [], message: String(cause) }],
            remediation: `Make package.json in ${pluginRoot} readable and valid JSON.`,
          }),
  });
  const entries = yield* Effect.try({
    try: () => entriesFromExports(pluginRoot, pkg.exports),
    catch: (cause) =>
      cause instanceof PluginManifestError
        ? cause
        : new PluginManifestError({
            message: `Invalid package exports in ${pluginRoot}.`,
            issues: [{ path: [], message: String(cause) }],
            remediation: "Correct package.json exports to point to files inside the plugin package.",
          }),
  });
  const bunOptions = {
    ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
  };

  const registry = options.registry ?? publishConfigRegistry(pkg) ?? DEFAULT_PLUGIN_REGISTRY;
  yield* publishOptionalEvent({
    _tag: "cli-meta:plugin:publish-start",
    pluginName: manifest.name,
    pluginRoot,
    registry,
    tag,
    dryRun,
    timestamp: DateTime.formatIso(yield* DateTime.now),
  });

  const publishCompleteEvent = Effect.fnUntraced(function* (published: boolean, exitCode: number) {
    yield* publishOptionalEvent({
      _tag: "cli-meta:plugin:publish-complete",
      pluginName: manifest.name,
      pluginRoot,
      registry,
      tag,
      dryRun,
      published,
      exitCode,
      timestamp: DateTime.formatIso(yield* DateTime.now),
    });
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

    const completed: PluginPublishResult = {
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
    return completed;
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
