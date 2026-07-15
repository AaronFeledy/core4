import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const actionReferencePattern = /^[-\w]+\/[-\w]+@[0-9a-f]{40}$/u;
const repoRoot = resolve(import.meta.dirname, "../../..");
const renderWorkflow = async (): Promise<string> =>
  Bun.$`bun -e ${'import { renderRuntimeBundleWorkflow } from "./scripts/build-runtime-bundle-workflow.ts"; process.stdout.write(renderRuntimeBundleWorkflow());'}`
    .cwd(repoRoot)
    .text();
const renderPrerequisiteScript = async (): Promise<string> =>
  Bun.$`bun -e ${'import { RUNTIME_BUNDLE_UBUNTU_PREREQUISITE_SCRIPT } from "./scripts/runtime-bundle-supply-chain.ts"; process.stdout.write(RUNTIME_BUNDLE_UBUNTU_PREREQUISITE_SCRIPT.replaceAll("          ", ""));'}`
    .cwd(repoRoot)
    .text();

describe("runtime-bundle workflow supply chain", () => {
  test("pins every action to an immutable commit", async () => {
    const workflow = await renderWorkflow();
    const actionReferences = Array.from(
      workflow.matchAll(/^\s*(?:-\s+)?uses:\s+(\S+)/gmu),
      (match) => match[1],
    );

    expect(actionReferences).toHaveLength(10);
    for (const actionReference of actionReferences) {
      expect(actionReference).toMatch(actionReferencePattern);
    }
  });

  test("installs Ubuntu build prerequisites from one fixed snapshot", async () => {
    const workflow = await renderWorkflow();
    const snapshotConfig = workflow.indexOf("UBUNTU_SNAPSHOT=20260701T000000Z");
    const aptConfig = workflow.indexOf("APT::Snapshot", snapshotConfig);
    const packageIndex = workflow.indexOf("sudo apt-get update", aptConfig);
    const packageInstall = workflow.indexOf("sudo apt-get install", packageIndex);
    const packageVerification = workflow.indexOf(
      'test "$INSTALLED_VERSION" = "$CANDIDATE_VERSION"',
      packageInstall,
    );

    expect(snapshotConfig).toBeGreaterThan(-1);
    expect(aptConfig).toBeGreaterThan(snapshotConfig);
    expect(packageIndex).toBeGreaterThan(aptConfig);
    expect(packageInstall).toBeGreaterThan(packageIndex);
    expect(packageVerification).toBeGreaterThan(packageInstall);
    expect(workflow).toContain("--allow-downgrades --reinstall");
    expect(workflow).toContain("https://snapshot.ubuntu.com/ubuntu/$UBUNTU_SNAPSHOT");
  });

  test("verifies package candidates without a pipefail SIGPIPE", async () => {
    const fakeBin = await mkdtemp(resolve(tmpdir(), "runtime-bundle-apt-"));
    const writeCommand = async (name: string, body: string): Promise<void> => {
      const path = resolve(fakeBin, name);
      await Bun.write(path, `#!/bin/sh\n${body}\n`);
      await chmod(path, 0o755);
    };

    try {
      await writeCommand("sudo", 'if [ "$1" = "tee" ]; then cat >/dev/null; fi');
      await writeCommand("dpkg-query", "printf '1.0\\n'");
      await writeCommand(
        "apt-cache",
        "printf '  Candidate: 1.0\\n        500 https://snapshot.ubuntu.com/ubuntu/20260701T000000Z noble/main amd64 Packages\\n'; seq 1 100000",
      );

      const child = Bun.spawn(["bash", "-c", await renderPrerequisiteScript()], {
        cwd: repoRoot,
        env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(await child.exited).toBe(0);
    } finally {
      await rm(fakeBin, { force: true, recursive: true });
    }
  });

  test("keeps the generated runtime workflow drift-free", async () => {
    const committed = await Bun.file(resolve(repoRoot, ".github/workflows/runtime-bundle.yml")).text();

    expect(committed).toBe(await renderWorkflow());
  });
});
