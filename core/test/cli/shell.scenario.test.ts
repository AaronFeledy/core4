import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Config } from "@oclif/core";
import { DateTime, Effect, Layer } from "effect";

import { shellApp } from "@lando/core/cli/operations";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type LandofileShape,
  type ProviderCapabilities,
  ProviderId,
} from "@lando/core/schema";
import {
  AppPlanner,
  LandofileService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/core/services";

import AppShellCommand from "../../src/cli/oclif/commands/app/shell.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");
const providerId = ProviderId.make("lando");

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

const plan: AppPlan = {
  id: AppId.make("shell-scenario"),
  name: "shell-scenario",
  slug: "shell-scenario",
  root: AbsolutePath.make("/tmp/shell-scenario"),
  provider: providerId,
  services: {} as AppPlan["services"],
  routes: [],
  networks: [],
  stores: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-05-18T00:00:00Z"),
    source: "shell.scenario.test",
    runtime: 4 as const,
  },
  extensions: {},
};

const fakeProvider: RuntimeProviderShape = {
  id: providerId,
  displayName: "Fake",
  version: "0.0.0",
  platform: "linux",
  capabilities,
  isAvailable: Effect.succeed(true),
  setup: () => Effect.void,
  getStatus: Effect.succeed({ running: true }),
  getVersions: Effect.succeed({ provider: "0.0.0" }),
  buildArtifact: () => Effect.die("not used"),
  pullArtifact: () => Effect.die("not used"),
  removeArtifact: () => Effect.void,
  apply: () => Effect.succeed({ changed: false }),
  start: () => Effect.void,
  stop: () => Effect.void,
  restart: () => Effect.void,
  destroy: () => Effect.void,
  exec: () => Effect.die("not used"),
  execStream: () => Effect.die("not used") as never,
  run: () => Effect.die("not used"),
  logs: () => Effect.die("not used") as never,
  inspect: () => Effect.die("not used"),
  list: () => Effect.succeed([]),
};

const layer = (landofile: LandofileShape = { name: "shell-scenario" }) =>
  Layer.mergeAll(
    Layer.succeed(LandofileService, { discover: Effect.succeed(landofile) }),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(capabilities),
      select: () => Effect.succeed(fakeProvider),
    }),
  );

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCli = async (args: ReadonlyArray<string>, cwd = repoRoot): Promise<RunResult> => {
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

describe("shellApp — host-mode scenarios (US-022)", () => {
  test("rejects --service with NotImplementedError (Beta-deferred)", async () => {
    const exit = await Effect.runPromiseExit(shellApp({ service: "web" }).pipe(Effect.provide(layer())));
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    const flat = JSON.stringify(exit.cause);
    expect(flat).toContain("NotImplementedError");
    expect(flat).toContain("app:shell");
    expect(flat).toContain("spec/08-cli-and-tooling.md");
  });

  test("host mode resolves cwd to the planned app root and propagates exit code from the launcher", async () => {
    const captures: Array<{ shell: string; cwd: string; env: Record<string, string> }> = [];
    const result = await Effect.runPromise(
      shellApp({
        shellPath: "/bin/sh",
        args: ["-c", "exit 7"],
        launch: async (spec) => {
          captures.push({
            shell: spec.shell,
            cwd: spec.cwd,
            env: { ...spec.env } as Record<string, string>,
          });
          return { exitCode: 7 };
        },
      }).pipe(Effect.provide(layer())),
    );
    expect(result.mode).toBe("host");
    expect(result.exitCode).toBe(7);
    expect(result.app).toBe("shell-scenario");
    expect(captures).toHaveLength(1);
    expect(captures[0]?.cwd).toBe("/tmp/shell-scenario");
    expect(captures[0]?.shell).toBe("/bin/sh");
    expect(captures[0]?.env.LANDO_APP_NAME).toBe("shell-scenario");
    expect(captures[0]?.env.LANDO_APP_ROOT).toBe("/tmp/shell-scenario");
  });

  test("custom cwd overrides the planned app root", async () => {
    let observedCwd = "";
    await Effect.runPromise(
      shellApp({
        shellPath: "/bin/sh",
        cwd: "/tmp/other",
        args: ["-c", "exit 0"],
        launch: async (spec) => {
          observedCwd = spec.cwd;
          return { exitCode: 0 };
        },
      }).pipe(Effect.provide(layer())),
    );
    expect(observedCwd).toBe("/tmp/other");
  });

  test("reserved LANDO_* env wins over caller options.env", async () => {
    let observedEnv: Record<string, string> = {};
    await Effect.runPromise(
      shellApp({
        shellPath: "/bin/sh",
        args: ["-c", "exit 0"],
        env: {
          LANDO_APP_NAME: "spoofed",
          LANDO_APP_ROOT: "/etc/spoof",
          MY_CUSTOM: "kept",
        },
        launch: async (spec) => {
          observedEnv = { ...spec.env };
          return { exitCode: 0 };
        },
      }).pipe(Effect.provide(layer())),
    );
    expect(observedEnv.LANDO_APP_NAME).toBe("shell-scenario");
    expect(observedEnv.LANDO_APP_ROOT).toBe("/tmp/shell-scenario");
    expect(observedEnv.MY_CUSTOM).toBe("kept");
  });
});

describe("lando shell — CLI surface (US-022)", () => {
  test("registers `shell` and `app:shell` as a top-level alias and OCLIF id", async () => {
    const config = await Config.load({ root: resolve(repoRoot, "core"), ignoreManifest: true });
    const rootPlugin = config.plugins.get(config.pjson.name);
    if (rootPlugin === undefined) throw new Error("OCLIF root plugin missing");
    const aliasesById = new Map(
      rootPlugin.commands.map((command) => [command.id, command.aliases ?? []] as const),
    );
    expect(aliasesById.get("app:shell")).toContain("shell");
    expect(AppShellCommand.aliases).toContain("shell");
  });

  test("compiled CLI `--service=web` is rejected with NotImplementedError (source CLI parity)", async () => {
    const result = await runCli(["shell", "--service=web"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("NotImplementedError");
    expect(result.stderr).toContain("commandId: app:shell");
    expect(result.stderr).toContain("specSection: spec/08-cli-and-tooling.md");
  });
});
