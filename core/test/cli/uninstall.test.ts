import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Effect } from "effect";

import { buildUninstallPlan, formatUninstallResult, uninstall } from "../../src/cli/commands/uninstall.ts";
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

  test("dry-run renders every uninstall step and previews the default keep-data mode", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      writeFileSync(join(root, "lando"), "binary", "utf-8");
      const providerRuntime = join(userDataRoot, "providers", "lando");
      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { "dry-run": true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _execPath: join(root, "lando"),
          _exists: (path: string) =>
            path === providerRuntime || path === userDataRoot || path === userCacheRoot,
        }),
      );

      const output = formatUninstallResult(result);
      expect(output).toContain("uninstall plan (dry-run)");
      expect(output).toContain("mode: keep-data");
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
      expect(output).toContain("manual remediation");
      expect(result.steps.find((step) => step.id === "managed-provider-runtime")).toMatchObject({
        status: "owned",
      });
      expect(result.steps.find((step) => step.id === "user-data-root")).toMatchObject({
        status: "skipped",
      });
      expect(result.steps.find((step) => step.id === "user-cache-root")).toMatchObject({
        status: "skipped",
      });
      expect(result.steps.find((step) => step.id === "global-app-state")).toMatchObject({
        status: "skipped",
      });
      expect(output).toContain("rerun with --purge");
      expect(await Bun.file(userDataRoot).exists()).toBe(false);
      expect(await Bun.file(userCacheRoot).exists()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dry-run --purge previews data and cache roots as owned", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { "dry-run": true, purge: true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _execPath: join(root, "lando"),
          _exists: (path: string) => path === userDataRoot || path === userCacheRoot,
        }),
      );

      const output = formatUninstallResult(result);
      expect(output).toContain("mode: purge");
      expect(result.steps.find((step) => step.id === "user-data-root")).toMatchObject({
        status: "owned",
      });
      expect(result.steps.find((step) => step.id === "user-cache-root")).toMatchObject({
        status: "owned",
      });
      expect(await Bun.file(userDataRoot).exists()).toBe(false);
      expect(await Bun.file(userCacheRoot).exists()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("plan includes a runtime-service step targeting the runtime directory", () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const runtimeDir = join(userDataRoot, "runtime");
      const plan = buildUninstallPlan({
        userDataRoot,
        userCacheRoot,
        execPath: join(root, "lando"),
        exists: (path: string) => path === runtimeDir,
      });

      expect(plan.find((step) => step.id === "runtime-service")).toMatchObject({
        label: "managed runtime service",
        target: runtimeDir,
        destructive: true,
        status: "owned",
        detail:
          "Terminate the Lando-managed runtime service and remove its socket, PID, and runtime directory.",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runtime-service is removed under both keep-data and purge", () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const runtimeDir = join(userDataRoot, "runtime");
      const options = {
        userDataRoot,
        userCacheRoot,
        execPath: join(root, "lando"),
        exists: (path: string) => path === runtimeDir,
      };

      expect(
        buildUninstallPlan(options, "keep-data").find((step) => step.id === "runtime-service"),
      ).toMatchObject({
        target: runtimeDir,
        status: "owned",
      });
      expect(
        buildUninstallPlan(options, "purge").find((step) => step.id === "runtime-service"),
      ).toMatchObject({
        target: runtimeDir,
        status: "owned",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("teardown runs before remove for runtime-service", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const runtimeDir = join(userDataRoot, "runtime");
      const order: string[] = [];
      const teardownRoots: string[] = [];

      const result = await Effect.runPromise(
        uninstall({
          yes: true,
          keepData: true,
          userDataRoot,
          userCacheRoot,
          execPath: join(root, "lando"),
          exists: (path: string) => path === runtimeDir,
          teardownRuntimeService: async (rootPath: string) => {
            teardownRoots.push(rootPath);
            order.push("teardown");
            return { terminated: true, pid: 1234 };
          },
          remove: async (path: string) => {
            order.push(`remove:${path}`);
          },
        }),
      );

      expect(result.steps.find((step) => step.id === "runtime-service")).toMatchObject({
        outcome: "completed",
      });
      expect(teardownRoots).toEqual([userDataRoot]);
      expect(order.slice(0, 2)).toEqual(["teardown", `remove:${runtimeDir}`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runtime-service teardown uses the resolved default data root", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
    const previousCacheRoot = process.env.LANDO_USER_CACHE_ROOT;
    try {
      process.env.LANDO_USER_DATA_ROOT = userDataRoot;
      process.env.LANDO_USER_CACHE_ROOT = userCacheRoot;
      const runtimeDir = join(userDataRoot, "runtime");
      const teardownRoots: string[] = [];

      const result = await Effect.runPromise(
        uninstall({
          yes: true,
          keepData: true,
          execPath: join(root, "lando"),
          exists: (path: string) => path === runtimeDir,
          teardownRuntimeService: async (rootPath: string) => {
            teardownRoots.push(rootPath);
            return { terminated: true, pid: 1234 };
          },
          remove: async () => {},
        }),
      );

      expect(result.steps.find((step) => step.id === "runtime-service")).toMatchObject({
        outcome: "completed",
      });
      expect(teardownRoots).toEqual([userDataRoot]);
    } finally {
      if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
      else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      if (previousCacheRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_CACHE_ROOT");
      else process.env.LANDO_USER_CACHE_ROOT = previousCacheRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runtime-service is idempotent when runtime dir is absent", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const runtimeDir = join(userDataRoot, "runtime");
      const order: string[] = [];

      const result = await Effect.runPromise(
        uninstall({
          yes: true,
          keepData: true,
          userDataRoot,
          userCacheRoot,
          execPath: join(root, "lando"),
          exists: () => false,
          teardownRuntimeService: async () => {
            order.push("teardown");
            return { terminated: false };
          },
          remove: async (path: string) => {
            order.push(`remove:${path}`);
          },
        }),
      );

      expect(result.failed).toBe(false);
      expect(result.steps.find((step) => step.id === "runtime-service")).toMatchObject({
        target: runtimeDir,
        status: "skipped",
        outcome: "skipped",
      });
      expect(order).not.toContain("teardown");
      expect(order).not.toContain(`remove:${runtimeDir}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("managed-provider-runtime remains distinct from runtime-service", () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const runtimeDir = join(userDataRoot, "runtime");
      const providerRuntime = join(userDataRoot, "providers", "lando");
      const plan = buildUninstallPlan({
        userDataRoot,
        userCacheRoot,
        execPath: join(root, "lando"),
        exists: (path: string) => path === runtimeDir || path === providerRuntime,
      });

      expect(plan.find((step) => step.id === "runtime-service")).toMatchObject({ target: runtimeDir });
      expect(plan.find((step) => step.id === "managed-provider-runtime")).toMatchObject({
        target: providerRuntime,
        status: "owned",
        detail: "Remove Lando-managed runtime bundles when present.",
      });
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

  test("purge failure after data-root removal writes a resumable report to the fallback path", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    const reportFallbackDir = join(root, "fallback");
    try {
      mkdirSync(join(userDataRoot, "global"), { recursive: true });
      mkdirSync(userCacheRoot, { recursive: true });

      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { yes: true, purge: true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _execPath: join(root, "lando"),
          _reportFallbackDir: reportFallbackDir,
          _remove: async (path: string) => {
            if (path === userCacheRoot) throw new Error("locked cache root");
            rmSync(path, { recursive: true, force: true });
          },
        }),
      );

      expect(result.failed).toBe(true);
      // The data root was purged; writing the report must never recreate it.
      expect(existsSync(userDataRoot)).toBe(false);
      expect(existsSync(join(userDataRoot, "uninstall"))).toBe(false);

      // The resumable report survives at the fallback location and its path is reported.
      const fallbackReportPath = join(reportFallbackDir, "lando-uninstall-report.json");
      expect(result.reportPath).toBe(fallbackReportPath);
      expect(existsSync(fallbackReportPath)).toBe(true);
      const report = JSON.parse(readFileSync(fallbackReportPath, "utf-8"));
      expect(report.status).toBe("failed");
      expect(report.steps).toContainEqual(
        expect.objectContaining({ id: "user-data-root", outcome: "completed" }),
      );
      expect(report.steps).toContainEqual(
        expect.objectContaining({ id: "user-cache-root", outcome: "failed" }),
      );
      expect(result.steps.find((step) => step.id === "user-data-root")).toMatchObject({
        outcome: "completed",
      });
      expect(result.steps.find((step) => step.id === "user-cache-root")).toMatchObject({
        outcome: "failed",
      });
      const rendered = formatUninstallResult(result);
      expect(rendered).toContain(`Partial failure report: ${fallbackReportPath}`);
      expect(rendered).not.toContain("Partial failure report: unavailable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("re-run after a partial purge failure reconciles remaining steps from disk", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    const reportFallbackDir = join(root, "fallback");
    try {
      mkdirSync(join(userDataRoot, "global"), { recursive: true });
      mkdirSync(userCacheRoot, { recursive: true });

      const first = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { yes: true, purge: true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _execPath: join(root, "lando"),
          _reportFallbackDir: reportFallbackDir,
          _remove: async (path: string) => {
            if (path === userCacheRoot) throw new Error("locked cache root");
            rmSync(path, { recursive: true, force: true });
          },
        }),
      );
      expect(first.failed).toBe(true);
      expect(existsSync(userDataRoot)).toBe(false);
      expect(existsSync(userCacheRoot)).toBe(true);

      // Re-running the same command re-plans from live disk state: the already-removed
      // data root is reconciled away and the still-present cache root is retried.
      const second = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { yes: true, purge: true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _execPath: join(root, "lando"),
          _reportFallbackDir: reportFallbackDir,
          _remove: async (path: string) => {
            rmSync(path, { recursive: true, force: true });
          },
        }),
      );
      expect(second.failed).toBe(false);
      expect(existsSync(userCacheRoot)).toBe(false);
      expect(second.reportPath).toBeUndefined();
      expect(second.steps.find((step) => step.id === "user-data-root")?.outcome).not.toBe("failed");
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
