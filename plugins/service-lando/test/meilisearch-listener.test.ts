import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as BunFileSystem from "@lando/engine/services/file-system";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import { GlobalConfig, LandofileShape, ServiceConfig } from "@lando/sdk/schema";
import { AppPlanner, ConfigService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";
import { meilisearchServiceFeature, meilisearchServiceType } from "../src/services/meilisearch.ts";
import { compileTestLandofile } from "./support/compiled-landofile.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

test.each(["0.0.0.0:7702", "bad", "127.0.0.1:7701", "[::1]:7701", ":0", ":65536"])(
  "rejects effective Meilisearch bind %s before application",
  async (bind) => {
    // Given
    const validate = meilisearchServiceFeature.validateEffective;
    if (validate === undefined) throw new Error("Missing effective validation");
    // When
    const result = await Effect.runPromise(
      validate({
        serviceName: "search",
        serviceType: "meilisearch",
        appRoot: "/srv/apps/search",
        base: "lando",
        primary: true,
        config: {},
        normalizedConfig: Schema.decodeUnknownSync(ServiceConfig)({
          type: "meilisearch",
          port: 7701,
          environment: { MEILI_HTTP_ADDR: bind },
        }),
      }).pipe(Effect.result),
    );
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { issues: [expect.objectContaining({ path: ["environment", "MEILI_HTTP_ADDR"] })] },
    });
  },
);

test.each([":7701", "0.0.0.0:7701", "[::]:07701"])("preserves matching Meilisearch bind %s", async (bind) => {
  // Given / When
  const plan = await composeServicePlan({
    serviceType: meilisearchServiceType,
    service: Schema.decodeUnknownSync(ServiceConfig)({
      type: "meilisearch",
      port: 7701,
      environment: { MEILI_HTTP_ADDR: bind },
    }),
    appRoot: "/srv/apps/search",
    serviceName: "search",
    metadata: { resolvedAt: "2026-11-01T00:00:00Z", source: "meilisearch-listener", runtime: 4 },
  });
  // Then
  expect(plan.environment.MEILI_HTTP_ADDR).toBe(bind);
  expect(plan.endpoints).toContainEqual(expect.objectContaining({ port: 7701, primary: true }));
});

test.each(["appEnv", "app-file", "service-file"])("rejects Meilisearch mismatch from %s", async (source) => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-meili-listener-"));
  try {
    const file = join(root, "listener.env");
    await Bun.write(file, "MEILI_HTTP_ADDR=0.0.0.0:7702\n");
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "inherited-meili",
      ...(source === "app-file" ? { env_file: [file] } : {}),
      services: {
        search: {
          type: "meilisearch",
          port: 7701,
          certs: false,
          ...(source === "service-file" ? { env_file: [file] } : {}),
        },
      },
    });
    const config = Schema.decodeUnknownSync(GlobalConfig)({
      appEnv: source === "appEnv" ? { MEILI_HTTP_ADDR: "0.0.0.0:7702" } : {},
    });
    const dependencies = Layer.mergeAll(
      PluginRegistryLayer.layer,
      BunFileSystem.layer,
      Layer.succeed(
        ConfigService,
        ConfigService.of({
          load: Effect.succeed(config),
          get: (key) => Effect.succeed(config[key]),
        }),
      ),
    );
    // When
    const result = await Effect.runPromise(
      Effect.flatMap(AppPlanner, (planner) =>
        planner.plan(compileTestLandofile(landofile), TestRuntimeProvider.capabilities),
      ).pipe(Effect.result, Effect.provide(AppPlannerLayer.layer.pipe(Layer.provide(dependencies)))),
    );
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        issues: [expect.objectContaining({ path: ["services", "search", "environment", "MEILI_HTTP_ADDR"] })],
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
