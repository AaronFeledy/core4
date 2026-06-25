import { Effect, Either, ParseResult, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import type { ServiceConfig, ServicePlan } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition } from "@lando/sdk/services";

import { type DraftServicePlan, deterministicMetadata, sortRecord } from "./draft.ts";

export interface BaseSeed {
  readonly name: ServicePlan["name"];
  readonly type: ServicePlan["type"];
  readonly provider: ServicePlan["provider"];
  readonly primary: ServicePlan["primary"];
  readonly environment?: Readonly<Record<string, string>>;
  readonly defaultFeatures: ReadonlyArray<ServiceFeatureDefinition>;
}

export interface ComposeServiceFeature {
  readonly id: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly definition: ServiceFeatureDefinition;
}

export interface ComposeServiceInput {
  readonly base: BaseSeed;
  readonly baseKind: ServiceFeatureContext["base"];
  readonly appName?: string | undefined;
  readonly appRoot: ServiceFeatureContext["appRoot"];
  readonly host?: ServiceFeatureContext["host"];
  readonly normalizedConfig: ServiceConfig;
  readonly features: ReadonlyArray<ComposeServiceFeature>;
}

interface OrderedFeature {
  readonly index: number;
  readonly id: string;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly definition: ServiceFeatureDefinition;
}

const recordConfig = (
  input: unknown,
  feature: string,
): Effect.Effect<Readonly<Record<string, unknown>>, ServiceFeatureError> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return Effect.fail(
      new ServiceFeatureError({ message: "Service feature config must decode to an object", feature }),
    );
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) output[key] = value;
  return Effect.succeed(sortRecord(output));
};

const decodeFeatureConfig = (
  feature: OrderedFeature,
): Effect.Effect<Readonly<Record<string, unknown>>, ServiceFeatureError> => {
  const rawConfig = feature.config ?? {};
  if (feature.definition.schema === undefined) return Effect.succeed(sortRecord(rawConfig));

  const decoded = Schema.decodeUnknownEither(feature.definition.schema)(rawConfig, {
    onExcessProperty: "error",
  });
  if (Either.isRight(decoded)) return recordConfig(decoded.right, feature.id);

  const details = ParseResult.ArrayFormatter.formatErrorSync(decoded.left)
    .map((issue) => issue.message)
    .join("; ");
  return Effect.fail(
    new ServiceFeatureError({
      message:
        details.length > 0 ? `Invalid service feature config: ${details}` : "Invalid service feature config",
      feature: feature.id,
      cause: decoded.left,
    }),
  );
};

const makeDraft = (base: BaseSeed): DraftServicePlan => ({
  name: base.name,
  type: base.type,
  provider: base.provider,
  primary: base.primary,
  environment: sortRecord(base.environment ?? {}),
  mounts: [],
  buildSteps: [],
  storage: [],
  endpoints: [],
  dependsOn: [],
  hostAliases: [],
});

const stableFeatureOrder = (input: ComposeServiceInput): ReadonlyArray<OrderedFeature> =>
  [...input.base.defaultFeatures.map((definition) => ({ id: definition.id, definition })), ...input.features]
    .map((feature, index) => ({ ...feature, index }))
    .sort((left, right) => left.definition.priority - right.definition.priority || left.index - right.index);

const makeContext = (
  input: ComposeServiceInput,
  draft: DraftServicePlan,
  config: Readonly<Record<string, unknown>>,
): ServiceFeatureContext => ({
  serviceName: draft.name,
  serviceType: draft.type,
  base: input.baseKind,
  primary: draft.primary,
  appName: input.appName,
  appRoot: input.appRoot,
  host: input.host,
  normalizedConfig: input.normalizedConfig,
  config,
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
  addStorage: (storage) => {
    draft.storage.push({ ...storage });
  },
  addEndpoint: (endpoint) => {
    draft.endpoints.push({ ...endpoint });
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
  setCerts: (certs) => {
    draft.certs = { ...certs };
  },
  setEntrypoint: (entrypoint) => {
    draft.entrypoint = Array.isArray(entrypoint) ? [...entrypoint] : entrypoint;
  },
  setCommand: (command) => {
    draft.command = Array.isArray(command) ? [...command] : command;
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

const finalizeDraft = (draft: DraftServicePlan): ServicePlan => {
  const coreExtension =
    draft.buildSteps.length === 0
      ? {}
      : {
          "@lando/core/service-features": {
            buildSteps: draft.buildSteps.map((step) => ({ ...step })),
          },
        };

  return {
    name: draft.name,
    type: draft.type,
    provider: draft.provider,
    primary: draft.primary,
    ...(draft.artifact === undefined ? {} : { artifact: draft.artifact }),
    ...(draft.command === undefined ? {} : { command: draft.command }),
    ...(draft.entrypoint === undefined ? {} : { entrypoint: draft.entrypoint }),
    environment: sortRecord(draft.environment),
    ...(draft.user === undefined ? {} : { user: draft.user }),
    ...(draft.workingDirectory === undefined ? {} : { workingDirectory: draft.workingDirectory }),
    ...(draft.appMount === undefined
      ? {}
      : {
          // Provider realization is finalized later; composition emits neutral passthrough intent.
          appMount: { ...draft.appMount, realization: "passthrough" },
        }),
    mounts: draft.mounts.map((mount) => ({ ...mount, realization: "passthrough" })),
    storage: draft.storage.map((storage) => ({ ...storage })),
    endpoints: draft.endpoints.map((endpoint) => ({ ...endpoint })),
    routes: [],
    dependsOn: draft.dependsOn.map((dependency) => ({ ...dependency })),
    ...(draft.healthcheck === undefined ? {} : { healthcheck: draft.healthcheck }),
    ...(draft.certs === undefined ? {} : { certs: draft.certs }),
    hostAliases: draft.hostAliases.map((alias) => ({ ...alias })),
    metadata: deterministicMetadata,
    extensions: coreExtension,
  };
};

export const composeService = (input: ComposeServiceInput): Effect.Effect<ServicePlan, ServiceFeatureError> =>
  Effect.gen(function* () {
    const draft = makeDraft(input.base);
    const orderedFeatures = stableFeatureOrder(input);

    yield* Effect.forEach(
      orderedFeatures,
      (feature) =>
        Effect.gen(function* () {
          const config = yield* decodeFeatureConfig(feature);
          yield* feature.definition.apply(makeContext(input, draft, config));
        }),
      { discard: true },
    );

    return finalizeDraft(draft);
  });
