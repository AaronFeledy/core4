import { Cause, Effect, Either, Exit, Schema } from "effect";

import {
  LandofileShape,
  LogSource,
  type ProviderId,
  ServiceConfig,
  ServiceName,
  ServicePlan,
} from "../schema/index.ts";
import type {
  AppFeatureContext,
  AppFeatureDefinition,
  AppFeatureServiceMutators,
  AppFeatureServiceView,
  ServiceAppMountIntent,
  ServiceBuildStepIntent,
  ServiceFeatureContext,
  ServiceFeatureDefinition,
  ServiceMountIntent,
  ServiceType,
  ServiceTypeInput,
  ServiceTypeResolution,
} from "../services/index.ts";
import { ContractFailure, isNonEmptyString } from "./_shared.ts";

export const TestServiceType: ServiceType = {
  id: "test",
  name: "test",
  base: "lando",
  schema: Schema.Unknown,
  resolve: (input: ServiceTypeInput) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: input.service,
      features: [],
    } satisfies ServiceTypeResolution),
};

const serviceCompositionFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `ServiceType composition contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireServiceComposition = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(serviceCompositionFailure(assertion, details));

/** Input the composition contract feeds into {@link ServiceType.resolve}. */
export interface ServiceCompositionContractInput {
  readonly serviceType: ServiceType;
  /** Landofile service block whose decoded config is resolved. */
  readonly landofileService: Record<string, unknown>;
  readonly serviceName?: string;
  readonly appName?: string;
  readonly appRoot?: string;
  readonly providerId?: ProviderId;
}

/**
 * Run the service-composition contract: the type exposes a non-empty id/name,
 * declares a `base` of `"l337"` or `"lando"`, and `resolve()` is an Effect that
 * yields a `ServiceTypeResolution` with decoded `normalizedConfig` and a stable
 * (replay-equal) `features` array — and never returns a `ServicePlan`.
 */
export const runServiceCompositionContract = (
  input: ServiceCompositionContractInput,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const serviceType = input.serviceType;
    const serviceName = input.serviceName ?? "web";
    const appName = input.appName ?? "myapp";
    const appRoot = input.appRoot ?? `/srv/apps/${appName}`;

    yield* requireServiceComposition(
      isNonEmptyString(serviceType.id),
      "service type exposes a non-empty id",
      serviceType.id,
    );
    yield* requireServiceComposition(
      isNonEmptyString(serviceType.name),
      "service type exposes a non-empty name",
      serviceType.name,
    );
    yield* requireServiceComposition(
      serviceType.base === "l337" || serviceType.base === "lando",
      "service type declares a base of l337 or lando",
      serviceType.base,
    );
    yield* requireServiceComposition(
      typeof serviceType.resolve === "function",
      "service type resolve is callable",
      typeof serviceType.resolve,
    );

    const decodedLandofile = Schema.decodeUnknownEither(LandofileShape)({
      name: appName,
      services: { [serviceName]: input.landofileService },
    });
    yield* requireServiceComposition(
      Either.isRight(decodedLandofile),
      "landofile service input decodes through LandofileShape",
      Either.isLeft(decodedLandofile) ? decodedLandofile.left : undefined,
    );
    if (Either.isLeft(decodedLandofile)) return;

    const decodedService = decodedLandofile.right.services?.[ServiceName.make(serviceName)];
    yield* requireServiceComposition(
      decodedService !== undefined,
      "landofile decode preserves the requested service entry",
      { serviceName },
    );
    if (decodedService === undefined) return;

    const makeInput = (): ServiceTypeInput => ({
      name: serviceName,
      service: decodedService,
      appRoot,
      appName,
      ...(input.providerId === undefined ? {} : { provider: input.providerId }),
      primary: false,
      metadata: {
        resolvedAt: "2026-05-10T18:51:00Z",
        source: "@lando/sdk/test/service-composition-contract",
        runtime: 4,
      },
    });

    const resolution = yield* serviceType
      .resolve(makeInput())
      .pipe(
        Effect.mapError((cause) => serviceCompositionFailure("service type resolve succeeds", String(cause))),
      );

    yield* requireServiceComposition(
      typeof resolution === "object" && resolution !== null,
      "resolve returns a ServiceTypeResolution object",
      resolution,
    );
    yield* requireServiceComposition(
      !Schema.is(ServicePlan)(resolution as unknown),
      "resolve returns a resolution, not a hand-built ServicePlan",
      { keys: Object.keys(resolution as unknown as Record<string, unknown>) },
    );
    yield* requireServiceComposition(
      resolution.base === serviceType.base,
      "resolution base matches the declared service type base",
      { declared: serviceType.base, resolved: resolution.base },
    );

    const normalizedDecodes = Schema.is(ServiceConfig)(resolution.normalizedConfig);
    yield* requireServiceComposition(
      normalizedDecodes,
      "resolution normalizedConfig is a valid ServiceConfig",
      resolution.normalizedConfig,
    );

    yield* requireServiceComposition(
      Array.isArray(resolution.features),
      "resolution features is an array of FeatureRefs",
      resolution.features,
    );
    for (const [index, feature] of resolution.features.entries()) {
      yield* requireServiceComposition(
        isNonEmptyString(feature.id),
        "resolution feature declares a non-empty id",
        { index, feature },
      );
    }

    const logSources = resolution.logSources ?? [];
    yield* requireServiceComposition(
      Array.isArray(logSources),
      "resolution logSources is an array of LogSources",
      resolution.logSources,
    );
    const sourceIds = new Set<string>();
    for (const [index, source] of logSources.entries()) {
      yield* requireServiceComposition(
        Schema.is(LogSource)(source),
        "resolution logSource is a valid LogSource",
        { index, source },
      );
      yield* requireServiceComposition(
        !sourceIds.has(String(source.id)),
        "resolution logSource ids are unique within the service",
        { index, source },
      );
      sourceIds.add(String(source.id));
      yield* requireServiceComposition(source.path.startsWith("/"), "resolution logSource path is absolute", {
        index,
        source,
      });
      yield* requireServiceComposition(
        resolution.base === "lando" || source.strategy !== "redirect",
        "resolution logSource strategy is supported by the base",
        { base: resolution.base, index, source },
      );
    }

    const second = yield* serviceType
      .resolve(makeInput())
      .pipe(
        Effect.mapError((cause) =>
          serviceCompositionFailure("service type resolve is replay-safe", String(cause)),
        ),
      );
    yield* requireServiceComposition(
      second.base === resolution.base &&
        stableJson(second.normalizedConfig) === stableJson(resolution.normalizedConfig),
      "resolution base + normalizedConfig stable across replays",
      {
        first: { base: resolution.base, normalizedConfig: resolution.normalizedConfig },
        second: { base: second.base, normalizedConfig: second.normalizedConfig },
      },
    );
    yield* requireServiceComposition(
      second.features.length === resolution.features.length &&
        second.features.every((feature, index) => feature.id === resolution.features[index]?.id),
      "resolution feature list is stable across replays",
      { first: resolution.features, second: second.features },
    );
    yield* requireServiceComposition(
      stableJson(second.logSources ?? []) === stableJson(logSources),
      "resolution logSources are stable across replays",
      { first: logSources, second: second.logSources ?? [] },
    );
  });

const serviceFeatureFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `ServiceFeature contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireServiceFeature = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(serviceFeatureFailure(assertion, details));

const providerCapabilityReads = new Set(["capabilities", "provider", "providerId"]);

const hasRealizationDecision = (intent: unknown): boolean =>
  typeof intent === "object" && intent !== null && "realization" in intent;

const stableUnknown = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableUnknown);
  if (value instanceof Map) {
    return Array.from(value.entries())
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, entry]) => [key, stableUnknown(entry)]);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableUnknown(entry)]),
    );
  }
  return value;
};

const stableJson = (value: unknown): string => JSON.stringify(stableUnknown(value));

const recordingServiceFeatureDraft = (
  recorded: ReturnType<typeof makeRecordingServiceFeatureContext>["recorded"],
) => ({
  env: Array.from(recorded.env.entries()).sort(([left], [right]) => left.localeCompare(right)),
  mounts: stableUnknown(recorded.mounts),
  appMounts: stableUnknown(recorded.appMounts),
  buildSteps: stableUnknown(recorded.buildSteps),
  extensions: Array.from(recorded.extensions.entries()).sort(([left], [right]) => left.localeCompare(right)),
  storage: stableUnknown(recorded.storage),
  endpoints: stableUnknown(recorded.endpoints),
  dependencies: stableUnknown(recorded.dependencies),
  hostAliases: stableUnknown(recorded.hostAliases),
  settings: stableUnknown(recorded.settings),
});

/** Input the feature contract uses to execute a single service feature. */
export interface ServiceFeatureContractHarness {
  readonly feature: ServiceFeatureDefinition;
  readonly serviceName?: string;
  readonly serviceType?: string;
  readonly base?: "l337" | "lando";
  readonly primary?: boolean;
  readonly appName?: string;
  readonly appRoot?: string;
  readonly normalizedConfig?: ServiceConfig;
  readonly config?: Readonly<Record<string, unknown>>;
}

const makeRecordingServiceFeatureContext = (input: ServiceFeatureContractHarness) => {
  const recorded = {
    env: new Map<string, string>(),
    mounts: [] as ServiceMountIntent[],
    appMounts: [] as ServiceAppMountIntent[],
    buildSteps: [] as ServiceBuildStepIntent[],
    extensions: new Map<string, unknown>(),
    storage: [] as unknown[],
    endpoints: [] as unknown[],
    dependencies: [] as unknown[],
    hostAliases: [] as unknown[],
    settings: {} as Record<string, unknown>,
    forbiddenReads: new Set<string>(),
  };

  const context: ServiceFeatureContext = {
    serviceName: input.serviceName ?? "web",
    serviceType: input.serviceType ?? "test",
    base: input.base ?? "lando",
    primary: input.primary ?? false,
    ...(input.appName === undefined ? {} : { appName: input.appName }),
    appRoot: input.appRoot ?? "/srv/apps/myapp",
    normalizedConfig: input.normalizedConfig ?? { type: "test" },
    config: input.config ?? {},
    addEnv(name, value) {
      recorded.env.set(name, value);
    },
    addMount(mount) {
      recorded.mounts.push(mount);
    },
    setAppMount(mount) {
      recorded.appMounts.push(mount);
    },
    addBuildStep(step) {
      recorded.buildSteps.push(step);
    },
    addExtension(key, value) {
      recorded.extensions.set(key, value);
    },
    addStorage(storage) {
      recorded.storage.push(storage);
    },
    addEndpoint(endpoint) {
      recorded.endpoints.push(endpoint);
    },
    addDependency(dependency) {
      recorded.dependencies.push(dependency);
    },
    addHostAlias(alias) {
      recorded.hostAliases.push(alias);
    },
    setHealthcheck(healthcheck) {
      recorded.settings.healthcheck = healthcheck;
    },
    setCerts(certs) {
      recorded.settings.certs = certs;
    },
    setEntrypoint(entrypoint) {
      recorded.settings.entrypoint = entrypoint;
    },
    setCommand(command) {
      recorded.settings.command = command;
    },
    setArtifact(artifact) {
      recorded.settings.artifact = artifact;
    },
    setUser(user) {
      recorded.settings.user = user;
    },
    setWorkingDirectory(path) {
      recorded.settings.workingDirectory = path;
    },
  };

  const proxiedContext = new Proxy(context, {
    get(target, property, receiver) {
      if (typeof property === "string" && providerCapabilityReads.has(property)) {
        recorded.forbiddenReads.add(property);
      }
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      if (typeof property === "string" && providerCapabilityReads.has(property)) {
        recorded.forbiddenReads.add(property);
      }
      return Reflect.has(target, property);
    },
  });

  return { context: proxiedContext, recorded };
};

/**
 * Run the service-feature contract: a feature exposes a stable id/priority/apply
 * hook, its `apply` succeeds against the published provider-neutral context, it
 * does not inspect provider capabilities, and its emitted mount/app-mount intent
 * never includes a realization decision.
 */
export const runServiceFeatureContract = (
  input: ServiceFeatureContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const feature = input.feature;

    yield* requireServiceFeature(
      isNonEmptyString(feature.id),
      "service feature exposes a non-empty id",
      feature.id,
    );
    yield* requireServiceFeature(
      Number.isFinite(feature.priority),
      "service feature exposes a finite priority",
      feature.priority,
    );
    yield* requireServiceFeature(
      typeof feature.apply === "function",
      "service feature apply is callable",
      typeof feature.apply,
    );
    yield* requireServiceFeature(
      feature.requires === undefined ||
        (Array.isArray(feature.requires) && feature.requires.every(isNonEmptyString)),
      "service feature requires is an array of non-empty capability strings",
      feature.requires,
    );

    const { context, recorded } = makeRecordingServiceFeatureContext(input);
    const applyEffect = yield* Effect.try({
      try: () => feature.apply(context),
      catch: (cause) => serviceFeatureFailure("feature apply succeeds", String(cause)),
    });
    const applyExit = yield* Effect.exit(applyEffect);
    if (Exit.isFailure(applyExit)) {
      yield* Effect.fail(serviceFeatureFailure("feature apply succeeds", Cause.pretty(applyExit.cause)));
      return;
    }

    yield* requireServiceFeature(
      recorded.forbiddenReads.size === 0,
      "feature does not inspect provider capabilities",
      Array.from(recorded.forbiddenReads),
    );

    const mountWithRealization = recorded.mounts.find(hasRealizationDecision);
    yield* requireServiceFeature(
      mountWithRealization === undefined,
      "feature emits mount intent without realization decisions",
      mountWithRealization,
    );

    const appMountWithRealization = recorded.appMounts.find(hasRealizationDecision);
    yield* requireServiceFeature(
      appMountWithRealization === undefined,
      "feature emits app mount intent without realization decisions",
      appMountWithRealization,
    );

    const storageWithRealization = recorded.storage.find(hasRealizationDecision);
    yield* requireServiceFeature(
      storageWithRealization === undefined,
      "feature emits storage intent without realization decisions",
      storageWithRealization,
    );

    const endpointWithRealization = recorded.endpoints.find(hasRealizationDecision);
    yield* requireServiceFeature(
      endpointWithRealization === undefined,
      "feature emits endpoint intent without realization decisions",
      endpointWithRealization,
    );

    const second = makeRecordingServiceFeatureContext(input);
    const secondApplyEffect = yield* Effect.try({
      try: () => feature.apply(second.context),
      catch: (cause) => serviceFeatureFailure("feature apply succeeds", String(cause)),
    });
    const secondApplyExit = yield* Effect.exit(secondApplyEffect);
    if (Exit.isFailure(secondApplyExit)) {
      yield* Effect.fail(
        serviceFeatureFailure("feature apply succeeds", Cause.pretty(secondApplyExit.cause)),
      );
      return;
    }

    const firstDraft = recordingServiceFeatureDraft(recorded);
    const secondDraft = recordingServiceFeatureDraft(second.recorded);
    yield* requireServiceFeature(
      stableJson(firstDraft) === stableJson(secondDraft),
      "service feature apply is deterministic/idempotent",
      { first: firstDraft, second: secondDraft },
    );
  });

const appFeatureFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({
    message: `AppFeature contract failed: ${assertion}`,
    assertion,
    details,
  });

const requireAppFeature = (condition: boolean, assertion: string, details?: unknown) =>
  condition ? Effect.void : Effect.fail(appFeatureFailure(assertion, details));

/** A resolved service draft the app-feature contract evaluates selectors against. */
export interface AppFeatureContractService {
  readonly serviceName: string;
  readonly serviceType: string;
  readonly base?: "l337" | "lando";
  readonly framework?: string;
  readonly primary?: boolean;
  readonly featureIds?: ReadonlyArray<string>;
  readonly environment?: Readonly<Record<string, string>>;
}

/** Input the app-feature contract uses to execute a single app feature. */
export interface AppFeatureContractHarness {
  readonly feature: AppFeatureDefinition;
  readonly services: ReadonlyArray<AppFeatureContractService>;
  readonly expectNoActivation?: boolean;
  readonly appName?: string;
  readonly appRoot?: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

interface RecordedAppFeatureService {
  readonly view: AppFeatureServiceView;
  readonly env: Map<string, string>;
  mutated: boolean;
}

const matchesActivation = (feature: AppFeatureDefinition, service: AppFeatureContractService): boolean => {
  const match = feature.activatedBy?.services;
  if (match === undefined) return true;
  const typeOk = match.type === undefined || service.serviceType === match.type;
  const featureOk = match.hasFeature === undefined || (service.featureIds ?? []).includes(match.hasFeature);
  return typeOk && featureOk;
};

const matchesSelectors = (feature: AppFeatureDefinition, service: AppFeatureContractService): boolean => {
  const selectors = feature.selectors;
  if (selectors === undefined) return true;
  if (selectors.types?.includes(service.serviceType)) return true;
  if (service.framework !== undefined && selectors.framework?.includes(service.framework)) return true;
  if (selectors.hasFeature?.some((id) => (service.featureIds ?? []).includes(id))) return true;
  if (selectors.names?.includes(service.serviceName)) return true;
  return false;
};

const makeRecordingAppFeatureContext = (
  input: AppFeatureContractHarness,
  options?: { readonly forceNoSelection?: boolean },
) => {
  const selectedNames =
    options?.forceNoSelection === true
      ? []
      : input.services
          .filter((service) => matchesSelectors(input.feature, service))
          .map((service) => service.serviceName);
  const selectedSet = new Set(selectedNames);

  const records = new Map<string, RecordedAppFeatureService>();
  const forbiddenReads = new Set<string>();
  for (const service of input.services) {
    const view: AppFeatureServiceView = {
      serviceName: service.serviceName,
      serviceType: service.serviceType,
      base: service.base ?? "lando",
      framework: service.framework,
      primary: service.primary ?? false,
      featureIds: service.featureIds ?? [],
      normalizedConfig: { type: service.serviceType },
    };
    records.set(service.serviceName, {
      view,
      env: new Map(Object.entries(service.environment ?? {})),
      mutated: false,
    });
  }

  const ledger = new Map<string, string>();
  const conflicts: Array<{ readonly service: string; readonly key: string }> = [];

  const mutatorsFor = (serviceName: string): AppFeatureServiceMutators => {
    const record = records.get(serviceName);
    const recordMutation = () => {
      if (record !== undefined) record.mutated = true;
    };
    const view = record?.view ?? {
      serviceName,
      serviceType: "unknown",
      base: "lando",
      primary: false,
      featureIds: [],
      normalizedConfig: { type: "unknown" },
    };
    return {
      service: view,
      addEnv: (name, value) => {
        const ledgerKey = `${serviceName}\u0000${name}`;
        const existing = ledger.get(ledgerKey);
        if (existing !== undefined && existing !== value) conflicts.push({ service: serviceName, key: name });
        ledger.set(ledgerKey, value);
        record?.env.set(name, value);
        recordMutation();
      },
      addMount: recordMutation,
      setAppMount: recordMutation,
      addBuildStep: recordMutation,
      addStorage: recordMutation,
      addEndpoint: recordMutation,
      addDependency: recordMutation,
      addHostAlias: recordMutation,
      setHealthcheck: recordMutation,
      setCerts: recordMutation,
      setEntrypoint: recordMutation,
      setCommand: recordMutation,
      setArtifact: recordMutation,
      setUser: recordMutation,
      setWorkingDirectory: recordMutation,
    };
  };

  const context: AppFeatureContext = {
    featureId: input.feature.id,
    ...(input.appName === undefined ? {} : { appName: input.appName }),
    appRoot: input.appRoot ?? "/srv/apps/myapp",
    config: input.config ?? {},
    selected: selectedNames
      .map((name) => records.get(name)?.view)
      .filter((view): view is AppFeatureServiceView => view !== undefined),
    forEachSelected: (mutate) => {
      for (const name of selectedNames) mutate(mutatorsFor(name));
    },
    select: (name) => (selectedSet.has(name) ? mutatorsFor(name) : undefined),
  };

  const proxiedContext = new Proxy(context, {
    get(target, property, receiver) {
      if (typeof property === "string" && providerCapabilityReads.has(property)) forbiddenReads.add(property);
      return Reflect.get(target, property, receiver);
    },
  });

  return { context: proxiedContext, records, selectedNames, conflicts, forbiddenReads };
};

/**
 * Run the app-feature contract: a feature exposes a stable id/priority/apply
 * hook; its `apply` selects service drafts through the published selector
 * surface, mutates each selected draft idempotently (a divergent write is a
 * conflict), never inspects provider capabilities, and surfaces its
 * `requires.globalServices` declarations.
 */
export const runAppFeatureContract = (
  input: AppFeatureContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const feature = input.feature;

    yield* requireAppFeature(isNonEmptyString(feature.id), "app feature exposes a non-empty id", feature.id);
    yield* requireAppFeature(
      Number.isFinite(feature.priority),
      "app feature exposes a finite priority",
      feature.priority,
    );
    yield* requireAppFeature(
      typeof feature.apply === "function",
      "app feature apply is callable",
      typeof feature.apply,
    );
    const globalServices = feature.requires?.globalServices ?? [];
    yield* requireAppFeature(
      globalServices.every(isNonEmptyString),
      "app feature requires.globalServices entries are non-empty ids",
      globalServices,
    );

    const activatedServices = input.services.filter((service) => matchesActivation(feature, service));
    const expectNoActivation =
      input.expectNoActivation === true ||
      (feature.activatedBy !== undefined && activatedServices.length === 0);

    if (expectNoActivation) {
      const { context, records, selectedNames, forbiddenReads } = makeRecordingAppFeatureContext(input, {
        forceNoSelection: true,
      });
      const applyExit = yield* Effect.exit(feature.apply(context));
      if (Exit.isFailure(applyExit)) {
        yield* Effect.fail(appFeatureFailure("app feature apply succeeds", Cause.pretty(applyExit.cause)));
        return;
      }

      const mutatedServices = Array.from(records.entries())
        .filter(([, record]) => record.mutated)
        .map(([serviceName]) => serviceName);
      yield* requireAppFeature(
        selectedNames.length === 0 && mutatedServices.length === 0,
        "app feature with no activation match is a no-op (no mutation, no selected services)",
        { selectedNames, mutatedServices },
      );
      yield* requireAppFeature(
        forbiddenReads.size === 0,
        "app feature does not inspect provider capabilities",
        Array.from(forbiddenReads),
      );
      return;
    }

    yield* requireAppFeature(
      feature.activatedBy === undefined || activatedServices.length > 0,
      "app feature activation matches at least one seeded service",
      { activatedBy: feature.activatedBy },
    );

    const { context, records, selectedNames, conflicts, forbiddenReads } =
      makeRecordingAppFeatureContext(input);

    yield* requireAppFeature(
      selectedNames.length > 0,
      "app feature selectors match at least one service draft",
      { selectors: feature.selectors },
    );

    const applyExit = yield* Effect.exit(feature.apply(context));
    if (Exit.isFailure(applyExit)) {
      yield* Effect.fail(appFeatureFailure("app feature apply succeeds", Cause.pretty(applyExit.cause)));
      return;
    }

    yield* requireAppFeature(
      forbiddenReads.size === 0,
      "app feature does not inspect provider capabilities",
      Array.from(forbiddenReads),
    );

    yield* requireAppFeature(
      conflicts.length === 0,
      "app feature mutations are idempotent (no divergent writes)",
      conflicts,
    );

    const requiresEffect = yield* Effect.exit(feature.apply(makeRecordingAppFeatureContext(input).context));
    yield* requireAppFeature(
      Exit.isSuccess(requiresEffect),
      "app feature apply is replay-safe",
      Exit.isFailure(requiresEffect) ? Cause.pretty(requiresEffect.cause) : undefined,
    );

    const mutatedSelected = selectedNames.some((name) => records.get(name)?.mutated === true);
    yield* requireAppFeature(
      selectedNames.length === 0 || mutatedSelected,
      "app feature mutates at least one selected service draft",
      { selectedNames },
    );
  });
