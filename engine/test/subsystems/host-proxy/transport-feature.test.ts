import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type CommandResultEnvelope,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { DateTime, Effect, Exit, Layer, Stream } from "effect";
import { hostProxyContainerGeneration } from "../../../src/subsystems/host-proxy/run-directory.ts";
import {
  HOST_PROXY_CONTAINER_LANDO,
  HOST_PROXY_CONTAINER_SOCKET,
  HOST_PROXY_TRANSPORT_EXTENSION_KEY,
  connectHostProxyRunLando,
  createHostProxyRunLandoSession,
  hostProxyRunLandoFeature,
  stripHostProxyRunLando,
} from "../../../src/subsystems/host-proxy/transport.ts";
import { HOST_PROXY_CONTAINER_BRIDGE_SOCKET } from "../../../src/subsystems/host-proxy/transport-feature.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const tempRoot = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-host-proxy-feature-"));
  tempDirs.push(dir);
  return dir;
};

const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make("/srv/apps/demo") };
const mount = { containerRoot: "/app", hostRoot: "/srv/apps/demo" };
const envelope: CommandResultEnvelope = {
  apiVersion: "v4",
  command: "app:open",
  ok: true,
  result: { app: "demo", targets: [], launch: "printed" },
  warnings: [],
  deprecations: [],
};
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-15T00:00:00Z"),
  source: "host-proxy-transport-feature.test",
  runtime: 4 as const,
};

const fakeExecutable = async (): Promise<string> => {
  const path = join(await tempRoot(), "lando-shim");
  await writeFile(path, "#!/usr/bin/env sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
};

const redactionLayer = Layer.succeed(
  RedactionService,
  RedactionService.of({
    ...makeRedactionService(),
  }),
);
const eventLayer = Layer.succeed(
  EventService,
  EventService.of({
    publish: () => Effect.void,
    subscribe: () => Stream.die("unused"),
    subscribeQueue: Effect.die("unused"),
    subscribeWithHistory: () => Effect.never,
    waitForAny: () => Effect.die("unused"),
    query: () => Effect.die("unused"),
    waitFor: () => Effect.die("unused"),
  }),
);
const run = <Value, Error>(program: Effect.Effect<Value, Error, EventService | RedactionService>) =>
  Effect.runPromise(program.pipe(Effect.provide(Layer.mergeAll(redactionLayer, eventLayer))));
const runExit = <Value, Error>(program: Effect.Effect<Value, Error, EventService | RedactionService>) =>
  Effect.runPromiseExit(program.pipe(Effect.provide(Layer.mergeAll(redactionLayer, eventLayer))));

const sessionFor = async () =>
  run(
    createHostProxyRunLandoSession({
      app,
      mountInfo: mount,
      allowlist: ["app:open"],
      callerService: "web",
      executor: () => Effect.succeed({ stdout: JSON.stringify(envelope), stderr: "", exitCode: 0 }),
      paths: { userCacheRoot: await tempRoot(), userDataRoot: await tempRoot() },
      shimArtifactPath: await fakeExecutable(),
    }),
  );

describe("hostProxyRunLandoFeature", () => {
  test("binds the container-facing directory and shim without auth env", async () => {
    const session = await sessionFor();
    if (session.shimPath === undefined) throw new TypeError("host-proxy shim path is missing");
    if (session.socketPath === undefined) throw new TypeError("host-proxy socket path is missing");
    const environment: Record<string, string> = {};
    const extensions: Record<string, unknown> = {};
    const mounts: Array<{
      readonly type: "bind";
      readonly origin: "integration";
      readonly source: string;
      readonly target: string;
      readonly readOnly: boolean;
      readonly realization: "passthrough";
    }> = [];
    const service = {
      addExtension: (name: string, value: { readonly contractDigest: string }) => {
        extensions[name] = value;
      },
      addEnv: (name: string, value: string) => {
        environment[name] = value;
      },
      addMount: (mountValue: {
        readonly type: "bind";
        readonly origin: "integration";
        readonly source: string;
        readonly target: string;
        readonly readOnly: boolean;
        readonly realization: "passthrough";
      }) => {
        mounts.push(mountValue);
      },
    };

    hostProxyRunLandoFeature(session).apply(service);

    const containerDir = join(dirname(session.shimPath), "container");
    expect(session.socketPath).toBe(join(containerDir, "sock"));
    // The bound directory exposes only container-facing files; the shim and worker state stay outside it.
    expect((await readdir(containerDir)).sort()).toEqual([".generation", "credentials", "sock"]);
    expect(environment.LANDO_HOST_PROXY_SOCKET).toBe("/run/lando/host-proxy/sock");
    expect(environment.LANDO_HOST_PROXY_TOKEN).toBeUndefined();
    expect(environment.LANDO_HOST_PROXY_SESSION).toBeUndefined();
    expect(environment.LANDO_HOST_PROXY_APP).toBeUndefined();
    expect(extensions[HOST_PROXY_TRANSPORT_EXTENSION_KEY]).toEqual({
      contractDigest: expect.stringMatching(/^[a-f0-9]{16}$/u),
    });
    expect(mounts).toEqual([
      {
        type: "bind",
        source: containerDir,
        origin: "integration",
        target: "/run/lando/host-proxy",
        readOnly: true,
        realization: "passthrough",
      },
      {
        type: "bind",
        source: session.shimPath,
        origin: "integration",
        target: "/usr/local/bin/lando",
        readOnly: true,
        realization: "passthrough",
      },
      ...["/usr/local/bin/xdg-open", "/usr/local/bin/open"].map((target) => ({
        type: "bind" as const,
        source: session.shimPath,
        origin: "integration" as const,
        target,
        readOnly: true,
        realization: "passthrough" as const,
      })),
    ]);
    await session.close();
  });

  test("file-binds a guest Unix socket even when the Windows worker retains a loopback control URL", () => {
    const environment: Record<string, string> = {};
    const mounts: Array<{ readonly source: string; readonly target: string }> = [];
    hostProxyRunLandoFeature({
      appId: "demo",
      sessionId: "session-1",
      token: "secret-token",
      url: "http://127.0.0.1:49152",
      socketPath: "/home/user/.local/share/lando/host-proxy/session/host-proxy.sock",
      shimPath: "C:\\lando\\shim",
      transport: "unix-socket",
    }).apply({
      addExtension: () => undefined,
      addEnv: (name, value) => {
        environment[name] = value;
      },
      addMount: (mount) => {
        mounts.push(mount);
      },
    });
    expect(environment.LANDO_HOST_PROXY_SOCKET).toBe(HOST_PROXY_CONTAINER_BRIDGE_SOCKET);
    expect(environment.LANDO_HOST_PROXY_URL).toBeUndefined();
    expect(mounts).toContainEqual(
      expect.objectContaining({
        source: "/home/user/.local/share/lando/host-proxy/session/host-proxy.sock",
        target: HOST_PROXY_CONTAINER_BRIDGE_SOCKET,
      }),
    );
    expect(mounts).toContainEqual(
      expect.objectContaining({
        source: "C:\\lando\\container",
        target: "/run/lando/host-proxy",
        readOnly: true,
      }),
    );
  });
  test("exposes TCP host-gateway URL without socket metadata or host-gateway mapping", () => {
    const environment: Record<string, string> = {};
    const mounts: Array<{ readonly target: string }> = [];
    const service = {
      addExtension: () => undefined,
      addEnv: (name: string, value: string) => {
        environment[name] = value;
      },
      addMount: (mountValue: { readonly target: string }) => {
        mounts.push(mountValue);
      },
    };

    hostProxyRunLandoFeature({
      appId: "demo",
      sessionId: "session-1",
      token: "secret-token",
      url: "http://127.0.0.1:49152",
      containerUrl: "http://host.containers.internal:49152",
      shimPath: "C:\\Users\\me\\AppData\\Local\\Lando\\Data\\run\\demo\\lando.exe",
      transport: "tcp-host-gateway",
    }).apply(service);

    expect(environment.LANDO_HOST_PROXY_TRANSPORT).toBe("tcp-host-gateway");
    expect(environment.LANDO_HOST_PROXY_URL).toBe("http://host.containers.internal:49152");
    expect(environment.LANDO_HOST_PROXY_SOCKET).toBeUndefined();
    expect(environment.LANDO_HOST_PROXY_TOKEN).toBeUndefined();
    expect(environment.LANDO_HOST_PROXY_SESSION).toBeUndefined();
    expect(environment.LANDO_HOST_PROXY_APP).toBeUndefined();
    expect(mounts).toContainEqual(
      expect.objectContaining({
        target: "/run/lando/host-proxy",
        source: "C:\\Users\\me\\AppData\\Local\\Lando\\Data\\run\\demo\\container",
        readOnly: true,
      }),
    );
    expect(mounts).not.toContainEqual(
      expect.objectContaining({ target: HOST_PROXY_CONTAINER_BRIDGE_SOCKET }),
    );
  });

  test.each(["kept", "recreated"] as const)(
    "a new session in a %s container directory keeps the contract only when the directory is kept",
    async (directory) => {
      // Given two consecutive sessions for one app and data root.
      const paths = { userCacheRoot: await tempRoot(), userDataRoot: await tempRoot() };
      const shimArtifactPath = await fakeExecutable();
      const open = async () => {
        const session = await run(
          createHostProxyRunLandoSession({
            app,
            mountInfo: mount,
            allowlist: ["app:open"],
            callerService: "web",
            executor: () => Effect.succeed({ stdout: JSON.stringify(envelope), stderr: "", exitCode: 0 }),
            paths,
            shimArtifactPath,
          }),
        );
        // The worker manager stamps the generation the same way after a session is ready.
        return {
          ...session,
          containerGeneration: await hostProxyContainerGeneration(dirname(session.shimPath)),
        };
      };
      const contractOf = (session: Parameters<typeof hostProxyRunLandoFeature>[0]) => {
        const extensions: Record<string, unknown> = {};
        hostProxyRunLandoFeature(session).apply({
          addEnv: () => undefined,
          addMount: () => undefined,
          addExtension: (name, value) => {
            extensions[name] = value;
          },
        });
        return extensions[HOST_PROXY_TRANSPORT_EXTENSION_KEY];
      };
      const first = await open();
      const firstContract = contractOf(first);
      await first.close();
      // When the next session starts, after something deleted the whole run directory or not.
      if (directory === "recreated") await rm(dirname(first.shimPath), { recursive: true, force: true });
      const second = await open();
      // Then a kept directory keeps the digest, so a running container's bind still reaches the new
      // session; a recreated one at the same path changes it, so bring-up recreates the container.
      expect(second.sessionId).not.toBe(first.sessionId);
      expect(second.socketPath).toBe(first.socketPath);
      if (directory === "kept") {
        expect(second.containerGeneration).toBe(first.containerGeneration);
        expect(contractOf(second)).toEqual(firstContract);
      } else {
        expect(second.containerGeneration).not.toBe(first.containerGeneration);
        expect(contractOf(second)).not.toEqual(firstContract);
      }
      const credentials = await Bun.file(join(dirname(second.shimPath), "container", "credentials")).json();
      expect(credentials).toMatchObject({ session: second.sessionId });
      await second.close();
    },
  );

  test("the contract digest changes when what containers see changes", () => {
    const base = {
      appId: "demo",
      sessionId: "session-1",
      token: "secret-token",
      socketPath: "/data/run/demo/container/sock",
      shimPath: "/data/run/demo/lando",
      transport: "unix-socket" as const,
    };
    const digestOf = (session: Parameters<typeof hostProxyRunLandoFeature>[0]) => {
      let digest = "";
      hostProxyRunLandoFeature(session).apply({
        addEnv: () => undefined,
        addMount: () => undefined,
        addExtension: (_name, value) => {
          digest = value.contractDigest;
        },
      });
      return digest;
    };
    const current = digestOf(base);
    expect(digestOf({ ...base, sessionId: "session-2", token: "other" })).toBe(current);
    expect(digestOf({ ...base, shimDigest: "sha256:rebuilt" })).not.toBe(current);
    expect(digestOf({ ...base, containerGeneration: "a".repeat(32) })).not.toBe(
      digestOf({ ...base, containerGeneration: "b".repeat(32) }),
    );
    expect(digestOf({ ...base, socketPath: "/guest/session-2/host-proxy.sock" })).not.toBe(current);
    expect(
      digestOf({
        ...base,
        socketPath: "/data2/run/demo/container/sock",
        shimPath: "/data2/run/demo/lando",
      }),
    ).not.toBe(current);
    expect(
      digestOf({ ...base, transport: "tcp-host-gateway", containerUrl: "http://host.containers.internal:1" }),
    ).not.toBe(current);
  });

  test("strips runLando auth env, mounts, and extensions from a persisted plan", () => {
    const service: ServicePlan = {
      name: ServiceName.make("web"),
      type: "lando",
      provider: ProviderId.make("lando"),
      primary: true,
      artifact: { kind: "ref" as const, ref: "node:22-alpine" },
      command: [],
      environment: {
        LANDO_APP_NAME: "demo",
        LANDO_HOST_PROXY_TRANSPORT: "unix-socket",
        LANDO_HOST_PROXY_SOCKET: HOST_PROXY_CONTAINER_SOCKET,
        LANDO_HOST_PROXY_TOKEN: "secret-token",
        LANDO_HOST_PROXY_SESSION: "session-id",
        LANDO_HOST_PROXY_APP: "demo",
        LANDO_HOST_PROXY_DEPTH: "0",
      },
      mounts: [
        ...["/usr/local/bin/xdg-open", "/usr/local/bin/open", HOST_PROXY_CONTAINER_BRIDGE_SOCKET].map(
          (target) => ({
            type: "bind" as const,
            source: "/tmp/lando-shim",
            target: PortablePath.make(target),
            readOnly: true,
            realization: "passthrough" as const,
          }),
        ),
        {
          type: "bind" as const,
          source: "/tmp/run/container",
          target: PortablePath.make("/run/lando/host-proxy"),
          readOnly: true,
          realization: "passthrough" as const,
        },
        {
          type: "bind" as const,
          source: "/tmp/lando-shim",
          target: PortablePath.make(HOST_PROXY_CONTAINER_LANDO),
          readOnly: true,
          realization: "passthrough" as const,
        },
        {
          type: "volume" as const,
          store: "app-data",
          target: PortablePath.make("/data"),
          readOnly: false,
        },
      ],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: { [HOST_PROXY_TRANSPORT_EXTENSION_KEY]: { sessionId: "session-id" }, keep: true },
    };

    const stripped = stripHostProxyRunLando({
      id: AppId.make("demo"),
      name: "Demo",
      slug: "demo",
      root: AbsolutePath.make("/tmp/demo"),
      provider: ProviderId.make("lando"),
      services: { [ServiceName.make("web")]: service },
      routes: [],
      stores: [],
      fileSync: [],
      metadata,
      extensions: {},
    } satisfies AppPlan);

    const strippedWeb = stripped.services[ServiceName.make("web")];
    expect(strippedWeb?.environment).toEqual({ LANDO_APP_NAME: "demo" });
    expect(strippedWeb?.mounts).toEqual([
      {
        type: "volume",
        store: "app-data",
        target: PortablePath.make("/data"),
        readOnly: false,
      },
    ]);
    expect(strippedWeb?.extensions).toEqual({ keep: true });
  });

  test("connectHostProxyRunLando rejects closed sessions", async () => {
    const session = await sessionFor();
    await session.close();

    const exit = await runExit(connectHostProxyRunLando(session));

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
