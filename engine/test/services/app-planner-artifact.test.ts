import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileValidationError } from "@lando/sdk/errors";
import { PluginManifest, type ServiceConfig, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, PluginRegistry, type ServiceType } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Schema } from "effect";
import * as Registry from "../../src/plugins/registry.ts";
import * as Planner from "../../src/services/planner.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const bareType: ServiceType = {
  id: "bare",
  name: "Bare service",
  base: "lando",
  schema: Schema.Unknown,
  versions: ["1"],
  artifacts: { "1": "nginx:1-alpine" },
  resolve: ({ service }) => Effect.succeed({ base: "lando", normalizedConfig: service, features: [] }),
};

const plan = async (
  service: ServiceConfig,
  options: {
    readonly featureArtifact?: boolean;
    readonly withManifest?: boolean;
    readonly normalizedType?: string;
  } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "lando-2122-"));
  roots.push(root);
  return Effect.runPromise(
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;
      const customRegistry = {
        ...registry,
        list:
          options.withManifest !== false
            ? Effect.succeed([
                Schema.decodeUnknownSync(PluginManifest)({
                  name: "@example/bare",
                  version: "1.0.0",
                  api: 4,
                  contributes: { serviceTypes: [{ id: "bare" }] },
                }),
                Schema.decodeUnknownSync(PluginManifest)({
                  name: "@example/unrelated",
                  version: "1.0.0",
                  api: 4,
                  contributes: { serviceTypes: ["normalized-family"] },
                }),
              ])
            : Effect.succeed([]),
        loadServiceType: () =>
          Effect.succeed({
            ...bareType,
            resolve: ({ service: config }: Parameters<ServiceType["resolve"]>[0]) =>
              Effect.succeed({
                base: "lando" as const,
                normalizedConfig:
                  options.normalizedType === undefined ? config : { ...config, type: options.normalizedType },
                features: options.featureArtifact ? [{ id: "bare.artifact" }] : [],
              }),
          }),
        loadServiceFeature: (id: string) =>
          id === "bare.artifact"
            ? Effect.succeed({
                id,
                priority: 100,
                apply: (
                  ctx: Parameters<import("@lando/sdk/services").ServiceFeatureDefinition["apply"]>[0],
                ) => Effect.sync(() => ctx.setArtifact({ kind: "ref", ref: "alpine:3.22" })),
              })
            : registry.loadServiceFeature(id),
      };
      return yield* Effect.flatMap(AppPlanner, (planner) =>
        planner.plan(
          literalTestLandofile(
            {
              name: "artifact-repro",
              runtime: 4,
              services: { [ServiceName.make("web")]: { type: "bare", home: false, ...service } },
            },
            root,
          ),
          { ...TestRuntimeProvider.capabilities, artifactBuild: true },
        ),
      ).pipe(Effect.provide(Planner.layer), Effect.provideService(PluginRegistry, customRegistry));
    }).pipe(Effect.provide(Registry.layer)),
  );
};

test("#2122 normalizes an image for a bare service type", async () => {
  const result = await plan({ image: "nginx:alpine" });
  expect(result.services[ServiceName.make("web")]?.artifact).toEqual({ kind: "ref", ref: "nginx:alpine" });
});

test("a feature artifact takes precedence over the authored image", async () => {
  const result = await plan({ image: "nginx:alpine" }, { featureArtifact: true });
  expect(result.services[ServiceName.make("web")]?.artifact).toEqual({ kind: "ref", ref: "alpine:3.22" });
});

test("an authored Compose build replaces a feature artifact", async () => {
  const result = await plan(
    { build: { context: ".", dockerfile: "Containerfile" } },
    { featureArtifact: true },
  );
  expect(result.services[ServiceName.make("web")]?.artifact).toMatchObject({
    kind: "build",
    spec: "Containerfile",
  });
});

test("a bare versioned service uses its published artifact tag", async () => {
  const result = await plan({ type: "bare:1" });
  expect(result.services[ServiceName.make("web")]?.artifact).toEqual({ kind: "ref", ref: "nginx:1-alpine" });
});

test.each(
  [true, false].flatMap((withManifest) => [
    { withManifest, service: {} },
    { withManifest, service: { build: { artifact: "echo no-base" } } },
  ]),
)("rejects missing artifact intent during planning: %j", async ({ withManifest, service }) => {
  const error = await plan(service, { withManifest }).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(LandofileValidationError);
  if (!(error instanceof LandofileValidationError)) throw new TypeError("Expected planning validation error");
  expect(error.message).toContain("web");
  expect(error.message).toContain("bare");
  if (withManifest) expect(error.message).toContain("@example/bare");
  expect(error.issues[0]?.path).toEqual(["services", "web", "type"]);
  expect(error.remediation).toContain("image:");
  expect(error.remediation).toContain("build:");
  expect(error.remediation).toContain("feature");
  expect(error.issues[0]?.suggestion).toBe(error.remediation);
});

test("attributes a normalized type's missing artifact to its registered plugin", async () => {
  const error = await plan({}, { normalizedType: "normalized-family" }).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(LandofileValidationError);
  if (!(error instanceof LandofileValidationError)) throw new TypeError("Expected planning validation error");
  expect(error.message).toContain("type bare from plugin @example/bare");
  expect(error.message).not.toContain("@example/unrelated");
});
