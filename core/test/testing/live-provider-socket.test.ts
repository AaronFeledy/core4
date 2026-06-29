import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeLandoPaths } from "@lando/core/paths";
import {
  LANDO_TEST_PODMAN_SOCKET_ENV,
  hasLiveProviderSocket,
  resolveLiveProviderSocket,
} from "@lando/core/testing";

const listenOnSocket = (socketPath: string): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(socketPath, () => resolve(server));
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
  });

describe("resolveLiveProviderSocket", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [LANDO_TEST_PODMAN_SOCKET_ENV, "LANDO_USER_DATA_ROOT"] as const;
  let dir: string;
  const servers: Server[] = [];

  beforeEach(async () => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      Reflect.deleteProperty(process.env, key);
    }
    dir = await mkdtemp(join(tmpdir(), "live-socket-"));
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await closeServer(server);
    }
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = savedEnv[key];
    }
    await rm(dir, { recursive: true, force: true });
  });

  test("returns undefined when neither override nor managed socket exists", () => {
    process.env.LANDO_USER_DATA_ROOT = dir;
    expect(resolveLiveProviderSocket()).toBeUndefined();
    expect(hasLiveProviderSocket()).toBe(false);
  });

  test("uses the env override when it is a live socket", async () => {
    process.env.LANDO_USER_DATA_ROOT = dir;
    const overridePath = join(dir, "override.sock");
    servers.push(await listenOnSocket(overridePath));

    process.env[LANDO_TEST_PODMAN_SOCKET_ENV] = overridePath;
    expect(resolveLiveProviderSocket()).toEqual({ socketPath: overridePath, source: "env" });
    expect(hasLiveProviderSocket()).toBe(true);
  });

  test("falls back to the managed Paths socket when the override is unset", async () => {
    process.env.LANDO_USER_DATA_ROOT = dir;
    const managedSocketPath = makeLandoPaths().providerSocketPath;
    await mkdir(join(dir, "runtime", "run"), { recursive: true });
    servers.push(await listenOnSocket(managedSocketPath));

    expect(resolveLiveProviderSocket()).toEqual({ socketPath: managedSocketPath, source: "paths" });
    expect(hasLiveProviderSocket()).toBe(true);
  });

  test("ignores the override when it points at a non-socket path and falls back to Paths", async () => {
    process.env.LANDO_USER_DATA_ROOT = dir;
    const regularFile = join(dir, "not-a-socket");
    await writeFile(regularFile, "");
    process.env[LANDO_TEST_PODMAN_SOCKET_ENV] = regularFile;

    const managedSocketPath = makeLandoPaths().providerSocketPath;
    await mkdir(join(dir, "runtime", "run"), { recursive: true });
    servers.push(await listenOnSocket(managedSocketPath));

    expect(resolveLiveProviderSocket()).toEqual({ socketPath: managedSocketPath, source: "paths" });
  });

  test("ignores an empty override", async () => {
    process.env.LANDO_USER_DATA_ROOT = dir;
    process.env[LANDO_TEST_PODMAN_SOCKET_ENV] = "";
    expect(resolveLiveProviderSocket()).toBeUndefined();
  });
});
