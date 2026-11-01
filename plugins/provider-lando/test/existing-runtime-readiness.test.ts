import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { DateTime, Effect, Stream } from "effect";
import { makeRuntimeProvider, persistAppliedPlan } from "../src/index.ts";
import { buildPodmanServiceArgs } from "../src/podman-service-args.ts";
import { ownerOnlyFileAccess } from "./private-file-access.ts";

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
  source: "test",
  runtime: 4 as const,
};
const app = AppId.make("offline-rescue");
const service = ServiceName.make("web");
const plan: AppPlan = {
  id: app,
  name: "Offline rescue",
  slug: "offline-rescue",
  root: AbsolutePath.make("/tmp/offline-rescue"),
  provider: ProviderId.make("lando"),
  services: {
    [service]: {
      name: service,
      type: "node",
      provider: ProviderId.make("lando"),
      primary: true,
      artifact: { kind: "ref", ref: "alpine:3" },
      init: true,
      environment: {},
      mounts: [],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {},
    },
  },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

test("old reachable managed runtime serves rescue requests without repair or extra pings", async () => {
  // Given an old installation with missing helper and an offline downloader.
  const root = await mkdtemp(join(tmpdir(), "lando-offline-rescue-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, ".runtime-installed-version"), "0.1.7");
  const requests: string[] = [];
  const socket = join(root, "api.sock");
  const server = Bun.serve({
    unix: socket,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (path.endsWith("/info")) return Response.json({ version: { Version: "6.0.2" } });
      if (path.endsWith("/logs")) return new Response("rescue log\n");
      if (path.endsWith("/containers/json"))
        return Response.json([
          {
            Id: "exact-owned-id",
            State: "exited",
            Labels: { "dev.lando.app": app, "dev.lando.app-root": plan.root, "dev.lando.service": service },
          },
        ]);
      if (path.endsWith("/json"))
        return Response.json({
          Id: "exact-owned-id",
          Name: "lando-offline-rescue-web",
          Config: {
            Labels: { "dev.lando.app": app, "dev.lando.app-root": plan.root, "dev.lando.service": service },
          },
          State: { Status: "exited", Running: false, ExitCode: 0 },
        });
      if (request.method === "DELETE" || path.endsWith("/stop")) return new Response(null, { status: 204 });
      if (path.includes("/networks/")) return new Response("{}", { status: 404 });
      return new Response("[]");
    },
  });
  try {
    const state = makePluginStateStore(
      makeTestStateStore().service,
      AbsolutePath.make(join(root, "state")),
      ownerOnlyFileAccess,
    );
    await Effect.runPromise(persistAppliedPlan(state, plan));
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        arch: "x64",
        runtimeBinDir: bin,
        runtimeConfigDir: join(root, "config"),
        runtimeRunDir: join(root, "run"),
        runtimeStorageDir: join(root, "storage"),
        providerSocketPath: socket,
        providerPidPath: join(root, "run", "podman.pid"),
        appliedPlanState: state,
        appliedPlanStateDir: join(root, "state"),
        sanitizeAppliedPlan: stripHostProxyRunLando,
        artifactDownload: () => Effect.die("rescue must not download"),
        podmanService: {
          launch: () => Effect.die("rescue must not launch"),
          isAlive: () => Effect.succeed(true),
          terminate: () => Effect.die("rescue must not terminate daemon"),
        },
      }),
    );
    requests.length = 0;
    // When real provider operations use the reachable API.
    expect(await Effect.runPromise(provider.inspect({ app, service, plan }))).toMatchObject({
      status: "stopped",
    });
    expect(
      await Effect.runPromise(Stream.runCollect(provider.logs({ app, service, plan }, { follow: false }))),
    ).toBeDefined();
    expect(await Effect.runPromise(provider.list({ app, includeUnplanned: true }))).toHaveLength(1);
    expect(await Effect.runPromise(provider.destroy({ app, plan }, { volumes: false }))).toMatchObject({
      kind: "destroyed",
      shutdownObservations: [
        { appId: app, service, containerId: "exact-owned-id", status: "exited", exitCode: 0 },
      ],
    });
    // Then only requested API work happened; no new files or preparation probes.
    expect(requests.some((request) => request.includes("_ping") || request.endsWith("/info"))).toBe(false);
    expect(requests.some((request) => request.startsWith("DELETE "))).toBe(true);
    expect(await readdir(bin)).toEqual([".runtime-installed-version"]);
    expect(await readdir(root)).toEqual(["api.sock", "bin"]);
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["inspect", "list", "getStatus"] as const)(
  "cold managed %s returns a tagged failure without launching or downloading",
  async (operation) => {
    // Given an unavailable endpoint with enough managed paths to permit preparation.
    const root = await mkdtemp(join(tmpdir(), "lando-cold-rescue-"));
    try {
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          platform: "linux",
          runtimeBinDir: join(root, "bin"),
          runtimeConfigDir: join(root, "config"),
          runtimeRunDir: join(root, "run"),
          runtimeStorageDir: join(root, "storage"),
          providerSocketPath: join(root, "missing.sock"),
          providerPidPath: join(root, "podman.pid"),
          sanitizeAppliedPlan: stripHostProxyRunLando,
          artifactDownload: () => Effect.die("cold read must not download"),
          podmanService: {
            launch: () => Effect.die("cold read must not launch"),
            isAlive: () => Effect.succeed(false),
            terminate: () => Effect.void,
          },
        }),
      );
      // When inspecting through the provider surface.
      const request = (() => {
        switch (operation) {
          case "inspect":
            return provider.inspect({ app, service, plan }).pipe(Effect.asVoid);
          case "list":
            return provider.list({}).pipe(Effect.asVoid);
          case "getStatus":
            return provider.getStatus.pipe(Effect.asVoid);
        }
      })();
      const failure = await Effect.runPromise(request.pipe(Effect.flip));
      // Then the transport failure stays tagged and no installation was attempted.
      expect(failure._tag).toBe("ProviderUnavailableError");
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([false, undefined])("starting init:%s does not prepare a sibling's native init", async (init) => {
  const root = await mkdtemp(join(tmpdir(), "lando-start-without-init-"));
  const runtimeBinDir = join(root, "bin");
  const runRoot = join(root, "run");
  const pidPath = join(runRoot, "podman.pid");
  const spec = buildPodmanServiceArgs({
    podmanBin: join(runtimeBinDir, "podman"),
    storageDir: join(root, "storage"),
    configDir: join(root, "config"),
    runRoot,
    socketPath: join(runRoot, "podman.sock"),
  });
  await mkdir(runtimeBinDir);
  await mkdir(runRoot);
  await writeFile(join(runtimeBinDir, ".runtime-installed-version"), "0.1.7");
  await writeFile(pidPath, "4321");
  await writeFile(`${pidPath}.launch.json`, JSON.stringify({ pid: 4321, env: spec.env }));
  const current = plan.services[service];
  if (current === undefined) throw new Error("fixture service missing");
  const { init: _init, ...withoutInit } = current;
  const sibling = ServiceName.make("native-init-sibling");
  const selectedPlan: AppPlan = {
    ...plan,
    services: {
      [service]: { ...withoutInit, ...(init === undefined ? {} : { init }) },
      [sibling]: { ...current, name: sibling, init: true },
    },
  };
  try {
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        runtimeBinDir,
        runtimeConfigDir: join(root, "config"),
        runtimeStorageDir: join(root, "storage"),
        runtimeRunDir: runRoot,
        providerPidPath: pidPath,
        providerSocketPath: join(runRoot, "podman.sock"),
        sanitizeAppliedPlan: stripHostProxyRunLando,
        artifactDownload: () => Effect.die("init:false and unspecified must not download native init"),
        podmanApi: {
          info: Effect.succeed({ version: { Version: "6.0.2" } }),
          ping: Effect.void,
          request: (request) =>
            Effect.succeed(
              request.method === "GET"
                ? {
                    status: 200,
                    body: JSON.stringify({
                      Id: "selected-id",
                      Config: {
                        Labels: {
                          "dev.lando.app": app,
                          "dev.lando.app-root": plan.root,
                          "dev.lando.service": service,
                        },
                      },
                    }),
                  }
                : { status: 204, body: "" },
            ),
        },
        podmanService: {
          launch: () => Effect.die("must reuse owned daemon"),
          isAlive: () => Effect.succeed(true),
          isServiceProcess: () => Effect.succeed(true),
          terminate: () => Effect.die("must not restart current daemon"),
        },
      }),
    );
    await Effect.runPromise(provider.start({ app, service, plan: selectedPlan }));
    expect((await readdir(runtimeBinDir)).includes("catatonit")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
