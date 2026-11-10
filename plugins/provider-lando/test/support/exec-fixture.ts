import { DateTime, Effect, Stream } from "effect";

import type {
  EngineHttpRequest,
  EngineHttpResponse,
  PodmanApiClient,
} from "@lando/container-runtime/engine-api";
import { installSupervisedExecFixture } from "@lando/container-runtime/testing/exec-supervision";
import { installNonCompensatingExecUmask } from "@lando/container-runtime/testing/exec-umask";
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

const providerId = ProviderId.make("lando");
export const appId = AppId.make("execapp");
const appRoot = AbsolutePath.make("/tmp/lando-exec-app");
export const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-14T00:00:00Z"),
  source: "exec.integration.test",
  runtime: 4 as const,
};

export const node: ServicePlan = {
  name: ServiceName.make("node"),
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "-e", "setInterval(() => {}, 1000)"],
  environment: {},
  mounts: [
    {
      type: "bind",
      role: "app",
      source: appRoot,
      target: PortablePath.make("/app"),
      readOnly: false,
      excludes: [],
      includes: [],
      realization: "passthrough",
    },
  ],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

export const plan: AppPlan = {
  valueModel: 1,
  id: appId,
  name: "Exec App",
  slug: "execapp",
  root: appRoot,
  provider: providerId,
  services: { [node.name]: node },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const frame = (stream: "stdout" | "stderr", text: string): Uint8Array => {
  const payload = textEncoder.encode(text);
  const output = new Uint8Array(8 + payload.length);
  output[0] = stream === "stdout" ? 1 : 2;
  new DataView(output.buffer).setUint32(4, payload.length, false);
  output.set(payload, 8);
  return output;
};

export const makeFakeApi = (
  exitCode: number,
  stdout: string,
  stderr = "",
  streamOverride?: NonNullable<PodmanApiClient["stream"]>,
) => {
  const calls: EngineHttpRequest[] = [];
  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    ping: Effect.succeed(undefined),
    request: (request) =>
      Effect.sync((): EngineHttpResponse => {
        calls.push(request);
        if (request.method === "GET" && request.path === "/containers/lando-execapp--node/json")
          return { status: 200, body: JSON.stringify({ Id: "lando-execapp--node" }) };
        if (request.method === "POST" && request.path === "/containers/lando-execapp--node/exec") {
          return { status: 201, body: JSON.stringify({ Id: "exec-1" }) };
        }
        if (request.method === "GET" && request.path === "/exec/exec-1/json") {
          return { status: 200, body: JSON.stringify({ ExitCode: exitCode }) };
        }
        if (request.method === "POST" && request.path.startsWith("/exec/exec-1/resize?")) {
          return { status: 200, body: "" };
        }
        if (request.method === "GET" && request.path.startsWith("/containers/json?")) {
          return { status: 200, body: "[]" };
        }
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      }),
    stream: (request) =>
      Stream.suspend(() => {
        calls.push(request);
        request.onResponseHead?.();
        if (streamOverride !== undefined) return streamOverride(request);
        const chunks = [frame("stdout", stdout), ...(stderr.length === 0 ? [] : [frame("stderr", stderr)])];
        return Stream.fromIterable(chunks);
      }),
  };

  installNonCompensatingExecUmask(api);
  installSupervisedExecFixture(api);
  return { api, calls };
};

export const decodeChunks = (chunks: Iterable<ExecChunk>) => {
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
