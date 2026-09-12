import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Stream } from "effect";

import { makePluginStateStore, makeTestStateStore } from "@lando/core/testing";
import {
  type DockerApiClient,
  type DockerHttpRequest,
  type DockerHttpResponse,
  makeRuntimeProvider,
  persistAppliedPlan,
} from "@lando/provider-docker";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { CommandSpec } from "@lando/sdk/services";
import { ownerOnlyFileAccess } from "./private-file-access.ts";

const providerId = ProviderId.make("docker");
const appId = AppId.make("exec-stdin-app");
const serviceName = ServiceName.make("web");
const containerName = "lando-exec-stdin-app-web";
const createPath = `/containers/${containerName}/exec` as const;
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-08-22T00:00:00Z"),
  source: "provider-docker/exec-stdin.test.ts",
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

const makeFakeApi = () => {
  const calls: DockerHttpRequest[] = [];
  const api: DockerApiClient = {
    info: Effect.succeed({}),
    request: (input) =>
      Effect.sync((): DockerHttpResponse => {
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

const runExec = async (api: DockerApiClient, command: CommandSpec, user?: string) => {
  const appliedPlanState = makePluginStateStore(
    makeTestStateStore().service,
    AbsolutePath.make("/tmp/provider-docker-exec-stdin-state"),
    ownerOnlyFileAccess,
  );
  await Effect.runPromise(persistAppliedPlan(appliedPlanState, plan));
  const provider = await Effect.runPromise(
    makeRuntimeProvider({ platform: "linux", dockerApi: api, appliedPlanState }),
  );
  return Effect.runPromise(
    provider.exec({ app: appId, service: serviceName, ...(user === undefined ? {} : { user }) }, command),
  );
};

const createBody = (calls: ReadonlyArray<DockerHttpRequest>): Record<string, unknown> | undefined => {
  const body = calls.find((call) => call.method === "POST" && call.path === createPath)?.body;
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
};

describe("provider-docker exec AttachStdin", () => {
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

describe("provider-docker exec User", () => {
  test("sets User on the exec-create body when the target has a user", async () => {
    // Given
    const fake = makeFakeApi();

    // When
    await runExec(fake.api, { command: ["true"] }, "www-data");

    // Then
    const body = createBody(fake.calls);
    expect(body).toEqual(expect.objectContaining({ User: "www-data" }));
  });

  test("omits User from the exec-create body when the target has no user", async () => {
    // Given
    const fake = makeFakeApi();

    // When
    await runExec(fake.api, { command: ["true"] });

    // Then
    const body = createBody(fake.calls);
    expect(body).toBeDefined();
    expect(typeof body).toBe("object");
    expect(body).not.toBeNull();
    expect("User" in (body ?? {})).toBe(false);
  });
});
