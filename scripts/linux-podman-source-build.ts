import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { BundleCommandRunner } from "./assemble-runtime-bundle.ts";

export { type InspectCommandRunner, verifyLinuxPodmanPortability } from "./linux-podman-portability.ts";

import {
  LinuxAardvarkDnsSourceBuild,
  LinuxNetavarkSourceBuild,
  LinuxPasstSourceBuild,
  type RuntimeBundleBinaryComponent,
  type RuntimeBundleComponent,
  type RuntimeBundleSourcePatch,
  isLinuxRuntimeBundle,
  runtimeBundlePatchPath,
  sourcePatchesOf,
} from "./runtime-bundle-sources.ts";

export const PodmanSourceBuild = {
  gitCommit: "4cabbe61fa3a27fafc4a3ee1226e38ae1664ae57",
  sourceDateEpoch: "1783532707",
  goflags: "-trimpath -buildvcs=false",
  extraLdflags: "-buildid=",
  /** Shown as `podman version` Build Origin when Lando's carried patches are applied. */
  patchedBuildOrigin: "lando-runtime (patched)",
} as const;

const PodmanSourceBuildOutputs = [
  { source: "bin/podman", installName: "bin/podman", mode: 0o755 },
  { source: "bin/rootlessport", installName: "bin/rootlessport", mode: 0o755 },
] as const;

const fileSha256 = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

const fileExists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

/**
 * Applies `patches` in order with zero fuzz. Each patch file must match its pinned SHA-256, every
 * file it modifies must match its pinned pre-image, every file it creates must be absent, and every
 * touched file must match its pinned post-image afterwards.
 */
export const applyVerifiedSourcePatches = async (options: {
  readonly sourceDir: string;
  readonly patches: readonly RuntimeBundleSourcePatch[];
  readonly execute: BundleCommandRunner;
}): Promise<void> => {
  for (const patch of options.patches) {
    const patchPath = runtimeBundlePatchPath(patch);
    const patchSha256 = await fileSha256(patchPath);
    if (patchSha256 !== patch.sha256) {
      throw new Error(
        `assemble-runtime-bundle: patch SHA-256 mismatch for ${patch.file}: expected ${patch.sha256}, received ${patchSha256}`,
      );
    }
    for (const file of patch.files) {
      const path = join(options.sourceDir, file.path);
      if (file.sourceSha256 === undefined) {
        if (await fileExists(path)) {
          throw new Error(
            `assemble-runtime-bundle: ${patch.file} creates ${file.path}, which already exists`,
          );
        }
        continue;
      }
      const sourceSha256 = await fileSha256(path);
      if (sourceSha256 !== file.sourceSha256) {
        throw new Error(
          `assemble-runtime-bundle: source SHA-256 mismatch before patching ${file.path}: expected ${file.sourceSha256}, received ${sourceSha256}`,
        );
      }
    }
    await options.execute(
      ["patch", "--batch", "--forward", "--fuzz=0", "--reject-file=-", "-p1", "-i", patchPath],
      options.sourceDir,
    );
    for (const file of patch.files) {
      const patchedSha256 = await fileSha256(join(options.sourceDir, file.path));
      if (patchedSha256 !== file.patchedSha256) {
        throw new Error(
          `assemble-runtime-bundle: patched source SHA-256 mismatch for ${file.path}: expected ${file.patchedSha256}, received ${patchedSha256}`,
        );
      }
    }
  }
};

interface LinuxHelperSourceBuildOptions {
  readonly component: RuntimeBundleComponent;
  readonly artifactPaths: ReadonlyMap<string, string>;
  readonly stageDir: string;
  readonly execute: BundleCommandRunner;
}

const sourceDirName = (component: RuntimeBundleComponent): string => `${component.name}-${component.version}`;

const inputPath = (paths: ReadonlyMap<string, string>, name: string): string => {
  const path = paths.get(name);
  if (path === undefined) throw new Error(`assemble-runtime-bundle: missing source-build input ${name}`);
  return path;
};

const installOutput = async (
  sourceDir: string,
  stageDir: string,
  output: { readonly source: string; readonly installName: string; readonly mode: number },
): Promise<void> => {
  const bytes = await readFile(join(sourceDir, output.source)).catch((cause: unknown) => {
    throw new Error(`assemble-runtime-bundle: missing Linux source-build output ${output.source}`, { cause });
  });
  const destPath = join(stageDir, output.installName);
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, bytes);
  await chmod(destPath, output.mode);
};

export const buildLinuxHelperFromSource = async (options: LinuxHelperSourceBuildOptions): Promise<void> => {
  if (!("inputs" in options.component)) {
    throw new Error(
      `assemble-runtime-bundle: ${options.component.name} does not declare source-build inputs`,
    );
  }
  const workDir = await mkdtemp(join(tmpdir(), `rb-${options.component.name}-src-`));
  try {
    await options.execute(["tar", "-xf", inputPath(options.artifactPaths, "source"), "-C", workDir]);
    const sourceDir = join(workDir, sourceDirName(options.component));
    await applyVerifiedSourcePatches({
      sourceDir,
      patches: sourcePatchesOf(options.component),
      execute: options.execute,
    });
    if (
      options.component.sourceBuild === LinuxNetavarkSourceBuild ||
      options.component.sourceBuild === LinuxAardvarkDnsSourceBuild
    ) {
      await options.execute(["tar", "-xzf", inputPath(options.artifactPaths, "vendor"), "-C", sourceDir]);
      await mkdir(join(sourceDir, ".cargo"), { recursive: true });
      // rustc embeds absolute source paths; remap the random work dir so rebuilds are byte-identical.
      const rustflags = ["-C", "link-arg=-Wl,--build-id=none", "--remap-path-prefix", `${workDir}=/build`];
      await writeFile(
        join(sourceDir, ".cargo", "config.toml"),
        `[source.crates-io]\nreplace-with = "vendored-sources"\n\n[source.vendored-sources]\ndirectory = "vendor"\n\n[net]\noffline = true\n\n[build]\nrustflags = ${JSON.stringify(rustflags)}\n`,
      );
      await options.execute(
        ["env", "SOURCE_DATE_EPOCH=0", "cargo", "build", "--release", "--locked", "--offline"],
        sourceDir,
      );
    } else if (options.component.sourceBuild === LinuxPasstSourceBuild) {
      await options.execute(["make", "passt", "pasta", "SOURCE_DATE_EPOCH=0"], sourceDir);
    } else {
      throw new Error(
        `assemble-runtime-bundle: unsupported Linux source build ${options.component.sourceBuild}`,
      );
    }
    for (const output of options.component.outputs) {
      await installOutput(sourceDir, options.stageDir, output);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};

export const buildLinuxPodmanFromSource = async (
  component: RuntimeBundleBinaryComponent,
  artifactPath: string,
  stageDir: string,
  execute: BundleCommandRunner,
): Promise<void> => {
  const workDir = await mkdtemp(join(tmpdir(), "rb-podman-src-"));
  try {
    await execute(["tar", "-xzf", artifactPath, "-C", workDir]);
    const sourceDir = join(workDir, `podman-${component.version}`);
    const patches = sourcePatchesOf(component);
    await applyVerifiedSourcePatches({ sourceDir, patches, execute });
    await execute(
      [
        "make",
        "bin/podman",
        "bin/rootlessport",
        `GIT_COMMIT=${PodmanSourceBuild.gitCommit}`,
        `SOURCE_DATE_EPOCH=${PodmanSourceBuild.sourceDateEpoch}`,
        "CGO_ENABLED=1",
        `GOFLAGS=${PodmanSourceBuild.goflags}`,
        "BUILDTAGS=grpcnotrace libsqlite3 systemd seccomp containers_image_openpgp",
        `EXTRA_LDFLAGS=${PodmanSourceBuild.extraLdflags}`,
        ...(patches.length > 0 ? [`BUILD_ORIGIN=${PodmanSourceBuild.patchedBuildOrigin}`] : []),
      ],
      sourceDir,
    );
    for (const output of PodmanSourceBuildOutputs) {
      const builtPath = join(sourceDir, output.source);
      const bytes = await readFile(builtPath).catch((cause: unknown) => {
        throw new Error(`assemble-runtime-bundle: missing Linux Podman source-build output ${builtPath}`, {
          cause,
        });
      });
      const installName = output.source === "bin/podman" ? component.installName : output.installName;
      const destPath = join(stageDir, installName);
      await mkdir(dirname(destPath), { recursive: true });
      await writeFile(destPath, bytes);
      await chmod(destPath, output.source === "bin/podman" ? component.mode : output.mode);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
};

export const verifyManagedLinuxPodman = async (
  hostKey: string,
  stageDir: string,
  execute: BundleCommandRunner,
): Promise<void> => {
  if (!isLinuxRuntimeBundle(hostKey)) return;

  const verifyDir = await mkdtemp(join(tmpdir(), "rb-verify-"));
  try {
    const storageDir = join(verifyDir, "storage");
    const runrootDir = join(verifyDir, "runroot");
    const configDir = join(verifyDir, "config");
    const socketPath = join(verifyDir, "podman.sock");
    await mkdir(storageDir, { recursive: true });
    await mkdir(runrootDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await execute([
      join(stageDir, "bin", "podman"),
      "--root",
      storageDir,
      "--runroot",
      runrootDir,
      "--config",
      configDir,
      "--storage-opt",
      `overlay.mount_program=${join(stageDir, "bin", "fuse-overlayfs")}`,
      "system",
      "service",
      "--time=0",
      `unix://${socketPath}`,
      "--help",
    ]);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `assemble-runtime-bundle: Linux Podman managed-service verifier failed for ${hostKey}: ${detail}`,
      { cause },
    );
  } finally {
    await rm(verifyDir, { recursive: true, force: true });
  }
};
