import { expect, test } from "bun:test";
import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { LandofileValidationError } from "@lando/sdk/errors";
import { LandofileShape, PortablePath } from "@lando/sdk/schema";
import { AppPlanner, PluginRegistry, type ServiceType } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";

test.each([false, true])(
  "uses original authored root and final substituted features (explicit=%s)",
  async (explicit) => {
    // Given a resolver with an implicit normalized root and a declaration replaced by planner seeding.
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "webroot-seeds",
      runtime: 4,
      services: {
        web: {
          type: "seed-context",
          image: "busybox",
          home: false,
          ...(explicit ? { webroot: "public" } : {}),
        },
      },
    });
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry;
        const type: ServiceType = {
          id: "seed-context",
          name: "seed-context",
          base: "l337",
          schema: Schema.Unknown,
          resolve: (input) =>
            Effect.succeed({
              base: "l337",
              normalizedConfig: { ...input.service, webroot: PortablePath.make("/implicit") },
              features: [{ id: "lando.ssh-agent", config: { webroot: "/discarded" } }],
            }),
        };
        // When
        return yield* Effect.flatMap(AppPlanner, (planner) =>
          planner.plan(rememberLandofileAppRoot(landofile, process.cwd()), TestRuntimeProvider.capabilities),
        ).pipe(
          Effect.provide(AppPlannerLayer.layer),
          Effect.provideService(PluginRegistry, { ...registry, loadServiceType: () => Effect.succeed(type) }),
        );
      }).pipe(Effect.provide(PluginRegistryLayer.layer)),
    );
    // Then implicit defaults remain valid but explicit input cannot use a replaced declaration.
    expect(Exit.isFailure(exit)).toBe(explicit);
    if (Exit.isFailure(exit))
      expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toBeInstanceOf(
        LandofileValidationError,
      );
  },
);
