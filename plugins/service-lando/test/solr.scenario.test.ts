import { describe, expect, test } from "bun:test";
import { Effect, Layer, Result, Schema, Stream } from "effect";
import {
  compileTestLandofile,
  toolingExecutionLayer,
  toolingValueResolverLayer,
} from "./support/compiled-landofile.ts";

import { runTooling } from "@lando/engine/operations/tooling";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as LandoEventService from "@lando/engine/services/event-service";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import * as ProviderExecToolingEngine from "@lando/engine/services/tooling-engine";
import { type LandofileValidationError, ProviderUnavailableError } from "@lando/sdk/errors";
import {
  type CurrentExecutableAppPlan,
  LandofileShape,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  LandofileService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { formatValidationIssuePath } from "@lando/sdk/schema";
import { services } from "../src/index.ts";
import { emptyConfigServiceLayer } from "./support/agent-env-test-config.ts";
import { execStreamFromResponse } from "./support/exec-stream-from-response.ts";

const providerId = ProviderId.make("lando");

const capabilities: ProviderCapabilities = {
  artifactBuild: true,
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
  architectureEmulation: false,
  composeSpec: "portable",
  providerExtensions: [],
};

interface ExecCall {
  readonly service: string;
  readonly command: ReadonlyArray<string>;
}

const makeProvider = (
  responses: ReadonlyArray<{ exitCode: number; stdout?: string; stderr?: string }>,
): { provider: RuntimeProviderShape; calls: ExecCall[] } => {
  const calls: ExecCall[] = [];
  let i = 0;
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    id: providerId,
    displayName: "Fake Lando",
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
          providerId,
          operation: "buildArtifact",
          message: "n/a",
          remediation:
            "Install or start the selected runtime provider and confirm it can perform `buildArtifact`.",
        }),
      ),
    pullArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId,
          operation: "pullArtifact",
          message: "n/a",
          remediation:
            "Install or start the selected runtime provider and confirm it can perform `pullArtifact`.",
        }),
      ),
    removeArtifact: () => Effect.void,
    apply: () => Effect.succeed({ changed: false }),
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    waitForExit: () => Effect.succeed({ exitCode: 0 }),
    exec: (target, spec) => {
      calls.push({ service: String(target.service), command: spec.command });
      const response = responses[i] ?? { exitCode: 0 };
      i += 1;
      return Effect.succeed({
        exitCode: response.exitCode,
        stdout: response.stdout ?? "",
        stderr: response.stderr ?? "",
      });
    },
    execStream: (target, spec) => {
      calls.push({ service: String(target.service), command: spec.command });
      const response = responses[i] ?? { exitCode: 0 };
      i += 1;
      return execStreamFromResponse(response);
    },
    run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    logs: () => Stream.empty,
    inspect: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId,
          operation: "inspect",
          message: "n/a",
          remediation: "Install or start the selected runtime provider and confirm it can perform `inspect`.",
        }),
      ),
    list: () => Effect.succeed([]),
  };
  return { provider, calls };
};

const planLandofile = (landofile: LandofileShape): Promise<CurrentExecutableAppPlan> =>
  Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) => planner.plan(compileTestLandofile(landofile), capabilities)).pipe(
      Effect.provide(Layer.merge(services, AppPlannerLayer.layer)),
      Effect.provide(PluginRegistryLayer.layer),
    ),
  );

const makeToolingLayer = (options: {
  readonly landofile: LandofileShape;
  readonly plan: CurrentExecutableAppPlan;
  readonly provider: RuntimeProviderShape;
}) => {
  const landofileLayer = Layer.succeed(
    LandofileService,
    LandofileService.of({
      discover: Effect.sync(() => compileTestLandofile(options.landofile)),
    }),
  );
  const plannerLayer = Layer.succeed(
    AppPlanner,
    AppPlanner.of({
      plan: () => Effect.succeed(options.plan),
    }),
  );
  const registryLayer = Layer.succeed(
    RuntimeProviderRegistry,
    RuntimeProviderRegistry.of({
      resolveAppliedPlan: () => Effect.succeed(undefined),
      resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
      appliedPlansFor: () => Effect.succeed([]),
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(capabilities),
      select: () => Effect.succeed(options.provider),
    }),
  );
  return Layer.mergeAll(
    toolingExecutionLayer,
    landofileLayer,
    plannerLayer,
    registryLayer,
    LandoEventService.layer,
    ProviderExecToolingEngine.layer.pipe(Layer.provide(toolingValueResolverLayer)),
    emptyConfigServiceLayer,
  );
};

describe("solr service type — scenario: Solr + lando solr-admin tooling", () => {
  test("AppPlanner produces a solr plan with HTTP endpoint, persistent storage, and HTTP healthcheck", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { search: { type: "solr", home: false } },
    });

    const appPlan = await planLandofile(landofile);
    const search = appPlan.services[ServiceName.make("search")];
    if (search === undefined) throw new Error("search service missing from solr plan");

    expect(search.type).toBe("solr");
    expect(search.artifact).toEqual({ kind: "ref", ref: "solr:9" });
    expect(search.endpoints).toEqual([
      {
        _tag: "internal",
        port: 8983,
        protocol: "http",
        name: "search",
        primary: true,
        scan: { path: "/", okCodes: [] },
      },
    ]);
    const volumes = search.mounts.filter((mount) => mount.type === "volume");
    expect(volumes).toHaveLength(1);
    expect(volumes[0]?.store).toBe("myapp-solr-data");
    expect(search.healthcheck?.kind).toBe("command");
    expect(search.healthcheck?.command).toEqual([
      "bash",
      "-c",
      "curl -sf http://localhost:8983/solr/admin/info/system",
    ]);
    expect(search.environment.LANDO_SERVICE_TYPE).toBe("solr");
  });

  test("AppPlanner with cores: produces a precreate-core command for the named core", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { search: { type: "solr", cores: ["gettingstarted"] } },
    });

    const appPlan = await planLandofile(landofile);
    const search = appPlan.services[ServiceName.make("search")];
    if (search === undefined) throw new Error("search service missing");

    expect(Array.isArray(search.command)).toBe(true);
    const cmd = search.command as string[];
    expect(cmd[0]).toBe("bash");
    expect(cmd[1]).toBe("-c");
    expect(cmd[2]).toContain('precreate-core "$core"');
    expect(cmd[2]).toContain("solr-foreground");
    expect(cmd).toContain("gettingstarted");
  });

  test.each([[".."], ["nested/core"]])(
    "AppPlanner refuses core %p with a source-aware Landofile error",
    async (core) => {
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "myapp",
        services: { search: { type: "solr", cores: [core] } },
      });

      const outcome = await Effect.runPromise(
        Effect.result(
          Effect.flatMap(AppPlanner, (planner) =>
            planner.plan(compileTestLandofile(landofile), capabilities),
          ).pipe(
            Effect.provide(Layer.merge(services, AppPlannerLayer.layer)),
            Effect.provide(PluginRegistryLayer.layer),
          ),
        ),
      );

      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        expect(outcome.failure._tag).toBe("LandofileValidationError");
        const failure = outcome.failure as LandofileValidationError;
        expect(failure.file.endsWith("/.lando.yml")).toBe(true);
        expect(failure.issues.map((issue) => formatValidationIssuePath(issue.path))).toEqual([
          "services.search.cores[0]",
        ]);
        expect(failure.issues).toEqual([
          expect.objectContaining({
            path: ["services", "search", "cores", 0],
            message: `${JSON.stringify(core)} is not a usable Solr core directory name.`,
            suggestion: expect.stringContaining("Rename the core to a plain directory name."),
          }),
        ]);
      }
    },
  );

  test("`lando solr-admin status` tooling alias routes through provider.exec to the search service", async () => {
    const solrStatusOutput = "Solr is running on port 8983\n";
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { search: { type: "solr", cores: ["gettingstarted"] } },
      tooling: {
        "solr-admin": {
          service: "search",
          cmd: ["solr"],
        },
      },
    });
    const appPlan = await planLandofile(landofile);

    const { provider, calls } = makeProvider([{ exitCode: 0, stdout: solrStatusOutput }]);
    const layer = makeToolingLayer({ landofile, plan: appPlan, provider });

    const result = await Effect.runPromise(
      runTooling({ name: "solr-admin", input: { _tag: "RawArgv", argv: ["status"] } }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(result.tool).toBe("solr-admin");
    expect(result.service).toBe("search");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(solrStatusOutput);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.service).toBe("search");
    expect(calls[0]?.command).toEqual(["solr", "status"]);
    const search = appPlan.services[ServiceName.make("search")];
    if (search === undefined) throw new Error("search service missing");
    expect(search.command).toEqual([
      "bash",
      "-c",
      expect.any(String),
      "lando-solr-precreate",
      "8983",
      "gettingstarted",
    ]);
  });

  test("`lando solr-admin healthcheck -c gettingstarted` routes through provider.exec", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { search: { type: "solr", cores: ["gettingstarted"] } },
      tooling: {
        "solr-admin": {
          service: "search",
          cmd: ["solr"],
        },
      },
    });
    const appPlan = await planLandofile(landofile);

    const healthOutput = '{"status":"OK","QTime":0}\n';
    const { provider, calls } = makeProvider([{ exitCode: 0, stdout: healthOutput }]);
    const layer = makeToolingLayer({ landofile, plan: appPlan, provider });

    const result = await Effect.runPromise(
      runTooling({
        name: "solr-admin",
        input: { _tag: "RawArgv", argv: ["healthcheck", "-c", "gettingstarted"] },
      }).pipe(Effect.provide(layer)),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(healthOutput);
    expect(calls[0]?.command).toEqual(["solr", "healthcheck", "-c", "gettingstarted"]);
  });
});
