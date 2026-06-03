import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { Effect, Either, Schema } from "effect";

import {
  type ConfigError,
  type LandoCommandError,
  NotImplementedError,
  PluginManifestError,
} from "@lando/sdk/errors";
import { PluginManifest } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

import { createStdioPromptIO } from "../../recipes/prompts/io.ts";

export interface PluginAddSpawner {
  readonly install: (request: {
    readonly spec: string;
    readonly cwd: string;
  }) => Promise<{
    readonly exitCode: number;
    readonly stderr: string;
    readonly packageRoot: string;
  }>;
}

export interface PluginAddPrompter {
  readonly confirmTrust: (request: {
    readonly pluginName: string;
    readonly spec: string;
  }) => Promise<boolean>;
}

export type PluginTrustStore = Set<string>;

export const globalTrustStore: PluginTrustStore = new Set<string>();

export interface PluginAddOptions {
  readonly spec: string;
  readonly trust?: boolean;
  readonly nonInteractive?: boolean;
  readonly pluginsRoot?: string;
  readonly userDataRoot?: string;
  readonly spawner?: PluginAddSpawner;
  readonly prompter?: PluginAddPrompter;
  readonly trustStore?: PluginTrustStore;
}

export interface PluginAddResult {
  readonly pluginName: string;
  readonly pluginVersion: string;
  readonly pluginsRoot: string;
  readonly entry: string;
  readonly trusted: boolean;
  readonly trustSource: "flag" | "prompt" | "session";
}

const REGISTRY_NAME_RE = /^(@[^/]+\/)?[a-z0-9][a-z0-9._-]*(@[^/\s]+)?$/i;

const trustNonInteractiveError = (spec: string): NotImplementedError =>
  new NotImplementedError({
    message: "Plugin trust prompt cannot run non-interactively without --trust.",
    commandId: "meta:plugin:add",
    specSection: "spec/10-plugins.md",
    remediation: `Re-run \`lando plugin:add ${spec} --trust\` to confirm the plugin should run as trusted host code. Persistent trust storage is deferred to Beta.`,
  });

const trustRejectedError = (pluginName: string): NotImplementedError =>
  new NotImplementedError({
    message: `User declined to trust plugin ${pluginName}.`,
    commandId: "meta:plugin:add",
    specSection: "spec/10-plugins.md",
    remediation: "Re-run with --trust if you intend to trust the plugin as host code.",
  });

const installFailure = (spec: string, stderr: string): NotImplementedError =>
  new NotImplementedError({
    message: `BunSelfExecError: bun add failed for ${spec}.`,
    commandId: "meta:plugin:add",
    specSection: "spec/10-plugins.md",
    remediation: `Resolve the underlying bun error and retry:\n${stderr.trim()}`,
  });

const ensurePluginsRoot = async (root: string): Promise<void> => {
  await mkdir(root, { recursive: true });
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) {
    await writeFile(
      pkgPath,
      `${JSON.stringify(
        { name: "lando-plugin-root", private: true, version: "0.0.0", description: "Managed by Lando." },
        null,
        2,
      )}\n`,
    );
  }
};

const parsePackageName = (spec: string): string => {
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash === -1) return spec;
    const after = spec.slice(slash + 1);
    const at = after.indexOf("@");
    return at === -1 ? spec : `${spec.slice(0, slash + 1)}${after.slice(0, at)}`;
  }
  const at = spec.indexOf("@");
  return at === -1 ? spec : spec.slice(0, at);
};

const decodePackageJson = (content: string, packageDir: string): PluginManifest => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    throw new PluginManifestError({
      message: `package.json in ${packageDir} is not valid JSON.`,
      issues: [(cause as Error).message],
    });
  }
  const candidate = (parsed as { landoPlugin?: unknown })?.landoPlugin ?? parsed;
  const decoded = Schema.decodeUnknownEither(PluginManifest)(candidate);
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

const verifyContainment = async (manifest: PluginManifest, packageDir: string): Promise<string> => {
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
): Promise<{ readonly manifest: PluginManifest; readonly entry: string }> => {
  const content = await readFile(join(packageDir, "package.json"), "utf8");
  const manifest = decodePackageJson(content, packageDir);
  const entry = await verifyContainment(manifest, packageDir);
  return { manifest, entry };
};

const defaultSpawner: PluginAddSpawner = {
  install: async ({ spec, cwd }) => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "add", spec],
      cwd,
      env: {
        ...(Object.fromEntries(
          Object.entries(process.env).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>),
        BUN_BE_BUN: "1",
        LANDO_DISALLOW_BUN_BE_BUN_REENTRY: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    const packageName = parsePackageName(spec);
    return { exitCode, stderr, packageRoot: join(cwd, "node_modules", packageName) };
  },
};

const defaultPrompter: PluginAddPrompter = {
  confirmTrust: async ({ pluginName }) => {
    const io = createStdioPromptIO();
    if (!io.isTTY) return false;
    io.write(
      `Plugin ${pluginName} will run as TRUSTED HOST CODE.\nTrust this plugin for the current Lando session? [y/N] `,
    );
    const line = (await io.readLine()).trim().toLowerCase();
    return line === "y" || line === "yes";
  },
};

const ensureTrust = async (
  manifest: PluginManifest,
  options: PluginAddOptions,
): Promise<"flag" | "prompt" | "session"> => {
  const store = options.trustStore ?? globalTrustStore;
  if (store.has(manifest.name)) return "session";
  if (options.trust === true) {
    store.add(manifest.name);
    return "flag";
  }
  if (options.nonInteractive === true) {
    throw trustNonInteractiveError(options.spec);
  }
  const prompter = options.prompter ?? defaultPrompter;
  const ok = await prompter.confirmTrust({ pluginName: manifest.name, spec: options.spec });
  if (!ok) throw trustRejectedError(manifest.name);
  store.add(manifest.name);
  return "prompt";
};

export const pluginAdd = (
  options: PluginAddOptions,
): Effect.Effect<
  PluginAddResult,
  ConfigError | LandoCommandError | NotImplementedError | PluginManifestError,
  ConfigService
> =>
  Effect.gen(function* () {
    if (typeof options.spec !== "string" || options.spec.trim().length === 0) {
      return yield* Effect.fail(
        new NotImplementedError({
          message: "Plugin spec is required.",
          commandId: "meta:plugin:add",
          specSection: "spec/10-plugins.md",
          remediation: "Pass an npm package spec, e.g. `lando plugin:add @lando/plugin-php`.",
        }),
      );
    }
    if (!REGISTRY_NAME_RE.test(options.spec)) {
      return yield* Effect.fail(
        new NotImplementedError({
          message: `meta:plugin:add only supports npm registry specs in Alpha (got ${options.spec}).`,
          commandId: "meta:plugin:add",
          specSection: "spec/10-plugins.md",
          remediation:
            "Git URL, tarball, and file: source kinds land in Beta. Pass a registry spec like `@lando/plugin-php@1.0.0`.",
        }),
      );
    }

    let pluginsRoot = options.pluginsRoot;
    if (pluginsRoot === undefined) {
      let userDataRoot = options.userDataRoot;
      if (userDataRoot === undefined) {
        const configService = yield* ConfigService;
        userDataRoot = yield* configService.get("userDataRoot");
        if (userDataRoot === undefined) {
          return yield* Effect.fail(
            new NotImplementedError({
              message: "userDataRoot is not configured.",
              commandId: "meta:plugin:add",
              specSection: "spec/10-plugins.md",
              remediation: "Configure userDataRoot in <userConfRoot>/config.yml.",
            }),
          );
        }
      }
      pluginsRoot = join(userDataRoot, "plugins");
    }
    yield* Effect.promise(() => ensurePluginsRoot(pluginsRoot));

    const spawner = options.spawner ?? defaultSpawner;
    const installed = yield* Effect.promise(() => spawner.install({ spec: options.spec, cwd: pluginsRoot }));
    if (installed.exitCode !== 0) {
      return yield* Effect.fail(installFailure(options.spec, installed.stderr));
    }

    const packageName = parsePackageName(options.spec);
    const packageDir = installed.packageRoot ?? join(pluginsRoot, "node_modules", packageName);

    const { manifest } = yield* Effect.tryPromise({
      try: () => validatePluginManifest(packageDir),
      catch: (cause) =>
        cause instanceof PluginManifestError
          ? cause
          : new PluginManifestError({
              message: `Failed to validate plugin manifest: ${String(cause)}`,
              issues: [String(cause)],
            }),
    });

    const trustSource = yield* Effect.tryPromise({
      try: () => ensureTrust(manifest, options),
      catch: (cause) =>
        cause instanceof NotImplementedError
          ? cause
          : new NotImplementedError({
              message: `Unexpected trust failure: ${String(cause)}`,
              commandId: "meta:plugin:add",
              specSection: "spec/10-plugins.md",
              remediation: "Re-run with --trust to bypass the prompt.",
            }),
    });

    return {
      pluginName: manifest.name,
      pluginVersion: manifest.version,
      pluginsRoot,
      entry: packageDir,
      trusted: true,
      trustSource,
    };
  });

export const renderPluginAddResult = (result: PluginAddResult): string =>
  `installed: ${result.pluginName}@${result.pluginVersion}\ntrusted: ${result.trustSource}\nplugins-root: ${result.pluginsRoot}`;
