import { Context, Effect, Layer } from "effect";

import { makeLandoPaths } from "@lando/paths";
import type { AppRef, GlobalConfig, LandofileShape } from "@lando/sdk/schema";
import { AppPlanner, ConfigService, PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { literalTestLandofile } from "../compiled-landofile.ts";

import { CertificateAuthorityResolver } from "../../src/plugins/certificate-authority-resolver.ts";
import {
  type GraphCertificateAuthorityCandidate,
  PluginContributionGraph,
} from "../../src/plugins/contribution-graph.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";

export const makeUntouchableResolver = () => {
  let calls = 0;
  const resolver = CertificateAuthorityResolver.of({
    resolve: Effect.suspend(() => {
      calls += 1;
      return Effect.die(new Error("planning must not resolve a certificate authority"));
    }),
  });
  return { resolver, calls: () => calls };
};

export const certificateAuthorityGraph = (
  certificateAuthorities: ReadonlyArray<Omit<GraphCertificateAuthorityCandidate, "acquisition">>,
) =>
  PluginContributionGraph.of({
    plugins: [],
    globalPlugins: [],
    certificateAuthorities: certificateAuthorities.map((candidate) => ({
      ...candidate,
      acquisition: { kind: "module", module: "./never-loaded.ts" },
    })),
    commands: [],
    diagnostics: [],
    hostContext: Context.empty(),
  });

export type AppPlannerCertsPlanInput = {
  readonly appRoot: string;
  readonly cacheRoot: string;
  readonly landofile: LandofileShape;
  readonly resolver?: Context.Service.Shape<typeof CertificateAuthorityResolver> | undefined;
  readonly graph?: Context.Service.Shape<typeof PluginContributionGraph> | undefined;
  readonly kind?: AppRef["kind"];
  readonly config?: GlobalConfig;
};

export const appPlannerCertsPaths = (input: Pick<AppPlannerCertsPlanInput, "appRoot" | "cacheRoot">) =>
  makeLandoPaths({
    platform: "linux",
    home: input.appRoot,
    env: {},
    userCacheRoot: input.cacheRoot,
  });

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
    Layer.succeed(PathsService, appPlannerCertsPaths(input)),
    ...(input.resolver === undefined ? [] : [Layer.succeed(CertificateAuthorityResolver, input.resolver)]),
    ...(input.graph === undefined ? [] : [Layer.succeed(PluginContributionGraph, input.graph)]),
  );
  const planner = AppPlannerLayer.layer.pipe(Layer.provide(dependencies));
  return Effect.flatMap(AppPlanner, (service) =>
    service.plan(
      literalTestLandofile(input.landofile, input.appRoot),
      TestRuntimeProvider.capabilities,
      input.kind === undefined ? undefined : { kind: input.kind },
    ),
  ).pipe(Effect.provide(planner));
};

export const planAppPlannerCerts = (input: AppPlannerCertsPlanInput) =>
  Effect.runPromise(planAppPlannerCertsEffect(input));
