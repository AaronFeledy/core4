import { Effect, Layer } from "effect";

import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { makeLandoPaths } from "@lando/paths";
import type { GlobalConfig, LandofileShape } from "@lando/sdk/schema";
import { AppPlanner, ConfigService, PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider, type makeTestCertificateAuthority } from "@lando/sdk/test";

import { CertificateAuthorityResolver } from "../../src/plugins/certificate-authority-resolver.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";

export type AppPlannerCertsTestCa = ReturnType<typeof makeTestCertificateAuthority>;

export type AppPlannerCertsPlanInput = {
  readonly appRoot: string;
  readonly cacheRoot: string;
  readonly landofile: LandofileShape;
  readonly ca?: AppPlannerCertsTestCa | undefined;
  readonly config?: GlobalConfig;
};

export const planAppPlannerCertsEffect = (input: AppPlannerCertsPlanInput) => {
  const config = input.config;
  const dependencies = Layer.mergeAll(
    PluginRegistryLayer.layer,
    BunFileSystem.layer,
    ...(config === undefined
      ? []
      : [
          Layer.succeed(
            ConfigService,
            ConfigService.of({
              load: Effect.succeed(config),
              get: <K extends keyof GlobalConfig>(key: K) => Effect.succeed(config[key]),
            }),
          ),
        ]),
    Layer.succeed(
      PathsService,
      makeLandoPaths({
        platform: "linux",
        home: input.appRoot,
        env: {},
        userCacheRoot: input.cacheRoot,
      }),
    ),
    ...(input.ca === undefined
      ? []
      : [
          Layer.succeed(
            CertificateAuthorityResolver,
            CertificateAuthorityResolver.of({ resolve: Effect.succeed(input.ca) }),
          ),
        ]),
  );
  const planner = AppPlannerLayer.layer.pipe(Layer.provide(dependencies));
  return Effect.flatMap(AppPlanner, (service) =>
    service.plan(rememberLandofileAppRoot(input.landofile, input.appRoot), TestRuntimeProvider.capabilities),
  ).pipe(Effect.provide(planner));
};

export const planAppPlannerCerts = (input: AppPlannerCertsPlanInput) =>
  Effect.runPromise(planAppPlannerCertsEffect(input));
