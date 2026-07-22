import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Duration, Effect, Stream } from "effect";

import type { RetryPolicy } from "@lando/sdk/probe";

import {
  type PodmanApiClient,
  type PodmanHttpRequest,
  type PodmanHttpResponse,
  type PodmanServiceRunner,
  makeRuntimeProvider,
} from "@lando/provider-lando";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";

const fastReadinessPolicy: RetryPolicy = {
  maxAttempts: 5,
  delay: Duration.millis(1),
  timeout: Duration.millis(200),
};

const providerId = ProviderId.make("lando");
const appId = AppId.make("ensureapp");
const appRoot = AbsolutePath.make("/tmp/lando-ensure-runtime-app");
const serviceName = ServiceName.make("node");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-14T00:00:00Z"),
  source: "ensure-runtime.integration.test",
  runtime: 4 as const,
};

const service: ServicePlan = {
  name: serviceName,
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
  name: "Ensure Runtime App",
  slug: "ensureapp",
  root: appRoot,
  provider: providerId,
  services: { [service.name]: service },
  routes: [],
  networks: [],
  stores: [],
  metadata,
  extensions: {},
};

const makeFrame = (text: string): Uint8Array => {
  const payload = new TextEncoder().encode(text);
  const output = new Uint8Array(8 + payload.length);
  output[0] = 1;
  output[4] = (payload.length >>> 24) & 0xff;
  output[5] = (payload.length >>> 16) & 0xff;
  output[6] = (payload.length >>> 8) & 0xff;
  output[7] = payload.length & 0xff;
  output.set(payload, 8);
  return output;
};

const makeFakePodmanApi = (
  events: string[],
  pingSuccessesBeforeEnsureFailure = 1,
  launchesBeforePingSuccess = 1,
): PodmanApiClient => {
  let pingCalls = 0;
  const existing = new Set<string>();
  const running = new Set<string>();
  const networks = new Set<string>();
  const volumes = new Set<string>();

  return {
    info: Effect.sync(() => {
      events.push("api.info");
      return { version: { Version: "6.0.2" } };
    }),
    ping: Effect.gen(function* () {
      pingCalls += 1;
      events.push("api.ping");
      const launchCount = events.filter((event) => event === "service.launch").length;
      if (pingCalls <= pingSuccessesBeforeEnsureFailure || launchCount >= launchesBeforePingSuccess) {
        return;
      }
      return yield* Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "podman-api",
          message: "fake unreachable runtime socket",
          remediation: "launch the fake runtime",
        }),
      );
    }),
    request: (request: PodmanHttpRequest) =>
      Effect.sync((): PodmanHttpResponse => {
        events.push(`api.request ${request.method} ${request.path}`);
        const containerMatch = request.path.match(/^\/containers\/([^/?]+)(?:\/([^?]+))?/u);
        const name = containerMatch === null ? "" : decodeURIComponent(containerMatch[1] ?? "");
        const action = containerMatch?.[2];

        if (request.path === "/networks/create") {
          networks.add((request.body as { Name?: string }).Name ?? "");
          return { status: 201, body: "{}" };
        }
        if (request.path === "/volumes/create") {
          const requestedName = (request.body as { Name?: string }).Name ?? "";
          const existed = volumes.has(requestedName);
          volumes.add(requestedName);
          return { status: existed ? 409 : 201, body: "{}" };
        }
        if (request.method === "GET" && action === "json") {
          if (!existing.has(name)) return { status: 404, body: "{}" };
          return { status: 200, body: JSON.stringify({ State: { Running: running.has(name) } }) };
        }
        if (request.method === "POST" && request.path.startsWith("/containers/create")) {
          const createdName = new URL(`http://localhost${request.path}`).searchParams.get("name") ?? "";
          existing.add(createdName);
          return { status: 201, body: "{}" };
        }
        if (request.method === "POST" && action === "start") {
          running.add(name);
          return { status: 204, body: "" };
        }
        if (request.method === "POST" && request.path.includes("/exec")) {
          return { status: 201, body: JSON.stringify({ Id: "exec-fake-1" }) };
        }
        if (request.method === "GET" && request.path.includes("/exec/")) {
          return { status: 200, body: JSON.stringify({ ExitCode: 0 }) };
        }
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      }),
    stream: () => Stream.make(makeFrame("ok\n")),
  };
};

const makeFakeServiceRunner = (events: string[]): PodmanServiceRunner => ({
  launch: () =>
    Effect.sync(() => {
      events.push("service.launch");
      return 42;
    }),
  isAlive: () => Effect.succeed(false),
  isServiceProcess: () => Effect.succeed(false),
  terminate: (_pid, _spec) => Effect.void,
});

const withRuntimeProvider = async <A>(
  events: string[],
  use: (provider: RuntimeProviderShape) => Promise<A>,
  pingSuccessesBeforeEnsureFailure = 1,
  launchesBeforePingSuccess = 1,
  readinessPolicy: RetryPolicy = fastReadinessPolicy,
): Promise<A> => {
  const tempDir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
  try {
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        podmanApi: makeFakePodmanApi(events, pingSuccessesBeforeEnsureFailure, launchesBeforePingSuccess),
        podmanCommand: { version: Effect.succeed("podman version 6.0.2") },
        podmanService: makeFakeServiceRunner(events),
        providerSocketPath: join(tempDir, "run", "podman.sock"),
        runtimeBinDir: join(tempDir, "bin"),
        runtimeStorageDir: join(tempDir, "storage"),
        runtimeRunDir: join(tempDir, "run"),
        runtimeConfigDir: join(tempDir, "config"),
        providerPidPath: join(tempDir, "run", "podman.pid"),
        readinessPolicy,
        rootlessProbes: {
          probe: () => ({
            subidConfigured: true,
            hasUidmapTools: true,
            cgroupsV2Delegated: true,
            hasXdgRuntimeDir: true,
          }),
        },
      }),
    );
    return await use(provider);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};

describe("provider-lando ensureRuntime factory wiring", () => {
  test("apply triggers ensureRuntime launch before bringUp", async () => {
    const events: string[] = [];
    await withRuntimeProvider(events, async (provider) => {
      await Effect.runPromise(provider.apply(plan, {}));
    });

    expect(events.filter((event) => event === "service.launch")).toHaveLength(1);
    expect(events.indexOf("service.launch")).toBeLessThan(
      events.findIndex((event) => event.startsWith("api.request")),
    );
  });

  test("two provider operations launch the runtime at most once", async () => {
    const events: string[] = [];
    await withRuntimeProvider(events, async (provider) => {
      await Effect.runPromise(provider.apply(plan, {}));
      await Effect.runPromise(
        provider.exec({ app: appId, service: serviceName, plan }, { command: ["echo", "hi"] }),
      );
    });

    expect(events.filter((event) => event === "service.launch")).toHaveLength(1);
  });

  test("failed ensureRuntime attempt is retried by the next provider operation", async () => {
    const events: string[] = [];
    await withRuntimeProvider(
      events,
      async (provider) => {
        await Effect.runPromiseExit(provider.apply(plan, {}));
        await Effect.runPromise(provider.apply(plan, {}));
      },
      1,
      2,
    );

    expect(events.filter((event) => event === "service.launch")).toHaveLength(2);
  });

  test("exec triggers ensureRuntime before exec", async () => {
    const events: string[] = [];
    await withRuntimeProvider(events, async (provider) => {
      await Effect.runPromise(
        provider.exec({ app: appId, service: serviceName, plan }, { command: ["echo", "hi"] }),
      );
    });

    expect(events.filter((event) => event === "service.launch")).toHaveLength(1);
    expect(events.indexOf("service.launch")).toBeLessThan(
      events.findIndex((event) => event.includes("/exec")),
    );
  });

  test("setup runs ensureRuntime as the final readiness step and shares the cached effect", async () => {
    const events: string[] = [];
    await withRuntimeProvider(
      events,
      async (provider) => {
        await Effect.runPromise(Effect.scoped(provider.setup({ force: false })));
        await Effect.runPromise(provider.apply(plan, {}));
      },
      2,
    );

    expect(events.filter((event) => event === "service.launch")).toHaveLength(1);
    const launchIndex = events.indexOf("service.launch");
    expect(
      events.slice(0, launchIndex).filter((event) => event === "api.ping").length,
    ).toBeGreaterThanOrEqual(1);
    expect(events.at(launchIndex + 1)).toBe("api.ping");
  });

  test("providerSocketPath alone constructs the runtime API client and triggers ensureRuntime", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const events: string[] = [];
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          platform: "linux",
          podmanApi: makeFakePodmanApi(events),
          podmanService: makeFakeServiceRunner(events),
          runtimeBinDir: join(tempDir, "bin"),
          runtimeStorageDir: join(tempDir, "storage"),
          runtimeRunDir: join(tempDir, "run"),
          runtimeConfigDir: join(tempDir, "config"),
          providerSocketPath: join(tempDir, "run", "podman.sock"),
          providerPidPath: join(tempDir, "run", "podman.pid"),
          readinessPolicy: fastReadinessPolicy,
          rootlessProbes: {
            probe: () => ({
              subidConfigured: true,
              hasUidmapTools: true,
              cgroupsV2Delegated: true,
              hasXdgRuntimeDir: true,
            }),
          },
        }),
      );

      await Effect.runPromiseExit(
        provider.exec({ app: appId, service: serviceName }, { command: ["echo", "hi"] }),
      );

      expect(events.filter((event) => event === "service.launch")).toHaveLength(1);
      expect(await readFile(join(tempDir, "run", "podman.pid"), "utf8")).toBe("42");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("external socketPath reuses the caller-managed runtime without launching one", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const events: string[] = [];
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          platform: "linux",
          podmanApi: makeFakePodmanApi(events),
          podmanService: makeFakeServiceRunner(events),
          socketPath: join(tempDir, "external-podman.sock"),
          providerSocketPath: join(tempDir, "run", "podman.sock"),
          providerPidPath: join(tempDir, "run", "podman.pid"),
          runtimeBinDir: join(tempDir, "bin"),
          runtimeStorageDir: join(tempDir, "storage"),
          runtimeRunDir: join(tempDir, "run"),
          runtimeConfigDir: join(tempDir, "config"),
        }),
      );

      await Effect.runPromise(provider.apply(plan, {}));

      expect(events).not.toContain("service.launch");
      expect(events.some((event) => event.startsWith("api.request"))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
