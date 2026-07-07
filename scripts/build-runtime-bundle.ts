#!/usr/bin/env bun
/**
 * Runtime-bundle manifest generator for `@lando/provider-lando`.
 *
 * `--local` mode stages per-platform bundle artifacts and emits a manifest with
 * `file://` URLs plus locally-computed SHA-256 values. CI points
 * `LANDO_RUNTIME_BUNDLE_MANIFEST` at that manifest so `lando setup` exercises
 * the real download-and-verify path against a bundle built from the current
 * commit (spec §13.5). Verification stays enforced against the computed
 * checksum — the override redirects verification, it never disables it (§5.8.1).
 *
 * Default (release) mode reads staged artifacts plus the pinned upstream base
 * URL and emits the committed `https://` manifest. Both modes share one builder.
 *
 * This runs outside `LandoRuntimeLive`, so it MAY touch the filesystem directly;
 * it is build tooling, not production source.
 */
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface RuntimeBundleTarget {
  readonly key: string;
  readonly filename: string;
}

export interface RuntimeBundleManifestEntry {
  readonly url: string;
  readonly sha256: string;
  readonly filename: string;
  readonly sizeBytes: number;
}

export interface RuntimeBundleManifest {
  readonly schemaVersion: 1;
  readonly runtimeVersion: string;
  readonly bundles: Record<string, RuntimeBundleManifestEntry>;
}

export const RUNTIME_BUNDLE_TARGETS: ReadonlyArray<RuntimeBundleTarget> = [
  { key: "linux-x64", filename: "lando-runtime-linux-x64.tar.gz" },
  { key: "linux-arm64", filename: "lando-runtime-linux-arm64.tar.gz" },
  { key: "darwin-x64", filename: "lando-runtime-darwin-x64.tar.gz" },
  { key: "darwin-arm64", filename: "lando-runtime-darwin-arm64.tar.gz" },
  { key: "win32-x64", filename: "lando-runtime-win32-x64.zip" },
];

const PROVIDER_DIR = resolve(import.meta.dir, "..", "plugins", "provider-lando");
const VERSION_FILE = join(PROVIDER_DIR, "runtime-bundle-version");
const COMMITTED_MANIFEST = join(PROVIDER_DIR, "runtime-bundle-versions.json");
const DEFAULT_STAGING_DIR = resolve(import.meta.dir, "..", "dist", "cache", "runtime-bundle");

/** Fallback host slug when the publishing workflow does not export `GITHUB_REPOSITORY` (spec §13.5). */
export const LANDO_RUNTIME_BUNDLE_REPOSITORY_DEFAULT = "lando-community/core4";

export const resolveRuntimeBundleRepository = (
  env: Record<string, string | undefined> = process.env,
): string => {
  const repository = env.GITHUB_REPOSITORY;
  return repository !== undefined && repository.length > 0
    ? repository
    : LANDO_RUNTIME_BUNDLE_REPOSITORY_DEFAULT;
};

export const releaseBundleBaseUrl = (runtimeVersion: string, repository: string): string =>
  `https://github.com/${repository}/releases/download/runtime-v${runtimeVersion}`;

export interface ReleaseBundleUrlOptions {
  readonly runtimeVersion: string;
  readonly repository: string;
  readonly baseUrl?: string;
}

export const releaseBundleUrl = (target: RuntimeBundleTarget, options: ReleaseBundleUrlOptions): string => {
  const base = options.baseUrl ?? releaseBundleBaseUrl(options.runtimeVersion, options.repository);
  return `${base.replace(/\/+$/u, "")}/${target.filename}`;
};

export const computeBundleEntry = async (
  artifactPath: string,
  url: string,
): Promise<RuntimeBundleManifestEntry> => {
  const bytes = await readFile(artifactPath);
  return {
    url,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    filename: basename(artifactPath),
    sizeBytes: bytes.byteLength,
  };
};

export interface BuildManifestOptions {
  readonly stagingDir: string;
  readonly runtimeVersion: string;
  readonly targets: ReadonlyArray<RuntimeBundleTarget>;
  readonly urlFor: (target: RuntimeBundleTarget, artifactPath: string) => string;
}

export const buildRuntimeBundleManifest = async (
  options: BuildManifestOptions,
): Promise<RuntimeBundleManifest> => {
  const bundles: Record<string, RuntimeBundleManifestEntry> = {};
  for (const target of options.targets) {
    const artifactPath = join(options.stagingDir, target.filename);
    const exists = await stat(artifactPath).then(
      (info) => info.isFile(),
      () => false,
    );
    if (!exists) continue;
    bundles[target.key] = await computeBundleEntry(artifactPath, options.urlFor(target, artifactPath));
  }
  return { schemaVersion: 1, runtimeVersion: options.runtimeVersion, bundles };
};

const readRuntimeVersion = async (override?: string): Promise<string> => {
  if (override !== undefined && override.length > 0) return override;
  const raw = await readFile(VERSION_FILE, "utf8").catch(() => "0.0.0\n");
  return raw.trim();
};

interface CliArgs {
  readonly local: boolean;
  readonly stagingDir: string;
  readonly out?: string;
  readonly platform?: string;
  readonly baseUrl?: string;
  readonly runtimeVersion?: string;
}

const parseArgs = (argv: ReadonlyArray<string>): CliArgs => {
  let local = false;
  let stagingDir = DEFAULT_STAGING_DIR;
  let out: string | undefined;
  let platform: string | undefined;
  let baseUrl: string | undefined;
  let runtimeVersion: string | undefined;
  const nextValue = (index: number): string => {
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`build-runtime-bundle: ${argv[index]} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--local") {
      local = true;
    } else if (arg === "--staging") {
      stagingDir = resolve(nextValue(i));
      i += 1;
    } else if (arg === "--out") {
      out = resolve(nextValue(i));
      i += 1;
    } else if (arg === "--platform") {
      platform = nextValue(i);
      i += 1;
    } else if (arg === "--base-url") {
      baseUrl = nextValue(i);
      i += 1;
    } else if (arg === "--runtime-version") {
      runtimeVersion = nextValue(i);
      i += 1;
    } else {
      throw new Error(`build-runtime-bundle: unknown argument ${arg}`);
    }
  }
  return {
    local,
    stagingDir,
    ...(out === undefined ? {} : { out }),
    ...(platform === undefined ? {} : { platform }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(runtimeVersion === undefined ? {} : { runtimeVersion }),
  };
};

const selectTargets = (platform: string | undefined): ReadonlyArray<RuntimeBundleTarget> => {
  if (platform === undefined) return RUNTIME_BUNDLE_TARGETS;
  const target = RUNTIME_BUNDLE_TARGETS.find((candidate) => candidate.key === platform);
  if (target === undefined) {
    throw new Error(`build-runtime-bundle: unsupported --platform ${platform}`);
  }
  return [target];
};

const main = async (argv: ReadonlyArray<string>): Promise<void> => {
  const args = parseArgs(argv);
  const runtimeVersion = await readRuntimeVersion(args.runtimeVersion);
  const targets = selectTargets(args.platform);

  const repository = resolveRuntimeBundleRepository();
  const urlFor = args.local
    ? (_target: RuntimeBundleTarget, artifactPath: string): string => pathToFileURL(artifactPath).href
    : (target: RuntimeBundleTarget): string =>
        releaseBundleUrl(target, {
          runtimeVersion,
          repository,
          ...(args.baseUrl === undefined ? {} : { baseUrl: args.baseUrl }),
        });

  const manifest = await buildRuntimeBundleManifest({
    stagingDir: args.stagingDir,
    runtimeVersion,
    targets,
    urlFor,
  });
  if (Object.keys(manifest.bundles).length === 0) {
    throw new Error(`build-runtime-bundle: no staged artifacts found under ${args.stagingDir}`);
  }

  const outPath =
    args.out ?? (args.local ? join(args.stagingDir, "runtime-bundle-versions.json") : COMMITTED_MANIFEST);
  await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${outPath}\n`);
};

if (import.meta.main) {
  main(process.argv.slice(2)).catch((cause) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
