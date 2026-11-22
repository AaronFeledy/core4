import { ServiceFeatureError } from "@lando/sdk/errors";
import type { EndpointPlan, ServiceConfig, ServicePlan } from "@lando/sdk/schema";
import { DependencyEnvironmentIntent, landoServiceStoreName, normalizeAppSlug } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { AUTHORED_BUILD_STEP_PREFIX, isAuthoredBuildStep } from "../planner/authored-build-step.ts";

import { type BaseSeed, type DraftServicePlan, makeDraft } from "./draft.ts";
import { endpointValidationError, normalizeEndpoints } from "./endpoint-normalizer.ts";
import { type ExtraArgsLauncher, captureExtraArgsLauncher } from "./extra-args-launcher.ts";
import {
  type ApplicationConfig,
  type PreparedServiceComposition,
  applicationFeatureConfig,
  declarePreparedServiceEndpoints,
  prepareServiceComposition,
} from "./feature-preparation.ts";
import { finalizeDraft } from "./finalize-service.ts";

export type { BaseSeed } from "./draft.ts";
export type { ExtraArgsLauncher } from "./extra-args-launcher.ts";

export interface ComposeServiceFeature {
  readonly id: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly definition: ServiceFeatureDefinition;
}

export interface ComposeServiceInput {
  readonly base: BaseSeed;
  readonly baseKind: ServiceFeatureContext["base"];
  readonly appName?: string | undefined;
  readonly dataName?: string | undefined;
  readonly appSlug: string;
  readonly featureOwners?: ReadonlyMap<string, string>;
  readonly appRoot: ServiceFeatureContext["appRoot"];
  readonly host?: ServiceFeatureContext["host"];
  readonly normalizedConfig: ServiceConfig;
  readonly authoredMounts?: ServiceFeatureContext["authoredMounts"];
  readonly resolutionMetadata?: Readonly<NonNullable<ServicePlan["provenance"]>> | undefined;
  readonly features: ReadonlyArray<ComposeServiceFeature>;
}

const makeContext = (
  input: PreparedServiceComposition["facts"],
  draft: DraftServicePlan,
  config: Readonly<Record<string, unknown>>,
  dependencyEnvironments: DependencyEnvironmentIntent[],
  setCommand: ServiceFeatureContext["setCommand"],
): ServiceFeatureContext => ({
  serviceName: draft.name,
  serviceType: draft.type,
  base: input.baseKind,
  primary: draft.primary,
  appName: input.appName,
  dataName: input.dataName,
  appRoot: input.appRoot,
  host: input.host,
  normalizedConfig: input.normalizedConfig,
  authoredMounts: input.authoredMounts ?? [],
  connection: draft.connection,
  config,
  addDependencyEnvironment: (intent) => {
    dependencyEnvironments.push(intent);
  },
  serviceStoreName: (role) =>
    landoServiceStoreName(
      input.dataName === undefined ? input.appSlug : normalizeAppSlug(input.dataName, input.appRoot),
      draft.name,
      role,
    ),
  addEnv: (name, value) => {
    draft.environment[name] = value;
  },
  addMount: (mount) => {
    draft.mounts.push({ ...mount });
  },
  setAppMount: (mount) => {
    draft.appMount = { ...mount };
  },
  addBuildStep: (step) => {
    draft.buildSteps.push({ ...step });
  },
  addExtension: (key, value) => {
    if (draft.extensions === undefined) draft.extensions = {};
    draft.extensions[key] = value;
  },
  addStorage: (storage, ownership) => {
    draft.storage.push({ ...storage });
    if (ownership !== undefined) {
      const owned = draft.storageOwnership ?? [];
      owned.push({ target: String(storage.target), seededOwners: [...ownership.seededOwners] });
      draft.storageOwnership = owned;
    }
  },
  addDependency: (dependency) => {
    draft.dependsOn.push({ ...dependency });
  },
  addHostAlias: (alias) => {
    draft.hostAliases.push({ ...alias });
  },
  setHealthcheck: (healthcheck) => {
    draft.healthcheck = { ...healthcheck };
  },
  setReadiness: (readiness) => {
    draft.readiness = { ...readiness };
    draft.readinessSource = "contributed";
  },
  setListenerAuthority: (authority) => {
    draft.listenerAuthority = authority;
  },
  setCerts: (certs) => {
    draft.certs = { ...certs };
  },
  setEntrypoint: (entrypoint) => {
    draft.entrypoint = Array.isArray(entrypoint) ? [...entrypoint] : entrypoint;
  },
  setCommand,
  setInit: (init) => {
    draft.init = init;
  },
  setArtifact: (artifact) => {
    draft.artifact = { ...artifact };
  },
  setUser: (user) => {
    draft.user = user;
  },
  setWorkingDirectory: (path) => {
    draft.workingDirectory = path;
  },
});

export const applyPreparedService = Effect.fn("ServiceFeature.applyPreparedService")(function* (input: {
  readonly prepared: PreparedServiceComposition;
  readonly endpointContributions: readonly EndpointPlan[];
  readonly applicationConfigs: ReadonlyMap<number, ApplicationConfig>;
  readonly authoredMounts?: ServiceFeatureContext["authoredMounts"];
  readonly launcherFeatures?: ReadonlySet<string>;
}): Effect.fn.Return<
  {
    readonly plan: ServicePlan;
    readonly endpointContributions: readonly EndpointPlan[];
    readonly featureIds: readonly string[];
    readonly dependencyEnvironments: readonly DependencyEnvironmentIntent[];
    readonly extraArgsLauncher: ExtraArgsLauncher | undefined;
  },
  ServiceFeatureError
> {
  const facts = {
    ...input.prepared.facts,
    ...(input.authoredMounts === undefined ? {} : { authoredMounts: input.authoredMounts }),
  };
  const draft = makeDraft({ ...facts.base, defaultFeatures: [] });
  const dependencyEnvironments: DependencyEnvironmentIntent[] = [];
  const launcher = captureExtraArgsLauncher(draft, input.launcherFeatures);
  if (facts.baseKind === "lando") draft.init = true;
  const orderedFeatures = input.prepared.features;
  draft.featureIds = orderedFeatures.map((feature) => feature.id);
  const endpointContributions = input.endpointContributions;
  draft.endpoints = endpointContributions.map((endpoint) => ({ ...endpoint }));

  yield* Effect.forEach(
    orderedFeatures,
    (feature) =>
      Effect.gen(function* () {
        const config = yield* applicationFeatureConfig(
          feature,
          input.applicationConfigs.get(feature.index) ?? { _tag: "Original" },
        );
        const firstStep = draft.buildSteps.length;
        const firstIntent = dependencyEnvironments.length;
        yield* launcher.capture(feature.id, (setCommand) =>
          feature.definition.apply(makeContext(facts, draft, config, dependencyEnvironments, setCommand)),
        );
        if (
          dependencyEnvironments
            .slice(firstIntent)
            .some((intent) => !Schema.is(DependencyEnvironmentIntent)(intent))
        ) {
          return yield* new ServiceFeatureError({
            feature: feature.id,
            message: "Invalid dependency-environment intent.",
            remediation: "Correct the feature's dependency-environment declaration or update the plugin.",
          });
        }
        const reserved = draft.buildSteps.slice(firstStep).find(isAuthoredBuildStep);
        if (reserved !== undefined) {
          return yield* Effect.fail(
            new ServiceFeatureError({
              feature: feature.id,
              message: `Build step ${reserved.id} uses the reserved ${AUTHORED_BUILD_STEP_PREFIX} prefix.`,
              remediation: "Rename the build step and its dependencies to use a feature-specific prefix.",
            }),
          );
        }
      }),
    { discard: true },
  );

  if (facts.normalizedConfig.init !== undefined) draft.init = facts.normalizedConfig.init;
  const finalized = finalizeDraft(draft);
  if (finalized instanceof ServiceFeatureError) return yield* Effect.fail(finalized);
  return {
    plan: finalized,
    endpointContributions,
    featureIds: draft.featureIds,
    dependencyEnvironments,
    extraArgsLauncher: launcher.current,
  };
});

export const composeServiceWithContributions = Effect.fn("ServiceFeature.composeServiceWithContributions")(
  function* (input: ComposeServiceInput) {
    const declared = yield* declarePreparedServiceEndpoints(prepareServiceComposition(input));
    const firstError = declared.errors[0];
    if (declared.errors.length === 1 && firstError !== undefined) return yield* Effect.fail(firstError);
    if (declared.errors.length > 0)
      return yield* Effect.fail(
        new ServiceFeatureError({
          feature: "composition",
          message: declared.errors.map((error) => error.message).join("; "),
          remediation: [...new Set(declared.errors.map((error) => error.remediation))].join(" "),
          issues: declared.errors.flatMap((error) =>
            error.issues?.length
              ? error.issues
              : [{ path: [], message: error.message, suggestion: error.remediation }],
          ),
        }),
      );
    return yield* applyPreparedService({
      prepared: declared.prepared,
      endpointContributions: declared.contributions,
      applicationConfigs: new Map(),
    });
  },
);

export const composeService = Effect.fn("ServiceFeature.composeService")(function* (
  input: ComposeServiceInput,
): Effect.fn.Return<ServicePlan, ServiceFeatureError> {
  const { plan, endpointContributions } = yield* composeServiceWithContributions(input);
  const endpoints = normalizeEndpoints(endpointContributions, input.normalizedConfig);
  const endpointError = endpointValidationError(endpoints, {
    appRoot: input.appRoot,
    serviceName: plan.name,
  });
  if (endpointError !== undefined) {
    return yield* Effect.fail(
      new ServiceFeatureError({
        message: endpointError.message,
        feature: "endpoints",
        cause: endpointError,
        remediation: "Correct the `endpoints` feature configuration in the Landofile, then re-run.",
      }),
    );
  }
  return { ...plan, endpoints };
});
