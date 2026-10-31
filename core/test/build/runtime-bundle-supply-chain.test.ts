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

const runPrerequisiteScript = async (
  aptCacheBody: string,
  installedVersion: string,
  updateBody = "exit 0",
) => {
  const fakeBin = await mkdtemp(resolve(tmpdir(), "runtime-bundle-apt-"));
  const writeCommand = async (name: string, body: string): Promise<void> => {
    const path = resolve(fakeBin, name);
    await Bun.write(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
  };

  try {
    await Bun.write(resolve(fakeBin, "updates"), "");
    await Bun.write(resolve(fakeBin, "sleeps"), "");
    await Bun.write(resolve(fakeBin, "install-arguments"), "");
    await Bun.write(resolve(fakeBin, "verified-packages"), "");
    await writeCommand(
      "sudo",
      `if [ "$1" = "tee" ]; then
  cat >"$APT_TEST_ROOT/config"
elif [ "$1" = "apt-get" ] && [ "$2" = "update" ]; then
  shift 2
  printf '%s\\n' "$*" >>"$APT_TEST_ROOT/updates"
  ${updateBody}
elif [ "$1" = "apt-get" ] && [ "$2" = "install" ]; then
  printf '%s\\n' "$@" >"$APT_TEST_ROOT/install-arguments"
  touch "$APT_TEST_ROOT/installed"
fi`,
    );
    await writeCommand("sleep", `printf '%s\\n' "$1" >>"$APT_TEST_ROOT/sleeps"`);
    await writeCommand(
      "dpkg-query",
      `printf '%s\\n' "$3" >>"$APT_TEST_ROOT/verified-packages"\nprintf '${installedVersion}\\n'`,
    );
    await writeCommand("apt-cache", aptCacheBody);
    const child = Bun.spawn(["bash", "-c", await renderPrerequisiteScript()], {
      cwd: repoRoot,
      env: { ...process.env, APT_TEST_ROOT: fakeBin, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return {
      exitCode,
      output: stdout + stderr,
      config: await Bun.file(resolve(fakeBin, "config")).text(),
      updates: await Bun.file(resolve(fakeBin, "updates")).text(),
      sleeps: await Bun.file(resolve(fakeBin, "sleeps")).text(),
      installed: await Bun.file(resolve(fakeBin, "installed")).exists(),
      installArguments: (await Bun.file(resolve(fakeBin, "install-arguments")).text()).split("\n"),
      verifiedPackages: (await Bun.file(resolve(fakeBin, "verified-packages")).text()).split("\n"),
    };
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

    expect(references).toHaveLength(2);
    for (const actionReference of references) {
      expect(actionReference).toMatch(actionReferencePattern);
    }
  });

  test("installs Ubuntu build prerequisites from one fixed snapshot", async () => {
    const workflow = await renderWorkflow();
    const snapshotConfig = workflow.indexOf("UBUNTU_SNAPSHOT=20261019T000000Z");
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
    expect(workflow).toContain('Acquire::Retries "3";');
    expect(workflow).toContain("sudo apt-get update --error-on=any");
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
        500 https://snapshot.ubuntu.com/ubuntu/20261019T000000Z noble/main amd64 Packages
POLICY
seq 1 100000`;

    expect((await runPrerequisiteScript(aptCacheBody, "1.0")).exitCode).toBe(0);
  });

  test("reinstalls and verifies the co-versioned GLib packages from the ARM snapshot", async () => {
    // Given: an arm64 candidate policy, whose snapshot URI is architecture-independent.
    const aptCacheBody = `cat <<'POLICY'
  Candidate: 1.0
  Version table:
 *** 1.0 500
        500 https://snapshot.ubuntu.com/ubuntu/20261019T000000Z noble/main arm64 Packages
POLICY`;
    // When: execute the generated install and verification script.
    const result = await runPrerequisiteScript(aptCacheBody, "1.0");
    // Then: every real GLib dependency is eligible for downgrade and is verified afterwards.
    expect(result.exitCode, result.output).toBe(0);
    expect(result.installArguments).toContain("--allow-downgrades");
    expect(result.installArguments).toContain("--reinstall");
    for (const name of [
      "libgirepository-2.0-0",
      "libglib2.0-0t64",
      "libglib2.0-bin",
      "libglib2.0-dev",
      "libglib2.0-dev-bin",
    ]) {
      expect(result.installArguments).toContain(name);
      expect(result.verifiedPackages).toContain(name);
    }
    expect(result.installArguments).not.toContain("libglib2.0-dev-bin-linux");
    expect(result.verifiedPackages).not.toContain("libglib2.0-dev-bin-linux");
  });

  test("rejects a live candidate when only another version comes from the snapshot", async () => {
    const aptCacheBody = `cat <<'POLICY'
  Candidate: 2.0
  Version table:
 *** 2.0 500
        500 http://archive.ubuntu.com/ubuntu noble-updates/main amd64 Packages
     1.0 100
        100 https://snapshot.ubuntu.com/ubuntu/20261019T000000Z noble/main amd64 Packages
POLICY`;

    expect((await runPrerequisiteScript(aptCacheBody, "2.0")).exitCode).not.toBe(0);
  });

  test("retries failed index updates with backoff before installing", async () => {
    const result = await runPrerequisiteScript(
      `printf '  Candidate: 1.0\\n  Version table:\\n *** 1.0 500\\n        500 https://snapshot.ubuntu.com/ubuntu/20261019T000000Z noble/main amd64 Packages\\n'`,
      "1.0",
      'test "$(wc -l < "$APT_TEST_ROOT/updates")" -ge 3',
    );

    expect(result.exitCode).toBe(0);
    expect(result.updates).toBe("--error-on=any\n".repeat(3));
    expect(result.sleeps).toBe("5\n15\n");
    expect(result.installed).toBe(true);
    expect(result.config).toBe('APT::Snapshot "20261019T000000Z";\nAcquire::Retries "3";\n');
  });

  test("fails closed with an annotation after four failed index updates", async () => {
    const result = await runPrerequisiteScript("exit 1", "1.0", "exit 100");

    expect(result.exitCode).not.toBe(0);
    expect(result.updates).toBe("--error-on=any\n".repeat(4));
    expect(result.sleeps).toBe("5\n15\n45\n");
    expect(result.installed).toBe(false);
    expect(result.output).toContain("::error title=runtime-bundle-apt-snapshot::");
  });

  test("keeps the generated runtime workflow drift-free", async () => {
    const committed = await Bun.file(resolve(repoRoot, ".github/workflows/runtime-bundle.yml")).text();

    expect(committed).toBe(await renderWorkflow());
  });
});
