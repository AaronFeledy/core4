import { Effect, Layer } from "effect";

import { makeLandoPaths } from "@lando/paths";
import type { LandofileShape } from "@lando/sdk/schema";
import { AppPlanner, PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider, type makeTestCertificateAuthority } from "@lando/sdk/test";

import { CertificateAuthorityResolver } from "@lando/engine/plugins/certificate-authority-resolver";
import { PluginRegistryLive } from "@lando/engine/plugins/registry";
import { FileSystemLive } from "@lando/engine/services/file-system";
import { AppPlannerLive } from "@lando/engine/services/planner";
import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";

export type AppPlannerCertsTestCa = ReturnType<typeof makeTestCertificateAuthority>;

export type AppPlannerCertsPlanInput = {
  readonly appRoot: string;
  readonly cacheRoot: string;
  readonly landofile: LandofileShape;
  readonly ca?: AppPlannerCertsTestCa | undefined;
};

export const planAppPlannerCertsEffect = (input: AppPlannerCertsPlanInput) => {
  const dependencies = Layer.mergeAll(
    PluginRegistryLive,
    FileSystemLive,
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
      : [Layer.succeed(CertificateAuthorityResolver, { resolve: Effect.succeed(input.ca) })]),
  );
  const planner = AppPlannerLive.pipe(Layer.provide(dependencies));
  return Effect.flatMap(AppPlanner, (service) =>
    service.plan(rememberLandofileAppRoot(input.landofile, input.appRoot), TestRuntimeProvider.capabilities),
  ).pipe(Effect.provide(planner));
};

export const planAppPlannerCerts = (input: AppPlannerCertsPlanInput) =>
  Effect.runPromise(planAppPlannerCertsEffect(input));
