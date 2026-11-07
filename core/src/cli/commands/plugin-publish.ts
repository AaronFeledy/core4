import { join } from "node:path";

import { DateTime, Effect, Schema } from "effect";

import { RedactionService } from "@lando/redaction/service";
import { PluginManifestError, RecipeSourceError } from "@lando/sdk/errors";

import { validatePluginManifest } from "@lando/engine/operations/plugin-install";
import { hostConfigReadPolicy } from "@lando/engine/services/config";
import { type NpmRegistryConfig, loadNpmRegistryConfig } from "../../recipes/npm-registry-config";
import { publishWithCredential } from "./npm-publish-runner";
import { publishOptionalEvent } from "./optional-event-publish";
import { pluginBuild } from "./plugin-build";
import { isArtifactStale, listOutputs, outputDirectoryExists } from "./plugin-build-files";
import { entriesFromExports, readPackageJson } from "./plugin-build-package";
import { resolvePluginPackageRoot } from "./plugin-package-root";
import { pluginTest } from "./plugin-test";

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
  readonly npmConfig?: () => Promise<NpmRegistryConfig>;
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

  const readPolicy = yield* hostConfigReadPolicy;
  const npmConfig = yield* Effect.tryPromise({
    try: () => (options.npmConfig ?? (() => loadNpmRegistryConfig(readPolicy)))(),
    catch: (cause) =>
      cause instanceof RecipeSourceError
        ? cause
        : new PluginPublishValidationError({
            message: "Could not read npm user configuration.",
            remediation: "Check your npm user config file permissions and retry.",
          }),
  });
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (redaction._tag === "Some") yield* redaction.value.registerValues(npmConfig.redactionTokens);
  const publishConfig = pkg.publishConfig;
  const packageRegistry =
    typeof publishConfig === "object" &&
    publishConfig !== null &&
    "registry" in publishConfig &&
    typeof publishConfig.registry === "string"
      ? publishConfig.registry
      : undefined;
  const registry =
    options.registry ??
    packageRegistry ??
    npmConfig.registryFor(typeof pkg.name === "string" ? pkg.name : manifest.name);
  const registryUrl = URL.parse(registry);
  if (registryUrl !== null && (registryUrl.username !== "" || registryUrl.password !== "")) {
    return yield* Effect.fail(
      new PluginPublishValidationError({
        message: "Publish registry URLs must not contain credentials.",
        remediation:
          "Remove URL userinfo and move credentials to the registry's nerf-key _authToken, _auth, or username plus _password fields in npm user configuration.",
      }),
    );
  }
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
    if (registryUrl?.protocol !== "http:" && registryUrl?.protocol !== "https:") {
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
      const credential = npmConfig.credentialFor(registry, registry);
      if (credential === undefined) {
        return yield* Effect.fail(
          new PluginPublishAuthError({
            message: `No registry auth for ${registry} in ${npmConfig.path}.`,
            remediation: npmConfig.authRemediation(registry),
            registry,
          }),
        );
      }
      const publish = yield* publishWithCredential(
        credential,
        { registry, packageName: typeof pkg.name === "string" ? pkg.name : manifest.name, tag },
        {
          cwd: join(pluginRoot, "dist"),
          verb: "publish",
          callerSubsystem: `plugin-authoring:meta:plugin:publish:${manifest.name}`,
          ...bunOptions,
        },
      );
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

export { renderPluginPublishResult } from "./plugin-publish-render";
