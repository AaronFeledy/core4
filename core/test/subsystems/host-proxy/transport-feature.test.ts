import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer } from "effect";

import { AbsolutePath, type CommandResultEnvelope } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";

import { RedactionService, createStandaloneRedactor } from "../../../src/redaction/service.ts";
import {
  connectHostProxyRunLando,
  createHostProxyRunLandoSession,
  hostProxyRunLandoFeature,
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

  test("connectHostProxyRunLando rejects closed sessions", async () => {
    const session = await sessionFor();
    await session.close();

    const exit = await runExit(connectHostProxyRunLando(session));

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
