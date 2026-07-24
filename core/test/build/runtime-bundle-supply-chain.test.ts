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
const renderReleaseWorkflow = async (): Promise<string> =>
  Bun.$`bun -e ${'import { renderReleaseWorkflow } from "./scripts/build-release-workflow.ts"; process.stdout.write(renderReleaseWorkflow());'}`
    .cwd(repoRoot)
    .text();
const renderPrerequisiteScript = async (): Promise<string> =>
  Bun.$`bun -e ${'import { RUNTIME_BUNDLE_UBUNTU_PREREQUISITE_SCRIPT } from "./scripts/runtime-bundle-supply-chain.ts"; process.stdout.write(RUNTIME_BUNDLE_UBUNTU_PREREQUISITE_SCRIPT.replaceAll("          ", ""));'}`
    .cwd(repoRoot)
    .text();
const actionReferences = (workflow: string): ReadonlyArray<string> =>
  Array.from(workflow.matchAll(/^\s*(?:-\s+)?uses:\s+(\S+)/gmu)).flatMap((match) => {
    const actionReference = match[1];
    return actionReference === undefined ? [] : [actionReference];
  });

const runPrerequisiteScript = async (aptCacheBody: string, installedVersion: string): Promise<number> => {
  const fakeBin = await mkdtemp(resolve(tmpdir(), "runtime-bundle-apt-"));
  const writeCommand = async (name: string, body: string): Promise<void> => {
    const path = resolve(fakeBin, name);
    await Bun.write(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
  };

  try {
    await writeCommand("sudo", 'if [ "$1" = "tee" ]; then cat >/dev/null; fi');
    await writeCommand("dpkg-query", `printf '${installedVersion}\\n'`);
    await writeCommand("apt-cache", aptCacheBody);
    const child = Bun.spawn(["bash", "-c", await renderPrerequisiteScript()], {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });

    return await child.exited;
  } finally {
    await rm(fakeBin, { force: true, recursive: true });
  }
};

describe("runtime-bundle workflow supply chain", () => {
  test("pins every action to an immutable commit", async () => {
    const workflow = await renderWorkflow();
    const references = actionReferences(workflow);

    expect(references).toHaveLength(10);
    for (const actionReference of references) {
      expect(actionReference).toMatch(actionReferencePattern);
    }
  });

  test("pins every closely related release action to an immutable commit", async () => {
    const references = actionReferences(await renderReleaseWorkflow());

    expect(references).toHaveLength(5);
    for (const actionReference of references) {
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
    expect(workflow).toMatch(/PACKAGES=.*\bpatch\b/u);
    for (const obsoletePackage of ["libassuan-dev", "libgpg-error-dev", "libgpgme-dev"]) {
      expect(workflow).not.toContain(obsoletePackage);
    }
  });

  test("verifies package candidates without a pipefail SIGPIPE", async () => {
    const aptCacheBody = `cat <<'POLICY'
  Candidate: 1.0
  Version table:
 *** 1.0 500
        500 https://snapshot.ubuntu.com/ubuntu/20260701T000000Z noble/main amd64 Packages
POLICY
seq 1 100000`;

    expect(await runPrerequisiteScript(aptCacheBody, "1.0")).toBe(0);
  });

  test("rejects a live candidate when only another version comes from the snapshot", async () => {
    const aptCacheBody = `cat <<'POLICY'
  Candidate: 2.0
  Version table:
 *** 2.0 500
        500 http://archive.ubuntu.com/ubuntu noble-updates/main amd64 Packages
     1.0 100
        100 https://snapshot.ubuntu.com/ubuntu/20260701T000000Z noble/main amd64 Packages
POLICY`;

    expect(await runPrerequisiteScript(aptCacheBody, "2.0")).not.toBe(0);
  });

  test("keeps the generated runtime workflow drift-free", async () => {
    const committed = await Bun.file(resolve(repoRoot, ".github/workflows/runtime-bundle.yml")).text();

    expect(committed).toBe(await renderWorkflow());
  });
});
