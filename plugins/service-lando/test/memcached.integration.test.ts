import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bringDown, bringUp, makePodmanApiClient } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LandofileShape,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

import { memcachedServiceType } from "../src/services/memcached.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("memcachedinttest");
const MEMCACHED_PORT = 31285;

const metadata = {
  resolvedAt: "2026-05-28T00:00:00Z",
  source: "memcached.integration.test",
  runtime: 4 as const,
};

const sendMemcachedCommand = (
  port: number,
  command: string,
  isDone: (output: string) => boolean,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => socket.write(command));
    let output = "";
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err !== undefined) reject(err);
      else resolve(output);
    };

    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () =>
      finish(new Error(`Timed out waiting for memcached response to ${command}`)),
    );
    socket.on("data", (chunk) => {
      output += chunk;
      if (isDone(output)) finish();
    });
    socket.on("error", (err) => finish(err));
    socket.on("close", () => {
      if (!settled) finish(new Error(`Memcached connection closed before complete response: ${output}`));
    });
  });

const waitForMemcached = async (port: number, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const output = await sendMemcachedCommand(port, "version\r\n", (response) =>
        response.startsWith("VERSION "),
      );
      expect(output).toMatch(/^VERSION /);
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Memcached endpoint not ready on ${port} within ${timeoutMs}ms: ${String(lastError)}`);
};

describe("memcached service type — live integration: text protocol set/get", () => {
  test.skipIf(!process.env.LANDO_TEST_PODMAN_SOCKET)(
    "boots Memcached and sets/gets a key through the exposed text protocol endpoint",
    async () => {
      const socketPath = process.env.LANDO_TEST_PODMAN_SOCKET ?? "";
      expect(socketPath).toBeTruthy();

      const appRootStr = await mkdtemp(join(tmpdir(), "lando-memcached-int-"));
      try {
        const landofile = Schema.decodeUnknownSync(LandofileShape)({
          name: "memcachedinttest",
          services: { cache: { type: "memcached", port: MEMCACHED_PORT } },
        });
        const service = landofile.services?.[ServiceName.make("cache")];
        if (service === undefined) throw new Error("cache service missing");

        const appRoot = AbsolutePath.make(appRootStr);
        const cache = memcachedServiceType.toServicePlan({
          name: "cache",
          service,
          appRoot: appRootStr,
          metadata,
        });
        const plan: AppPlan = {
          id: appId,
          name: "Memcached Integration App",
          slug: "memcachedinttest",
          root: appRoot,
          provider: providerId,
          services: { [cache.name]: cache },
          routes: [],
          networks: [],
          stores: [],
          metadata: cache.metadata,
          extensions: {},
        };

        const api = makePodmanApiClient(socketPath);
        try {
          const applied = await Effect.runPromise(bringUp(plan, { podmanApi: api }));
          expect(applied.changed).toBe(true);

          await waitForMemcached(MEMCACHED_PORT, 60_000);
          const setOutput = await sendMemcachedCommand(MEMCACHED_PORT, "set foo 0 0 3\r\nbar\r\n", (output) =>
            output.endsWith("STORED\r\n"),
          );
          expect(setOutput).toBe("STORED\r\n");

          const getOutput = await sendMemcachedCommand(MEMCACHED_PORT, "get foo\r\n", (output) =>
            output.endsWith("END\r\n"),
          );
          expect(getOutput).toBe("VALUE foo 0 3\r\nbar\r\nEND\r\n");
        } finally {
          await Effect.runPromise(Effect.either(bringDown(plan, { podmanApi: api })));
        }
      } finally {
        await rm(appRootStr, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
