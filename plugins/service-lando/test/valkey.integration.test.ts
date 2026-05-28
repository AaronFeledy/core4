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

import { valkeyServiceType } from "../src/services/valkey.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("valkeyinttest");
const VALKEY_PORT = 31279;

const metadata = {
  resolvedAt: "2026-05-28T00:00:00Z",
  source: "valkey.integration.test",
  runtime: 4 as const,
};

/**
 * Send a single Valkey/RESP command over the Valkey TCP endpoint. The integration
 * boots `valkey/valkey:8` which speaks the Redis Serialization Protocol (RESP),
 * so we hand-encode the inline command form (`PING\r\n`, `SET foo bar\r\n`,
 * `GET foo\r\n`) and parse the first RESP reply byte to know when the response
 * is complete.
 *
 * - `+` → simple string ending at the first `\r\n` (used by `PING`, `SET`).
 * - `$` → bulk string with a length prefix; we read until two `\r\n` markers
 *   appear, the first terminating the length line and the second the payload.
 * - `-` → error reply ending at the first `\r\n`.
 */
const sendValkeyCommand = (port: number, command: string): Promise<string> =>
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

    const isComplete = (response: string): boolean => {
      if (response.length === 0) return false;
      const first = response.charCodeAt(0);
      // `+` simple string or `-` error → single line terminated by \r\n
      if (first === 0x2b /* + */ || first === 0x2d /* - */) return response.includes("\r\n");
      // `$` bulk string → length line + payload + \r\n
      if (first === 0x24 /* $ */) {
        const firstCrlf = response.indexOf("\r\n");
        if (firstCrlf === -1) return false;
        const length = Number.parseInt(response.slice(1, firstCrlf), 10);
        if (Number.isNaN(length)) return false;
        if (length === -1) return true; // nil bulk string `$-1\r\n`
        return response.length >= firstCrlf + 2 + length + 2;
      }
      // Fallback: any line terminator (covers `:` integer replies).
      return response.includes("\r\n");
    };

    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => finish(new Error(`Timed out waiting for valkey response to ${command}`)));
    socket.on("data", (chunk) => {
      output += chunk;
      if (isComplete(output)) finish();
    });
    socket.on("error", (err) => finish(err));
    socket.on("close", () => {
      if (!settled) finish(new Error(`Valkey connection closed before complete response: ${output}`));
    });
  });

const waitForValkey = async (port: number, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const output = await sendValkeyCommand(port, "PING\r\n");
      expect(output).toMatch(/^\+PONG/);
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Valkey endpoint not ready on ${port} within ${timeoutMs}ms: ${String(lastError)}`);
};

describe("valkey service type — live integration: RESP ping/set/get", () => {
  test.skipIf(!process.env.LANDO_TEST_PODMAN_SOCKET)(
    "boots Valkey and pings/sets/gets a key through the exposed RESP endpoint",
    async () => {
      const socketPath = process.env.LANDO_TEST_PODMAN_SOCKET ?? "";
      expect(socketPath).toBeTruthy();

      const appRootStr = await mkdtemp(join(tmpdir(), "lando-valkey-int-"));
      try {
        const landofile = Schema.decodeUnknownSync(LandofileShape)({
          name: "valkeyinttest",
          services: { cache: { type: "valkey", port: VALKEY_PORT } },
        });
        const service = landofile.services?.[ServiceName.make("cache")];
        if (service === undefined) throw new Error("cache service missing");

        const appRoot = AbsolutePath.make(appRootStr);
        const cache = valkeyServiceType.toServicePlan({
          name: "cache",
          service,
          appRoot: appRootStr,
          metadata,
        });
        const plan: AppPlan = {
          id: appId,
          name: "Valkey Integration App",
          slug: "valkeyinttest",
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

          await waitForValkey(VALKEY_PORT, 60_000);

          const pingOutput = await sendValkeyCommand(VALKEY_PORT, "PING\r\n");
          expect(pingOutput).toBe("+PONG\r\n");

          const setOutput = await sendValkeyCommand(VALKEY_PORT, "SET foo bar\r\n");
          expect(setOutput).toBe("+OK\r\n");

          const getOutput = await sendValkeyCommand(VALKEY_PORT, "GET foo\r\n");
          expect(getOutput).toBe("$3\r\nbar\r\n");
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
