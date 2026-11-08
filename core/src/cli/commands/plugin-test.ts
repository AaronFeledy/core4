import { DateTime, Effect, Schema } from "effect";

import { PluginManifestError } from "@lando/sdk/errors";

import { validatePluginManifest } from "@lando/engine/operations/plugin-install";
import { bunSelfRun } from "./bun-self-runner";
import { publishOptionalEvent } from "./optional-event-publish";
import { resolvePluginPackageRoot } from "./plugin-package-root";

export interface PluginTestOptions {
  readonly argv?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly execPath?: string;
}

export interface PluginTestResult {
  readonly pluginName: string;
  readonly pluginRoot: string;
  readonly argv: ReadonlyArray<string>;
  readonly exitCode: number;
}

export const PluginTestResultSchema = Schema.Struct({
  pluginName: Schema.String,
  pluginRoot: Schema.String,
  argv: Schema.Array(Schema.String),
  exitCode: Schema.Number,
});

const splitPluginTestArgv = (
  argv: ReadonlyArray<string>,
): { readonly paths: ReadonlyArray<string>; readonly forwarded: ReadonlyArray<string> } => {
  const dash = argv.indexOf("--");
  if (dash === -1) return { paths: argv, forwarded: [] };
  return { paths: argv.slice(0, dash), forwarded: argv.slice(dash + 1) };
};

export const pluginTest = Effect.fn("PluginTest.test")(function* (options: PluginTestOptions = {}) {
  const pluginRoot = yield* resolvePluginPackageRoot(options.cwd, "meta:plugin:test");
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
  const { paths, forwarded } = splitPluginTestArgv(options.argv ?? []);
  const argv = ["test", ...paths, ...forwarded];
  const callerSubsystem = `plugin-authoring:meta:plugin:test:${manifest.name}`;
  yield* publishOptionalEvent({
    _tag: "cli-meta:plugin:test-start",
    pluginName: manifest.name,
    pluginRoot,
    argv,
    timestamp: DateTime.formatIso(yield* DateTime.now),
  });
  const result = yield* bunSelfRun({
    argv,
    cwd: pluginRoot,
    verb: "test",
    callerSubsystem,
    ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
  });
  yield* publishOptionalEvent({
    _tag: "cli-meta:plugin:test-complete",
    pluginName: manifest.name,
    pluginRoot,
    argv,
    exitCode: result.exitCode,
    timestamp: DateTime.formatIso(yield* DateTime.now),
  });
  const completed: PluginTestResult = {
    pluginName: manifest.name,
    pluginRoot,
    argv,
    exitCode: result.exitCode,
  };
  return completed;
});

export const renderPluginTestResult = (result: PluginTestResult): string =>
  [
    `plugin-test: ${result.pluginName}`,
    `command: bun ${result.argv.join(" ")}`,
    `result: ${result.exitCode === 0 ? "passed" : `failed (exit ${result.exitCode})`}`,
  ].join("\n");
