import { resolve } from "node:path";

import { Effect, Schema } from "effect";

import { type NotImplementedError, PluginManifestError } from "@lando/sdk/errors";
import { EventService } from "@lando/sdk/services";

import { type BunSelfSpawner, bunSelfRun } from "./bun-self-runner.ts";
import { validatePluginManifest } from "./plugin-add.ts";
import { findNearestPluginPackageRoot } from "./plugin-package-root.ts";

export interface PluginTestOptions {
  readonly argv?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly spawner?: BunSelfSpawner;
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

const publishPluginTestEvent = (event: Readonly<Record<string, unknown>>) =>
  Effect.serviceOption(EventService).pipe(
    Effect.flatMap((events) =>
      events._tag === "Some" ? events.value.publish(event as never).pipe(Effect.ignore) : Effect.void,
    ),
  );

export const pluginTest = (
  options: PluginTestOptions = {},
): Effect.Effect<PluginTestResult, NotImplementedError | PluginManifestError> =>
  Effect.gen(function* () {
    const cwd = options.cwd ?? process.cwd();
    const pluginRoot = yield* Effect.tryPromise({
      try: () => findNearestPluginPackageRoot(cwd, "meta:plugin:test"),
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
    const { paths, forwarded } = splitPluginTestArgv(options.argv ?? []);
    const argv = ["test", ...paths, ...forwarded];
    const callerSubsystem = `plugin-authoring:meta:plugin:test:${manifest.name}`;
    yield* publishPluginTestEvent({
      _tag: "cli-meta:plugin:test-start",
      pluginName: manifest.name,
      pluginRoot,
      argv,
      timestamp: new Date().toISOString(),
    });
    const result = yield* bunSelfRun({
      argv,
      cwd: pluginRoot,
      verb: "test",
      callerSubsystem,
      ...(options.spawner === undefined ? {} : { spawner: options.spawner }),
      ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
    });
    yield* publishPluginTestEvent({
      _tag: "cli-meta:plugin:test-complete",
      pluginName: manifest.name,
      pluginRoot,
      argv,
      exitCode: result.exitCode,
      timestamp: new Date().toISOString(),
    });
    return { pluginName: manifest.name, pluginRoot, argv, exitCode: result.exitCode };
  });

export const renderPluginTestResult = (result: PluginTestResult): string =>
  [
    `plugin-test: ${result.pluginName}`,
    `command: bun ${result.argv.join(" ")}`,
    `result: ${result.exitCode === 0 ? "passed" : `failed (exit ${result.exitCode})`}`,
  ].join("\n");
