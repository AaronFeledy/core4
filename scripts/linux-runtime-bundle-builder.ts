import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { BundleCommandRunner } from "./assemble-runtime-bundle.ts";

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
  const imageVersion = /^FROM oven\/bun:([^@\s]+)@sha256:[0-9a-f]{64} AS bun$/mu.exec(dockerfile)?.[1];
  if (imageVersion !== bunVersion || runningVersion !== bunVersion) {
    throw new Error(
      `assemble-runtime-bundle: Bun pin mismatch (.bun-version=${bunVersion}, builder=${imageVersion ?? "missing"}, host=${runningVersion})`,
    );
  }
};

export const buildLinuxRuntimeBundle = async (options: {
  readonly hostKey: string;
  readonly outDir: string;
  readonly repository: string;
  readonly execute: BundleCommandRunner;
}): Promise<string> => {
  assertNativeLinuxBundle(options.hostKey);
  const bunVersion = (await readFile(join(repoRoot, ".bun-version"), "utf8")).trim();
  assertLinuxBuilderBunPin(await readFile(join(recipeRoot, "Dockerfile"), "utf8"), bunVersion, Bun.version);
  const context = await mkdtemp(join(tmpdir(), "rb-builder-"));
  let exportDir = "";
  let temporaryArtifact: string | undefined;
  let primaryFailure: { cause: unknown } | undefined;
  let outputArtifact: string | undefined;
  try {
    exportDir = await mkdtemp(join(tmpdir(), "rb-export-"));
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
    await options.execute([
      "docker",
      "buildx",
      "build",
      "--platform",
      options.hostKey === "linux-x64" ? "linux/amd64" : "linux/arm64",
      "--target",
      "bundle",
      "--output",
      `type=local,dest=${exportDir}`,
      "--build-arg",
      `BUNDLE_PLATFORM=${options.hostKey}`,
      "--build-arg",
      `REPOSITORY=${options.repository}`,
      "--file",
      join(context, "Dockerfile"),
      context,
    ]);
    const filename = `lando-runtime-${options.hostKey}.tar.gz`;
    const exportedArtifact = join(exportDir, filename);
    const artifactStat = await lstat(exportedArtifact);
    if (!artifactStat.isFile() || artifactStat.size === 0) throw new Error("Invalid runtime bundle export");
    await mkdir(options.outDir, { recursive: true });
    const artifactPath = join(options.outDir, filename);
    temporaryArtifact = join(options.outDir, `.${filename}.${randomUUID()}.tmp`);
    await copyFile(exportedArtifact, temporaryArtifact);
    await rename(temporaryArtifact, artifactPath);
    temporaryArtifact = undefined;
    outputArtifact = artifactPath;
  } catch (cause) {
    primaryFailure = { cause };
  }
  const cleanup = [
    rm(context, { recursive: true, force: true }),
    ...(exportDir === "" ? [] : [rm(exportDir, { recursive: true, force: true })]),
    ...(temporaryArtifact === undefined ? [] : [rm(temporaryArtifact, { force: true })]),
  ];
  const results = await Promise.allSettled(cleanup);
  const cleanupFailure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (primaryFailure !== undefined) throw primaryFailure.cause;
  if (cleanupFailure !== undefined) throw cleanupFailure.reason;
  if (outputArtifact === undefined)
    throw new Error("assemble-runtime-bundle: builder did not export an archive");
  return outputArtifact;
};
