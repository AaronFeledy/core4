import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DateTime, Effect, Layer, Schema, Stream } from "effect";

import { buildInfoSummary, infoApp, renderInfoAppResult } from "@lando/core/cli/operations";
import { ProviderUnavailableError } from "@lando/core/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LogSource,
  type LogSource as LogSourceShape,
  PortablePath,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/core/schema";
import {
  AppPlanner,
  type ConfigService,
  LandofileService,
  ProxyService,
  RuntimeProviderRegistry,
} from "@lando/core/services";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { TestProxyService } from "@lando/sdk/test";

import { agentEnvConfigServiceLayer, emptyConfigServiceLayer } from "./agent-env-test-config.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");
const providerId = ProviderId.make("lando");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const capabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceLogSources: true,
  serviceHealth: "lando",
  hostReachability: "emulated",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none",
  serviceFileCopy: "none",
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
};

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "info.scenario.test",
  runtime: 4 as const,
};

const servicePlan = (name: "node" | "postgres" | "memcached" | "valkey"): ServicePlan => ({
  name: ServiceName.make(name),
  type: name === "node" ? "node:lts" : name,
  provider: providerId,
  primary: name === "node",
  artifact: {
    kind: "ref",
    ref:
      name === "node"
        ? "node:22-alpine"
        : name === "postgres"
          ? "postgres:16-alpine"
          : name === "memcached"
            ? "memcached:1.6"
            : "valkey/valkey:8",
  },
  command:
    name === "node"
      ? ["node", "server.js"]
      : name === "postgres"
        ? ["postgres"]
        : name === "memcached"
          ? ["memcached"]
          : ["valkey-server"],
  environment:
    name === "postgres" ? { POSTGRES_USER: "lando", POSTGRES_DB: "appdb", POSTGRES_PASSWORD: "secret" } : {},
  mounts: [],
  storage:
    name === "postgres"
      ? [
          {
            store: "test_info_postgres_data",
            target: PortablePath.make("/var/lib/postgresql/data"),
            readOnly: false,
          },
        ]
      : [],
  endpoints:
    name === "node"
      ? [
          {
            _tag: "published",
            port: 3000,
            protocol: "http",
            name: "http",
            publication: { hostPort: 3000 },
          },
        ]
      : name === "postgres"
        ? [
            {
              _tag: "published",
              port: 5432,
              protocol: "tcp",
              name: "database",
              publication: { hostPort: 5432 },
            },
          ]
        : name === "memcached"
          ? [
              {
                _tag: "published",
                port: 11211,
                protocol: "tcp",
                name: "cache",
                publication: { hostPort: 11211 },
              },
            ]
          : [
              {
                _tag: "published",
                port: 6379,
                protocol: "tcp",
                name: "valkey",
                publication: { hostPort: 6379 },
              },
            ],
  routes: [],
  dependsOn: name === "node" ? [{ service: ServiceName.make("postgres"), condition: "started" }] : [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const node = servicePlan("node");
const postgres = servicePlan("postgres");
const memcached = servicePlan("memcached");
const valkey = servicePlan("valkey");

const plan: AppPlan = {
  id: AppId.make("test-info"),
  name: "test-info",
  slug: "test-info",
  root: AbsolutePath.make("/tmp/test-info"),
  provider: providerId,
  services: {
    [node.name]: node,
    [postgres.name]: postgres,
    [memcached.name]: memcached,
    [valkey.name]: valkey,
  },
  routes: [],
  networks: [],
  stores: [{ name: "test_info_postgres_data", kind: "data", scope: "app" }],
  fileSync: [],
  metadata,
  extensions: {},
};

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-info-scenario-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const runCli = async (args: ReadonlyArray<string>, cwd: string): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

const makeInfoLayer = (
  state: "running" | "stopped",
  options?: {
    readonly landofile?: { readonly agentEnv?: boolean };
    readonly config?: Layer.Layer<ConfigService>;
    readonly plannedApp?: AppPlan;
    readonly providerCapabilities?: ProviderCapabilities;
    readonly proxyAuthorities?: ReadonlyArray<{
      readonly scheme: "http" | "https";
      readonly hostname: string;
      readonly port: number;
    }>;
  },
) => {
  const plannedApp = options?.plannedApp ?? plan;
  const providerCapabilities = options?.providerCapabilities ?? capabilities;
  const provider: RuntimeProviderShape = {
    id: "lando",
    displayName: "Lando Runtime Provider",
    version: "0.0.0",
    platform: "linux",
    capabilities: providerCapabilities,
    isAvailable: Effect.succeed(true),
    setup: () => Effect.void,
    getStatus: Effect.succeed({ running: true }),
    getVersions: Effect.succeed({ provider: "0.0.0" }),
    buildArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "buildArtifact",
          message: "unavailable",
        }),
      ),
    pullArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "pullArtifact",
          message: "unavailable",
        }),
      ),
    removeArtifact: () => Effect.void,
    apply: () => Effect.succeed({ changed: false }),
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    destroy: () => Effect.void,
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    execStream: () => Stream.die("not used"),
    run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    runStream: () => Stream.die("not used"),
    logs: () => Stream.die("not used"),
    inspect: (target) =>
      Effect.succeed({
        app: plannedApp.id,
        service: target.service,
        providerId,
        status: state,
        state,
        endpoints: state === "running" ? (plannedApp.services[target.service]?.endpoints ?? []) : [],
      }),
    list: () => Effect.succeed([]),
    snapshotVolume: () => Effect.die("not used"),
    restoreVolume: () => Effect.die("not used"),
    listVolumes: () => Effect.succeed([]),
    removeVolume: () => Effect.void,
    copyToService: () => Effect.die("not used"),
    copyFromService: () => Stream.die("not used"),
    exportArtifact: () => Stream.die("not used"),
    importArtifact: () => Effect.die("not used"),
  };

  return Layer.mergeAll(
    Layer.succeed(LandofileService, {
      discover: Effect.succeed({ name: "test-info", services: {}, ...options?.landofile }),
    }),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plannedApp) }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(providerCapabilities),
      select: () => Effect.succeed(provider),
    }),
    Layer.succeed(ProxyService, {
      id: "recording",
      capabilities: { wildcardHostnames: true, tls: true, pathPrefixes: true },
      setup: () => Effect.void,
      applyRoutes: (routes, app) => Effect.succeed({ app, appliedRoutes: routes, authorities: [] }),
      removeRoutes: () => Effect.void,
      status: Effect.succeed({
        state: "running",
        authorities: options?.proxyAuthorities ?? [],
        configuredApps: [plannedApp.id],
      }),
      stop: Effect.void,
    }),
    options?.config ?? emptyConfigServiceLayer,
  );
};

describe("lando info", () => {
  test("prints running services with endpoint URLs as plain text", async () => {
    const result = await Effect.runPromise(infoApp().pipe(Effect.provide(makeInfoLayer("running"))));
    const output = renderInfoAppResult(result);

    expect(output).toMatch(/node\s+running\s+http:\/\/localhost:3000/);
    expect(output).toMatch(/postgres\s+running\s+postgresql:\/\/lando@localhost:5432\/appdb/);
    expect(output).toMatch(/memcached\s+running\s+memcached:\/\/localhost:11211/);
    expect(output).toMatch(/valkey\s+running\s+valkey:\/\/localhost:6379,\s*redis:\/\/localhost:6379/);
    expect(output).not.toContain(`${String.fromCharCode(27)}[`);
  });

  test("prints stopped services without endpoints", async () => {
    const result = await Effect.runPromise(infoApp().pipe(Effect.provide(makeInfoLayer("stopped"))));
    const output = renderInfoAppResult(result);

    expect(output).toMatch(/node\s+stopped\s+no endpoints/);
    expect(output).toMatch(/postgres\s+stopped\s+no endpoints/);
    expect(output).toMatch(/memcached\s+stopped\s+no endpoints/);
    expect(output).toMatch(/valkey\s+stopped\s+no endpoints/);
    expect(output).not.toContain("localhost");
  });

  test("renders routed authorities from proxy status without exposing internal endpoints", async () => {
    // Given
    const routedPlan: AppPlan = {
      ...plan,
      services: {
        ...plan.services,
        [node.name]: {
          ...node,
          endpoints: [{ _tag: "internal", port: 3000, protocol: "http", name: "http" }],
        },
      },
      routes: [
        {
          hostname: "node.test-info.lndo.site",
          scheme: "https",
          service: node.name,
          endpoint: 3000,
          backend: { service: node.name, protocol: "http", port: 3000 },
        },
      ],
    };

    // When
    const result = await Effect.runPromise(
      infoApp().pipe(
        Effect.provide(
          makeInfoLayer("running", {
            plannedApp: routedPlan,
            proxyAuthorities: [{ scheme: "https", hostname: "node.test-info.lndo.site", port: 7443 }],
          }),
        ),
      ),
    );

    // Then
    const nodeInfo = result.services.find((service) => service.service === "node");
    expect(nodeInfo?.endpoints).toEqual(["https://node.test-info.lndo.site:7443"]);
    expect(renderInfoAppResult(result)).not.toContain("localhost:3000");
  });

  test("prints a visible host-proxy unavailable notice from the plan extension", async () => {
    const plannedApp: AppPlan = {
      ...plan,
      extensions: {
        ...plan.extensions,
        "@lando/core/host-proxy": {
          runLando: {
            availability: "unavailable",
            reason: "Provider hostReachability is none; host-proxy runLando is disabled.",
          },
        },
      },
    };

    const result = await Effect.runPromise(
      infoApp().pipe(
        Effect.provide(
          makeInfoLayer("running", {
            plannedApp,
            providerCapabilities: { ...capabilities, hostReachability: "none" },
          }),
        ),
      ),
    );
    const output = renderInfoAppResult(result);

    expect(output).toContain("host-proxy");
    expect(output).toContain("unavailable");
    expect(output).toContain("hostReachability");
  });

  test("fails outside an app directory with init remediation", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["info"], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No .lando.yml or .lando.ts found");
      expect(result.stderr).toContain("lando init");
    });
  });
});

describe("lando info --deep — agent-context env audit", () => {
  const offKey = "LANDO_AGENT_ENV";
  const withAgentEnvOff = async <A>(value: string | undefined, run: () => Promise<A>): Promise<A> => {
    const saved = process.env[offKey];
    if (value === undefined) delete process.env[offKey];
    else process.env[offKey] = value;
    try {
      return await run();
    } finally {
      if (saved === undefined) delete process.env[offKey];
      else process.env[offKey] = saved;
    }
  };

  test("omits the agentEnv audit without --deep", async () => {
    const result = await Effect.runPromise(infoApp().pipe(Effect.provide(makeInfoLayer("running"))));
    expect(result.agentEnv).toBeUndefined();
  });

  test("reports the resolved built-in allowlist as enabled", async () => {
    const result = await withAgentEnvOff(undefined, () =>
      Effect.runPromise(infoApp({ deep: true }).pipe(Effect.provide(makeInfoLayer("running")))),
    );
    expect(result.agentEnv?.enabled).toBe(true);
    expect([...(result.agentEnv?.forwarded ?? [])]).toEqual([
      "CLAUDECODE",
      "CLAUDE_CODE",
      "CURSOR_AGENT",
      "OPENCODE",
      "COPILOT_CLI",
      "GEMINI_CLI",
      "AGENT",
      "CI",
    ]);
    const rendered = renderInfoAppResult(result);
    expect(rendered).toContain("agent-env\tenabled");
    expect(rendered).toContain("CLAUDECODE");
  });

  test("reports built-ins plus allow minus deny", async () => {
    const result = await withAgentEnvOff(undefined, () =>
      Effect.runPromise(
        infoApp({ deep: true }).pipe(
          Effect.provide(
            makeInfoLayer("running", {
              config: agentEnvConfigServiceLayer({ allow: ["FOO_TOKEN"], deny: ["CI"] }),
            }),
          ),
        ),
      ),
    );
    expect(result.agentEnv?.enabled).toBe(true);
    expect(result.agentEnv?.forwarded).toContain("FOO_TOKEN");
    expect(result.agentEnv?.forwarded).not.toContain("CI");
  });

  test("reports disabled + empty when the app opts out via agentEnv:false", async () => {
    const result = await withAgentEnvOff(undefined, () =>
      Effect.runPromise(
        infoApp({ deep: true }).pipe(
          Effect.provide(makeInfoLayer("running", { landofile: { agentEnv: false } })),
        ),
      ),
    );
    expect(result.agentEnv?.enabled).toBe(false);
    expect(result.agentEnv?.forwarded).toEqual([]);
    expect(renderInfoAppResult(result)).toContain("agent-env\tdisabled");
  });

  test("deep resolved app targets re-read agentEnv instead of using a cached Landofile snapshot", async () => {
    const result = await withAgentEnvOff(undefined, () =>
      Effect.runPromise(
        infoApp(
          { deep: true },
          {
            plan,
            root: process.cwd(),
            app: { kind: "user", id: plan.id, root: plan.root },
            landofile: { name: "test-info" },
          },
        ).pipe(Effect.provide(makeInfoLayer("running", { landofile: { agentEnv: false } }))),
      ),
    );

    expect(result.agentEnv?.enabled).toBe(false);
    expect(result.agentEnv?.forwarded).toEqual([]);
  });

  test("reports disabled when LANDO_AGENT_ENV=0", async () => {
    const result = await withAgentEnvOff("0", () =>
      Effect.runPromise(infoApp({ deep: true }).pipe(Effect.provide(makeInfoLayer("running")))),
    );
    expect(result.agentEnv?.enabled).toBe(false);
    expect(result.agentEnv?.forwarded).toEqual([]);
  });
});

describe("lando info — resolved log sources", () => {
  const makeLogSourceLayer = (logSources: ReadonlyArray<LogSourceShape>, serviceLogSources: boolean) => {
    const svc: ServicePlan = { ...postgres, logSources };
    const logPlan: AppPlan = { ...plan, services: { [svc.name]: svc } };
    const caps: ProviderCapabilities = { ...capabilities, serviceLogSources };
    const provider: RuntimeProviderShape = {
      id: "lando",
      displayName: "Lando Runtime Provider",
      version: "0.0.0",
      platform: "linux",
      capabilities: caps,
      isAvailable: Effect.succeed(true),
      setup: () => Effect.void,
      getStatus: Effect.succeed({ running: true }),
      getVersions: Effect.succeed({ provider: "0.0.0" }),
      buildArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({ providerId: "lando", operation: "buildArtifact", message: "x" }),
        ),
      pullArtifact: () =>
        Effect.fail(
          new ProviderUnavailableError({ providerId: "lando", operation: "pullArtifact", message: "x" }),
        ),
      removeArtifact: () => Effect.void,
      apply: () => Effect.succeed({ changed: false }),
      start: () => Effect.void,
      stop: () => Effect.void,
      restart: () => Effect.void,
      destroy: () => Effect.void,
      exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      execStream: () => Stream.die("not used"),
      run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
      runStream: () => Stream.die("not used"),
      logs: () => Stream.die("not used"),
      inspect: (target) =>
        Effect.succeed({
          app: logPlan.id,
          service: target.service,
          providerId,
          status: "running",
          state: "running",
          endpoints: logPlan.services[target.service]?.endpoints ?? [],
        }),
      list: () => Effect.succeed([]),
      snapshotVolume: () => Effect.die("not used"),
      restoreVolume: () => Effect.die("not used"),
      listVolumes: () => Effect.succeed([]),
      removeVolume: () => Effect.void,
      copyToService: () => Effect.die("not used"),
      copyFromService: () => Stream.die("not used"),
      exportArtifact: () => Stream.die("not used"),
      importArtifact: () => Effect.die("not used"),
    };
    return Layer.mergeAll(
      Layer.succeed(LandofileService, { discover: Effect.succeed({ name: "test-info", services: {} }) }),
      Layer.succeed(AppPlanner, { plan: () => Effect.succeed(logPlan) }),
      Layer.succeed(RuntimeProviderRegistry, {
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(caps),
        select: () => Effect.succeed(provider),
      }),
      Layer.succeed(ProxyService, TestProxyService),
      emptyConfigServiceLayer,
    );
  };

  const followSource = Schema.decodeUnknownSync(LogSource)({
    id: "slow-query",
    path: "/var/log/mysql/slow.log",
    stream: "stderr",
    strategy: "follow",
  });
  const redirectSource = Schema.decodeUnknownSync(LogSource)({
    id: "access",
    path: "/var/log/apache/access.log",
    stream: "stdout",
    strategy: "redirect",
  });

  test("reports a follow source as available when the provider advertises serviceLogSources", async () => {
    const result = await Effect.runPromise(
      infoApp().pipe(Effect.provide(makeLogSourceLayer([followSource], true))),
    );
    const svc = result.services.find((service) => service.service === "postgres");
    expect(svc?.logSources).toEqual([
      { id: "slow-query", path: "/var/log/mysql/slow.log", strategy: "follow", availability: "available" },
    ]);
    const rendered = renderInfoAppResult(result);
    expect(rendered).toContain("log-source\tslow-query\t/var/log/mysql/slow.log\tfollow\tavailable");
  });

  test("reports a follow source unavailable with a reason when the provider lacks serviceLogSources", async () => {
    const result = await Effect.runPromise(
      infoApp().pipe(Effect.provide(makeLogSourceLayer([followSource], false))),
    );
    const svc = result.services.find((service) => service.service === "postgres");
    expect(svc?.logSources?.[0]?.availability).toBe("unavailable");
    expect(svc?.logSources?.[0]?.reason).toContain("serviceLogSources");
    const rendered = renderInfoAppResult(result);
    expect(rendered).toContain("serviceLogSources");
    expect(buildInfoSummary(result).sections[0]?.rows[0]?.fields?.[3]?.value).toContain("serviceLogSources");
  });

  test("reports a redirect source as redirected-to-console", async () => {
    const result = await Effect.runPromise(
      infoApp().pipe(Effect.provide(makeLogSourceLayer([redirectSource], true))),
    );
    const svc = result.services.find((service) => service.service === "postgres");
    expect(svc?.logSources?.[0]?.availability).toBe("redirected-to-console");
  });
});
