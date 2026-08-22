import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Stream } from "effect";

import { exec } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { CommandSpec } from "@lando/sdk/services";
import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "../src/capabilities.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("exec-stdin-app");
const serviceName = ServiceName.make("web");
const containerName = "lando-exec-stdin-app-web";
const createPath = `/containers/${containerName}/exec` as const;
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-08-22T00:00:00Z"),
  source: "provider-lando/exec-stdin.test.ts",
  runtime: 4 as const,
};

const service: ServicePlan = {
  name: serviceName,
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  environment: {},
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
  name: "Exec Stdin App",
  slug: "exec-stdin-app",
  root: AbsolutePath.make("/tmp/exec-stdin-app"),
  provider: providerId,
  services: { [serviceName]: service },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const target = { app: appId, service: serviceName };

const makeFakeApi = () => {
  const calls: PodmanHttpRequest[] = [];
  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    ping: Effect.void,
    request: (input) =>
      Effect.sync((): PodmanHttpResponse => {
        calls.push(input);
        if (input.method === "POST" && input.path === createPath) {
          return { status: 201, body: JSON.stringify({ Id: "exec-1" }) };
        }
        if (input.method === "GET" && input.path === "/exec/exec-1/json") {
          return { status: 200, body: JSON.stringify({ ExitCode: 0 }) };
        }
        return { status: 500, body: `unexpected ${input.method} ${input.path}` };
      }),
    stream: (input) => {
      calls.push(input);
      return Stream.empty;
    },
  };
  return { api, calls };
};

const oneChunkStdin = async function* (): AsyncIterable<Uint8Array> {
  yield new Uint8Array([0x61]);
};

const runExec = (api: PodmanApiClient, command: CommandSpec) =>
  Effect.runPromise(exec(plan, target, command, { podmanApi: api }));

const createBody = (calls: ReadonlyArray<PodmanHttpRequest>) =>
  calls.find((call) => call.method === "POST" && call.path === createPath)?.body;

describe("provider-lando exec AttachStdin", () => {
  test("sets AttachStdin true when only stdinStream is provided", async () => {
    // Given
    const fake = makeFakeApi();

    // When
    await runExec(fake.api, { command: ["cat"], stdinStream: oneChunkStdin() });

    // Then
    expect(createBody(fake.calls)).toMatchObject({ AttachStdin: true });
  });

  test("sets AttachStdin true when stdin is inherit", async () => {
    // Given
    const fake = makeFakeApi();

    // When
    await runExec(fake.api, { command: ["cat"], stdin: "inherit" });

    // Then
    expect(createBody(fake.calls)).toMatchObject({ AttachStdin: true });
  });

  test("sets AttachStdin false when command has no stdin source", async () => {
    // Given
    const fake = makeFakeApi();

    // When
    await runExec(fake.api, { command: ["true"] });

    // Then
    expect(createBody(fake.calls)).toMatchObject({ AttachStdin: false });
  });
});
