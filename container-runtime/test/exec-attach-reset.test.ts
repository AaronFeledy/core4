import { expect, test } from "bun:test";
import { Socket } from "node:net";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { DateTime, Effect, Stream } from "effect";
import type { EngineHttpApi } from "../src/engine-api.ts";
import { engineApiFailure } from "../src/engine-errors.ts";
import { exec } from "../src/podman/exec.ts";
import { makeSocketHttpClient, socketHttpConnection } from "../src/transport.ts";

test("preserves stdout and exit zero when the attach socket resets in the response tick", async () => {
  // Given
  const ctx = { providerId: "lando", remediation: "Run lando doctor." } as const;
  const app = AppId.make("attach-reset");
  const service = ServiceName.make("app");
  const provider = ProviderId.make("lando");
  const metadata = {
    source: "exec-attach-reset.test.ts",
    resolvedAt: DateTime.makeUnsafe("2026-10-13T00:00:00Z"),
    runtime: 4 as const,
  };
  const plan: AppPlan = {
    id: app,
    name: "attach-reset",
    slug: "attach-reset",
    root: AbsolutePath.make("/tmp/attach-reset"),
    provider,
    metadata,
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    extensions: {},
    services: {
      [service]: {
        name: service,
        type: "compose",
        provider,
        primary: true,
        artifact: { kind: "ref", ref: "alpine:3.20" },
        environment: {},
        mounts: [],
        storage: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata,
        extensions: {},
      },
    },
  };
  const payload = new TextEncoder().encode("1\n");
  const frame = new Uint8Array(8 + payload.length);
  frame[0] = 1;
  new DataView(frame.buffer).setUint32(4, payload.length);
  frame.set(payload, 8);
  const client = makeSocketHttpClient({
    apiPrefix: "/v6.0.0",
    connect: async () => {
      const socket = new Socket();
      const connection = socketHttpConnection(socket);
      return {
        ...connection,
        write: (data: string | Uint8Array) => {
          if (typeof data !== "string") return;
          queueMicrotask(() => {
            socket.emit("data", new TextEncoder().encode("HTTP/1.1 101 UPGRADED\r\n\r\n"));
            socket.emit("data", frame);
            socket.emit("error", Object.assign(new Error("peer reset"), { code: "ECONNRESET" }));
            socket.emit("close");
          });
        },
        end: () => {},
      };
    },
  });
  const api: EngineHttpApi = {
    request: (input) =>
      Effect.succeed({
        status: 200,
        body: JSON.stringify(input.method === "POST" ? { Id: "exec-1" } : { Running: false, ExitCode: 0 }),
      }),
    stream: (input) =>
      Stream.fromAsyncIterable(client.stream(input), (cause) =>
        engineApiFailure(ctx, "podman-api", input, cause),
      ),
  };
  const stdinStream = {
    async *[Symbol.asyncIterator]() {
      yield new Uint8Array([1]);
    },
  };
  // When
  const result = await Effect.runPromise(
    exec(plan, { app, service }, { command: ["head", "-n", "1"], stdinStream }, { api, ctx }),
  );
  // Then
  expect(result).toEqual({ stdout: "1\n", stderr: "", exitCode: 0 });
});
