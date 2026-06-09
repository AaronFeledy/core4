import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Effect } from "effect";

import { formatUninstallResult } from "../../src/cli/commands/uninstall.ts";
import { metaUninstallSpec, uninstallOptionsFromInput } from "../../src/cli/oclif/commands/meta/uninstall.ts";

const makeRoots = () => {
  const root = mkdtempSync(join(tmpdir(), "lando-uninstall-test-"));
  const userDataRoot = join(root, "data");
  const userCacheRoot = join(root, "cache");
  return { root, userDataRoot, userCacheRoot };
};

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

const runCli = async (
  args: ReadonlyArray<string>,
  env: Record<string, string>,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

describe("meta:uninstall", () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  test("is registered as a minimal bootstrap command with a top-level alias", () => {
    expect(metaUninstallSpec.id).toBe("meta:uninstall");
    expect(metaUninstallSpec.bootstrap).toBe("minimal");
    expect(metaUninstallSpec.topLevelAlias).toBe(true);
  });

  test("compiled argv input maps dry-run and confirmation flags", () => {
    expect(uninstallOptionsFromInput({ flags: { "dry-run": true } })).toMatchObject({
      dryRun: true,
      yes: false,
    });
    expect(uninstallOptionsFromInput({ flags: { yes: true } })).toMatchObject({
      dryRun: false,
      yes: true,
    });
    expect(uninstallOptionsFromInput({ flags: { yes: true, "keep-data": true } })).toMatchObject({
      keepData: true,
      purge: false,
    });
    expect(uninstallOptionsFromInput({ flags: { yes: true, purge: true } })).toMatchObject({
      keepData: false,
      purge: true,
    });
  });

  test("dry-run renders every uninstall step without mutating roots", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      writeFileSync(join(root, "lando"), "binary", "utf-8");
      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { "dry-run": true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _execPath: join(root, "lando"),
          _exists: (path: string) => path === userDataRoot || path === userCacheRoot,
        }),
      );

      const output = formatUninstallResult(result);
      expect(output).toContain("uninstall plan (dry-run)");
      expect(output).toContain("managed provider runtime");
      expect(output).toContain("managed provider machines");
      expect(output).toContain("Mutagen binary");
      expect(output).toContain("Mutagen agents");
      expect(output).toContain("CA trust-store changes");
      expect(output).toContain("global app state");
      expect(output).toContain("caches");
      expect(output).toContain("installed binary");
      expect(output).toContain("shell entries");
      expect(output).toContain("user data root");
      expect(output).toContain("user cache root");
      expect(output).toContain("owned by Lando");
      expect(output).toContain("user-owned");
      expect(output).toContain("skipped");
      expect(output).toContain("manual remediation");
      expect(await Bun.file(userDataRoot).exists()).toBe(false);
      expect(await Bun.file(userCacheRoot).exists()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("destructive execution without --yes refuses and tells the user how to proceed", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: {},
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _execPath: join(root, "lando"),
          _exists: () => false,
        }),
      );

      const output = formatUninstallResult(result);
      expect(result.refused).toBe(true);
      expect(output).toContain("uninstall refused");
      expect(output).toContain("Rerun `lando uninstall --yes` after reviewing this plan.");
      expect(output).toContain("uninstall plan");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("marks installed binaries under the managed bin directory as owned", async () => {
    const result = await Effect.runPromise(
      metaUninstallSpec.run({
        flags: { "dry-run": true },
        _userDataRoot: "/tmp/lando-data",
        _userCacheRoot: "/tmp/lando-cache",
        _execPath: "/tmp/lando-data/bin/lando",
        _exists: () => true,
      }),
    );

    expect(result.steps.find((step) => step.id === "installed-binary")).toMatchObject({
      status: "owned",
    });
  });

  test("marks Windows-style installed binaries under the managed bin directory as owned", async () => {
    const result = await Effect.runPromise(
      metaUninstallSpec.run({
        flags: { "dry-run": true },
        _userDataRoot: String.raw`C:\Users\me\AppData\Local\lando`,
        _userCacheRoot: String.raw`C:\Users\me\AppData\Local\lando-cache`,
        _execPath: String.raw`C:\Users\me\AppData\Local\lando\bin\lando.exe`,
        _exists: () => true,
      }),
    );

    expect(result.steps.find((step) => step.id === "installed-binary")).toMatchObject({
      status: "owned",
    });
  });

  test("confirmed --keep-data removes owned toolchain entries but preserves data roots", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const runtime = join(userDataRoot, "providers", "lando");
      const mutagen = join(userDataRoot, "bin", process.platform === "win32" ? "mutagen.exe" : "mutagen");
      const agents = join(userDataRoot, "bin", "mutagen-agents");
      const globalState = join(userDataRoot, "global");
      const binary = join(userDataRoot, "bin", "lando");
      for (const path of [runtime, agents, globalState, userCacheRoot]) mkdirSync(path, { recursive: true });
      writeFileSync(mutagen, "mutagen", "utf-8");
      writeFileSync(binary, "lando", "utf-8");

      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { yes: true, "keep-data": true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _execPath: binary,
        }),
      );

      expect(result.refused).toBe(false);
      expect(existsSync(runtime)).toBe(false);
      expect(existsSync(mutagen)).toBe(false);
      expect(existsSync(agents)).toBe(false);
      expect(existsSync(binary)).toBe(false);
      expect(existsSync(userDataRoot)).toBe(true);
      expect(existsSync(globalState)).toBe(true);
      expect(existsSync(userCacheRoot)).toBe(true);
      expect(result.steps.find((step) => step.id === "global-app-state")).toMatchObject({
        status: "skipped",
      });
      expect(result.steps.find((step) => step.id === "user-data-root")).toMatchObject({ status: "skipped" });
      expect(result.steps.find((step) => step.id === "user-cache-root")).toMatchObject({ status: "skipped" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("confirmed --purge removes owned data and cache roots", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const binary = join(userDataRoot, "bin", "lando");
      mkdirSync(join(userDataRoot, "global"), { recursive: true });
      mkdirSync(userCacheRoot, { recursive: true });
      mkdirSync(join(userDataRoot, "bin"), { recursive: true });
      writeFileSync(binary, "lando", "utf-8");

      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { yes: true, purge: true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _execPath: binary,
        }),
      );

      expect(result.refused).toBe(false);
      expect(existsSync(userDataRoot)).toBe(false);
      expect(existsSync(userCacheRoot)).toBe(false);
      expect(formatUninstallResult(result)).toContain("removed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("user-owned installed binary stays manual during confirmed purge", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const binary = join(root, "usr-local-bin-lando");
      mkdirSync(userDataRoot, { recursive: true });
      writeFileSync(binary, "lando", "utf-8");

      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { yes: true, purge: true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _execPath: binary,
        }),
      );

      expect(existsSync(binary)).toBe(true);
      expect(result.steps.find((step) => step.id === "installed-binary")).toMatchObject({
        status: "user-owned",
        outcome: "manual",
      });
      expect(formatUninstallResult(result)).toContain(`Remove ${binary} manually`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("partial failures write a resumable uninstall report", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const runtime = join(userDataRoot, "providers", "lando");
      const mutagen = join(userDataRoot, "bin", process.platform === "win32" ? "mutagen.exe" : "mutagen");
      mkdirSync(runtime, { recursive: true });
      mkdirSync(join(userDataRoot, "bin"), { recursive: true });
      writeFileSync(mutagen, "mutagen", "utf-8");

      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { yes: true, "keep-data": true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _execPath: join(root, "lando"),
          _remove: async (path: string) => {
            if (path === runtime) throw new Error("locked runtime");
            rmSync(path, { recursive: true, force: true });
          },
        }),
      );

      expect(result.failed).toBe(true);
      expect(result.reportPath).toBe(join(userDataRoot, "uninstall", "report.json"));
      const report = JSON.parse(readFileSync(result.reportPath, "utf-8"));
      expect(report.status).toBe("failed");
      expect(report.steps).toContainEqual(
        expect.objectContaining({ id: "managed-provider-runtime", outcome: "failed" }),
      );
      expect(report.steps).toContainEqual(
        expect.objectContaining({ id: "mutagen-binary", outcome: "completed" }),
      );
      expect(report.steps).toContainEqual(
        expect.objectContaining({ id: "installed-binary", outcome: "manual" }),
      );
      expect(formatUninstallResult(result)).toContain("uninstall incomplete");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("source CLI dry-run and refusal exercise the real command surface", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const env = {
        LANDO_USER_DATA_ROOT: userDataRoot,
        LANDO_USER_CACHE_ROOT: userCacheRoot,
        LANDO_USER_CONF_ROOT: join(root, "conf"),
      };
      const dryRun = await runCli(["uninstall", "--dry-run"], env);
      expect(dryRun.exitCode).toBe(0);
      expect(dryRun.stdout).toContain("uninstall plan (dry-run)");
      expect(dryRun.stdout).toContain("No changes were made.");

      const refused = await runCli(["meta:uninstall"], env);
      expect(refused.exitCode).toBe(1);
      expect(refused.stdout).toContain("uninstall refused");
      expect(refused.stdout).toContain("Rerun `lando uninstall --yes` after reviewing this plan.");

      const keepData = await runCli(["uninstall", "--yes", "--keep-data"], env);
      expect(keepData.exitCode).toBe(0);
      expect(keepData.stdout).toContain("uninstall complete");
      expect(keepData.stdout).toContain("mode: keep-data");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
