import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assembleBundle, parseRuntimeBundleSources } from "../../../scripts/assemble-runtime-bundle.ts";
import { fixtureLicense, licenseBytes } from "./runtime-bundle-license-fixture.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const binary = new TextEncoder().encode("fixture-binary");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const nativeTest = process.platform === "linux" ? test : test.skip;

const sources = (hostKey: string) => ({
  schemaVersion: 1,
  runtimeVersion: "9.9.9-fixture",
  bundles: {
    [hostKey]: {
      components: [
        {
          name: "fixture-engine",
          license: fixtureLicense("1.0.0"),
          version: "1.0.0",
          url: "https://example.test/fixture-engine",
          sha256: sha256(binary),
          archive: "none",
          installName: "bin/fixture-engine",
          mode: 493,
        },
      ],
    },
  },
});

const childScript = `
const { mock } = await import("bun:test");
if (process.env.BUNDLE_TEST_CLEANUP_LOG) {
  const fs = await import("node:fs/promises");
  const originalRm = fs.rm;
  mock.module("node:fs/promises", () => ({
    ...fs,
    rm: async (path, options) => {
      await fs.appendFile(process.env.BUNDLE_TEST_CLEANUP_LOG, String(path) + "\\n");
      await originalRm(path, options);
      if (String(path).includes("rb-stage-")) throw new Error("injected cleanup failure");
    },
  }));
}
const { assembleBundle } = await import("./scripts/assemble-runtime-bundle.ts");
const binary = new TextEncoder().encode("fixture-binary");
const license = new TextEncoder().encode("fixture-license-bytes");
try {
  await assembleBundle({
    hostKey: process.env.BUNDLE_TEST_HOST,
    sources: JSON.parse(process.env.BUNDLE_TEST_SOURCES),
    outDir: process.env.BUNDLE_TEST_OUT_DIR,
    repository: "owner/repo",
    fetchArtifact: async (url) => url.endsWith("/LICENSE") ? license : binary,
    inspectCommand: async () => "linux-vdso.so.1\\nlibc.so.6 => /lib/libc.so.6\\n",
    verifyCommand: async () => {},
  });
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
}
`;

const runWithToolFailure = async (options: {
  hostKey: "linux-x64" | "win32-x64";
  command: "tar" | "gzip" | "zip" | "find" | "sort";
  script: string;
  additionalCommands?: ReadonlyArray<{ name: string; script: string }>;
  expectedCode: number;
  previous: boolean;
  cleanupFailure?: boolean;
}): Promise<void> => {
  const fixtureDir = await mkdtemp(join(tmpdir(), "rb-pack-fault-"));
  const outputDir = join(fixtureDir, "output");
  const fakeBin = join(fixtureDir, "bin");
  const filename =
    options.hostKey === "linux-x64" ? "lando-runtime-linux-x64.tar.gz" : "lando-runtime-win32-x64.zip";
  const artifact = join(outputDir, filename);
  try {
    await Bun.$`mkdir -p ${outputDir} ${fakeBin}`;
    if (options.previous) await writeFile(artifact, "previous");
    for (const command of [
      { name: options.command, script: options.script },
      ...(options.additionalCommands ?? []),
    ]) {
      const fakeCommand = join(fakeBin, command.name);
      await writeFile(fakeCommand, `#!/bin/sh\n${command.script}\n`);
      await chmod(fakeCommand, 0o755);
    }
    const cleanupLog = join(fixtureDir, "cleanup.log");
    const child = Bun.spawn([process.execPath, "-e", childScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        BUNDLE_TEST_HOST: options.hostKey,
        BUNDLE_TEST_SOURCES: JSON.stringify(sources(options.hostKey)),
        BUNDLE_TEST_OUT_DIR: outputDir,
        ...(options.cleanupFailure ? { BUNDLE_TEST_CLEANUP_LOG: cleanupLog } : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stdout + stderr).toContain(`command failed (${options.expectedCode})`);
    expect(stdout + stderr).not.toContain("injected cleanup failure");
    expect(await readdir(outputDir)).toEqual(options.previous ? [filename] : []);
    if (options.previous) expect(await readFile(artifact, "utf8")).toBe("previous");
    if (options.cleanupFailure) {
      const cleaned = (await readFile(cleanupLog, "utf8")).trim().split("\n");
      expect(cleaned.some((path) => path.includes("rb-stage-"))).toBe(true);
      expect(cleaned.some((path) => path.includes("rb-dl-"))).toBe(true);
      expect(cleaned.some((path) => path.includes(".rb-assembly-"))).toBe(true);
    }
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
};

describe("runtime bundle packing failures", () => {
  nativeTest("packs the Windows zip reproducibly under its original filename", async () => {
    const firstDir = await mkdtemp(join(tmpdir(), "rb-zip-first-"));
    const secondDir = await mkdtemp(join(tmpdir(), "rb-zip-second-"));
    try {
      const options = {
        hostKey: "win32-x64",
        sources: parseRuntimeBundleSources(sources("win32-x64")),
        repository: "owner/repo",
        fetchArtifact: async (url: string): Promise<Uint8Array> =>
          url.endsWith("/LICENSE") ? licenseBytes : binary,
      };
      const first = await assembleBundle({ ...options, outDir: firstDir });
      const second = await assembleBundle({ ...options, outDir: secondDir });
      expect(first.filename).toBe("lando-runtime-win32-x64.zip");
      expect(first.sha256).toBe(second.sha256);
      const firstBytes = await readFile(first.artifactPath);
      expect(Array.from(firstBytes.slice(0, 2))).toEqual([0x50, 0x4b]);
      expect(firstBytes).toEqual(await readFile(second.artifactPath));
    } finally {
      await rm(firstDir, { recursive: true, force: true });
      await rm(secondDir, { recursive: true, force: true });
    }
  });

  nativeTest.each([false, true])(
    "tar failure rejects partial gzip output (previous=%p)",
    async (previous) => {
      await runWithToolFailure({
        hostKey: "linux-x64",
        command: "tar",
        script: "printf 'partial archive'; exit 23",
        expectedCode: 23,
        previous,
      });
    },
  );

  nativeTest("gzip failure rejects output and preserves an existing archive", async () => {
    await runWithToolFailure({
      hostKey: "linux-x64",
      command: "gzip",
      script: "cat >/dev/null; exit 29",
      expectedCode: 29,
      previous: true,
    });
  });

  nativeTest("when tar and gzip both fail, pipefail reports the rightmost gzip failure", async () => {
    await runWithToolFailure({
      hostKey: "linux-x64",
      command: "tar",
      script: "printf 'partial archive'; exit 23",
      additionalCommands: [{ name: "gzip", script: "cat >/dev/null; exit 29" }],
      expectedCode: 29,
      previous: false,
    });
  });

  nativeTest("zip failure does not leave a final archive", async () => {
    await runWithToolFailure({
      hostKey: "win32-x64",
      command: "zip",
      script: "exit 37",
      expectedCode: 37,
      previous: false,
    });
  });

  nativeTest("find failure in zip listing propagates through command substitution", async () => {
    const realFind = Bun.which("find");
    if (realFind === null) throw new Error("find is required for this test");
    await runWithToolFailure({
      hostKey: "win32-x64",
      command: "find",
      script: `if [ "$2" = "-exec" ]; then exec "${realFind}" "$@"; fi\nexit 31`,
      expectedCode: 31,
      previous: true,
    });
  });

  nativeTest("sort failure in zip listing propagates through the pipeline", async () => {
    await runWithToolFailure({
      hostKey: "win32-x64",
      command: "sort",
      script: "exit 41",
      expectedCode: 41,
      previous: false,
    });
  });

  nativeTest("primary tar failure survives cleanup failure and still attempts every cleanup", async () => {
    await runWithToolFailure({
      hostKey: "linux-x64",
      command: "tar",
      script: "printf 'partial archive'; exit 23",
      expectedCode: 23,
      previous: true,
      cleanupFailure: true,
    });
  });

  nativeTest("reports cleanup failure after successful packing", async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), "rb-pack-cleanup-"));
    const outputDir = join(fixtureDir, "output");
    const cleanupLog = join(fixtureDir, "cleanup.log");
    try {
      const child = Bun.spawn([process.execPath, "-e", childScript], {
        cwd: repoRoot,
        env: {
          ...process.env,
          BUNDLE_TEST_HOST: "linux-x64",
          BUNDLE_TEST_SOURCES: JSON.stringify(sources("linux-x64")),
          BUNDLE_TEST_OUT_DIR: outputDir,
          BUNDLE_TEST_CLEANUP_LOG: cleanupLog,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(1);
      expect(stdout + stderr).toContain("injected cleanup failure");
      expect(await readdir(outputDir)).toEqual(["lando-runtime-linux-x64.tar.gz"]);
      const cleaned = (await readFile(cleanupLog, "utf8")).trim().split("\n");
      expect(cleaned.some((path) => path.includes("rb-stage-"))).toBe(true);
      expect(cleaned.some((path) => path.includes("rb-dl-"))).toBe(true);
      expect(cleaned.some((path) => path.includes(".rb-assembly-"))).toBe(true);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
