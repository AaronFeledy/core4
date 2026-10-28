import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Schema, Stream } from "effect";
import { DateTime } from "effect";

import type {
  EngineHttpRequest,
  EngineHttpResponse,
  PodmanApiClient,
} from "@lando/container-runtime/engine-api";
import {
  installSupervisedExecFixture,
  supervisedExecFixtureOptions,
} from "@lando/container-runtime/testing/exec-supervision";
import { PodmanMachineNotRunningError, resolvePodmanDesktopMachine } from "@lando/provider-podman";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type HostPlatform,
  type PlanMetadata,
  ProviderId,
  ServiceName,
  type ServicePlan,
  appIdentityKey,
} from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";
import { makeProviderLayer } from "./provider-fixture.ts";

const providerId = ProviderId.make("podman");
const appId = AppId.make("desktop-app");
const serviceName = ServiceName.make("web");

const metadata: PlanMetadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-27T00:00:00Z"),
  source: "provider-podman desktop integration",
  runtime: 4,
};

const servicePlan: ServicePlan = {
  name: serviceName,
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "server.js"],
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const plan: AppPlan = {
  valueModel: 1,
  id: appId,
  name: "Desktop App",
  slug: "desktop-app",
  root: AbsolutePath.make("/tmp/lando-provider-podman-desktop"),
  provider: providerId,
  services: { [serviceName]: servicePlan },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const FRAMED_LOG = (channel: 1 | 2, text: string): Uint8Array => {
  const payload = new TextEncoder().encode(text);
  const out = new Uint8Array(8 + payload.byteLength);
  out[0] = channel;
  const view = new DataView(out.buffer, out.byteOffset + 4, 4);
  view.setUint32(0, payload.byteLength, false);
  out.set(payload, 8);
  return out;
};

const makeFakeApi = () => {
  const running = new Set<string>();
  const existing = new Set<string>();
  const labels = new Map<string, Readonly<Record<string, string>>>();
  const networks = new Map<
    string,
    {
      readonly Id: string;
      readonly Name: string;
      readonly Driver: string;
      readonly Labels: Readonly<Record<string, string>>;
    }
  >();
  const resolveContainer = (ref: string) =>
    [...existing].find((name) => name === ref || `${name}-id` === ref) ?? ref;
  const calls: EngineHttpRequest[] = [];

  const api: PodmanApiClient = {
    info: Effect.succeed({ host: { os: "darwin" }, version: { Version: "6.0.2" } }),
    ping: Effect.void,
    request: (request) =>
      Effect.sync((): EngineHttpResponse => {
        calls.push(request);

        if (
          request.method === "GET" &&
          request.path.startsWith("/libpod/images/") &&
          request.path.endsWith("/json")
        ) {
          return {
            status: 200,
            body: JSON.stringify({ Os: "linux", Architecture: "amd64", RepoDigests: [] }),
          };
        }
        if (request.path === "/networks/create" || request.path === "/libpod/networks/create") {
          const payload =
            request.path === "/libpod/networks/create"
              ? Schema.decodeUnknownSync(
                  Schema.Struct({
                    name: Schema.String,
                    driver: Schema.Literal("bridge"),
                    dns_enabled: Schema.Literal(true),
                    options: Schema.Struct({ metric: Schema.Literal("50") }),
                    labels: Schema.Record(Schema.String, Schema.String),
                  }),
                )(request.body)
              : undefined;
          const body = Schema.decodeUnknownSync(
            Schema.Struct({
              Name: Schema.String,
              Driver: Schema.String,
              Labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
            }),
          )(
            payload === undefined
              ? request.body
              : { Name: payload.name, Driver: payload.driver, Labels: payload.labels },
          );
          const network = {
            Id: `${body.Name}-id`,
            Name: body.Name,
            Driver: body.Driver,
            Labels: body.Labels ?? {},
          };
          networks.set(body.Name, network);
          return { status: 201, body: JSON.stringify({ Id: network.Id }) };
        }
        if (request.method === "POST" && request.path.startsWith("/libpod/volumes/prune")) {
          return { status: 200, body: "[]" };
        }
        if (
          request.path.startsWith("/networks/") &&
          (request.method === "GET" || request.method === "DELETE")
        ) {
          const ref = decodeURIComponent(request.path.slice("/networks/".length));
          const network = [...networks.values()].find((entry) => entry.Name === ref || entry.Id === ref);
          if (network === undefined) return { status: 404, body: "" };
          if (request.method === "GET") return { status: 200, body: JSON.stringify(network) };
          networks.delete(network.Name);
          return { status: 204, body: "" };
        }
        if (request.path.startsWith("/containers/create?name=")) {
          const name = decodeURIComponent(request.path.slice("/containers/create?name=".length));
          existing.add(name);
          labels.set(
            name,
            Schema.decodeUnknownSync(Schema.Struct({ Labels: Schema.Record(Schema.String, Schema.String) }))(
              request.body,
            ).Labels,
          );
          return { status: 201, body: JSON.stringify({ Id: `${name}-id` }) };
        }
        if (request.path.endsWith("/start")) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/start".length));
          existing.add(name);
          running.add(name);
          return { status: 204, body: "" };
        }
        if (request.path.endsWith("/stop")) {
          const name = resolveContainer(
            decodeURIComponent(request.path.slice("/containers/".length, -"/stop".length)),
          );
          if (!existing.has(name)) return { status: 404, body: "" };
          const wasRunning = running.delete(name);
          return { status: wasRunning ? 204 : 304, body: "" };
        }
        if (request.path.endsWith("?force=true&v=true") && request.method === "DELETE") {
          const name = resolveContainer(
            decodeURIComponent(request.path.slice("/containers/".length, -"?force=true&v=true".length)),
          );
          const existed = existing.delete(name);
          labels.delete(name);
          running.delete(name);
          return { status: existed ? 204 : 404, body: "" };
        }
        if (request.path.startsWith("/containers/") && request.path.endsWith("/json")) {
          const name = resolveContainer(
            decodeURIComponent(request.path.slice("/containers/".length, -"/json".length)),
          );
          if (!existing.has(name)) return { status: 404, body: "" };
          return {
            status: 200,
            body: JSON.stringify({
              Id: `${name}-id`,
              Config: { Labels: labels.get(name) },
              State: { Running: running.has(name), Status: running.has(name) ? "running" : "stopped" },
            }),
          };
        }
        if (request.path.startsWith("/containers/") && request.path.endsWith("/exec")) {
          return { status: 201, body: JSON.stringify({ Id: "exec-id" }) };
        }
        if (request.path === "/exec/exec-id/start") {
          return { status: 200, body: "" };
        }
        if (request.path === "/exec/exec-id/json") {
          return { status: 200, body: JSON.stringify({ ExitCode: 0, Running: false }) };
        }

        return {
          status: 500,
          body: JSON.stringify({ error: `unhandled ${request.method} ${request.path}` }),
        };
      }),
    stream: (request) => {
      calls.push(request);
      if (request.path.includes("/logs?")) {
        return Stream.fromIterable([FRAMED_LOG(1, "hello from podman desktop\n")]);
      }
      if (request.path.endsWith("/exec/exec-id/start")) {
        return Stream.fromIterable([FRAMED_LOG(1, "stdout-text\n")]);
      }
      return Stream.fromIterable([]);
    },
  };

  installSupervisedExecFixture(api);
  return { api, calls };
};

const buildProvider = (stateDir: string, platform: HostPlatform, fakeApi: PodmanApiClient) =>
  Effect.runPromise(
    RuntimeProvider.pipe(
      Effect.provide(
        makeProviderLayer({
          podmanApi: fakeApi,
          ...supervisedExecFixtureOptions(fakeApi),
          platform,
          env: { HOME: "/Users/desktop-tester" },
          stateDir,
        }),
      ),
    ),
  );

describe.each([
  ["darwin", "darwin" as const],
  ["win32", "win32" as const],
])("provider-podman Podman Desktop fake-client (%s)", (_label, platform) => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), `lando-provider-podman-desktop-${platform}-`));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  test("apply brings up the service via the Podman REST API", async () => {
    const fake = makeFakeApi();
    const provider = await buildProvider(stateDir, platform, fake.api);

    await Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: true })));

    expect(fake.calls.find((call) => call.path === "/libpod/networks/create")?.body).toEqual({
      name: `lando-${plan.slug}`,
      driver: "bridge",
      dns_enabled: true,
      options: { metric: "50" },
      labels: {
        "dev.lando.app": plan.id,
        "dev.lando.app-root": plan.root,
        "dev.lando.owner": appIdentityKey("owner", plan.root),
        "dev.lando.provider": plan.provider,
      },
    });
    expect(
      fake.calls.some((call) => call.path.startsWith("/containers/create?name=") && call.method === "POST"),
    ).toBe(true);
    expect(fake.calls.some((call) => call.path.endsWith("/start"))).toBe(true);
  });

  test("inspect returns a snapshot with providerId=podman", async () => {
    const fake = makeFakeApi();
    const provider = await buildProvider(stateDir, platform, fake.api);
    await Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: true })));

    const snapshot = await Effect.runPromise(provider.inspect({ app: appId, service: serviceName }));
    expect(String(snapshot.providerId)).toBe("podman");
    expect(snapshot.state).toBeTruthy();
  });

  test("exec routes through the Podman REST API", async () => {
    const fake = makeFakeApi();
    const provider = await buildProvider(stateDir, platform, fake.api);
    await Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: true })));

    const result = await Effect.runPromise(
      provider.exec({ app: appId, service: serviceName }, { command: ["echo", "ok"] }),
    );

    expect(result.exitCode).toBe(0);
    expect(fake.calls.some((call) => call.path.includes("/exec"))).toBe(true);
  });

  test("logs streams through the Podman REST API", async () => {
    const fake = makeFakeApi();
    const provider = await buildProvider(stateDir, platform, fake.api);
    await Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: true })));

    const chunks = await Effect.runPromise(
      Stream.runCollect(provider.logs({ app: appId, service: serviceName }, { follow: false })),
    );

    expect(Array.from(chunks).length).toBeGreaterThan(0);
    expect(fake.calls.some((call) => call.path.includes("/logs?"))).toBe(true);
  });

  test("destroy brings down the service and the network", async () => {
    const fake = makeFakeApi();
    const provider = await buildProvider(stateDir, platform, fake.api);
    await Effect.runPromise(Effect.scoped(provider.apply(plan, { reconcile: true })));

    await Effect.runPromise(provider.destroy({ app: appId }, { volumes: true }));

    expect(
      fake.calls.some((call) => call.path.endsWith("?force=true&v=true") && call.method === "DELETE"),
    ).toBe(true);
    expect(fake.calls.some((call) => call.path.startsWith("/networks/") && call.method === "DELETE")).toBe(
      true,
    );
  });
});

describe("provider-podman Podman Desktop machine-not-running remediation", () => {
  test("maps capability-probe socket failure to PodmanMachineNotRunningError on macOS", async () => {
    const socketFailure = new ProviderUnavailableError({
      providerId: "podman",
      operation: "podman-api",
      message: "ENOENT: socket missing",
      remediation: "Install or start the `podman` provider and confirm it can perform `podman-api`.",
    });
    const fakeApi: PodmanApiClient = { info: Effect.fail(socketFailure), ping: Effect.void };

    const exit = await Effect.runPromiseExit(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            podmanApi: fakeApi,
            platform: "darwin",
            env: { HOME: "/Users/test" },
          }),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(PodmanMachineNotRunningError);
        if (failure.value instanceof PodmanMachineNotRunningError) {
          expect(failure.value.remediation).toContain("podman machine start");
          expect(failure.value.remediation).toContain(resolvePodmanDesktopMachine({}));
        }
      }
    }
  });

  test("maps capability-probe socket failure to PodmanMachineNotRunningError on Windows", async () => {
    const socketFailure = new ProviderUnavailableError({
      providerId: "podman",
      operation: "podman-api",
      message: "Named pipe not found",
      remediation: "Install or start the `podman` provider and confirm it can perform `podman-api`.",
    });
    const fakeApi: PodmanApiClient = { info: Effect.fail(socketFailure), ping: Effect.void };

    const exit = await Effect.runPromiseExit(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            podmanApi: fakeApi,
            platform: "win32",
            env: {},
          }),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause);
      if (failure._tag === "Some") {
        expect(failure.value).toBeInstanceOf(PodmanMachineNotRunningError);
        if (failure.value instanceof PodmanMachineNotRunningError) {
          expect(failure.value.remediation).toMatch(/Podman Desktop|podman machine start/);
        }
      }
    }
  });

  test("uses the effective process env machine name in Podman Desktop remediation", async () => {
    const socketFailure = new ProviderUnavailableError({
      providerId: "podman",
      operation: "podman-api",
      message: "Named pipe not found",
      remediation: "Install or start the `podman` provider and confirm it can perform `podman-api`.",
    });
    const fakeApi: PodmanApiClient = { info: Effect.fail(socketFailure), ping: Effect.void };
    const original = process.env.LANDO_PODMAN_MACHINE;

    process.env.LANDO_PODMAN_MACHINE = "custom-machine";
    try {
      const exit = await Effect.runPromiseExit(
        RuntimeProvider.pipe(
          Effect.provide(
            makeProviderLayer({
              podmanApi: fakeApi,
              platform: "win32",
            }),
          ),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(PodmanMachineNotRunningError);
          if (failure.value instanceof PodmanMachineNotRunningError) {
            expect(failure.value.remediation).toContain("custom-machine");
            expect(failure.value.remediation).not.toContain("podman-machine-default");
          }
        }
      }
    } finally {
      if (original === undefined) {
        Reflect.deleteProperty(process.env, "LANDO_PODMAN_MACHINE");
      } else {
        process.env.LANDO_PODMAN_MACHINE = original;
      }
    }
  });

  test("Linux capability-probe failure does NOT map to PodmanMachineNotRunningError (no managed VM there)", async () => {
    const socketFailure = new ProviderUnavailableError({
      providerId: "podman",
      operation: "podman-api",
      message: "Connection refused",
      remediation: "Install or start the `podman` provider and confirm it can perform `podman-api`.",
    });
    const fakeApi: PodmanApiClient = { info: Effect.fail(socketFailure), ping: Effect.void };

    const exit = await Effect.runPromiseExit(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            podmanApi: fakeApi,
            platform: "linux",
            env: { XDG_RUNTIME_DIR: "/run/user/1000" },
          }),
        ),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.findErrorOption(exit.cause);
      if (failure._tag === "Some") {
        expect(failure.value).not.toBeInstanceOf(PodmanMachineNotRunningError);
        expect(failure.value).toBeInstanceOf(ProviderUnavailableError);
      }
    }
  });
});

const liveDesktopSocket = process.env.LANDO_TEST_PODMAN_DESKTOP_SOCKET;
const liveDesktopPlatform = process.platform === "darwin" || process.platform === "win32";
const liveDesktopTest =
  liveDesktopSocket !== undefined && liveDesktopSocket.length > 0 && liveDesktopPlatform ? test : test.skip;

liveDesktopTest(
  "live: Podman Desktop socket reachable via SDK provider contract",
  async () => {
    const { runProviderContract } = await import("@lando/sdk/test");
    const { makePodmanApiClient } = await import("@lando/provider-podman");
    const socket = liveDesktopSocket ?? "";

    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            podmanApi: makePodmanApiClient(socket),
            platform: process.platform === "darwin" ? "darwin" : "win32",
          }),
        ),
      ),
    );

    await Effect.runPromise(runProviderContract(provider));
  },
  120_000,
);
