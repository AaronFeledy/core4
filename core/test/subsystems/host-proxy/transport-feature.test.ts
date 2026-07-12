import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect, Exit, Layer } from "effect";

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

import { RedactionService, createStandaloneRedactor } from "../../../src/redaction/service.ts";
import {
  HOST_PROXY_CONTAINER_LANDO,
  HOST_PROXY_CONTAINER_SHIM,
  HOST_PROXY_CONTAINER_SOCKET,
  HOST_PROXY_TRANSPORT_EXTENSION_KEY,
  connectHostProxyRunLando,
  createHostProxyRunLandoSession,
  hostProxyRunLandoFeature,
  stripHostProxyRunLando,
} from "../../../src/subsystems/host-proxy/transport.ts";

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
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "host-proxy-transport-feature.test",
  runtime: 4 as const,
};

const fakeExecutable = async (): Promise<string> => {
  const path = join(await tempRoot(), "lando-shim");
  await writeFile(path, "#!/usr/bin/env sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
};

const redactionLayer = Layer.succeed(RedactionService, {
  forProfile: (profile, options) => Effect.succeed(createStandaloneRedactor(profile, options)),
});
const eventLayer = Layer.succeed(EventService, {
  publish: () => Effect.void,
  subscribe: () => Effect.die("unused"),
  waitFor: () => Effect.die("unused"),
} as never);
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
      executor: () => Effect.succeed({ envelope, exitCode: 0 }),
      paths: { userCacheRoot: await tempRoot(), userDataRoot: await tempRoot() },
      shimArtifactPath: await fakeExecutable(),
    }),
  );

describe("hostProxyRunLandoFeature", () => {
  test("injects least-privilege socket and shim mounts plus auth env", async () => {
    const session = await sessionFor();
    const environment: Record<string, string> = {};
    const mounts: Array<{
      readonly type: "bind";
      readonly source: string;
      readonly target: string;
      readonly readOnly: boolean;
      readonly realization: "passthrough";
    }> = [];
    const service = {
      addEnv: (name: string, value: string) => {
        environment[name] = value;
      },
      addMount: (mountValue: {
        readonly type: "bind";
        readonly source: string;
        readonly target: string;
        readonly readOnly: boolean;
        readonly realization: "passthrough";
      }) => {
        mounts.push(mountValue);
      },
    };

    hostProxyRunLandoFeature(session).apply(service);

    expect(environment.LANDO_HOST_PROXY_SOCKET).toBe("/run/lando/host-proxy.sock");
    expect(environment.LANDO_HOST_PROXY_TOKEN).toBe(session.token);
    expect(mounts).toEqual([
      {
        type: "bind",
        source: session.socketPath,
        target: "/run/lando/host-proxy.sock",
        readOnly: true,
        realization: "passthrough",
      },
      {
        type: "bind",
        source: session.shimPath,
        target: "/usr/local/lib/lando/host-proxy-client",
        readOnly: true,
        realization: "passthrough",
      },
      {
        type: "bind",
        source: session.shimPath,
        target: "/usr/local/bin/lando",
        readOnly: true,
        realization: "passthrough",
      },
    ]);
    await session.close();
  });

  test("exposes TCP host-gateway URL without socket metadata or host-gateway mapping", () => {
    const environment: Record<string, string> = {};
    const mounts: Array<{ readonly target: string }> = [];
    const service = {
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
    expect(environment.LANDO_HOST_PROXY_TOKEN).toBe("secret-token");
    expect(mounts).not.toContainEqual(expect.objectContaining({ target: "/run/lando/host-proxy.sock" }));
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
        {
          type: "bind" as const,
          source: "/tmp/host-proxy.sock",
          target: PortablePath.make(HOST_PROXY_CONTAINER_SOCKET),
          readOnly: true,
          realization: "passthrough" as const,
        },
        {
          type: "bind" as const,
          source: "/tmp/lando-shim",
          target: PortablePath.make(HOST_PROXY_CONTAINER_SHIM),
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
          source: "app-data",
          target: PortablePath.make("/data"),
          readOnly: false,
          realization: "passthrough" as const,
        },
      ],
      storage: [],
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
      services: { web: service },
      routes: [],
      networks: [],
      stores: [],
      fileSync: [],
      metadata,
      extensions: {},
    } satisfies AppPlan);

    const strippedWeb = stripped.services.web;
    expect(strippedWeb?.environment).toEqual({ LANDO_APP_NAME: "demo" });
    expect(strippedWeb?.mounts).toEqual([
      {
        type: "volume",
        source: "app-data",
        target: "/data",
        readOnly: false,
        realization: "passthrough",
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
