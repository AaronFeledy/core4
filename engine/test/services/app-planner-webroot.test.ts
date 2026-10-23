import { expect, test } from "bun:test";
import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { LandofileValidationError } from "@lando/sdk/errors";
import {
  LandofileShape,
  type ServiceConfig,
  ServiceName,
  formatValidationIssuePath,
} from "@lando/sdk/schema";
import { AppPlanner, PluginRegistry, type ServiceType } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import { composeExtendedServiceType } from "../../src/services/extends.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";

const APP_ROOT = process.cwd();
const plan = (service: typeof ServiceConfig.Encoded) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "webroot-contract",
    runtime: 4,
    services: { web: { home: false, certs: false, ...service } },
  });
  return Effect.flatMap(AppPlanner, (planner) =>
    planner.plan(rememberLandofileAppRoot(landofile, APP_ROOT), TestRuntimeProvider.capabilities),
  ).pipe(Effect.provide(AppPlannerLayer.layer));
};

test.each([
  { type: "ruby:3.3", framework: "rails", appMount: false, webroot: "public" },
  { type: "ruby:3.3", framework: "rails", appMount: false, webroot: "/srv/public" },
  { type: "python:3.12", webroot: "public" },
  { type: "go:1.22", webroot: "/srv/public" },
  { type: "mysql:8.0", webroot: "public" },
] satisfies readonly (typeof ServiceConfig.Encoded)[])(
  "rejects unsupported explicit webroot %j",
  async (service) => {
    // Given an authored root without a composed feature that handles it.
    // When the complete planner runs.
    const exit = await Effect.runPromiseExit(plan(service).pipe(Effect.provide(PluginRegistryLayer.layer)));
    // Then the diagnostic identifies the authored field and Landofile.
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("Expected unsupported webroot rejection");
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    expect(error).toBeInstanceOf(LandofileValidationError);
    if (!(error instanceof LandofileValidationError)) throw new Error("Expected validation error");
    expect(error.file).toBe(`${APP_ROOT}/.lando.yml`);
    expect(error.issues.map((issue) => formatValidationIssuePath(issue.path))).toEqual([
      "services.web.webroot",
    ]);
  },
);

test("Ruby preserves authored nested context and cwd through the complete planner", async () => {
  // Given authored spelling distinct from the Rails preset.
  const service = {
    type: "ruby:3.3",
    framework: "rails",
    webroot: "./frontend/public/",
    appMount: { target: "/site" },
  };
  // When
  const result = await Effect.runPromise(plan(service).pipe(Effect.provide(PluginRegistryLayer.layer)));
  // Then
  const web = result.services[ServiceName.make("web")];
  expect(web?.environment.LANDO_WEBROOT).toBe("/site/frontend/public");
  expect(web?.extensions["lando-service-ruby"]).toMatchObject({ webroot: "/site/frontend/public" });
  expect(String(web?.workingDirectory)).toBe("/site");
  expect(web?.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
});

test("Ruby omits only implicit context when the app mount is disabled", async () => {
  // Given / When
  const result = await Effect.runPromise(
    plan({ type: "ruby:3.3", framework: "rails", appMount: false }).pipe(
      Effect.provide(PluginRegistryLayer.layer),
    ),
  );
  // Then
  const web = result.services[ServiceName.make("web")];
  expect(web?.environment.LANDO_WEBROOT).toBeUndefined();
  expect(web?.workingDirectory).toBeUndefined();
  expect(web?.extensions["lando-service-ruby"]).not.toHaveProperty("webroot");
});

test.each(["php:8.3", "nginx", "apache", "static:nginx", "tomcat"])(
  "%s accepts an absolute server root without an app mount",
  async (type) => {
    // Given / When
    const result = await Effect.runPromise(
      plan({ type, appMount: false, webroot: "/srv/public" }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    // Then the supporting server composition plans without app-context env.
    const web = result.services[ServiceName.make("web")];
    expect(web?.environment.LANDO_WEBROOT).toBeUndefined();
    expect(web?.appMount).toBeUndefined();
  },
);

test.each([undefined, null, 7, ""])("does not accept invalid feature declaration %j", async (webroot) => {
  // Given a custom type, not a built-in language identifier.
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const registry = yield* PluginRegistry;
      const type: ServiceType = {
        id: "custom-context",
        name: "custom-context",
        base: "l337",
        schema: Schema.Unknown,
        resolve: (input) =>
          Effect.succeed({
            base: "l337",
            normalizedConfig: input.service,
            features: [{ id: "custom.marker", config: { webroot } }],
          }),
      };
      // When
      return yield* plan({ type: type.id, image: "busybox", webroot: "public" }).pipe(
        Effect.provideService(PluginRegistry, {
          ...registry,
          loadServiceType: () => Effect.succeed(type),
          loadServiceFeature: () =>
            Effect.succeed({ id: "custom.marker", priority: 900, apply: () => Effect.void }),
        }),
      );
    }).pipe(Effect.provide(PluginRegistryLayer.layer)),
  );
  // Then
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("Expected declaration rejection");
  expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBeInstanceOf(LandofileValidationError);
});

test.each(["python:3.12", "ruby:3.3"])(
  "an inherited supporting feature handles a %s root without changing language policy",
  async (baseType) => {
    // Given a parent declaration and a child overlay on the same feature.
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry;
        const parent = yield* registry.loadServiceType(baseType);
        const supporting: ServiceType = {
          ...parent,
          id: "supporting-python",
          resolve: (input) =>
            parent.resolve(input).pipe(
              Effect.map((resolution) => ({
                ...resolution,
                features: [
                  ...resolution.features,
                  { id: "custom.root", config: { webroot: "/srv/public", env: "ROOT_CONTEXT" } },
                ],
              })),
            ),
        };
        const child: ServiceType = {
          id: "inherited-python",
          name: "inherited-python",
          base: "lando",
          extends: supporting.id,
          schema: Schema.Unknown,
          resolve: (input) =>
            Effect.succeed({
              base: "lando",
              normalizedConfig: input.service,
              features: [{ id: "custom.root", config: { command: ["serve", "/srv/public"] } }],
            }),
        };
        const composed = yield* composeExtendedServiceType(child, (id) =>
          id === supporting.id ? supporting : undefined,
        );
        // When the real composition applies the inherited feature.
        return yield* plan({ type: child.id, webroot: "/srv/public", appMount: false }).pipe(
          Effect.provideService(PluginRegistry, {
            ...registry,
            loadServiceType: () => Effect.succeed(composed),
            loadServiceFeature: (id) =>
              id === "custom.root"
                ? Effect.succeed({
                    id,
                    priority: 900,
                    schema: Schema.Unknown,
                    apply: (ctx) =>
                      Effect.sync(() => {
                        const config = Schema.decodeUnknownSync(
                          Schema.Struct({
                            webroot: Schema.String,
                            env: Schema.String,
                            command: Schema.Array(Schema.String),
                          }),
                        )(ctx.config);
                        ctx.addEnv(config.env, config.webroot);
                        ctx.setCommand(config.command);
                        ctx.addExtension("custom.root", { webroot: config.webroot });
                      }),
                  })
                : registry.loadServiceFeature(id),
          }),
        );
      }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    // Then merged configuration has a real command, env, and extension effect.
    const web = result.services[ServiceName.make("web")];
    expect(web?.command).toEqual(["serve", "/srv/public"]);
    expect(web?.environment.ROOT_CONTEXT).toBe("/srv/public");
    expect(web?.extensions["custom.root"]).toEqual({ webroot: "/srv/public" });
  },
);
