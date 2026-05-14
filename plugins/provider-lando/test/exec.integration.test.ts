import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Stream } from "effect";

import { bringDown, bringUp, exec, execStream, makePodmanApiClient } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { ExecChunk } from "@lando/sdk/services";
import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "../src/capabilities.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("execapp");
const appRoot = AbsolutePath.make("/tmp/lando-exec-app");
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-14T00:00:00Z"),
  source: "exec.integration.test",
  runtime: 4 as const,
};

const node: ServicePlan = {
  name: ServiceName.make("node"),
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "-e", "setInterval(() => {}, 1000)"],
  environment: {},
  appMount: {
    source: appRoot,
    target: PortablePath.make("/app"),
    readOnly: false,
    excludes: [],
    includes: [],
    realization: "passthrough",
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
  name: "Exec App",
  slug: "execapp",
  root: appRoot,
  provider: providerId,
  services: { [node.name]: node },
  routes: [],
  networks: [],
  stores: [],
  metadata,
  extensions: {},
};

const frame = (stream: "stdout" | "stderr", text: string): Uint8Array => {
  const payload = textEncoder.encode(text);
  const output = new Uint8Array(8 + payload.length);
  output[0] = stream === "stdout" ? 1 : 2;
  output[4] = (payload.length >>> 24) & 0xff;
  output[5] = (payload.length >>> 16) & 0xff;
  output[6] = (payload.length >>> 8) & 0xff;
  output[7] = payload.length & 0xff;
  output.set(payload, 8);
  return output;
};

const makeFakeApi = (exitCode: number, stdout: string, stderr = "") => {
  const calls: PodmanHttpRequest[] = [];
  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    request: (request) =>
      Effect.sync((): PodmanHttpResponse => {
        calls.push(request);
        if (request.method === "POST" && request.path === "/containers/lando-execapp-node/exec") {
          return { status: 201, body: JSON.stringify({ Id: "exec-1" }) };
        }
        if (request.method === "GET" && request.path === "/exec/exec-1/json") {
          return { status: 200, body: JSON.stringify({ ExitCode: exitCode }) };
        }
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      }),
    stream: (request) => {
      calls.push(request);
      const chunks = [frame("stdout", stdout), ...(stderr.length === 0 ? [] : [frame("stderr", stderr)])];
      return Stream.fromIterable(chunks);
    },
  };

  return { api, calls };
};

const decodeChunks = (chunks: Iterable<ExecChunk>) => {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  for (const chunk of chunks) {
    if ("exitCode" in chunk) {
      exitCode = chunk.exitCode;
    } else if (chunk.kind === "stdout") {
      stdout += textDecoder.decode(chunk.chunk);
    } else {
      stderr += textDecoder.decode(chunk.chunk);
    }
  }

  return { exitCode, stdout, stderr };
};

describe("provider-lando exec", () => {
  test("streams stdout chunks and completes with exit code", async () => {
    const fake = makeFakeApi(0, "hi\n");

    const chunks = await Effect.runPromise(
      execStream(
        plan,
        { app: appId, service: node.name },
        { command: ["node", "-e", "console.log('hi')"] },
        { podmanApi: fake.api },
      ).pipe(Stream.runCollect),
    );
    const decoded = decodeChunks(chunks);

    expect(decoded).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "" });
    expect(fake.calls.some((call) => call.path === "/exec/exec-1/start" && call.method === "POST")).toBe(
      true,
    );
  });

  test("resolves nonzero exit as an exit code without stderr", async () => {
    const fake = makeFakeApi(1, "");

    const result = await Effect.runPromise(
      exec(plan, { app: appId, service: node.name }, { command: ["false"] }, { podmanApi: fake.api }),
    );

    expect(result).toEqual({ exitCode: 1, stdout: "", stderr: "" });
  });

  test.skipIf(!process.env.LANDO_TEST_PODMAN_SOCKET)(
    "execs commands in a live Podman service",
    async () => {
      const socketPath = process.env.LANDO_TEST_PODMAN_SOCKET;
      expect(socketPath).toBeTruthy();
      const api = makePodmanApiClient(socketPath ?? "");

      await Effect.runPromise(bringUp(plan, { podmanApi: api }));
      try {
        const chunks = await Effect.runPromise(
          execStream(
            plan,
            { app: appId, service: node.name },
            { command: ["node", "-e", "console.log('hi')"] },
            { podmanApi: api },
          ).pipe(Stream.runCollect),
        );
        const streamed = decodeChunks(chunks);
        const failed = await Effect.runPromise(
          exec(plan, { app: appId, service: node.name }, { command: ["false"] }, { podmanApi: api }),
        );

        expect(streamed.stdout).toContain("hi\n");
        expect(streamed.exitCode).toBe(0);
        expect(failed.exitCode).toBe(1);
        expect(failed.stderr).toBe("");
      } finally {
        await Effect.runPromise(bringDown(plan, { podmanApi: api }));
      }
    },
    60_000,
  );
});
