import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { LinuxBundleBuildEngine } from "./linux-runtime-bundle-engines.ts";
import { runWithCleanup } from "./runtime-bundle-cleanup.ts";

const repoRoot = resolve(import.meta.dir, "..");
const recipeRoot = join(repoRoot, "scripts", "runtime-bundle-builder");

export const assertNativeLinuxBundle = (
  hostKey: string,
  platform: string = process.platform,
  arch: string = process.arch,
): void => {
  if (platform !== "linux" || !["x64", "arm64"].includes(arch) || hostKey !== `linux-${arch}`) {
    throw new Error(
      `assemble-runtime-bundle: ${hostKey} requires a native ${hostKey} builder; got ${platform}-${arch}`,
    );
  }
};

export const assertLinuxBuilderBunPin = (
  dockerfile: string,
  bunVersion: string,
  runningVersion: string,
): void => {
  const pinnedImage = /^FROM oven\/bun:\$\{BUN_VERSION\}@sha256:[0-9a-f]{64} AS bun$/mu.test(dockerfile);
  const imageVersion = pinnedImage ? /^ARG BUN_VERSION=(\S+)$/mu.exec(dockerfile)?.[1] : undefined;
  if (imageVersion !== bunVersion || runningVersion !== bunVersion) {
    throw new Error(
      `assemble-runtime-bundle: Bun pin mismatch (.bun-version=${bunVersion}, builder=${imageVersion ?? "missing"}, host=${runningVersion})`,
    );
  }
};

interface LinuxRuntimeBundleBuildArgs {
  readonly hostKey: string;
  readonly repository: string;
}

export const buildxPlatform = (hostKey: string): string =>
  hostKey === "linux-x64" ? "linux/amd64" : "linux/arm64";

const buildArgs = (options: LinuxRuntimeBundleBuildArgs): ReadonlyArray<string> => [
  `BUNDLE_PLATFORM=${options.hostKey}`,
  `REPOSITORY=${options.repository}`,
];

/** Writes the complete BuildKit context: the bundled entry plus every file it reads at build time. */
const stageLinuxRuntimeBundleContext = async (context: string): Promise<void> => {
  const scriptsDir = join(context, "scripts");
  await mkdir(join(scriptsDir, "patches"), { recursive: true });
  const result = await Bun.build({
    entrypoints: [join(recipeRoot, "entry.ts")],
    outdir: scriptsDir,
    naming: "entry.js",
    target: "bun",
  });
  if (!result.success) throw new AggregateError(result.logs, "Cannot bundle runtime builder entry");
  for (const name of ["Dockerfile", "prerequisites.sh"]) {
    await copyFile(join(recipeRoot, name), join(context, name));
  }
  const sources = "plugins/provider-lando/runtime-bundle-sources.json";
  await mkdir(dirname(join(context, sources)), { recursive: true });
  await copyFile(join(repoRoot, sources), join(context, sources));
  const patch = "netavark-v2.0.0-systemd-user-bus.patch";
  await copyFile(join(repoRoot, "scripts", "patches", patch), join(scriptsDir, "patches", patch));
};

/** SHA-256 over the platform, build arguments, and every staged context file's path and bytes. */
export const linuxRuntimeBundleContextDigest = async (
  context: string,
  options: LinuxRuntimeBundleBuildArgs,
): Promise<string> => {
  const hash = createHash("sha256");
  for (const field of [buildxPlatform(options.hostKey), ...buildArgs(options)]) hash.update(`${field}\0`);
  for (const path of (await readdir(context, { recursive: true })).sort()) {
    if (!(await lstat(join(context, path))).isFile()) continue;
    const bytes = await readFile(join(context, path));
    hash.update(`${path}\0${bytes.byteLength}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
};

/** Actions cache key for an assembled Linux bundle: identical inputs to `docker buildx build` share a key. */
export const linuxRuntimeBundleCacheKey = async (options: LinuxRuntimeBundleBuildArgs): Promise<string> => {
  const context = await mkdtemp(join(tmpdir(), "rb-builder-"));
  try {
    await stageLinuxRuntimeBundleContext(context);
    return `runtime-bundle-${options.hostKey}-${await linuxRuntimeBundleContextDigest(context, options)}`;
  } finally {
    await rm(context, { recursive: true, force: true });
  }
};

export const buildLinuxRuntimeBundle = async (options: {
  readonly hostKey: string;
  readonly outDir: string;
  readonly repository: string;
  readonly engine: LinuxBundleBuildEngine;
}): Promise<string> => {
  const bunVersion = (await readFile(join(repoRoot, ".bun-version"), "utf8")).trim();
  assertLinuxBuilderBunPin(await readFile(join(recipeRoot, "Dockerfile"), "utf8"), bunVersion, Bun.version);
  const filename = `lando-runtime-${options.hostKey}.tar.gz`;
  const context = await mkdtemp(join(tmpdir(), "rb-builder-"));
  let exportDir = "";
  let temporaryArtifact: string | undefined;
  return runWithCleanup(
    async () => {
      exportDir = await mkdtemp(join(tmpdir(), "rb-export-"));
      await stageLinuxRuntimeBundleContext(context);
      await options.engine.build({
        context,
        platform: buildxPlatform(options.hostKey),
        buildArgs: buildArgs(options),
        exportDir,
        artifactName: filename,
      });
      const exportedArtifact = join(exportDir, filename);
      const artifactStat = await lstat(exportedArtifact);
      if (!artifactStat.isFile() || artifactStat.size === 0) throw new Error("Invalid runtime bundle export");
      await mkdir(options.outDir, { recursive: true });
      const artifactPath = join(options.outDir, filename);
      temporaryArtifact = join(options.outDir, `.${filename}.${randomUUID()}.tmp`);
      await copyFile(exportedArtifact, temporaryArtifact);
      await rename(temporaryArtifact, artifactPath);
      temporaryArtifact = undefined;
      return artifactPath;
    },
    () => [
      rm(context, { recursive: true, force: true }),
      ...(exportDir === "" ? [] : [rm(exportDir, { recursive: true, force: true })]),
      ...(temporaryArtifact === undefined ? [] : [rm(temporaryArtifact, { force: true })]),
    ],
  );
};
