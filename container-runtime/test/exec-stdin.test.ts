import { describe, expect, test } from "bun:test";
import { DateTime, Duration, Effect, Stream } from "effect";

import { ProviderUnavailableError, ServiceExecError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { CommandSpec, ExecTarget } from "@lando/sdk/services";

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

const runExec = (api: EngineHttpApi, command: CommandSpec, execTarget: ExecTarget = target) =>
  Effect.runPromise(exec(plan, execTarget, command, { api, ctx }));

const createBody = (calls: ReadonlyArray<EngineHttpRequest>) =>
  calls.find((call) => call.method === "POST" && call.path === createPath)?.body;

const attachFrame = (kind: 1 | 2, value: string): Uint8Array => {
  const payload = new TextEncoder().encode(value);
  const frame = new Uint8Array(8 + payload.length);
  frame[0] = kind;
  new DataView(frame.buffer).setUint32(4, payload.length);
  frame.set(payload, 8);
  return frame;
};

describe("podman exec user", () => {
  test.each(["www-data", "1000:1000"])("forwards %s to the exec create request", async (user) => {
    const fake = makeFakeApi();

    await runExec(fake.api, { command: ["id"] }, { ...target, user });

    expect(createBody(fake.calls)).toMatchObject({ User: user });
  });

  test("omits User when the target does not specify one", async () => {
    const fake = makeFakeApi();

    await runExec(fake.api, { command: ["id"] });

    expect(createBody(fake.calls)).not.toHaveProperty("User");
  });
});

describe("podman exec start errors", () => {
  const apiFailingStartWith = (error: ProviderUnavailableError): EngineHttpApi => ({
    request: (input) =>
      input.method === "POST" && input.path === createPath
        ? Effect.succeed({ status: 201, body: JSON.stringify({ Id: "exec-1" }) })
        : Effect.succeed({ status: 500, body: "unexpected request" }),
    stream: () => Stream.fail(error),
  });

  test("classifies an HTTP rejection for a requested user as an execution error", async () => {
    const transportError = new ProviderUnavailableError({
      providerId: "lando",
      operation: "engine.stream",
      message: "Container runtime stream request failed with HTTP 500.",
      details: { method: "POST", path: "/exec/exec-1/start", status: 500 },
      remediation: "Run lando doctor.",
    });

    const error = await Effect.runPromise(
      exec(
        plan,
        { ...target, user: "missing-user" },
        { command: ["id"] },
        {
          api: apiFailingStartWith(transportError),
          ctx,
        },
      ).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(ServiceExecError);
    if (!(error instanceof ServiceExecError)) throw new Error("Expected ServiceExecError");
    expect(error.service).toBe(serviceName);
    expect(error.message).toContain("requested user");
    expect(error.details).toEqual({ status: 500, requestedUser: "missing-user" });
    expect(error.remediation).toContain("exists");
    expect(error.remediation).toContain("--user");
  });

  test("classifies an HTTP rejection without a user as an execution error", async () => {
    const transportError = new ProviderUnavailableError({
      providerId: "lando",
      operation: "engine.stream",
      message: "Container runtime stream request failed with HTTP 409.",
      details: { status: 409 },
      remediation: "Run lando doctor.",
    });

    const error = await Effect.runPromise(
      exec(plan, target, { command: ["id"] }, { api: apiFailingStartWith(transportError), ctx }).pipe(
        Effect.flip,
      ),
    );

    expect(error).toBeInstanceOf(ServiceExecError);
    if (!(error instanceof ServiceExecError)) throw new Error("Expected ServiceExecError");
    expect(error.details).toEqual({ status: 409 });
  });

  test("preserves a statusless transport availability error", async () => {
    const transportError = new ProviderUnavailableError({
      providerId: "lando",
      operation: "engine.stream",
      message: "Named pipe is unavailable.",
      remediation: "Run lando setup.",
    });

    const error = await Effect.runPromise(
      exec(
        plan,
        { ...target, user: "www-data" },
        { command: ["id"] },
        {
          api: apiFailingStartWith(transportError),
          ctx,
        },
      ).pipe(Effect.flip),
    );

    expect(error).toBe(transportError);
  });
});

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

describe("podman exec completion", () => {
  test("returns output and exit code when the attach pipe stays open after exit", async () => {
    let inspections = 0;
    const api: EngineHttpApi = {
      execAttachNeedsInspectCompletion: true,
      request: (input) =>
        Effect.sync(() => {
          if (input.path === createPath) return { status: 201, body: JSON.stringify({ Id: "exec-1" }) };
          if (input.path === "/exec/exec-1/json") {
            inspections += 1;
            return {
              status: 200,
              body: JSON.stringify(
                inspections === 1 ? { Running: true, ExitCode: null } : { Running: false, ExitCode: 37 },
              ),
            };
          }
          return { status: 500, body: "unexpected request" };
        }),
      stream: (input) =>
        Stream.suspend(() => {
          input.onResponseHead?.();
          return Stream.fromIterable([attachFrame(1, "probe-out"), attachFrame(2, "probe-err")]).pipe(
            Stream.concat(Stream.never),
          );
        }),
    };

    const result = await runExec(api, { command: ["probe"] });

    expect(result).toEqual({ stdout: "probe-out", stderr: "probe-err", exitCode: 37 });
    expect(inspections).toBeGreaterThanOrEqual(2);
  }, 5_000);
});

describe("podman exec stdin completion", () => {
  test("waits for a still-running exec after stdin half-closes the attach stream", async () => {
    let inspections = 0;
    const api: EngineHttpApi = {
      execAttachNeedsInspectCompletion: true,
      request: (input) =>
        Effect.sync(() => {
          if (input.path === createPath) return { status: 201, body: JSON.stringify({ Id: "exec-1" }) };
          if (input.path === "/exec/exec-1/json") {
            inspections += 1;
            return {
              status: 200,
              body: JSON.stringify(
                inspections < 3 ? { Running: true, ExitCode: 0 } : { Running: false, ExitCode: 23 },
              ),
            };
          }
          return { status: 500, body: "unexpected request" };
        }),
      stream: (input) =>
        Stream.suspend(() => {
          input.onResponseHead?.();
          return Stream.make(attachFrame(1, "stdin-consumed"));
        }),
    };

    const result = await runExec(api, { command: ["cat"], stdinStream: oneChunkStdin() });

    expect(result).toEqual({ stdout: "stdin-consumed", stderr: "", exitCode: 23 });
    expect(inspections).toBeGreaterThanOrEqual(3);
  }, 5_000);
});

describe("podman exec delayed output", () => {
  const apiWithStream = (attached: Stream.Stream<Uint8Array, ProviderUnavailableError>): EngineHttpApi => ({
    execAttachNeedsInspectCompletion: true,
    request: (input) =>
      Effect.sync(() => {
        if (input.path === createPath) return { status: 201, body: JSON.stringify({ Id: "exec-1" }) };
        if (input.path === "/exec/exec-1/json") {
          return { status: 200, body: JSON.stringify({ Running: false, ExitCode: 19 }) };
        }
        return { status: 500, body: "unexpected request" };
      }),
    stream: (input) =>
      Stream.suspend(() => {
        input.onResponseHead?.();
        return attached;
      }),
  });

  test("retains a final frame arriving 250 ms after Podman reports exit", async () => {
    const attached = Stream.make(attachFrame(1, "first")).pipe(
      Stream.concat(
        Stream.fromEffect(Effect.sleep(Duration.millis(250)).pipe(Effect.as(attachFrame(2, "last")))),
      ),
      Stream.concat(Stream.never),
    );

    const result = await runExec(apiWithStream(attached), { command: ["probe"] });

    expect(result).toEqual({ stdout: "first", stderr: "last", exitCode: 19 });
  }, 5_000);

  test("propagates a real stream error after Podman reports exit", async () => {
    const failure = new ProviderUnavailableError({
      providerId: "podman",
      operation: "exec",
      message: "attach stream failed",
    });
    const attached = Stream.make(attachFrame(1, "first")).pipe(
      Stream.concat(
        Stream.fromEffect(Effect.sleep(Duration.millis(200))).pipe(
          Stream.flatMap(() => Stream.fail(failure)),
        ),
      ),
    );

    await expect(runExec(apiWithStream(attached), { command: ["probe"] })).rejects.toMatchObject({
      message: "attach stream failed",
    });
  }, 5_000);
});
