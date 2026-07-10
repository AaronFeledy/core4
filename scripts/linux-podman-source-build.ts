import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { BundleCommandRunner } from "./assemble-runtime-bundle.ts";
import {
  LinuxAardvarkDnsSourceBuild,
  LinuxNetavarkSourceBuild,
  LinuxPasstSourceBuild,
  type RuntimeBundleBinaryComponent,
  type RuntimeBundleComponent,
  isLinuxRuntimeBundle,
} from "./runtime-bundle-sources.ts";

export const PodmanSourceBuild = {
  gitCommit: "4cabbe61fa3a27fafc4a3ee1226e38ae1664ae57",
  sourceDateEpoch: "1783532707",
  goflags: "-trimpath -buildvcs=false",
  extraLdflags: "-buildid=",
} as const;

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
    if (
      options.component.sourceBuild === LinuxNetavarkSourceBuild ||
      options.component.sourceBuild === LinuxAardvarkDnsSourceBuild
    ) {
      await options.execute(["tar", "-xzf", inputPath(options.artifactPaths, "vendor"), "-C", sourceDir]);
      await mkdir(join(sourceDir, ".cargo"), { recursive: true });
      await writeFile(
        join(sourceDir, ".cargo", "config.toml"),
        `[source.crates-io]\nreplace-with = "vendored-sources"\n\n[source.vendored-sources]\ndirectory = "vendor"\n\n[net]\noffline = true\n\n[build]\nrustflags = ["-C", "link-arg=-Wl,--build-id=none"]\n`,
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
    await execute(
      [
        "make",
        "bin/podman",
        `GIT_COMMIT=${PodmanSourceBuild.gitCommit}`,
        `SOURCE_DATE_EPOCH=${PodmanSourceBuild.sourceDateEpoch}`,
        `GOFLAGS=${PodmanSourceBuild.goflags}`,
        `EXTRA_LDFLAGS=${PodmanSourceBuild.extraLdflags}`,
      ],
      sourceDir,
    );
    const builtPath = join(sourceDir, "bin", "podman");
    const bytes = await readFile(builtPath).catch((cause: unknown) => {
      throw new Error(`assemble-runtime-bundle: missing Linux Podman source-build output ${builtPath}`, {
        cause,
      });
    });
    const destPath = join(stageDir, component.installName);
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, bytes);
    await chmod(destPath, component.mode);
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
