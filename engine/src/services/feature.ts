import { Effect, Either, ParseResult, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import {
  PortablePath,
  type ServiceConfig,
  type ServicePlan,
  containerDestinationRefusalMessage,
  parseContainerDestination,
} from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition } from "@lando/sdk/services";

import {
  type BaseSeed,
  type DraftServicePlan,
  deterministicMetadata,
  makeDraft,
  sortRecord,
} from "./draft.ts";

export type { BaseSeed } from "./draft.ts";

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

interface OrderedFeature extends ComposeServiceFeature {
  readonly index: number;
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

const destinationError = (target: string, reason: "not-absolute" | "root"): ServiceFeatureError =>
  new ServiceFeatureError({
    message: containerDestinationRefusalMessage(reason, target),
    feature: "destination",
  });

const finalizeDraft = (draft: DraftServicePlan): ServicePlan | ServiceFeatureError => {
  const featureIds = draft.featureIds ?? [];
  const dataTrees = draft.storageOwnership ?? [];
  const coreExtension =
    draft.buildSteps.length === 0 && featureIds.length === 0 && dataTrees.length === 0
      ? {}
      : {
          "@lando/core/service-features": {
            ...(featureIds.length === 0 ? {} : { featureIds: [...featureIds] }),
            ...(dataTrees.length === 0 ? {} : { dataTrees: dataTrees.map((tree) => ({ ...tree })) }),
            ...(draft.buildSteps.length === 0
              ? {}
              : { buildSteps: draft.buildSteps.map((step) => ({ ...step })) }),
          },
        };

  let appMount: ServicePlan["appMount"];
  if (draft.appMount !== undefined) {
    const parsed = parseContainerDestination(draft.appMount.target);
    if (!parsed.ok) return destinationError(draft.appMount.target, parsed.reason);
    appMount = {
      ...draft.appMount,
      target: parsed.value,
      realization: "passthrough",
    };
  }

  const mounts: Array<ServicePlan["mounts"][number]> = [];
  for (const mount of draft.mounts) {
    const parsed = parseContainerDestination(mount.target);
    if (!parsed.ok) return destinationError(mount.target, parsed.reason);
    mounts.push({
      ...mount,
      target: parsed.value,
      realization: "passthrough",
    });
  }

  const storage: Array<ServicePlan["storage"][number]> = [];
  for (const entry of draft.storage) {
    const parsed = parseContainerDestination(entry.target);
    if (!parsed.ok) return destinationError(entry.target, parsed.reason);
    storage.push({
      ...entry,
      target: parsed.value,
    });
  }

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
    ...(appMount === undefined ? {} : { appMount }),
    mounts,
    storage,
    endpoints: draft.endpoints.map((endpoint) => ({ ...endpoint })),
    routes: [],
    dependsOn: draft.dependsOn.map((dependency) => ({ ...dependency })),
    ...(draft.healthcheck === undefined ? {} : { healthcheck: draft.healthcheck }),
    ...(draft.certs === undefined ? {} : { certs: draft.certs }),
    hostAliases: draft.hostAliases.map((alias) => ({ ...alias })),
    metadata: deterministicMetadata,
    extensions: { ...coreExtension, ...(draft.extensions ?? {}) },
  };
};

export const composeService = (input: ComposeServiceInput): Effect.Effect<ServicePlan, ServiceFeatureError> =>
  Effect.gen(function* () {
    const draft = makeDraft(input.base);
    const orderedFeatures = stableFeatureOrder(input);
    draft.featureIds = orderedFeatures.map((feature) => feature.id);

    yield* Effect.forEach(
      orderedFeatures,
      (feature) =>
        Effect.gen(function* () {
          const config = yield* decodeFeatureConfig(feature);
          yield* feature.definition.apply(makeContext(input, draft, config));
        }),
      { discard: true },
    );

    // Explicit endpoint intent replaces feature defaults, including an empty list.
    if (input.normalizedConfig.endpoints !== undefined) {
      draft.endpoints = input.normalizedConfig.endpoints.map((endpoint) => {
        switch (endpoint.protocol) {
          case "unix":
            return { ...endpoint, socketPath: PortablePath.make(endpoint.socketPath) };
          case "http":
          case "https":
          case "tcp":
          case "udp":
            return { ...endpoint };
          default:
            return endpoint satisfies never;
        }
      });
    }
    const finalized = finalizeDraft(draft);
    if (finalized instanceof ServiceFeatureError) return yield* Effect.fail(finalized);
    return finalized;
  });
