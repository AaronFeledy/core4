import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Stream } from "effect";
import { DateTime } from "effect";

import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "@lando/provider-lando";
import {
  PodmanMachineNotRunningError,
  makeProviderLayer,
  resolvePodmanDesktopMachine,
} from "@lando/provider-podman";
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
} from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";

const providerId = ProviderId.make("podman");
const appId = AppId.make("desktop-app");
const serviceName = ServiceName.make("web");

const metadata: PlanMetadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-27T00:00:00Z"),
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
  name: "Desktop App",
  slug: "desktop-app",
  root: AbsolutePath.make("/tmp/lando-provider-podman-desktop"),
  provider: providerId,
  services: { [serviceName]: servicePlan },
  routes: [],
  networks: [],
  stores: [],
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
  const calls: PodmanHttpRequest[] = [];

  const api: PodmanApiClient = {
    info: Effect.succeed({ host: { os: "darwin" } }),
    request: (request) =>
      Effect.sync((): PodmanHttpResponse => {
        calls.push(request);

        if (request.path === "/networks/create") return { status: 201, body: "{}" };
        if (request.path.startsWith("/networks/") && request.method === "DELETE") {
          return { status: 204, body: "" };
        }
        if (request.path.startsWith("/containers/create?name=")) {
          const name = decodeURIComponent(request.path.slice("/containers/create?name=".length));
          existing.add(name);
          return { status: 201, body: JSON.stringify({ Id: `${name}-id` }) };
        }
        if (request.path.endsWith("/start")) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/start".length));
          existing.add(name);
          running.add(name);
          return { status: 204, body: "" };
        }
        if (request.path.endsWith("/stop")) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/stop".length));
          const wasRunning = running.delete(name);
          return { status: wasRunning ? 204 : 304, body: "" };
        }
        if (request.path.endsWith("?force=true") && request.method === "DELETE") {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"?force=true".length));
          const existed = existing.delete(name);
          running.delete(name);
          return { status: existed ? 204 : 404, body: "" };
        }
        if (request.path.startsWith("/containers/") && request.path.endsWith("/json")) {
          const name = decodeURIComponent(request.path.slice("/containers/".length, -"/json".length));
          if (!existing.has(name)) return { status: 404, body: "" };
          return {
            status: 200,
            body: JSON.stringify({
              Id: `${name}-id`,
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

  return { api, calls };
};

const buildProvider = (stateDir: string, platform: HostPlatform, fakeApi: PodmanApiClient) =>
  Effect.runPromise(
    RuntimeProvider.pipe(
      Effect.provide(
        makeProviderLayer({
          podmanApi: fakeApi,
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

    await Effect.runPromise(provider.apply(plan, { reconcile: true }));

    expect(fake.calls.some((call) => call.path === "/networks/create")).toBe(true);
    expect(
      fake.calls.some((call) => call.path.startsWith("/containers/create?name=") && call.method === "POST"),
    ).toBe(true);
    expect(fake.calls.some((call) => call.path.endsWith("/start"))).toBe(true);
  });

  test("inspect returns a snapshot with providerId=podman", async () => {
    const fake = makeFakeApi();
    const provider = await buildProvider(stateDir, platform, fake.api);
    await Effect.runPromise(provider.apply(plan, { reconcile: true }));

    const snapshot = await Effect.runPromise(provider.inspect({ app: appId, service: serviceName }));
    expect(snapshot.providerId).toBe("podman");
    expect(snapshot.state).toBeTruthy();
  });

  test("exec routes through the Podman REST API", async () => {
    const fake = makeFakeApi();
    const provider = await buildProvider(stateDir, platform, fake.api);
    await Effect.runPromise(provider.apply(plan, { reconcile: true }));

    const result = await Effect.runPromise(
      provider.exec({ app: appId, service: serviceName }, { command: ["echo", "ok"] }),
    );

    expect(result.exitCode).toBe(0);
    expect(fake.calls.some((call) => call.path.includes("/exec"))).toBe(true);
  });

  test("logs streams through the Podman REST API", async () => {
    const fake = makeFakeApi();
    const provider = await buildProvider(stateDir, platform, fake.api);
    await Effect.runPromise(provider.apply(plan, { reconcile: true }));

    const chunks = await Effect.runPromise(
      Stream.runCollect(provider.logs({ app: appId, service: serviceName }, { follow: false })),
    );

    expect(Array.from(chunks).length).toBeGreaterThan(0);
    expect(fake.calls.some((call) => call.path.includes("/logs?"))).toBe(true);
  });

  test("destroy brings down the service and the network", async () => {
    const fake = makeFakeApi();
    const provider = await buildProvider(stateDir, platform, fake.api);
    await Effect.runPromise(provider.apply(plan, { reconcile: true }));

    await Effect.runPromise(provider.destroy({ app: appId }, { volumes: true }));

    expect(fake.calls.some((call) => call.path.endsWith("?force=true") && call.method === "DELETE")).toBe(
      true,
    );
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
    });
    const fakeApi: PodmanApiClient = { info: Effect.fail(socketFailure) };

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
      const failure = Cause.failureOption(exit.cause);
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
    });
    const fakeApi: PodmanApiClient = { info: Effect.fail(socketFailure) };

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
      const failure = Cause.failureOption(exit.cause);
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
    });
    const fakeApi: PodmanApiClient = { info: Effect.fail(socketFailure) };
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
        const failure = Cause.failureOption(exit.cause);
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
    });
    const fakeApi: PodmanApiClient = { info: Effect.fail(socketFailure) };

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
      const failure = Cause.failureOption(exit.cause);
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
