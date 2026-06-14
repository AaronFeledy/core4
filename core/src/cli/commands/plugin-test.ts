import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { Effect } from "effect";

import { type NotImplementedError, PluginManifestError } from "@lando/sdk/errors";
import { EventService } from "@lando/sdk/services";

import { type BunSelfSpawner, bunSelfRun } from "./bun-self-runner.ts";
import { validatePluginManifest } from "./plugin-add.ts";

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

const splitPluginTestArgv = (
  argv: ReadonlyArray<string>,
): { readonly paths: ReadonlyArray<string>; readonly forwarded: ReadonlyArray<string> } => {
  const dash = argv.indexOf("--");
  if (dash === -1) return { paths: argv, forwarded: [] };
  return { paths: argv.slice(0, dash), forwarded: argv.slice(dash + 1) };
};

const isMissingPathError = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { readonly code?: unknown }).code === "ENOENT";

const parsePackageJson = async (packagePath: string): Promise<Readonly<Record<string, unknown>>> => {
  const raw = await readFile(packagePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PluginManifestError({
      message: `package.json in ${dirname(packagePath)} must contain a JSON object.`,
      issues: ["Expected a package object."],
    });
  }
  return parsed as Readonly<Record<string, unknown>>;
};

const looksLikePluginPackage = (pkg: Readonly<Record<string, unknown>>): boolean => {
  if ("landoPlugin" in pkg) return true;
  // PluginManifest schema: `api` is Literal(4) and `entry` is optional (defaulted).
  if (pkg.api === 4 && typeof pkg.name === "string") return true;
  const keywords = pkg.keywords;
  return Array.isArray(keywords) && keywords.some((entry) => entry === "lando-plugin");
};

const findNearestPackageRoot = async (cwd: string): Promise<string> => {
  let current = resolve(cwd);
  while (true) {
    const packagePath = join(current, "package.json");
    const packageStat = await stat(packagePath).catch((cause: unknown) => {
      if (isMissingPathError(cause)) return undefined;
      throw cause;
    });
    if (packageStat?.isFile() === true) {
      const pkg = await parsePackageJson(packagePath);
      if (looksLikePluginPackage(pkg)) return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new PluginManifestError({
        message: `No plugin package.json found from ${resolve(cwd)}.`,
        issues: ["Run meta:plugin:test from inside a Lando plugin package."],
      });
    }
    current = parent;
  }
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
      try: () => findNearestPackageRoot(cwd),
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
