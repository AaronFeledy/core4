import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Stream } from "effect";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { CommandSpec } from "@lando/sdk/services";

import type { EngineHttpApi, EngineHttpRequest, EngineHttpResponse } from "../src/engine-api.ts";
import { exec } from "../src/podman/exec.ts";

const ctx = { providerId: "podman", remediation: "Run `lando setup` and retry." } as const;
const providerId = ProviderId.make("lando");
const appId = AppId.make("exec-stdin-app");
const serviceName = ServiceName.make("web");
const containerName = "lando-exec-stdin-app-web";
const createPath = `/containers/${containerName}/exec` as const;
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-08-22T00:00:00Z"),
  source: "container-runtime/exec-stdin.test.ts",
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
  const calls: EngineHttpRequest[] = [];
  const api: EngineHttpApi = {
    request: (input) =>
      Effect.sync((): EngineHttpResponse => {
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

const runExec = (api: EngineHttpApi, command: CommandSpec) =>
  Effect.runPromise(exec(plan, target, command, { api, ctx }));

const createBody = (calls: ReadonlyArray<EngineHttpRequest>) =>
  calls.find((call) => call.method === "POST" && call.path === createPath)?.body;

describe("podman exec AttachStdin", () => {
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

describe("podman exec error context", () => {
  test("tags a missing-api failure with the caller provider id and remediation", async () => {
    // Given a caller context for the podman provider and no engine API client
    // When
    const error = await Effect.runPromise(
      exec(plan, target, { command: ["true"] }, { ctx }).pipe(Effect.flip),
    );

    // Then
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error.providerId).toBe("podman");
    expect(error.message).toContain("provider-podman");
    expect(error.remediation).toBe(ctx.remediation);
  });
});
