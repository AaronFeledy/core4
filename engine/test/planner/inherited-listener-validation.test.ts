import { expect, test } from "bun:test";
import { LandofileValidationError } from "@lando/sdk/errors";
import { LandofileShape, type ServiceConfig, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, PluginRegistry, type ServiceType } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import { composeExtendedServiceType } from "../../src/services/extends.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";

const planInherited = (
  parentId: string,
  service: typeof ServiceConfig.Encoded,
  resolve: ServiceType["resolve"],
) =>
  Effect.gen(function* () {
    const registry = yield* PluginRegistry;
    const parent = yield* registry.loadServiceType(parentId);
    const child: ServiceType = {
      id: `inherited-${parentId}`,
      name: `inherited-${parentId}`,
      extends: parentId,
      base: "lando",
      schema: Schema.Unknown,
      resolve,
    };
    const composed = yield* composeExtendedServiceType(child, (id) =>
      id === parent.id ? parent : undefined,
    );
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "inherited-listeners",
      services: { web: { ...service, type: child.id, home: false, certs: false, routes: [] } },
    });
    return yield* Effect.flatMap(AppPlanner, (planner) =>
      planner.plan(literalTestLandofile(landofile, process.cwd()), {
        ...TestRuntimeProvider.capabilities,
        artifactBuild: true,
      }),
    ).pipe(
      Effect.provide(AppPlannerLayer.layer),
      Effect.provideService(PluginRegistry, {
        ...registry,
        loadServiceType: (id) => (id === child.id ? Effect.succeed(composed) : registry.loadServiceType(id)),
      }),
    );
  }).pipe(Effect.provide(PluginRegistryLayer.layer));

test("MinIO child feature override can reclaim the parent's default console port for the API", async () => {
  // Given no authored consolePort and a real child that overrides the parent's feature config.
  const planning = planInherited("minio", { port: 9001, image: "example.test/minio:fixture" }, (input) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: input.service,
      features: [{ id: "service-lando.minio", config: { consolePort: 19001 } }],
    }),
  );
  // When
  const plan = await Effect.runPromise(planning);
  // Then final feature authority governs launch, discovery, and the API client alias.
  const service = plan.services[ServiceName.make("web")];
  expect(service?.command).toEqual([
    "mkdir -p /data/$MINIO_BUCKET && exec minio server /data --address :9001 --console-address :19001",
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
  expect(service?.environment.MC_HOST_local).toEndWith("@127.0.0.1:9001");
});

test.each([
  { parent: "mailpit", endpoints: undefined },
  { parent: "mailpit", endpoints: [] },
  { parent: "mailhog", endpoints: undefined },
  { parent: "mailhog", endpoints: [] },
])(
  "inherited $parent normalized collision stays in the typed channel: $endpoints",
  async ({ parent, endpoints }) => {
    // Given valid parent input and a child normalization colliding with the inherited HTTP UI.
    const planning = planInherited(
      parent,
      {
        port: 1025,
        ...(endpoints === undefined ? {} : { endpoints }),
      },
      (input) =>
        Effect.succeed({
          base: "lando",
          normalizedConfig: { ...input.service, port: 8025 },
          features: [],
        }),
    );
    // When defects remain fatal while expected failures become Result.Failure.
    const result = await Effect.runPromise(Effect.result(planning));
    // Then the expected validation error preserves the field and actionable remedy.
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) throw new Error("Expected inherited listener rejection");
    expect(result.failure).toBeInstanceOf(LandofileValidationError);
    if (!(result.failure instanceof LandofileValidationError)) throw new Error("Expected validation error");
    expect(result.failure.issues).toEqual([
      expect.objectContaining({
        path: ["services", "web", "port"],
        suggestion: expect.any(String),
      }),
    ]);
    expect(result.failure.issues[0]?.suggestion).toContain("Set port:");
  },
);

test.each(["mailpit", "mailhog"])("%s child may repair an intermediate parent collision", async (parent) => {
  // Given a parent input whose SMTP port overlaps its default HTTP listener.
  const planning = planInherited(parent, { port: 8025 }, (input) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: { ...input.service, port: 2525 },
      features: [],
    }),
  );
  // When
  const plan = await Effect.runPromise(planning);
  // Then only final inherited facts govern both executable and endpoint intent.
  expect(plan.services[ServiceName.make("web")]?.endpoints).toContainEqual(
    expect.objectContaining({ port: 2525, protocol: "tcp" }),
  );
});

test.each([
  { image: "example.test/minio:fixture" },
  { build: { context: ".", dockerfileInline: "FROM example.test/minio:fixture" } },
])("MinIO inherited features accept explicit artifact intent %j", async (artifact) => {
  // Given an authored artifact and an inherited MinIO feature.
  const planning = planInherited("minio", artifact, (input) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: input.service,
      features: [],
    }),
  );
  // When
  const plan = await Effect.runPromise(planning);
  // Then the final inherited artifact is accepted without provider execution.
  expect(plan.services[ServiceName.make("web")]?.artifact).toMatchObject(
    "image" in artifact ? { kind: "ref", ref: artifact.image } : { kind: "build" },
  );
});
