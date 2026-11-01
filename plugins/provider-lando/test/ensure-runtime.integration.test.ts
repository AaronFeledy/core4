import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { DateTime, Duration, Effect, Stream } from "effect";

import type { RetryPolicy } from "@lando/sdk/probe";

import type {
  PodmanApiClient,
  PodmanHttpRequest,
  PodmanHttpResponse,
  PodmanServiceRunner,
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
import { LEGACY_NATIVE_INIT_BRIDGE_VERSION, catatonitFixture } from "./fixtures/catatonit.ts";
import { decodeNetworkCreate } from "./network-fixture.ts";
import { makeRuntimeProvider } from "./provider-fixture.ts";
import { runScoped, runScopedExit } from "./scope-helpers.ts";

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
  resolvedAt: DateTime.makeUnsafe("2026-05-14T00:00:00Z"),
  source: "ensure-runtime.integration.test",
  runtime: 4 as const,
};

const service: ServicePlan = {
  name: serviceName,
  type: "node",
  provider: providerId,
  primary: true,
  init: true,
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

const plan: AppPlan = {
  valueModel: 1,
  id: appId,
  name: "Ensure Runtime App",
  slug: "ensureapp",
  root: appRoot,
  provider: providerId,
  services: { [service.name]: service },
  routes: [],
  stores: [],
  fileSync: [],
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
  const networks = new Map<string, { readonly Id: string }>();
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

        if (request.method === "GET" && request.path.includes("/images/") && request.path.endsWith("/json")) {
          return {
            status: 200,
            body: JSON.stringify({
              Os: "linux",
              Architecture: "amd64",
              RepoDigests: ["img@sha256:test"],
            }),
          };
        }
        const networkCreate = decodeNetworkCreate(request);
        if (networkCreate !== undefined) {
          networks.set(networkCreate.Name, { Id: `${networkCreate.Name}-id`, ...networkCreate });
          return { status: 201, body: "{}" };
        }
        if (request.method === "GET" && request.path.startsWith("/networks/")) {
          const reference = decodeURIComponent(request.path.slice("/networks/".length));
          const name = [...networks].find(([, network]) => network.Id === reference)?.[0] ?? reference;
          const network = networks.get(name);
          return { status: network === undefined ? 404 : 200, body: JSON.stringify(network ?? {}) };
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
    stream: (request) => {
      events.push(`api.stream ${request.method} ${request.path}`);
      return Stream.make(makeFrame("ok\n"));
    },
  };
};

const makeFakeServiceRunner = (events: string[]): PodmanServiceRunner => {
  const launched = new Set<number>();
  return {
    launch: () =>
      Effect.sync(() => {
        events.push("service.launch");
        launched.add(42);
        return 42;
      }),
    isAlive: (pid) => Effect.succeed(launched.has(pid)),
    isServiceProcess: (pid) => Effect.succeed(launched.has(pid)),
    terminate: (pid) =>
      Effect.sync(() => {
        launched.delete(pid);
      }),
  };
};

const withRuntimeProvider = async <A>(
  events: string[],
  use: (provider: RuntimeProviderShape, tempDir: string) => Promise<A>,
  pingSuccessesBeforeEnsureFailure = 1,
  launchesBeforePingSuccess = 1,
  readinessPolicy: RetryPolicy = fastReadinessPolicy,
): Promise<A> => {
  const tempDir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
  try {
    const init = catatonitFixture();
    await mkdir(join(tempDir, "bin"), { mode: 0o700 });
    await writeFile(
      join(tempDir, "bin", ".runtime-installed-version"),
      `${LEGACY_NATIVE_INIT_BRIDGE_VERSION}\n`,
    );
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        sanitizeAppliedPlan: stripHostProxyRunLando,
        platform: "linux",
        arch: "x64",
        _catatonitPackage: init.pkg,
        artifactDownload: (request) => {
          events.push("artifact.download");
          return init.download(request);
        },
        podmanApi: makeFakePodmanApi(events, pingSuccessesBeforeEnsureFailure, launchesBeforePingSuccess),
        podmanCommand: { version: Effect.succeed("podman version 6.0.2") },
        podmanService: makeFakeServiceRunner(events),
        providerSocketPath: join(tempDir, "podman.sock"),
        runtimeBinDir: join(tempDir, "bin"),
        runtimeStorageDir: join(tempDir, "storage"),
        runtimeRunDir: join(tempDir, "run"),
        runtimeConfigDir: join(tempDir, "config"),
        providerPidPath: join(tempDir, "run", "podman.pid"),
        readinessPolicy,
        rootlessProbes: {
          probe: () => ({
            subidConfigured: true,
            subidRangeSufficient: true,
            subidRangesDisjoint: true,
            hasUidmapTools: true,
            cgroupsV2Delegated: true,
            hasXdgRuntimeDir: true,
          }),
        },
      }),
    );
    return await use(provider, tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};

describe("provider-lando ensureRuntime factory wiring", () => {
  test("logs uses the existing runtime without downloading, configuring, or launching it", async () => {
    // Given: an answering runtime transport with no prepared native init helper.
    const events: string[] = [];
    // When: planful logs are requested through the provider.
    await withRuntimeProvider(events, async (provider, tempDir) => {
      const logs = await Effect.runPromise(
        Stream.runCollect(provider.logs({ app: appId, service: serviceName, plan }, { follow: false })),
      );
      expect(Array.from(logs).map((entry) => entry.line)).toEqual(["ok"]);
      expect(await readdir(tempDir)).toEqual(["bin"]);
      expect(await readdir(join(tempDir, "bin"))).toEqual([".runtime-installed-version"]);
    });
    // Then: only the existing transport is used; no runtime preparation occurs.
    expect(events.filter((event) => event === "service.launch")).toHaveLength(0);
    expect(events.filter((event) => event === "artifact.download")).toHaveLength(0);
    expect(events.filter((event) => event.startsWith("api.stream GET /containers/"))).toHaveLength(1);
  });
  test("apply triggers ensureRuntime launch before bringUp", async () => {
    const events: string[] = [];
    await withRuntimeProvider(events, async (provider, tempDir) => {
      await runScoped(provider.apply(plan, { reconcile: true }));
      expect(new Uint8Array(await readFile(join(tempDir, "bin", "catatonit")))).toEqual(
        new Uint8Array(catatonitFixture().elf),
      );
      expect(await readFile(join(tempDir, "config", "containers.conf"), "utf8")).toContain(
        `init_path = "${join(tempDir, "bin", "catatonit")}"`,
      );
    });

    expect(events.filter((event) => event === "artifact.download")).toHaveLength(2);
    expect(events.filter((event) => event === "service.launch")).toHaveLength(1);
    expect(events.indexOf("service.launch")).toBeLessThan(
      events.findIndex((event) => event.startsWith("api.request")),
    );
  });

  test("two provider operations launch the runtime at most once", async () => {
    const events: string[] = [];
    await withRuntimeProvider(events, async (provider) => {
      await runScoped(provider.apply(plan, { reconcile: true }));
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
        await runScopedExit(provider.apply(plan, { reconcile: true }));
        await runScoped(provider.apply(plan, { reconcile: true }));
      },
      1,
      2,
    );

    expect(events.filter((event) => event === "service.launch")).toHaveLength(2);
  });

  test("exec uses the existing runtime without downloading, configuring, or launching it", async () => {
    const events: string[] = [];
    await withRuntimeProvider(events, async (provider, tempDir) => {
      const result = await Effect.runPromise(
        provider.exec({ app: appId, service: serviceName, plan }, { command: ["echo", "hi"] }),
      );
      expect(result).toEqual({ exitCode: 0, stdout: "ok\n", stderr: "" });
      expect(await readdir(tempDir)).toEqual(["bin"]);
      expect(await readdir(join(tempDir, "bin"))).toEqual([".runtime-installed-version"]);
    });

    expect(events.filter((event) => event === "service.launch")).toHaveLength(0);
    expect(events.filter((event) => event === "artifact.download")).toHaveLength(0);
    expect(events).toContain("api.request POST /containers/lando-ensureapp-node/exec");
  });

  test("setup prepares verified native init and apply reuses the ready runtime", async () => {
    const events: string[] = [];
    await withRuntimeProvider(
      events,
      async (provider, tempDir) => {
        const setupPlan = await Effect.runPromise(provider.planSetup({ force: false }));
        await runScoped(provider.setup(setupPlan, { force: false }));
        expect(new Uint8Array(await readFile(join(tempDir, "bin", "catatonit")))).toEqual(
          new Uint8Array(catatonitFixture().elf),
        );
        expect(await readFile(join(tempDir, "config", "containers.conf"), "utf8")).toContain(
          `init_path = "${join(tempDir, "bin", "catatonit")}"`,
        );
        await runScoped(provider.apply(plan, { reconcile: true }));
      },
      2,
    );

    expect(events.filter((event) => event === "artifact.download")).toHaveLength(2);
    expect(events.filter((event) => event === "service.launch")).toHaveLength(1);
    const launchIndex = events.indexOf("service.launch");
    expect(
      events.slice(0, launchIndex).filter((event) => event === "api.ping").length,
    ).toBeGreaterThanOrEqual(1);
    expect(events.at(launchIndex + 1)).toBe("api.ping");
  });

  test("providerSocketPath alone does not prepare the runtime for exec", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lando-ensure-runtime-"));
    try {
      const events: string[] = [];
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          sanitizeAppliedPlan: stripHostProxyRunLando,
          platform: "linux",
          artifactDownload: () => {
            events.push("artifact.download");
            return Effect.fail(
              new ProviderUnavailableError({
                providerId: "lando",
                operation: "setup",
                message: "unexpected download",
                remediation: "fix fixture",
              }),
            );
          },
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
              subidRangeSufficient: true,
              subidRangesDisjoint: true,
              hasUidmapTools: true,
              cgroupsV2Delegated: true,
              hasXdgRuntimeDir: true,
            }),
          },
        }),
      );

      const result = await runScoped(
        provider.exec({ app: appId, service: serviceName, plan }, { command: ["echo", "hi"] }),
      );

      expect(result.exitCode).toBe(0);
      expect(events.filter((event) => event === "service.launch")).toHaveLength(0);
      expect(events.filter((event) => event === "artifact.download")).toHaveLength(0);
      expect(await readdir(tempDir)).toEqual([]);
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
          sanitizeAppliedPlan: stripHostProxyRunLando,
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

      await runScoped(provider.apply(plan, { reconcile: true }));

      expect(events).not.toContain("service.launch");
      expect(events.some((event) => event.startsWith("api.request"))).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
