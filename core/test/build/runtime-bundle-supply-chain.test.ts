import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
const prerequisiteScript = (): Promise<string> =>
  readFile(resolve(repoRoot, "scripts/runtime-bundle-builder/prerequisites.sh"), "utf8");
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
    const fixtureEtc = resolve(fakeBin, "etc/apt");
    const fixtureLists = resolve(fakeBin, "var/lib/apt/lists");
    await mkdir(resolve(fixtureEtc, "sources.list.d"), { recursive: true });
    await mkdir(resolve(fixtureEtc, "apt.conf.d"), { recursive: true });
    await mkdir(fixtureLists, { recursive: true });
    await Bun.write(resolve(fixtureEtc, "sources.list"), "live source\n");
    await Bun.write(resolve(fixtureEtc, "sources.list.d/live.sources"), "live source\n");
    await Bun.write(resolve(fixtureLists, "old-index"), "old\n");
    await Bun.write(resolve(fakeBin, "updates"), "");
    await Bun.write(resolve(fakeBin, "sleeps"), "");
    await writeCommand(
      "apt-get",
      `if [ "$1" = "update" ]; then
  shift
  printf '%s\\n' "$*" >>"$APT_TEST_ROOT/updates"
  ${updateBody}
elif [ "$1" = "install" ]; then
  touch "$APT_TEST_ROOT/installed"
fi`,
    );
    await writeCommand("sleep", `printf '%s\\n' "$1" >>"$APT_TEST_ROOT/sleeps"`);
    await writeCommand("dpkg-query", `printf '${installedVersion}\\n'`);
    await writeCommand("apt-cache", aptCacheBody);
    const script = (await prerequisiteScript())
      .replaceAll("/etc/apt", fixtureEtc)
      .replaceAll("/var/lib/apt", resolve(fakeBin, "var/lib/apt"));
    if (/(?<![\w/])\/(?:etc\/apt|var\/lib\/apt)/u.test(script)) {
      throw new Error("APT path escaped the fixture");
    }
    const child = Bun.spawn(["bash", "-c", script], {
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
      sources: await Bun.file(resolve(fixtureEtc, "sources.list.d/runtime-bundle.sources")).text(),
      retries: await Bun.file(resolve(fixtureEtc, "apt.conf.d/50lando-runtime-bundle-snapshot")).text(),
      liveSourceExists: await Bun.file(resolve(fixtureEtc, "sources.list.d/live.sources")).exists(),
      oldIndexExists: await Bun.file(resolve(fixtureLists, "old-index")).exists(),
      updates: await Bun.file(resolve(fakeBin, "updates")).text(),
      sleeps: await Bun.file(resolve(fakeBin, "sleeps")).text(),
      installed: await Bun.file(resolve(fakeBin, "installed")).exists(),
    };
  } finally {
    await rm(fakeBin, { force: true, recursive: true });
  }
};

describe("runtime-bundle workflow supply chain", () => {
  test("pins every action to an immutable commit", async () => {
    const workflow = await renderWorkflow();
    const references = actionReferences(workflow);

    expect(references).toHaveLength(8);
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

  test("installs build prerequisites from only the signed Ubuntu snapshot", async () => {
    const workflow = await renderWorkflow();
    const script = await prerequisiteScript();
    expect(workflow).toContain("bun run scripts/assemble-runtime-bundle.ts --platform");
    expect(workflow).not.toContain("sudo apt-get install -y --allow-downgrades");
    expect(script).toContain("Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg");
    expect(script).toContain("apt-get update --error-on=any");
    expect(script).toContain('Acquire::Retries "3";');
    expect(script).toContain('test "$INSTALLED_VERSION" = "$CANDIDATE_VERSION"');
    expect(script).toMatch(/PACKAGES=.*\bpatch\b/u);
    for (const obsoletePackage of ["libassuan-dev", "libgpg-error-dev", "libgpgme-dev"]) {
      expect(script).not.toContain(obsoletePackage);
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

  test("rejects an installed version that differs from the signed snapshot candidate", async () => {
    const result = await runPrerequisiteScript(
      `printf '  Candidate: 2.0\\n  Version table:\\n *** 2.0 500\\n        500 https://snapshot.ubuntu.com/ubuntu/20261019T000000Z noble/main amd64 Packages\\n'`,
      "1.0",
    );
    expect(result.exitCode).not.toBe(0);
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
    expect(result.retries).toBe('Acquire::Retries "3";\n');
    expect(result.sources).toContain("URIs: https://snapshot.ubuntu.com/ubuntu/20261019T000000Z/");
    expect(result.sources).toContain("Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg");
    expect(result.liveSourceExists).toBe(false);
    expect(result.oldIndexExists).toBe(false);
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
