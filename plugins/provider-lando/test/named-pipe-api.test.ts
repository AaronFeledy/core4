import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect, Stream } from "effect";

import { makePodmanApiClient } from "../src/capabilities.ts";

interface IpcFixture {
  readonly endpoint: string;
  readonly requests: string[];
}

const withIpcServer = async <A>(action: (fixture: IpcFixture) => Promise<A>): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), "lando-npipe-api-"));
  const socketPath = join(root, "podman.sock");
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method ?? ""} ${request.url ?? ""}`);
    response.setHeader("content-type", "application/json");
    if (request.url === "/v6.0.0/libpod/info") {
      response.end('{"host":{"arch":"x64"}}');
      return;
    }
    if (request.url === "/v6.0.0/libpod/_ping") {
      response.end("OK");
      return;
    }
    if (request.url === "/v6.0.0/libpod/events") {
      response.end('{"status":"start"}\n');
      return;
    }
    response.end('{"Version":"6.0.1"}');
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    return await action({ endpoint: `npipe:${socketPath}`, requests });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
    );
    await rm(root, { recursive: true, force: true });
  }
};

describe("provider-lando named-pipe Podman API", () => {
  test("pings over the normalized IPC endpoint", async () => {
    await withIpcServer(async ({ endpoint, requests }) => {
      const client = makePodmanApiClient(endpoint);

      await Effect.runPromise(client.ping);

      expect(requests).toEqual(["GET /v6.0.0/libpod/_ping"]);
    });
  });

  test("reads info over the normalized IPC endpoint", async () => {
    await withIpcServer(async ({ endpoint, requests }) => {
      const client = makePodmanApiClient(endpoint);

      const info = await Effect.runPromise(client.info);

      expect(info).toEqual({ host: { arch: "x64" } });
      expect(requests).toEqual(["GET /v6.0.0/libpod/info"]);
    });
  });

  test("sends ordinary requests over the normalized IPC endpoint", async () => {
    await withIpcServer(async ({ endpoint, requests }) => {
      const request = makePodmanApiClient(endpoint).request;
      if (request === undefined) throw new Error("provider-lando request client is missing");

      const response = await Effect.runPromise(request({ method: "GET", path: "/libpod/version" }));

      expect(response).toEqual({ status: 200, body: '{"Version":"6.0.1"}' });
      expect(requests).toEqual(["GET /v6.0.0/libpod/version"]);
    });
  });

  test("streams responses over the normalized IPC endpoint", async () => {
    await withIpcServer(async ({ endpoint, requests }) => {
      const stream = makePodmanApiClient(endpoint).stream;
      if (stream === undefined) throw new Error("provider-lando stream client is missing");

      const chunks = await Effect.runPromise(
        stream({ method: "GET", path: "/libpod/events" }).pipe(Stream.runCollect),
      );

      expect(Array.from(chunks, (chunk) => new TextDecoder().decode(chunk)).join("")).toBe(
        '{"status":"start"}\n',
      );
      expect(requests).toEqual(["GET /v6.0.0/libpod/events"]);
    });
  });
});
