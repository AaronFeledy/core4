import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { BundleCommandRunner, RuntimeBundleComponent } from "./assemble-runtime-bundle.ts";

export const LinuxPodmanSourceBuild = "podman-linux-native" as const;

export const PodmanSourceBuild = {
  gitCommit: "4cabbe61fa3a27fafc4a3ee1226e38ae1664ae57",
  sourceDateEpoch: "1783532707",
  goflags: "-trimpath -buildvcs=false",
  extraLdflags: "-buildid=",
} as const;

const linuxHostKeys = new Set(["linux-x64", "linux-arm64"]);

export const isLinuxRuntimeBundle = (hostKey: string): boolean => linuxHostKeys.has(hostKey);

export const validateLinuxPodmanSource = (hostKey: string, component: RuntimeBundleComponent): void => {
  if (!isLinuxRuntimeBundle(hostKey) || component.name !== "podman") return;
  if (component.url.includes("podman-remote-static")) {
    throw new Error(
      `assemble-runtime-bundle: Linux Podman must be source-built, not remote-static (${hostKey})`,
    );
  }
};

export const buildLinuxPodmanFromSource = async (
  component: RuntimeBundleComponent,
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
    const configPath = join(verifyDir, "containers.conf");
    await mkdir(storageDir, { recursive: true });
    await mkdir(runrootDir, { recursive: true });
    await writeFile(configPath, "");
    await execute([
      join(stageDir, "bin", "podman"),
      "--root",
      storageDir,
      "--runroot",
      runrootDir,
      "--config",
      configPath,
      "--storage-opt",
      `overlay.mount_program=${join(stageDir, "bin", "fuse-overlayfs")}`,
      "system",
      "service",
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
