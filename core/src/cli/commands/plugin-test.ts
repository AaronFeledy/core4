import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { Effect, Either, Schema } from "effect";

import { type NotImplementedError, PluginManifestError } from "@lando/sdk/errors";
import { PluginManifest, type PluginManifest as PluginManifestShape } from "@lando/sdk/schema";
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

const parsePackageJson = async (
  packagePath: string,
): Promise<Readonly<Record<string, unknown>> | undefined> => {
  const raw = await readFile(packagePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Readonly<Record<string, unknown>>;
};

const manifestPathFromPackage = (pkg: Readonly<Record<string, unknown>>): string | undefined => {
  const lando = pkg.lando;
  if (typeof lando !== "object" || lando === null || Array.isArray(lando)) return undefined;
  const manifest = (lando as { readonly manifest?: unknown }).manifest;
  return typeof manifest === "string" && manifest.trim() !== "" ? manifest : undefined;
};

const looksLikePluginPackage = (pkg: Readonly<Record<string, unknown>>): boolean => {
  if ("landoPlugin" in pkg) return true;
  // PluginManifest schema: `api` is Literal(4) and `entry` is optional (defaulted).
  if (pkg.api === 4 && typeof pkg.name === "string") return true;
  if (manifestPathFromPackage(pkg) !== undefined) return true;
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
      if (pkg !== undefined && looksLikePluginPackage(pkg)) return current;
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

const normalizeLegacyContributionRefs = (values: unknown): unknown => {
  if (!Array.isArray(values)) return values;
  return values.map((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const id = (value as { readonly id?: unknown }).id;
    return typeof id === "string" ? id : value;
  });
};

const normalizeManifestCandidate = (
  candidate: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => {
  const provides = candidate.provides;
  const contributes =
    candidate.contributes ??
    (typeof provides === "object" && provides !== null && !Array.isArray(provides)
      ? Object.fromEntries(
          Object.entries(provides).map(([key, value]) => [key, normalizeLegacyContributionRefs(value)]),
        )
      : undefined);
  return {
    ...("name" in candidate ? { name: candidate.name } : {}),
    ...("version" in candidate ? { version: candidate.version } : {}),
    ...("api" in candidate ? { api: candidate.api } : {}),
    ...("description" in candidate ? { description: candidate.description } : {}),
    ...("enabled" in candidate ? { enabled: candidate.enabled } : {}),
    ...("bundled" in candidate ? { bundled: candidate.bundled } : {}),
    ...("deprecated" in candidate ? { deprecated: candidate.deprecated } : {}),
    ...(contributes === undefined ? {} : { contributes }),
    ...("entry" in candidate ? { entry: candidate.entry } : {}),
    ...("requires" in candidate ? { requires: candidate.requires } : {}),
  };
};

const stripYamlQuotes = (value: string): string => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const parseYamlScalar = (raw: string): unknown => {
  const value = stripYamlQuotes(raw);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/u.test(value)) return Number(value);
  return value;
};

const parsePluginManifestYaml = (content: string): Readonly<Record<string, unknown>> => {
  const manifest: Record<string, unknown> = {};
  const requires: Record<string, string> = {};
  let inRequires = false;
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const topLevel = line.match(/^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/u);
    if (topLevel !== null) {
      const [, key, rawValue = ""] = topLevel as [string, string, string?];
      inRequires = key === "requires" && rawValue.trim() === "";
      if (rawValue.trim() !== "") manifest[key] = parseYamlScalar(rawValue);
      continue;
    }
    if (inRequires) {
      const nested = line.match(/^\s+(.+?):\s*(.+)$/u);
      if (nested !== null) {
        const [, key, rawValue] = nested as [string, string, string];
        requires[stripYamlQuotes(key)] = String(parseYamlScalar(rawValue));
      }
    }
  }
  if (Object.keys(requires).length > 0) manifest.requires = requires;
  return manifest;
};

const decodeManifestCandidate = (
  candidate: Readonly<Record<string, unknown>>,
  sourcePath: string,
): PluginManifestShape => {
  const decoded = Schema.decodeUnknownEither(PluginManifest)(normalizeManifestCandidate(candidate), {
    onExcessProperty: "error",
  });
  if (Either.isLeft(decoded)) {
    throw new PluginManifestError({
      message: `Plugin manifest validation failed in ${sourcePath}.`,
      issues: [String(decoded.left)],
    });
  }
  return decoded.right;
};

const readManifestFile = async (manifestPath: string): Promise<PluginManifestShape> => {
  const content = await readFile(manifestPath, "utf8");
  const parsed = manifestPath.endsWith(".json")
    ? (JSON.parse(content) as unknown)
    : parsePluginManifestYaml(content);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PluginManifestError({
      message: `Plugin manifest in ${manifestPath} must contain an object.`,
      issues: ["Expected a plugin manifest object."],
    });
  }
  return decodeManifestCandidate(parsed as Readonly<Record<string, unknown>>, manifestPath);
};

const validatePluginTestManifest = async (
  pluginRoot: string,
): Promise<{ readonly manifest: PluginManifestShape }> => {
  const packagePath = join(pluginRoot, "package.json");
  const pkg = await parsePackageJson(packagePath);
  if (pkg === undefined) {
    throw new PluginManifestError({
      message: `package.json in ${pluginRoot} is not valid plugin package metadata.`,
      issues: ["Expected a JSON object package file."],
    });
  }
  if ("landoPlugin" in pkg || (pkg.api === 4 && typeof pkg.name === "string")) {
    const { manifest } = await validatePluginManifest(pluginRoot);
    return { manifest };
  }
  const declaredManifest = manifestPathFromPackage(pkg);
  const candidates =
    declaredManifest === undefined ? ["plugin.yaml", "plugin.yml", "plugin.json"] : [declaredManifest];
  for (const candidate of candidates) {
    const manifestPath = resolve(pluginRoot, candidate);
    const manifestStat = await stat(manifestPath).catch((cause: unknown) => {
      if (isMissingPathError(cause)) return undefined;
      throw cause;
    });
    if (manifestStat?.isFile() === true) return { manifest: await readManifestFile(manifestPath) };
  }
  throw new PluginManifestError({
    message: `No plugin manifest found in ${pluginRoot}.`,
    issues: [
      "Expected package.json#landoPlugin, package.json with api: 4, package.json#lando.manifest, or plugin.yaml.",
    ],
  });
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
      try: () => validatePluginTestManifest(pluginRoot),
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
