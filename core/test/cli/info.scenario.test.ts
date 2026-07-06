import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DateTime, Effect, Layer, Stream } from "effect";

import { infoApp, renderInfoAppResult } from "@lando/core/cli/operations";
import { ProviderUnavailableError } from "@lando/core/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
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
  RuntimeProviderRegistry,
} from "@lando/core/services";
import type { RuntimeProviderShape } from "@lando/sdk/services";

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
      ? [{ port: 3000, protocol: "http", name: "http" }]
      : name === "postgres"
        ? [{ port: 5432, protocol: "tcp", name: "database" }]
        : name === "memcached"
          ? [{ port: 11211, protocol: "tcp", name: "cache" }]
          : [{ port: 6379, protocol: "tcp", name: "valkey" }],
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
  stores: [{ name: "test_info_postgres_data", scope: "app" }],
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
  },
) => {
  const provider: RuntimeProviderShape = {
    id: "lando",
    displayName: "Lando Runtime Provider",
    version: "0.0.0",
    platform: "linux",
    capabilities,
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
    logs: () => Stream.die("not used"),
    inspect: (target) =>
      Effect.succeed({
        app: plan.id,
        service: target.service,
        providerId,
        status: state,
        state,
        endpoints: state === "running" ? (plan.services[target.service]?.endpoints ?? []) : [],
      }),
    list: () => Effect.succeed([]),
  };

  return Layer.mergeAll(
    Layer.succeed(LandofileService, {
      discover: Effect.succeed({ name: "test-info", services: {}, ...options?.landofile }),
    }),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(capabilities),
      select: () => Effect.succeed(provider),
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
