import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema, Stream } from "effect";

import { runTooling } from "@lando/core/cli/operations";
import { ProviderUnavailableError } from "@lando/core/errors";
import {
  type AppPlan,
  LandofileShape,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
} from "@lando/core/schema";
import {
  AppPlanResolver,
  AppPlanner,
  LandofileService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/core/services";

import { PluginRegistryLive } from "../../../core/src/plugins/registry.ts";
import { AppPlannerLive } from "../../../core/src/services/planner.ts";
import { ProviderExecToolingEngineLive } from "../../../core/src/services/tooling-engine.ts";
import { emptyConfigServiceLayer } from "../../../core/test/cli/agent-env-test-config.ts";
import { services } from "../src/index.ts";

const providerId = ProviderId.make("lando");

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
      Effect.fail(new ProviderUnavailableError({ providerId, operation: "buildArtifact", message: "n/a" })),
    pullArtifact: () =>
      Effect.fail(new ProviderUnavailableError({ providerId, operation: "pullArtifact", message: "n/a" })),
    removeArtifact: () => Effect.void,
    apply: () => Effect.succeed({ changed: false }),
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    destroy: () => Effect.void,
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
    execStream: () => Stream.empty,
    run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    logs: () => Stream.empty,
    inspect: () =>
      Effect.fail(new ProviderUnavailableError({ providerId, operation: "inspect", message: "n/a" })),
    list: () => Effect.succeed([]),
  };
  return { provider, calls };
};

const planLandofile = (landofile: LandofileShape): Promise<AppPlan> =>
  Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, capabilities, { kind: "user" })).pipe(
      Effect.provide(Layer.merge(services, AppPlannerLive)),
      Effect.provide(PluginRegistryLive),
    ),
  );

const makeToolingLayer = (options: {
  readonly landofile: LandofileShape;
  readonly plan: AppPlan;
  readonly provider: RuntimeProviderShape;
}) => {
  const landofileLayer = Layer.succeed(LandofileService, {
    discover: Effect.succeed(options.landofile),
  });
  const plannerLayer = Layer.succeed(AppPlanResolver, {
    plan: () => Effect.succeed(options.plan),
  });
  const registryLayer = Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(capabilities),
    select: () => Effect.succeed(options.provider),
  });
  return Layer.mergeAll(
    landofileLayer,
    plannerLayer,
    registryLayer,
    ProviderExecToolingEngineLive,
    emptyConfigServiceLayer,
  );
};

describe("meilisearch service type — scenario: index create + document post + query via lando meili tooling", () => {
  test("AppPlanner produces a meilisearch plan with HTTP endpoint, persistent storage, and /health healthcheck", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { search: { type: "meilisearch" } },
    });

    const appPlan = await planLandofile(landofile);
    const search = appPlan.services[ServiceName.make("search")];
    if (search === undefined) throw new Error("search service missing from meilisearch plan");

    expect(search.type).toBe("meilisearch");
    expect(search.artifact).toEqual({
      kind: "ref",
      ref: "getmeili/meilisearch:v1.11",
    });
    expect(search.endpoints).toEqual([{ port: 7700, protocol: "http", name: "search" }]);
    expect(search.storage).toHaveLength(1);
    expect(search.storage[0]?.store).toBe("myapp-meilisearch-data");
    expect(search.healthcheck?.kind).toBe("command");
    expect(search.healthcheck?.command).toEqual(["sh", "-c", "curl -sf http://localhost:7700/health"]);
    expect(search.environment.LANDO_SERVICE_TYPE).toBe("meilisearch");
    expect(search.environment.MEILI_MASTER_KEY).toBe("lando");
    expect(search.environment.MEILI_NO_ANALYTICS).toBe("true");
    expect(search.environment.MEILI_ENV).toBe("development");
  });

  test("`lando meili create-index` tooling alias creates a Meilisearch index via provider.exec", async () => {
    const createOutput =
      '{"taskUid":0,"indexUid":"movies","status":"enqueued","type":"indexCreation","enqueuedAt":"2026-05-28T12:00:00Z"}\n';
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { search: { type: "meilisearch" } },
      tooling: {
        meili: {
          service: "search",
          cmd: [
            "sh",
            "-c",
            'op="$1"; shift; name="$1"; shift; curl -sf -X POST -H "Authorization: Bearer ${MEILI_MASTER_KEY}" -H "Content-Type: application/json" --data "{\\"uid\\":\\"${name}\\"}" "http://localhost:7700/indexes"',
            "meili",
          ],
        },
      },
    });
    const appPlan = await planLandofile(landofile);

    const { provider, calls } = makeProvider([{ exitCode: 0, stdout: createOutput }]);
    const layer = makeToolingLayer({ landofile, plan: appPlan, provider });

    const result = await Effect.runPromise(
      runTooling({ name: "meili", args: ["create-index", "movies"] }).pipe(Effect.provide(layer)),
    );

    expect(result.tool).toBe("meili");
    expect(result.service).toBe("search");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(createOutput);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.service).toBe("search");
    expect(calls[0]?.command?.[0]).toBe("sh");
    expect(calls[0]?.command?.[1]).toBe("-c");
    expect(calls[0]?.command?.[3]).toBe("meili");
    expect(calls[0]?.command?.[4]).toBe("create-index");
    expect(calls[0]?.command?.[5]).toBe("movies");
  });

  test("`lando meili add-document` tooling alias posts a JSON document via provider.exec", async () => {
    const addOutput =
      '{"taskUid":1,"indexUid":"movies","status":"enqueued","type":"documentAdditionOrUpdate","enqueuedAt":"2026-05-28T12:01:00Z"}\n';
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { search: { type: "meilisearch" } },
      tooling: {
        meili: {
          service: "search",
          cmd: [
            "sh",
            "-c",
            'op="$1"; shift; name="$1"; shift; body="$1"; shift; curl -sf -X POST -H "Authorization: Bearer ${MEILI_MASTER_KEY}" -H "Content-Type: application/json" --data "${body}" "http://localhost:7700/indexes/${name}/documents"',
            "meili",
          ],
        },
      },
    });
    const appPlan = await planLandofile(landofile);

    const { provider, calls } = makeProvider([{ exitCode: 0, stdout: addOutput }]);
    const layer = makeToolingLayer({ landofile, plan: appPlan, provider });

    const result = await Effect.runPromise(
      runTooling({
        name: "meili",
        args: ["add-document", "movies", '[{"id":1,"title":"Casablanca"}]'],
      }).pipe(Effect.provide(layer)),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(addOutput);
    expect(calls[0]?.command?.[4]).toBe("add-document");
    expect(calls[0]?.command?.[5]).toBe("movies");
    expect(calls[0]?.command?.[6]).toBe('[{"id":1,"title":"Casablanca"}]');
  });

  test("`lando meili search` tooling alias queries a Meilisearch index via provider.exec", async () => {
    const searchOutput =
      '{"hits":[{"id":1,"title":"Casablanca"}],"query":"casa","processingTimeMs":1,"limit":20,"offset":0,"estimatedTotalHits":1}\n';
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { search: { type: "meilisearch" } },
      tooling: {
        meili: {
          service: "search",
          cmd: [
            "sh",
            "-c",
            'op="$1"; shift; name="$1"; shift; q="$1"; shift; curl -sf -X POST -H "Authorization: Bearer ${MEILI_MASTER_KEY}" -H "Content-Type: application/json" --data "{\\"q\\":\\"${q}\\"}" "http://localhost:7700/indexes/${name}/search"',
            "meili",
          ],
        },
      },
    });
    const appPlan = await planLandofile(landofile);

    const { provider, calls } = makeProvider([{ exitCode: 0, stdout: searchOutput }]);
    const layer = makeToolingLayer({ landofile, plan: appPlan, provider });

    const result = await Effect.runPromise(
      runTooling({ name: "meili", args: ["search", "movies", "casa"] }).pipe(Effect.provide(layer)),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(searchOutput);
    expect(calls[0]?.command?.[4]).toBe("search");
    expect(calls[0]?.command?.[5]).toBe("movies");
    expect(calls[0]?.command?.[6]).toBe("casa");
  });
});
