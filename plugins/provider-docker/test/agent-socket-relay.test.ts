import { expect, test } from "bun:test";
import { volumeOwnershipLabels } from "@lando/container-runtime/data-plane";
import type { EngineApiClient, EngineHttpRequest } from "@lando/container-runtime/engine-api";
import { AbsolutePath, AgentSocketBridgeInput, AppId, type AppPlan, ProviderId } from "@lando/sdk/schema";
import { DateTime, Effect, Exit, Schema, Scope } from "effect";
import { makeRuntimeProvider } from "../src/index.ts";

const input = Schema.decodeSync(AgentSocketBridgeInput)({
  appId: "test-app",
  appRoot: "/apps/test",
  sessionId: "session-one",
  kind: "ssh",
  socketName: "agent.sock",
  upstream: { _tag: "loopback-tcp", port: 12345, token: "secret-token" },
});
const plan: AppPlan = {
  id: AppId.make("test-app"),
  name: "Test",
  slug: "test-app",
  root: AbsolutePath.make("/apps/test"),
  provider: ProviderId.make("docker"),
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: {
    source: "agent-socket-relay.test",
    resolvedAt: DateTime.unsafeMake("2026-09-25T00:00:00Z"),
    runtime: 4,
  },
  extensions: {},
};

const fakeApi = (failurePath?: string) => {
  const requests: EngineHttpRequest[] = [];
  const api: EngineApiClient = {
    info: Effect.succeed({}),
    request: (request) =>
      Effect.sync(() => {
        requests.push(request);
        if (request.path === failurePath) return { status: 500, body: "secret-token" };
        if (request.path === "/containers/relay-id/stop?t=1" && failurePath !== undefined) {
          return { status: 304, body: "" };
        }
        if (request.path === "/volumes/create") return { status: 201, body: JSON.stringify(request.body) };
        if (request.path.startsWith("/containers/create")) return { status: 201, body: '{"Id":"relay-id"}' };
        if (request.path === "/containers/relay-id/exec") return { status: 201, body: '{"Id":"exec-id"}' };
        if (request.path === "/exec/exec-id/json")
          return { status: 200, body: '{"Running":false,"ExitCode":0}' };
        if (request.method === "GET" && request.path.startsWith("/volumes/"))
          return { status: 404, body: "" };
        if (request.method === "GET" && /^\/containers\/[^/]+\/json$/u.test(request.path)) {
          return { status: 404, body: "" };
        }
        return { status: 204, body: "" };
      }),
  };
  return { api, requests };
};

const open = (api: EngineApiClient, bridgeInput = input) =>
  Effect.gen(function* () {
    const provider = yield* makeRuntimeProvider({
      platform: "darwin",
      dockerApi: api,
    });
    expect(provider.openAgentSocketBridge).toBeDefined();
    if (provider.openAgentSocketBridge === undefined) return yield* Effect.die("Missing agent socket bridge");
    return yield* provider.openAgentSocketBridge(bridgeInput);
  });

test("creates an owned volume and a token-bearing socat relay container", async () => {
  // Given
  const fake = fakeApi();
  // When
  const result = await Effect.runPromise(Effect.scoped(open(fake.api)));
  // Then
  expect(result).toEqual({ _tag: "volume", volume: "lando-agent-ssh-test-app" });
  expect(fake.requests.find((request) => request.path === "/volumes/create")?.body).toMatchObject({
    Name: "lando-agent-ssh-test-app",
    Labels: {
      ...volumeOwnershipLabels(plan, { name: "lando-agent-ssh-test-app", scope: "app", kind: "data" }),
      "dev.lando.volume-owner": "/apps/test",
      "dev.lando.app": "test-app",
    },
  });
  expect(fake.requests.find((request) => request.path.startsWith("/containers/create"))?.body).toMatchObject({
    Image: expect.stringMatching(/^alpine\/socat@sha256:[a-f0-9]{64}$/),
    Entrypoint: ["socat"],
    Env: ["LANDO_AGENT_TOKEN=secret-token"],
    Cmd: [
      "UNIX-LISTEN:/run/lando/agent/agent.sock,fork,unlink-early,mode=666",
      'SYSTEM:{ printf %s "$LANDO_AGENT_TOKEN"; cat; } | socat - TCP:host.docker.internal:12345',
    ],
    HostConfig: {
      Binds: ["lando-agent-ssh-test-app:/run/lando/agent"],
      ExtraHosts: ["host.docker.internal:host-gateway"],
    },
  });
  expect(fake.requests.find((request) => request.path === "/containers/relay-id/exec")?.body).toMatchObject({
    Cmd: ["test", "-S", "/run/lando/agent/agent.sock"],
  });
});

test("release removes container and volume", async () => {
  // Given
  const fake = fakeApi();
  const scope = await Effect.runPromise(Scope.make());
  await Effect.runPromise(open(fake.api).pipe(Scope.extend(scope)));
  expect(fake.requests.some((request) => request.method === "DELETE")).toBe(false);
  // When
  await Effect.runPromise(Scope.close(scope, Exit.void));
  // Then
  expect(fake.requests.slice(-3).map(({ method, path }) => [method, path])).toEqual([
    ["POST", "/containers/relay-id/stop?t=1"],
    ["DELETE", "/containers/relay-id?force=true"],
    ["DELETE", "/volumes/lando-agent-ssh-test-app"],
  ]);
});

test.each([
  { ...input, upstream: { _tag: "unix" as const, path: "/tmp/agent.sock" } },
  {
    ...input,
    upstream: {
      _tag: "loopback-tcp" as const,
      port: input.upstream._tag === "loopback-tcp" ? input.upstream.port : 12345,
    },
  },
  { ...input, socketName: "../agent.sock" },
])("rejects a unix upstream, missing token, or unsafe socket name: %j", async (invalid) => {
  // Given
  const fake = fakeApi();
  // When
  const result = await Effect.runPromise(Effect.scoped(open(fake.api, invalid)).pipe(Effect.either));
  // Then
  expect(result).toMatchObject({ _tag: "Left", left: { _tag: "ProviderUnavailableError" } });
  expect(fake.requests).toEqual([]);
});

test("cleans up when starting the relay fails without exposing the token", async () => {
  // Given
  const fake = fakeApi("/containers/relay-id/start");
  // When
  const result = await Effect.runPromise(Effect.scoped(open(fake.api)).pipe(Effect.either));
  // Then
  expect(result).toMatchObject({ _tag: "Left", left: { _tag: "ProviderUnavailableError" } });
  expect(JSON.stringify(result)).not.toContain("secret-token");
  expect(
    fake.requests.filter((request) => request.method === "DELETE").map((request) => request.path),
  ).toEqual(["/containers/relay-id?force=true", "/volumes/lando-agent-ssh-test-app"]);
});

test("rejects missing canonical ownership context before creating resources", async () => {
  // Given
  const fake = fakeApi();
  const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "darwin", dockerApi: fake.api }));
  const ownerless = { ...input };
  Reflect.deleteProperty(ownerless, "appRoot");
  // When
  const result = await Effect.runPromise(
    Effect.scoped(
      Schema.decodeUnknown(AgentSocketBridgeInput)(ownerless).pipe(
        Effect.flatMap(
          (decoded) => provider.openAgentSocketBridge?.(decoded) ?? Effect.die("Missing agent socket bridge"),
        ),
      ),
    ).pipe(Effect.either),
  );
  // Then
  expect(result).toMatchObject({ _tag: "Left", left: { _tag: "ParseError" } });
  expect(fake.requests).toEqual([]);
});

const relayVolume = "lando-agent-ssh-test-app";
const relayContainer = "lando-agent-relay-ssh-test-app";
const ownedRelayLabels = {
  ...volumeOwnershipLabels(plan, { name: relayVolume, scope: "app", kind: "data" }),
  "dev.lando.app": "test-app",
  "dev.lando.store": relayVolume,
  "dev.lando.scope": "app",
  "dev.lando.volume-instance": "previous-instance",
  "dev.lando.agent-session": "previous-session",
};

const relayApi = (seed: "owned" | "foreign") => {
  const requests: EngineHttpRequest[] = [];
  let volume: "owned" | "foreign" | "absent" = seed;
  let container: "owned" | "absent" = seed === "owned" ? "owned" : "absent";
  const api: EngineApiClient = {
    info: Effect.succeed({}),
    request: (request) =>
      Effect.sync(() => {
        requests.push(request);
        if (request.method === "GET" && request.path === `/volumes/${relayVolume}`) {
          return volume === "absent"
            ? { status: 404, body: "" }
            : {
                status: 200,
                body: JSON.stringify({
                  Name: relayVolume,
                  Labels: volume === "owned" ? ownedRelayLabels : { "com.example.owner": "someone-else" },
                }),
              };
        }
        if (request.method === "GET" && request.path === `/containers/${relayContainer}/json`) {
          return container === "absent"
            ? { status: 404, body: "" }
            : {
                status: 200,
                body: JSON.stringify({ Id: "stale-relay", Config: { Labels: ownedRelayLabels } }),
              };
        }
        if (request.method === "DELETE" && request.path === `/containers/${relayContainer}?force=true`) {
          container = "absent";
          return { status: 204, body: "" };
        }
        if (request.method === "DELETE" && request.path === `/volumes/${relayVolume}`) {
          volume = "absent";
          return { status: 204, body: "" };
        }
        if (request.path === "/volumes/create") {
          if (seed === "foreign") return { status: 201, body: JSON.stringify(request.body) };
          if (volume !== "absent") {
            return {
              status: 201,
              body: JSON.stringify({ Name: relayVolume, Labels: ownedRelayLabels }),
            };
          }
          volume = "owned";
          return { status: 201, body: JSON.stringify(request.body) };
        }
        if (request.path.startsWith("/containers/create")) return { status: 201, body: '{"Id":"relay-id"}' };
        if (request.path === "/containers/relay-id/exec") return { status: 201, body: '{"Id":"exec-id"}' };
        if (request.path === "/exec/exec-id/json")
          return { status: 200, body: '{"Running":false,"ExitCode":0}' };
        return { status: 204, body: "" };
      }),
  };
  return { api, requests };
};

test("stale owned relay volume and container from a previous session are reclaimed and start succeeds", async () => {
  // Given
  const fake = relayApi("owned");

  // When
  const result = await Effect.runPromise(Effect.scoped(open(fake.api)));

  // Then
  expect(result).toEqual({ _tag: "volume", volume: relayVolume });
  const createAt = fake.requests.findIndex((request) => request.path === "/volumes/create");
  expect(createAt).toBeGreaterThan(0);
  expect(fake.requests.slice(0, createAt).map(({ method, path }) => [method, path])).toEqual([
    ["GET", `/volumes/${relayVolume}`],
    ["GET", `/containers/${relayContainer}/json`],
    ["DELETE", `/containers/${relayContainer}?force=true`],
    ["DELETE", `/volumes/${relayVolume}`],
  ]);
});

test("a foreign unowned volume with that name is not deleted and fails with remediation", async () => {
  // Given
  const fake = relayApi("foreign");

  // When
  const result = await Effect.runPromise(Effect.scoped(open(fake.api)).pipe(Effect.either));

  // Then
  expect(result._tag).toBe("Left");
  if (result._tag !== "Left") return;
  expect(result.left).toMatchObject({ _tag: "ProviderUnavailableError" });
  expect(
    "remediation" in result.left &&
      typeof result.left.remediation === "string" &&
      result.left.remediation.length > 0,
  ).toBe(true);
  expect(fake.requests.some((request) => request.method === "DELETE")).toBe(false);
});
