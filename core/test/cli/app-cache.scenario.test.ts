import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DateTime, Effect, Layer } from "effect";

import { refreshAppCache, renderAppCacheRefreshResult } from "@lando/core/cli/operations";
import { AbsolutePath, AppId, type AppPlan, type ProviderCapabilities, ProviderId } from "@lando/core/schema";
import { AppPlanner, LandofileService, RuntimeProviderRegistry } from "@lando/core/services";
import { CacheError } from "@lando/sdk/errors";

import { appCommandCachePath } from "../../src/cache/paths.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");
const providerId = ProviderId.make("lando");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const capabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "lando",
  hostReachability: "emulated",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
};

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "app-cache.scenario.test",
  runtime: 4 as const,
};

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-app-cache-scenario-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const runCli = async (args: ReadonlyArray<string>, cwd: string): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
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

describe("lando app:cache:refresh", () => {
  test("rebuilds app and plugin command index without contacting the provider", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        "name: test-app-cache\nservices:\n  web:\n    type: node\ntooling:\n  hello:\n    cmds: echo hi\n    description: say hi\n",
      );
      const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-app-cache-root-")));

      try {
        const plan: AppPlan = {
          id: AppId.make("test-app-cache"),
          name: "test-app-cache",
          slug: "test-app-cache",
          root: AbsolutePath.make(dir),
          provider: providerId,
          services: {},
          routes: [],
          networks: [],
          stores: [],
          fileSync: [],
          metadata,
          extensions: {},
        };

        let selectCalls = 0;
        const layer = Layer.mergeAll(
          Layer.succeed(LandofileService, {
            discover: Effect.succeed({
              name: "test-app-cache",
              services: {},
              tooling: { hello: { cmds: "echo hi", description: "say hi" } },
            }),
          }),
          Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
          Layer.succeed(RuntimeProviderRegistry, {
            list: Effect.succeed([providerId]),
            capabilities: Effect.succeed(capabilities),
            select: () => {
              selectCalls += 1;
              return Effect.die("provider must not be selected");
            },
          }),
        );

        const result = await Effect.runPromise(
          refreshAppCache({ cwd: dir, cacheRoot }).pipe(Effect.provide(layer)),
        );

        expect(selectCalls).toBe(0);
        expect(result.app).toBe("test-app-cache");
        expect(result.commandsCompiled).toBe(1);
        expect(result.appCommandCachePath).toMatch(/apps\/test-app-cache-[a-f0-9]{12}\/commands\.bin$/u);
        expect(result.pluginCommandCachePath).toContain("plugin-command-cache.bin");
        expect(renderAppCacheRefreshResult(result)).toBe("refreshed: test-app-cache (1 command)");

        const appStat = await stat(result.appCommandCachePath ?? "");
        expect(appStat.size).toBeGreaterThan(0);
        const pluginStat = await stat(result.pluginCommandCachePath ?? "");
        expect(pluginStat.size).toBeGreaterThan(0);
      } finally {
        await rm(cacheRoot, { recursive: true, force: true });
      }
    });
  });

  test("fails when app-command cache write fails", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(
        join(dir, ".lando.yml"),
        "name: strict-app-cache\nservices:\n  web:\n    type: node\ntooling:\n  hello:\n    cmds: echo hi\n",
      );
      const cacheRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-app-cache-root-")));

      try {
        const plan: AppPlan = {
          id: AppId.make("strict-app-cache"),
          name: "strict-app-cache",
          slug: "strict-app-cache",
          root: AbsolutePath.make(dir),
          provider: providerId,
          services: {},
          routes: [],
          networks: [],
          stores: [],
          fileSync: [],
          metadata,
          extensions: {},
        };
        const layer = Layer.mergeAll(
          Layer.succeed(LandofileService, {
            discover: Effect.succeed({
              name: "strict-app-cache",
              services: {},
              tooling: { hello: { cmds: "echo hi" } },
            }),
          }),
          Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
          Layer.succeed(RuntimeProviderRegistry, {
            list: Effect.succeed([providerId]),
            capabilities: Effect.succeed(capabilities),
            select: () => Effect.die("provider must not be selected"),
          }),
        );

        const blockedPath = dirname(appCommandCachePath(cacheRoot, "strict-app-cache", dir));
        await mkdir(dirname(blockedPath), { recursive: true });
        await writeFile(blockedPath, "not a directory");

        const exit = await Effect.runPromiseExit(
          refreshAppCache({ cwd: dir, cacheRoot }).pipe(Effect.provide(layer)),
        );

        expect(exit._tag).toBe("Failure");
        if (exit._tag !== "Failure") return;
        const failure = exit.cause._tag === "Fail" ? exit.cause.error : undefined;
        expect(failure).toBeInstanceOf(CacheError);
        expect(failure?.message).toBe("Failed to write app-command cache.");
      } finally {
        await rm(cacheRoot, { recursive: true, force: true });
      }
    });
  });

  test("fails outside an app directory with init remediation", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["app:cache:refresh"], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No .lando.yml or .lando.ts found");
      expect(result.stderr).toContain("lando init");
    });
  });
});
