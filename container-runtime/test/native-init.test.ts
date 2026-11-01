import { expect, test } from "bun:test";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { Effect } from "effect";
import type { EngineApiClient, EngineHttpRequest, EngineHttpResponse } from "../src/engine-api.ts";
import { nativeInitFixture } from "./support/native-init-fixture.ts";
import {
  NATIVE_INIT_CASE_IDS,
  NATIVE_INIT_IMAGE,
  assertNativeInitTransport,
  commandForCase,
  commandTransportArgv,
  hostConfigInitFragment,
  intentForCase,
  nativeInitClient,
  nativeInitCreateBody,
  nativeInitStopDeadlineMs,
  runNativeInit,
} from "./support/native-init.ts";

const recordingApi = (respond: (input: EngineHttpRequest) => EngineHttpResponse) => {
  const calls: EngineHttpRequest[] = [];
  const api: EngineApiClient = {
    info: Effect.succeed({}),
    request: (input) =>
      Effect.sync(() => {
        calls.push(input);
        return respond(input);
      }),
  };
  return { api, calls };
};

test("exports the six durable native-init cases with correct init intent", () => {
  expect([...NATIVE_INIT_CASE_IDS]).toEqual([
    "direct-term",
    "handler-marker",
    "orphan-reaping",
    "init-false",
    "compose-omitted",
    "nonforwarding-wrapper",
  ]);
  expect(intentForCase("direct-term")).toBe("true");
  expect(intentForCase("handler-marker")).toBe("true");
  expect(intentForCase("orphan-reaping")).toBe("true");
  expect(intentForCase("init-false")).toBe("false");
  expect(intentForCase("compose-omitted")).toBe("omitted");
  expect(intentForCase("nonforwarding-wrapper")).toBe("true");
  expect(commandForCase("handler-marker").join(" ")).toContain("native-init-marker");
  expect(commandForCase("nonforwarding-wrapper").join(" ")).toContain("trap");
});

test("create body encodes Init true/false and omits the field for raw Compose intent", () => {
  expect(hostConfigInitFragment("true")).toEqual({ Init: true });
  expect(hostConfigInitFragment("false")).toEqual({ Init: false });
  expect(hostConfigInitFragment("omitted")).toEqual({});

  const omitted = nativeInitCreateBody({
    command: commandForCase("compose-omitted"),
    intent: "omitted",
    name: "raw",
  });
  expect(omitted.Image).toBe(NATIVE_INIT_IMAGE);
  expect(omitted.HostConfig).toMatchObject({ NetworkMode: "none" });
  expect(omitted.HostConfig).not.toHaveProperty("Init");

  const enabled = nativeInitCreateBody({
    command: commandForCase("direct-term"),
    intent: "true",
    name: "on",
  });
  expect(enabled.HostConfig).toMatchObject({ Init: true });

  const disabled = nativeInitCreateBody({
    command: commandForCase("init-false"),
    intent: "false",
    name: "off",
  });
  expect(disabled.HostConfig).toMatchObject({ Init: false });
});

test("stop deadline is grace-relative and never a fixed 1.2s wall clock", () => {
  expect(nativeInitStopDeadlineMs(10)).toBeGreaterThan(10_000);
  expect(nativeInitStopDeadlineMs(10)).toBeGreaterThanOrEqual(40_000);
  expect(nativeInitStopDeadlineMs(1)).toBeGreaterThan(1_200);
  expect(nativeInitStopDeadlineMs(30)).toBe(30_000 + 30_000);
});

test("rejects empty API endpoint instead of discovering a runtime", () => {
  expect(() => assertNativeInitTransport({ kind: "api", provider: "podman", endpoint: "" })).toThrow(
    /explicit endpoint/i,
  );
  expect(() => nativeInitClient({ kind: "api", provider: "docker", endpoint: "   " })).toThrow();
});

test("rejects default and empty command connections", () => {
  expect(() =>
    assertNativeInitTransport({
      kind: "command",
      provider: "podman",
      command: "podman",
      connection: "default",
    }),
  ).toThrow(/never "default"/i);
  expect(() =>
    assertNativeInitTransport({
      kind: "command",
      provider: "podman",
      command: "podman",
      connection: "",
    }),
  ).toThrow();
  expect(() =>
    assertNativeInitTransport({
      kind: "command",
      provider: "podman",
      command: "podman",
      connection: "podman-machine-default",
    }),
  ).toThrow();
});

test("rejects Windows unix socket API endpoints", () => {
  expect(() =>
    assertNativeInitTransport(
      { kind: "api", provider: "podman", endpoint: "/run/podman/podman.sock" },
      "win32",
    ),
  ).toThrow(/named-pipe/i);
  expect(() =>
    assertNativeInitTransport(
      {
        kind: "api",
        provider: "podman",
        endpoint: ["\\", "\\", ".", "\\", "pipe", "\\", "podman-lifecycle"].join(""),
      },
      "win32",
    ),
  ).not.toThrow();
});

test("command transport argv always pins --connection before subcommands", () => {
  const argv = commandTransportArgv(
    { kind: "command", provider: "podman", command: "/usr/bin/podman", connection: "lando-lifecycle-owned" },
    ["info", "--format", "json"],
  );
  expect(argv).toEqual([
    "/usr/bin/podman",
    "--connection",
    "lando-lifecycle-owned",
    "info",
    "--format",
    "json",
  ]);
  expect(argv).not.toContainEqual("default");
});

test("cleans exact container IDs when a scenario fails mid-run", async () => {
  const fake = recordingApi((input) => {
    if (input.method === "DELETE") return { status: 204, body: "" };
    if (input.path.startsWith("/containers/create")) return { status: 201, body: '{"Id":"native-c1"}' };
    return { status: 200, body: JSON.stringify({ Id: "native-c1", State: { Running: true, ExitCode: 0 } }) };
  });
  const failure = new Error("scenario assertion failed");
  const scenario = async () => {
    await using fixture = nativeInitFixture(fake.api);
    await fixture.call({
      method: "POST",
      path: "/containers/create?name=owned",
      body: nativeInitCreateBody({
        command: commandForCase("direct-term"),
        intent: "true",
        name: "owned",
      }),
    });
    throw failure;
  };
  await expect(scenario()).rejects.toBe(failure);
  const deletes = fake.calls.filter((call) => call.method === "DELETE").map((call) => call.path);
  expect(deletes).toEqual(["/containers/native-c1?force=true&v=true"]);
});

test("isolates fixture identity when two runs share a daemon", async () => {
  const fake = recordingApi(() => ({ status: 404, body: "" }));
  await using first = nativeInitFixture(fake.api);
  await using second = nativeInitFixture(fake.api);
  expect(first.name).not.toBe(second.name);
  expect(first.runId).not.toBe(second.runId);
});

test("does not touch resources when the selected API cannot answer", async () => {
  const fake = recordingApi(() => ({ status: 500, body: "must not request" }));
  const api: EngineApiClient = {
    ...fake.api,
    info: Effect.fail(
      new ProviderUnavailableError({
        providerId: "docker",
        operation: "info",
        message: "unreachable",
        remediation: "Supply an answering endpoint.",
      }),
    ),
  };
  await expect(
    runNativeInit({ transport: { kind: "api", provider: "docker", endpoint: "/explicit.sock" } }, api),
  ).rejects.toThrow();
  expect(fake.calls).toEqual([]);
});

test("attempts remaining cleanup and rejects success when an exact removal fails", async () => {
  const fake = recordingApi((input) => {
    if (input.path.startsWith("/containers/create")) return { status: 201, body: '{"Id":"partial-id"}' };
    if (input.method === "DELETE") return { status: 500, body: "injected failure" };
    return { status: 200, body: "" };
  });
  const fixture = nativeInitFixture(fake.api);
  await fixture.call({
    method: "POST",
    path: "/containers/create?name=partial",
    body: nativeInitCreateBody({
      command: commandForCase("direct-term"),
      intent: "true",
      name: "partial",
    }),
  });
  await expect(fixture[Symbol.asyncDispose]()).rejects.toBeInstanceOf(AggregateError);
  expect(
    fake.calls.filter((call) => call.method === "DELETE").map(({ method, path }) => ({ method, path })),
  ).toEqual([{ method: "DELETE", path: "/containers/partial-id?force=true&v=true" }]);
});
