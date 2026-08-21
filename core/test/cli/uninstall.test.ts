import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Effect } from "effect";

import { metaUninstallSpec, uninstallOptionsFromInput } from "../../src/cli/command-specs/meta/uninstall.ts";
import { formatUninstallResult } from "../../src/cli/commands/uninstall.ts";
import { type DiscoveredApp, buildUninstallPlan, uninstall } from "../../src/testing/engine-layers.ts";

const makeRoots = () => {
  const root = mkdtempSync(join(tmpdir(), "lando-uninstall-test-"));
  const userDataRoot = join(root, "data");
  const userCacheRoot = join(root, "cache");
  return {
    root,
    userDataRoot,
    userCacheRoot,
    cgroupsDelegatePath: join(root, "delegate.conf"),
    shellProfilePath: join(root, ".profile"),
  };
};

const sandboxCliExtras = (root: string) => ({
  _cgroupsDelegatePath: join(root, "delegate.conf"),
  _shellProfilePath: join(root, ".profile"),
});

const sandboxUninstallIo = (root: string) => ({
  cgroupsDelegatePath: join(root, "delegate.conf"),
  shellProfilePath: join(root, ".profile"),
});

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
    const readText = (path: string) => `text:${path}`;
    const writeText = async () => {};
    const terminateRuntimeBinProcesses = async () => {};
    expect(
      uninstallOptionsFromInput({
        flags: { yes: true },
        _cgroupsDelegatePath: "/tmp/sandbox/delegate.conf",
        _shellProfilePath: "/tmp/sandbox/.profile",
        _readText: readText,
        _writeText: writeText,
        _terminateRuntimeBinProcesses: terminateRuntimeBinProcesses,
      }),
    ).toMatchObject({
      cgroupsDelegatePath: "/tmp/sandbox/delegate.conf",
      shellProfilePath: "/tmp/sandbox/.profile",
      readText,
      writeText,
      terminateRuntimeBinProcesses,
    });
  });

  test("dry-run renders every uninstall step and previews the default keep-data mode", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      writeFileSync(join(root, "lando"), "binary", "utf-8");
      const providerRuntime = join(userDataRoot, "providers", "provider-lando");
      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { "dry-run": true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _execPath: join(root, "lando"),
          ...sandboxCliExtras(root),
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
      expect(output).toContain("cgroups delegation drop-in");
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
          ...sandboxCliExtras(root),
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

  test("plan includes a runtime-service step targeting the runtime directory", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const runtimeDir = join(userDataRoot, "runtime");
      const plan = await buildUninstallPlan({
        userDataRoot,
        userCacheRoot,
        execPath: join(root, "lando"),
        ...sandboxUninstallIo(root),
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

  test("plan reports host-proxy sessions under userDataRoot run directory without removing the run root", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const hostProxyRunDir = join(userDataRoot, "run");
      const plan = await buildUninstallPlan({
        userDataRoot,
        userCacheRoot,
        execPath: join(root, "lando"),
        ...sandboxUninstallIo(root),
        exists: (path: string) => path === hostProxyRunDir,
      });

      expect(plan.find((step) => step.id === "host-proxy-sessions")).toMatchObject({
        target: hostProxyRunDir,
        status: "owned",
        destructive: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("teardown owns host-proxy cleanup without removing unrelated run state", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const hostProxyRunDir = join(userDataRoot, "run");
      const teardownRoots: string[] = [];
      const removed: string[] = [];

      const result = await Effect.runPromise(
        uninstall({
          yes: true,
          keepData: true,
          userDataRoot,
          userCacheRoot,
          execPath: join(root, "lando"),
          ...sandboxUninstallIo(root),
          exists: (path: string) => path === hostProxyRunDir,
          teardownHostProxySessions: async (rootPath: string) => {
            teardownRoots.push(rootPath);
          },
          remove: async (path: string) => {
            removed.push(path);
          },
        }),
      );

      expect(result.steps.find((step) => step.id === "host-proxy-sessions")).toMatchObject({
        outcome: "completed",
      });
      expect(teardownRoots).toEqual([userDataRoot]);
      expect(removed).not.toContain(hostProxyRunDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("runtime-service is removed under both keep-data and purge", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const runtimeDir = join(userDataRoot, "runtime");
      const options = {
        userDataRoot,
        userCacheRoot,
        execPath: join(root, "lando"),
        ...sandboxUninstallIo(root),
        exists: (path: string) => path === runtimeDir,
      };

      expect(
        (await buildUninstallPlan(options, "keep-data")).find((step) => step.id === "runtime-service"),
      ).toMatchObject({
        target: runtimeDir,
        status: "owned",
      });
      expect(
        (await buildUninstallPlan(options, "purge")).find((step) => step.id === "runtime-service"),
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
      let runtimeDirExists = true;

      const result = await Effect.runPromise(
        uninstall({
          yes: true,
          keepData: true,
          userDataRoot,
          userCacheRoot,
          execPath: join(root, "lando"),
          ...sandboxUninstallIo(root),
          exists: (path: string) => path === runtimeDir && runtimeDirExists,
          teardownRuntimeService: async (rootPath: string) => {
            teardownRoots.push(rootPath);
            order.push("teardown");
            return { terminated: true, pid: 1234 };
          },
          remove: async (path: string) => {
            order.push(`remove:${path}`);
            if (path === runtimeDir) runtimeDirExists = false;
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
      let runtimeDirExists = true;

      const result = await Effect.runPromise(
        uninstall({
          yes: true,
          keepData: true,
          execPath: join(root, "lando"),
          ...sandboxUninstallIo(root),
          exists: (path: string) => path === runtimeDir && runtimeDirExists,
          teardownRuntimeService: async (rootPath: string) => {
            teardownRoots.push(rootPath);
            return { terminated: true, pid: 1234 };
          },
          remove: async (path: string) => {
            if (path === runtimeDir) runtimeDirExists = false;
          },
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
          ...sandboxUninstallIo(root),
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

  test("managed-provider-runtime remains distinct from runtime-service", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const runtimeDir = join(userDataRoot, "runtime");
      const providerRuntime = join(userDataRoot, "providers", "provider-lando");
      const legacyRuntime = join(userDataRoot, "providers", "lando");
      const plan = await buildUninstallPlan({
        userDataRoot,
        userCacheRoot,
        execPath: join(root, "lando"),
        ...sandboxUninstallIo(root),
        exists: (path: string) => path === runtimeDir || path === providerRuntime,
      });

      expect(plan.find((step) => step.id === "runtime-service")).toMatchObject({ target: runtimeDir });
      expect(plan.find((step) => step.id === "managed-provider-runtime")).toMatchObject({
        target: providerRuntime,
        status: "owned",
        detail: "Remove Lando-managed runtime bundles when present.",
      });
      expect(plan.find((step) => step.id === "managed-provider-runtime")?.target).not.toBe(legacyRuntime);
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
          ...sandboxCliExtras(root),
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
        _cgroupsDelegatePath: "/tmp/lando-data/delegate.conf",
        _shellProfilePath: "/tmp/lando-data/.profile",
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
        _cgroupsDelegatePath: String.raw`C:\Users\me\AppData\Local\lando\delegate.conf`,
        _shellProfilePath: String.raw`C:\Users\me\AppData\Local\lando\.profile`,
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
      const runtime = join(userDataRoot, "providers", "provider-lando");
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
          ...sandboxCliExtras(root),
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
          ...sandboxCliExtras(root),
          _listDiscoveredApps: async () => [], // No running apps
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
          ...sandboxCliExtras(root),
          _listDiscoveredApps: async () => [], // No running apps
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
      const runtime = join(userDataRoot, "providers", "provider-lando");
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
          ...sandboxCliExtras(root),
          _remove: async (path: string) => {
            if (path === runtime) throw new Error("locked runtime");
            rmSync(path, { recursive: true, force: true });
          },
        }),
      );

      expect(result.failed).toBe(true);
      const reportPath = result.reportPath;
      expect(reportPath).toBe(join(userDataRoot, "uninstall", "report.json"));
      if (reportPath === undefined) throw new Error("expected uninstall report path");
      const report = JSON.parse(readFileSync(reportPath, "utf-8"));
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
          ...sandboxCliExtras(root),
          _reportFallbackDir: reportFallbackDir,
          _listDiscoveredApps: async () => [], // No running apps
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

  test("default fallback report uses a private temp directory", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    let fallbackDir: string | undefined;
    try {
      mkdirSync(join(userDataRoot, "global"), { recursive: true });
      mkdirSync(userCacheRoot, { recursive: true });

      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { yes: true, purge: true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _execPath: join(root, "lando"),
          ...sandboxCliExtras(root),
          _listDiscoveredApps: async () => [], // No running apps
          _remove: async (path: string) => {
            if (path === userCacheRoot) throw new Error("locked cache root");
            rmSync(path, { recursive: true, force: true });
          },
        }),
      );

      expect(result.failed).toBe(true);
      const reportPath = result.reportPath;
      if (reportPath === undefined) throw new Error("expected fallback report path");
      fallbackDir = dirname(reportPath);
      expect(fallbackDir.startsWith(join(tmpdir(), "lando-uninstall-"))).toBe(true);
      expect(reportPath).toBe(join(fallbackDir, "lando-uninstall-report.json"));
      expect(existsSync(reportPath)).toBe(true);
      if (process.platform !== "win32") {
        expect(statSync(fallbackDir).mode & 0o077).toBe(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (fallbackDir !== undefined) rmSync(fallbackDir, { recursive: true, force: true });
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
          ...sandboxCliExtras(root),
          _reportFallbackDir: reportFallbackDir,
          _listDiscoveredApps: async () => [], // No running apps
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
          ...sandboxCliExtras(root),
          _reportFallbackDir: reportFallbackDir,
          _listDiscoveredApps: async () => [], // No running apps
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

      // Execute through the same sandboxed extras as the other confirm tests.
      // Live CLI uses the real /etc/systemd/.../delegate.conf default and must
      // not unlink (or EACCES-fail on) a host drop-in.
      const keepData = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { yes: true, "keep-data": true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _userConfRoot: join(root, "conf"),
          _execPath: join(root, "lando"),
          ...sandboxCliExtras(root),
        }),
      );
      expect(keepData.failed).toBe(false);
      expect(keepData.mode).toBe("keep-data");
      const keepDataOutput = formatUninstallResult(keepData);
      expect(keepDataOutput).toContain("uninstall complete");
      expect(keepDataOutput).toContain("mode: keep-data");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("purge cleans up running apps and their resources", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      mkdirSync(userDataRoot, { recursive: true });
      mkdirSync(userCacheRoot, { recursive: true });
      const userConfRoot = join(root, "conf");
      mkdirSync(userConfRoot, { recursive: true });

      const cleanedApps: ReadonlyArray<{ appId: string; providerId: string }>[] = [];

      // Simulate discovered RUNNING apps
      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { yes: true, purge: true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _userConfRoot: userConfRoot,
          _execPath: join(root, "lando"),
          ...sandboxCliExtras(root),
          _listDiscoveredApps: async () => [
            {
              appId: "test-app",
              appName: "test-app",
              providerId: "docker",
              appRoot: "/fake/path",
              services: ["web", "database"],
            },
          ],
          _cleanupDiscoveredApps: async (apps: ReadonlyArray<DiscoveredApp>) => {
            cleanedApps.push(
              apps.map((app: DiscoveredApp) => ({ appId: app.appId, providerId: app.providerId })),
            );
          },
        }),
      );

      // Uninstall must succeed after cleanup
      expect(result.failed).toBe(false);

      // Running-apps step must be marked as completed
      const runningAppsStep = result.steps.find((step) => step.id === "running-apps");
      expect(runningAppsStep?.outcome).toBe("completed");
      expect(runningAppsStep?.status).toBe("owned");

      // Verify cleanup was called with the correct apps
      expect(cleanedApps.length).toBe(1);
      expect(cleanedApps[0]).toEqual([{ appId: "test-app", providerId: "docker" }]);

      // Data/cache/config directories should be deleted after successful cleanup
      expect(existsSync(userDataRoot)).toBe(false);
      expect(existsSync(userCacheRoot)).toBe(false);
      expect(existsSync(userConfRoot)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("purge succeeds when apps are cached but not running", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      mkdirSync(userDataRoot, { recursive: true });
      mkdirSync(userCacheRoot, { recursive: true });
      const userConfRoot = join(root, "conf");
      mkdirSync(userConfRoot, { recursive: true });

      // Create fake cache files to simulate stopped apps (files exist but containers not running)
      const dockerAppsDir = join(userDataRoot, "providers", "provider-docker", "apps");
      mkdirSync(dockerAppsDir, { recursive: true });
      writeFileSync(
        join(dockerAppsDir, "stopped-app.json"),
        JSON.stringify({
          plan: {
            id: "stopped-app",
            name: "stopped-app",
            root: "/fake/path",
            services: { web: {} },
          },
        }),
      );

      // Discovery returns empty (no running containers, only cached files)
      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { yes: true, purge: true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _userConfRoot: userConfRoot,
          _execPath: join(root, "lando"),
          ...sandboxCliExtras(root),
          _listDiscoveredApps: async () => [], // No running apps
        }),
      );

      // Uninstall must succeed
      expect(result.failed).toBe(false);

      // Running-apps step should be completed with "owned" status (cleanup path)
      const runningAppsStep = result.steps.find((step) => step.id === "running-apps");
      expect(runningAppsStep?.status).toBe("owned");
      expect(runningAppsStep?.outcome).toBe("completed");

      // Data/cache/config directories should be deleted
      expect(existsSync(userDataRoot)).toBe(false);
      expect(existsSync(userCacheRoot)).toBe(false);
      expect(existsSync(userConfRoot)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("purge fails closed when discovery throws an error", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      mkdirSync(userDataRoot, { recursive: true });
      mkdirSync(userCacheRoot, { recursive: true });
      const userConfRoot = join(root, "conf");
      mkdirSync(userConfRoot, { recursive: true });

      // Discovery throws an error (e.g., timeout or runtime unavailable)
      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { yes: true, purge: true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _userConfRoot: userConfRoot,
          _execPath: join(root, "lando"),
          ...sandboxCliExtras(root),
          _listDiscoveredApps: async () => {
            throw new Error("docker ps query timed out after 1000ms");
          },
        }),
      );

      // Uninstall must fail
      expect(result.failed).toBe(true);

      // Running-apps step must be marked as failed with user-owned status
      const runningAppsStep = result.steps.find((step) => step.id === "running-apps");
      expect(runningAppsStep?.status).toBe("user-owned");
      expect(runningAppsStep?.outcome).toBe("failed");
      expect(runningAppsStep?.error).toContain("Cannot verify");
      expect(runningAppsStep?.error).toContain("discovery failed");

      // Critical: data/cache/config directories must NOT be deleted
      expect(existsSync(userDataRoot)).toBe(true);
      expect(existsSync(userCacheRoot)).toBe(true);
      expect(existsSync(userConfRoot)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("purge fails closed when cleanup throws an error", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      mkdirSync(userDataRoot, { recursive: true });
      mkdirSync(userCacheRoot, { recursive: true });
      const userConfRoot = join(root, "conf");
      mkdirSync(userConfRoot, { recursive: true });

      // Cleanup throws an error
      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { yes: true, purge: true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _userConfRoot: userConfRoot,
          _execPath: join(root, "lando"),
          ...sandboxCliExtras(root),
          _listDiscoveredApps: async () => [
            {
              appId: "test-app",
              appName: "test-app",
              providerId: "docker",
              appRoot: "/fake/path",
              services: ["web"],
            },
          ],
          _cleanupDiscoveredApps: async () => {
            throw new Error("Failed to stop containers");
          },
        }),
      );

      // Uninstall must fail
      expect(result.failed).toBe(true);

      // Running-apps step must be marked as failed
      const runningAppsStep = result.steps.find((step) => step.id === "running-apps");
      expect(runningAppsStep?.outcome).toBe("failed");
      expect(runningAppsStep?.error).toContain("Failed to stop containers");

      // Critical: data/cache/config directories must NOT be deleted
      expect(existsSync(userDataRoot)).toBe(true);
      expect(existsSync(userCacheRoot)).toBe(true);
      expect(existsSync(userConfRoot)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("purge fails closed when container runtime is unavailable", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      mkdirSync(userDataRoot, { recursive: true });
      mkdirSync(userCacheRoot, { recursive: true });
      const userConfRoot = join(root, "conf");
      mkdirSync(userConfRoot, { recursive: true });

      // Simulate runtime being unavailable by throwing when discovery is attempted
      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { yes: true, purge: true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _userConfRoot: userConfRoot,
          _execPath: join(root, "lando"),
          ...sandboxCliExtras(root),
          _listDiscoveredApps: async () => {
            throw new Error(
              "Failed to query container runtimes: podman: command not found; docker: command not found",
            );
          },
        }),
      );

      // Uninstall must fail
      expect(result.failed).toBe(true);

      // Running-apps step must be marked as failed with user-owned status
      const runningAppsStep = result.steps.find((step) => step.id === "running-apps");
      expect(runningAppsStep?.status).toBe("user-owned");
      expect(runningAppsStep?.outcome).toBe("failed");
      expect(runningAppsStep?.error).toContain("Cannot verify");
      expect(runningAppsStep?.error).toContain("discovery failed");

      // Critical: data/cache/config directories must NOT be deleted
      expect(existsSync(userDataRoot)).toBe(true);
      expect(existsSync(userCacheRoot)).toBe(true);
      expect(existsSync(userConfRoot)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("purge cleans up orphaned containers even without cache files", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      mkdirSync(userDataRoot, { recursive: true });
      mkdirSync(userCacheRoot, { recursive: true });
      const userConfRoot = join(root, "conf");
      mkdirSync(userConfRoot, { recursive: true });

      const cleanedApps: ReadonlyArray<{ appId: string; providerId: string }>[] = [];

      // Simulate running container discovered by docker ps but no cache file exists
      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { yes: true, purge: true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _userConfRoot: userConfRoot,
          _execPath: join(root, "lando"),
          ...sandboxCliExtras(root),
          _listDiscoveredApps: async () => [
            {
              appId: "orphaned-app",
              appName: "orphaned-app",
              providerId: "docker",
              appRoot: "(unknown)", // No cache file
              services: [],
            },
          ],
          _cleanupDiscoveredApps: async (apps: ReadonlyArray<DiscoveredApp>) => {
            cleanedApps.push(
              apps.map((app: DiscoveredApp) => ({ appId: app.appId, providerId: app.providerId })),
            );
          },
        }),
      );

      // Uninstall must succeed after cleanup even without cache
      expect(result.failed).toBe(false);

      // Running-apps step must be marked as completed
      const runningAppsStep = result.steps.find((step) => step.id === "running-apps");
      expect(runningAppsStep?.outcome).toBe("completed");

      // Verify cleanup was called
      expect(cleanedApps.length).toBe(1);
      expect(cleanedApps[0]).toEqual([{ appId: "orphaned-app", providerId: "docker" }]);

      // Data/cache/config directories should be deleted after successful cleanup
      expect(existsSync(userDataRoot)).toBe(false);
      expect(existsSync(userCacheRoot)).toBe(false);
      expect(existsSync(userConfRoot)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("purge discovery probes the managed podman binary with runtime flags", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    try {
      const runtimeBinDir = join(userDataRoot, "runtime", "bin");
      mkdirSync(runtimeBinDir, { recursive: true });
      const probeLog = join(root, "managed-podman-argv.log");
      writeFileSync(
        join(runtimeBinDir, "podman"),
        ["#!/bin/sh", `echo "$@" >> "${probeLog}"`, "exit 0", ""].join("\n"),
        { mode: 0o755 },
      );

      await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { "dry-run": true, purge: true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _userConfRoot: join(root, "conf"),
          _execPath: join(root, "lando"),
          ...sandboxCliExtras(root),
        }),
      );

      const recorded = existsSync(probeLog) ? readFileSync(probeLog, "utf8") : "";
      expect(recorded).toContain("--root");
      expect(recorded).toContain(join(userDataRoot, "runtime", "storage"));
      expect(recorded).toContain("--runroot");
      expect(recorded).toContain(join(userDataRoot, "runtime", "run"));
      expect(recorded).toContain("--config");
      expect(recorded).toContain(join(userDataRoot, "runtime", "config"));
      expect(recorded).toContain("--storage-opt");
      expect(recorded).toContain(`overlay.mount_program=${join(runtimeBinDir, "fuse-overlayfs")}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("purge honors LANDO_SHELL_PROFILE when stripping the shellenv block", async () => {
    const { root, userDataRoot, userCacheRoot } = makeRoots();
    const customProfilePath = join(root, "custom-shell-profile");
    const previousProfile = process.env.LANDO_SHELL_PROFILE;
    try {
      writeFileSync(
        customProfilePath,
        [
          "export USER_LINE=keep-me",
          "# >>> LANDO shellenv >>>",
          "export LANDO_USER_DATA_ROOT='/tmp/lando'",
          'export PATH="${LANDO_USER_DATA_ROOT}/bin:${PATH}"',
          "# <<< LANDO shellenv <<<",
          "export AFTER=still-here",
          "",
        ].join("\n"),
      );
      process.env.LANDO_SHELL_PROFILE = customProfilePath;

      const result = await Effect.runPromise(
        metaUninstallSpec.run({
          flags: { yes: true, purge: true },
          _userDataRoot: userDataRoot,
          _userCacheRoot: userCacheRoot,
          _userConfRoot: join(root, "conf"),
          _execPath: join(root, "lando"),
          _cgroupsDelegatePath: join(root, "delegate.conf"),
          _listDiscoveredApps: async () => [],
          _exists: (path: string) => (path === root || path.startsWith(`${root}/`)) && existsSync(path),
        }),
      );

      expect(result.failed).toBe(false);
      expect(result.steps.find((step) => step.id === "shell-entries")).toMatchObject({
        target: customProfilePath,
        status: "owned",
        outcome: "completed",
      });
      const rewritten = readFileSync(customProfilePath, "utf8");
      expect(rewritten).toContain("export USER_LINE=keep-me");
      expect(rewritten).toContain("export AFTER=still-here");
      expect(rewritten).not.toContain("# >>> LANDO shellenv >>>");
      expect(rewritten).not.toContain("# <<< LANDO shellenv <<<");
      expect(rewritten).not.toContain("LANDO_USER_DATA_ROOT");
    } finally {
      process.env.LANDO_SHELL_PROFILE = previousProfile;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
