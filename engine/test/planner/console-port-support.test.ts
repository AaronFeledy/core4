import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileShape, type ServiceConfig, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, PluginRegistry, type ServiceType } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Schema } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import { composeExtendedServiceType } from "../../src/services/extends.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";

const plan = (service: typeof ServiceConfig.Encoded) =>
  Effect.flatMap(AppPlanner, (planner) =>
    planner.plan(
      literalTestLandofile(
        Schema.decodeUnknownSync(LandofileShape)({
          name: "console-support",
          services: { web: { home: false, certs: false, ...service } },
        }),
        process.cwd(),
      ),
      TestRuntimeProvider.capabilities,
    ),
  ).pipe(Effect.provide(AppPlannerLayer.layer));

test.each(["mailpit", "compose"])("planner rejects unsupported %s consolePort", async (type) => {
  // Given an authored console port on a service without a supporting feature.
  const service = { type, image: "busybox", consolePort: 19001 };
  // When / Then the real planner rejects the authored field with actionable advice.
  await expect(
    Effect.runPromise(plan(service).pipe(Effect.provide(PluginRegistryLayer.layer))),
  ).rejects.toMatchObject({
    _tag: "LandofileValidationError",
    issues: [
      expect.objectContaining({
        path: ["services", "web", "consolePort"],
        suggestion: expect.any(String),
      }),
    ],
  });
});

test.each(["mailpit", "compose"])("lint rejects unsupported %s consolePort", async (type) => {
  // Given a real Landofile, not a direct catalog-schema decode.
  const root = await mkdtemp(join(tmpdir(), "lando-console-lint-"));
  try {
    await writeFile(
      join(root, ".lando.yml"),
      `name: console-support\nservices:\n  web:\n    type: ${type}\n    image: busybox\n    consolePort: 19001\n`,
    );
    // When
    const result = await Effect.runPromise(
      appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    // Then the resolve-pass diagnostic survives lint aggregation.
    expect(result.valid).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({
        path: ["services", "web", "consolePort"],
        suggestion: expect.any(String),
      }),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ordinary mailpit plans without a console support declaration", async () => {
  // Given / When
  const result = await Effect.runPromise(
    plan({ type: "mailpit" }).pipe(Effect.provide(PluginRegistryLayer.layer)),
  );
  // Then
  expect(result.services[ServiceName.make("web")]?.endpoints).toContainEqual(
    expect.objectContaining({ port: 8025, protocol: "http" }),
  );
});

test.each([{ endpoints: undefined }, { endpoints: [] }])(
  "planner rejects an effective MinIO feature collision with endpoints %j",
  async ({ endpoints }) => {
    // Given a real MinIO resolution whose executable feature config is overridden after parent validation.
    const planning = Effect.gen(function* () {
      const registry = yield* PluginRegistry;
      const parent = yield* registry.loadServiceType("minio");
      const overridden: ServiceType = {
        ...parent,
        resolve: (input) =>
          parent.resolve(input).pipe(
            Effect.map((resolution) => ({
              ...resolution,
              features: resolution.features.map((ref) => ({
                ...ref,
                config: { ...ref.config, consolePort: 9000 },
              })),
            })),
          ),
      };
      return yield* plan({
        type: "minio",
        image: "example.test/minio:fixture",
        consolePort: 19001,
        routes: [],
        ...(endpoints === undefined ? {} : { endpoints }),
      }).pipe(
        Effect.provideService(PluginRegistry, {
          ...registry,
          loadServiceType: (id) =>
            id === "minio" ? Effect.succeed(overridden) : registry.loadServiceType(id),
        }),
      );
    }).pipe(Effect.provide(PluginRegistryLayer.layer));
    // When / Then the planner's validation phase rejects the effective pair before plan assembly.
    await expect(Effect.runPromise(planning)).rejects.toMatchObject({
      _tag: "LandofileValidationError",
      issues: [
        expect.objectContaining({
          path: ["services", "web", "port"],
          suggestion: expect.any(String),
        }),
      ],
    });
  },
);

test("a differently named MinIO child inherits executable console support", async () => {
  // Given the real registered parent and a child with no schema or feature declarations.
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;
      const parent = yield* registry.loadServiceType("minio");
      const child: ServiceType = {
        id: "inherited-object-store",
        name: "inherited-object-store",
        extends: "minio",
        base: "lando",
        schema: Schema.Unknown,
        resolve: (input) => Effect.succeed({ base: "lando", normalizedConfig: input.service, features: [] }),
      };
      const composed = yield* composeExtendedServiceType(child, (id) =>
        id === parent.id ? parent : undefined,
      );
      // When the actual planner resolves and composes the inherited feature.
      return yield* plan({ type: child.id, consolePort: 19001, image: "example.test/minio:fixture" }).pipe(
        Effect.provideService(PluginRegistry, {
          ...registry,
          loadServiceType: (id) =>
            id === child.id ? Effect.succeed(composed) : registry.loadServiceType(id),
        }),
      );
    }).pipe(Effect.provide(PluginRegistryLayer.layer)),
  );
  // Then the inherited declaration controls both launch and discovery.
  const service = result.services[ServiceName.make("web")];
  expect(service?.command).toEqual([
    "mkdir -p /data/$MINIO_BUCKET && exec minio server /data --address :9000 --console-address :19001",
  ]);
  expect(service?.endpoints).toContainEqual(
    expect.objectContaining({
      _tag: "internal",
      port: 19001,
      protocol: "http",
      name: "console",
      scan: expect.objectContaining({ path: "/" }),
    }),
  );
});
