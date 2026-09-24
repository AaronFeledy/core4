import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DateTime, Effect, Exit } from "effect";

import { makePreparedWindowsMutagenAppClient } from "@lando/file-sync-mutagen";
import {
  type WindowsSyncTargetOperations,
  prepareWindowsDockerCli,
  prepareWindowsSyncTargets,
} from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
  fileSyncVolumeName,
} from "@lando/sdk/schema";
import { makePluginStateStore } from "@lando/state-store/plugin";
import { makeTestStateStore } from "@lando/state-store/testing";

const image = "example.invalid/sync@sha256:".concat("a".repeat(64));
const root = AbsolutePath.make("C:\\Users\\me\\demo");
const appId = AppId.make("demo-id");
const provider = ProviderId.make("lando");
const serviceName = ServiceName.make("web");
const volumeName = fileSyncVolumeName("demo", serviceName, "app-mount");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "windows-mutagen-composition.test.ts",
  runtime: 4 as const,
};
const service: ServicePlan = {
  name: serviceName,
  type: "node",
  provider,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "server.js"],
  environment: {},
  appMount: {
    source: root,
    target: PortablePath.make("/app"),
    readOnly: false,
    realization: "accelerated",
    excludes: [],
    includes: [],
  },
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};
const plan: AppPlan = {
  id: appId,
  name: "demo",
  slug: "demo",
  root,
  provider,
  services: { [serviceName]: service },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [
    {
      engineId: "mutagen",
      session: {
        app: { kind: "user", id: appId, root },
        service: serviceName,
        mountKey: "app-mount",
        source: root,
        target: { _tag: "volume", name: volumeName, path: PortablePath.make("/app") },
        mode: "two-way-safe",
        excludes: [],
      },
    },
  ],
  metadata,
  extensions: {},
};
const privateFileAccess = {
  enforce: async (_path: string) => undefined,
  verify: async (_path: string) => undefined,
};
const endpoint = {
  containerId: "owned-helper-id",
  containerName: "owned-helper",
  volumeName,
  path: "/sync" as const,
};
const helpers: WindowsSyncTargetOperations = {
  prepareImage: () => Effect.void,
  ensure: () => Effect.succeed(endpoint),
};

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("opt-in Windows Mutagen composition", () => {
  test("rejects incomplete provider targets before a process or alias preparation", async () => {
    let prepared = false;
    const result = await Effect.runPromiseExit(
      makePreparedWindowsMutagenAppClient({
        plan,
        preparedTargets: { targets: [] },
        binDir: "C:\\Lando\\bin",
        dataDir: "C:\\Lando\\mutagen-data",
        stateStore: makePluginStateStore(
          makeTestStateStore().service,
          AbsolutePath.make("/tmp/windows-mutagen-composition-test"),
          privateFileAccess,
        ),
        prepareDockerCli: () =>
          Effect.sync(() => {
            prepared = true;
            return "C:\\Lando\\docker.exe";
          }),
        hostPlatform: "win32",
        verifyInstalled: async () => true,
        runner: { run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }) },
      }),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(prepared).toBe(false);
  });

  const windowsTest = process.platform === "win32" ? test : test.skip;
  windowsTest("uses real verified alias and provider targets, then rejects alias tampering", async () => {
    const runtimeBinDir = await mkdtemp(join(tmpdir(), "lando-mutagen-runtime-"));
    directories.push(runtimeBinDir);
    await writeFile(join(runtimeBinDir, ".runtime-installed-version"), "6.0.0\n");
    await writeFile(join(runtimeBinDir, "podman.exe"), "owned-podman-binary");
    const preparedTargets = await Effect.runPromise(prepareWindowsSyncTargets(plan, image, helpers));
    const calls: Array<{ args: ReadonlyArray<string>; env: Readonly<Record<string, string>> }> = [];
    let created = false;
    const client = await Effect.runPromise(
      makePreparedWindowsMutagenAppClient({
        plan,
        preparedTargets,
        binDir: runtimeBinDir,
        dataDir: join(runtimeBinDir, "mutagen-data"),
        stateStore: makePluginStateStore(
          makeTestStateStore().service,
          AbsolutePath.make(runtimeBinDir),
          privateFileAccess,
        ),
        prepareDockerCli: () => prepareWindowsDockerCli(runtimeBinDir, "win32"),
        verifyInstalled: async () => true,
        runner: {
          run: ({ args, env }) =>
            Effect.sync(() => {
              calls.push({ args, env: env ?? {} });
              if (args[0] === "version") return { exitCode: 0, stdout: "Mutagen version 0.18.1", stderr: "" };
              if (args[1] === "list")
                return {
                  exitCode: 0,
                  stdout: JSON.stringify(
                    created
                      ? [
                          {
                            identifier: "sync_Abc123",
                            name: "demo-web-app-mount",
                            alpha: { protocol: "local", path: root, connected: true },
                            beta: {
                              protocol: "docker",
                              host: endpoint.containerId,
                              path: endpoint.path,
                              environment: {
                                DOCKER_HOST: "npipe:////./pipe/podman-lando",
                                DOCKER_CONTEXT: "",
                              },
                              connected: true,
                            },
                            mode: "two-way-safe",
                            ignore: { paths: [] },
                            paused: false,
                            status: "watching",
                            successfulCycles: 1,
                          },
                        ]
                      : [],
                  ),
                  stderr: "",
                };
              if (args[1] === "create") {
                created = true;
                return { exitCode: 0, stdout: "Created session sync_Abc123\n", stderr: "" };
              }
              return { exitCode: 0, stdout: "", stderr: "" };
            }),
        },
      }),
    );
    expect(await Effect.runPromise(client.version)).toBe("0.18.1");
    const plannedSession = plan.fileSync[0]?.session;
    if (plannedSession === undefined) throw new Error("Expected one planned sync session.");
    await Effect.runPromise(client.create({ name: "demo-web-app-mount", spec: plannedSession }));
    expect(calls.some(({ args }) => args.includes("docker://owned-helper-id/sync"))).toBe(true);
    expect(
      calls.every(
        ({ env }) =>
          env.DOCKER_HOST === "npipe:////./pipe/podman-lando" &&
          env.MUTAGEN_DOCKER_PATH === join(runtimeBinDir, "docker-compat"),
      ),
    ).toBe(true);
    const alias = join(runtimeBinDir, "docker-compat", "docker.exe");
    expect(await readFile(alias, "utf8")).toBe("owned-podman-binary");
    const count = calls.length;
    await writeFile(alias, "tampered");
    expect(Exit.isFailure(await Effect.runPromiseExit(client.version))).toBe(true);
    expect(calls).toHaveLength(count);
  });
});
