import { expect, test } from "bun:test";
import { LandofileValidationError } from "@lando/sdk/errors";
import { definePlugin } from "@lando/sdk/plugins";
import { PluginManifest, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { AppFeatureDefinition, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { NGINX_DEFAULT_IMAGE } from "@lando/service-lando/services/default-images";
import { Effect, Schema } from "effect";
import { bundledPluginModules } from "../../src/composition.ts";
import * as Registry from "../../src/plugins/registry.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";
import { planApp } from "../plan-app.ts";

const web = ServiceName.make("web");
const worker = { name: "nginx", uid: 101, gid: 101 };
const foreignImage = `example.test/library/${NGINX_DEFAULT_IMAGE}`;
const pluginName = "@example/launcher-mutation";

type LauncherWrites = Pick<
  Parameters<ServiceFeatureDefinition["apply"]>[0],
  "setCommand" | "setEntrypoint" | "setArtifact"
>;

const plan = (
  service: Readonly<Record<string, unknown>>,
  feature?: {
    readonly phase: "before service" | "after service" | "before app" | "app";
    readonly apply: (ctx: LauncherWrites) => void;
  },
  services: Readonly<Record<string, unknown>> = {},
): Promise<ServicePlan | undefined> => {
  const appPhase = feature?.phase === "before app" || feature?.phase === "app";
  const mutation: ServiceFeatureDefinition = {
    id: "test.launcher-mutation",
    priority: feature?.phase === "before service" ? 500 : 700,
    apply: (ctx) => Effect.sync(() => feature?.apply(ctx)),
  };
  const appMutation: AppFeatureDefinition = {
    id: mutation.id,
    priority: feature?.phase === "before app" ? 50 : 700,
    selectors: { names: [web] },
    apply: (ctx) => Effect.sync(() => ctx.forEachSelected((selected) => feature?.apply(selected))),
  };
  const child: ServiceType = {
    id: "test-nginx",
    name: "test-nginx",
    base: "lando",
    extends: "nginx",
    schema: Schema.Unknown,
    resolve: ({ service: normalizedConfig }) =>
      Effect.succeed({ base: "lando", normalizedConfig, features: [{ id: mutation.id }] }),
  };
  const plugin = definePlugin({
    name: pluginName,
    manifest: Schema.decodeUnknownSync(PluginManifest)({
      name: pluginName,
      version: "1.0.0",
      api: 4,
      entry: "index.js",
      contributes: appPhase
        ? { appFeatures: [appMutation.id] }
        : { serviceTypes: [child.id], serviceFeatures: [mutation.id] },
    }),
    ...(appPhase
      ? { appFeatures: new Map([[appMutation.id, appMutation]]) }
      : {
          serviceTypes: new Map([[child.id, child]]),
          serviceFeatures: new Map([[mutation.id, mutation]]),
        }),
  });
  const serviceType = feature === undefined || appPhase ? "nginx" : child.id;
  return Effect.runPromise(
    Effect.gen(function* () {
      const landofile = yield* compileTestLandofile(
        {
          name: "project-user-launcher",
          services: { ...services, [web]: { type: serviceType, ...service } },
        },
        "/srv/launcher-composition",
      );
      const result = yield* planApp(
        {
          landofile,
          providerCapabilities: {
            ...TestRuntimeProvider.capabilities,
            artifactBuild: true,
            bindOwnership: "root-is-host-user",
            projectUserMapping: "userns-keep-id",
          },
        },
        Registry.layerWith({ app: false, user: false }, [
          ...bundledPluginModules(),
          ...(feature === undefined ? [] : [plugin]),
        ]),
      );
      return result.services[web];
    }),
  );
};

test.each(["before service", "after service", "app"] as const)(
  "a contributed entrypoint (%s) prevents implicit worker mapping",
  async (phase) => {
    const entrypoint = ["replacement-entrypoint"];
    const service = await plan({}, { phase, apply: (ctx) => ctx.setEntrypoint(entrypoint) });
    expect(service?.entrypoint).toEqual(entrypoint);
    expect(service?.projectUserExplanation?.state).toBe("unresolved");
  },
);

test("the FPM command rewrite cannot re-enable mapping over a contributed entrypoint", async () => {
  const entrypoint = ["replacement-entrypoint"];
  const service = await plan(
    { backend: "fpm" },
    { phase: "before app", apply: (ctx) => ctx.setEntrypoint(entrypoint) },
    { fpm: { type: "php:8.3", via: "fpm", port: 9070 } },
  );
  expect(service?.command?.[2]).toContain("fastcgi_pass fpm:9070;");
  expect(service?.entrypoint).toEqual(entrypoint);
  expect(service?.projectUserExplanation?.state).toBe("unresolved");
});

test.each(["after service", "app"] as const)(
  "an unmarked %s command write replaces the stock launcher even with identical bytes",
  async (phase) => {
    const stock = await plan({});
    if (stock?.command === undefined) throw new Error("Expected a stock launcher");
    const command = stock.command;
    const service = await plan({}, { phase, apply: (ctx) => ctx.setCommand(command) });
    expect(service?.command).toEqual(command);
    expect(service?.projectUserExplanation?.state).toBe("unresolved");
  },
);

test.each(["after service", "app"] as const)(
  "a foreign image from %s carries no stock identity",
  async (phase) => {
    const artifact = { kind: "ref", ref: foreignImage } as const;
    const service = await plan({}, { phase, apply: (ctx) => ctx.setArtifact(artifact) });
    expect(service?.artifact).toEqual(artifact);
    expect(service?.projectUserExplanation?.state).toBe("unresolved");
    expect(service?.home).toMatchObject({ state: "unknown", reason: "custom-image" });
  },
);

test("a canonical alias of the stock artifact preserves the worker", async () => {
  const artifact = { kind: "ref", ref: `index.docker.io/library/${NGINX_DEFAULT_IMAGE}` } as const;
  const service = await plan({}, { phase: "app", apply: (ctx) => ctx.setArtifact(artifact) });
  expect(service?.artifact).toEqual(artifact);
  expect(service?.projectUser).toEqual(worker);
});

test("a numeric project user still maps on a substituted image", async () => {
  const service = await plan(
    { projectUser: "501:502" },
    { phase: "app", apply: (ctx) => ctx.setArtifact({ kind: "ref", ref: foreignImage }) },
  );
  expect(service?.projectUser).toEqual({ name: "501", uid: 501, gid: 502 });
});

test("the catalog name cannot be selected on a substituted image", async () => {
  await expect(
    plan(
      { projectUser: "nginx" },
      { phase: "app", apply: (ctx) => ctx.setArtifact({ kind: "ref", ref: foreignImage }) },
    ),
  ).rejects.toBeInstanceOf(LandofileValidationError);
});

test("an explicit catalog name still maps with a replacement launcher on the stock image", async () => {
  const service = await plan(
    { projectUser: "nginx" },
    { phase: "app", apply: (ctx) => ctx.setCommand(["replacement"]) },
  );
  expect(service?.projectUser).toEqual(worker);
});
