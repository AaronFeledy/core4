/**
 * App-scoped feature composition engine (stage 4 of the composition pipeline).
 * Where the service-feature engine (`feature.ts`) mutates a single service draft, an
 * `AppFeature` runs once per app AFTER the entire per-service phase, selects a
 * set of resolved service drafts, and applies the same provider-neutral intent
 * mutators to each selected draft. The engine: evaluates `activatedBy` (no
 * match => no `apply`, no activated entry), resolves selectors against the
 * post-stage-3 drafts (never the finalized `AppPlan`), applies mutators
 * idempotently with divergent-write conflict detection, rejects cyclic
 * cross-feature mutation, and returns the aggregated `requires` so the planner
 * can fold it into the app plan. Provider realization stays out of the
 * app-feature context.
 */
import { Cause, Effect, Either, ParseResult, Schema } from "effect";

import {
  AppFeatureCycleError,
  AppFeatureMutationConflictError,
  AppFeatureSelectorMatchedNothingError,
} from "@lando/sdk/errors";
import type { AppFeatureError } from "@lando/sdk/errors";
import {
  type ExpressionContext,
  evaluateTemplateEither,
  parseExpressionEither,
} from "@lando/sdk/expressions";
import type { ProviderCapabilities, ServiceConfig } from "@lando/sdk/schema";
import type {
  AppFeatureContext,
  AppFeatureDefinition,
  AppFeatureServiceMutators,
  AppFeatureServiceView,
} from "@lando/sdk/services";

import type { DraftServicePlan } from "./draft.ts";

/** A resolved service draft (stages 1-3) the app-feature pass mutates. */
export interface AppFeatureServiceDraft extends DraftServicePlan {
  readonly serviceName: string;
  readonly serviceType: string;
  readonly base: "l337" | "lando";
  readonly framework?: string | undefined;
  readonly featureIds: ReadonlyArray<string>;
  readonly normalizedConfig: ServiceConfig;
}

/** A registered app-feature plus its raw contribution config. */
export interface ComposeAppFeature {
  readonly id: string;
  readonly definition: AppFeatureDefinition;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly pluginId?: string | undefined;
}

/** Resolves a `fromConfig` selector expression to a list of service names. */
export type FromConfigSelectorResolver = (
  expression: string,
  context: {
    readonly appName?: string | undefined;
    readonly appRoot: string;
    readonly services: ReadonlyArray<AppFeatureServiceView>;
  },
) => Effect.Effect<ReadonlyArray<string>, AppFeatureError>;

export interface ComposeAppFeaturesInput {
  readonly appName?: string | undefined;
  readonly appRoot: string;
  readonly services: ReadonlyArray<AppFeatureServiceDraft>;
  readonly features: ReadonlyArray<ComposeAppFeature>;
  readonly resolveFromConfig?: FromConfigSelectorResolver | undefined;
}

export interface ActivatedAppFeature {
  readonly id: string;
  readonly pluginId?: string | undefined;
  readonly priority: number;
  readonly selectedServices: ReadonlyArray<string>;
  readonly triggeredByServices: ReadonlyArray<string>;
}

export interface AppFeatureRequires {
  readonly providerCapabilities: ReadonlyArray<keyof ProviderCapabilities>;
  readonly globalServices: ReadonlyArray<string>;
}

export interface ComposeAppFeaturesResult {
  readonly activatedFeatures: ReadonlyArray<ActivatedAppFeature>;
  readonly requires: AppFeatureRequires;
}

interface OrderedAppFeature extends ComposeAppFeature {
  readonly index: number;
}

const viewOf = (draft: AppFeatureServiceDraft): AppFeatureServiceView => ({
  serviceName: draft.serviceName,
  serviceType: draft.serviceType,
  base: draft.base,
  framework: draft.framework,
  primary: draft.primary,
  featureIds: draft.featureIds,
  normalizedConfig: draft.normalizedConfig,
});

const triggeredBy = (
  feature: AppFeatureDefinition,
  services: ReadonlyArray<AppFeatureServiceDraft>,
): ReadonlyArray<string> => {
  const match = feature.activatedBy?.services;
  if (match === undefined) return services.map((service) => service.serviceName);

  return services
    .filter((service) => {
      const typeOk = match.type === undefined || service.serviceType === match.type;
      const featureOk = match.hasFeature === undefined || service.featureIds.includes(match.hasFeature);
      return typeOk && featureOk;
    })
    .map((service) => service.serviceName);
};

const selectFromConfig = (
  expression: string,
  input: ComposeAppFeaturesInput,
  feature: AppFeatureDefinition,
): Effect.Effect<ReadonlyArray<string>, AppFeatureError> => {
  if (input.resolveFromConfig !== undefined) {
    return input.resolveFromConfig(expression, {
      appName: input.appName,
      appRoot: input.appRoot,
      services: input.services.map(viewOf),
    });
  }

  const parsed = parseExpressionEither(expression, { filePath: "<app-feature-selector>" });
  if (Either.isLeft(parsed)) {
    return Effect.fail(
      new AppFeatureSelectorMatchedNothingError({
        message: `fromConfig selector failed to parse: ${expression}`,
        feature: feature.id,
        remediation: "Fix the fromConfig expression so it resolves to a list of service names.",
      }),
    );
  }

  const servicesScope: Record<string, unknown> = {};
  for (const service of input.services) {
    servicesScope[service.serviceName] = { config: service.normalizedConfig };
  }
  const context: ExpressionContext = { services: servicesScope };

  const evaluated = evaluateTemplateEither(parsed.right, context);
  if (Either.isLeft(evaluated)) {
    return Effect.fail(
      new AppFeatureSelectorMatchedNothingError({
        message: `fromConfig selector failed to evaluate: ${expression}`,
        feature: feature.id,
        remediation: "Ensure the referenced service config yields a list of service names.",
      }),
    );
  }

  const value = evaluated.right;
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) {
    return Effect.fail(
      new AppFeatureSelectorMatchedNothingError({
        message: `fromConfig selector must yield a string[] of service names: ${expression}`,
        feature: feature.id,
        remediation: "Return a list of service names from the fromConfig expression.",
      }),
    );
  }

  return Effect.succeed(value);
};

const selectServices = (
  feature: AppFeatureDefinition,
  input: ComposeAppFeaturesInput,
): Effect.Effect<ReadonlyArray<string>, AppFeatureError> =>
  Effect.gen(function* () {
    const selectors = feature.selectors;
    if (selectors === undefined) return input.services.map((service) => service.serviceName);

    const matched = new Set<string>();
    for (const service of input.services) {
      if (selectors.types?.includes(service.serviceType)) matched.add(service.serviceName);
      else if (service.framework !== undefined && selectors.framework?.includes(service.framework))
        matched.add(service.serviceName);
      else if (selectors.hasFeature?.some((id) => service.featureIds.includes(id)))
        matched.add(service.serviceName);
      else if (selectors.names?.includes(service.serviceName)) matched.add(service.serviceName);
    }

    if (selectors.fromConfig !== undefined) {
      const names = yield* selectFromConfig(selectors.fromConfig, input, feature);
      const valid = new Set(input.services.map((service) => service.serviceName));
      for (const name of names) if (valid.has(name)) matched.add(name);
    }

    return input.services.map((service) => service.serviceName).filter((name) => matched.has(name));
  });

const decodeFeatureConfig = (
  feature: OrderedAppFeature,
): Effect.Effect<Readonly<Record<string, unknown>>, AppFeatureError> => {
  const rawConfig = feature.config ?? {};
  if (feature.definition.schema === undefined) return Effect.succeed(rawConfig);

  const decoded = Schema.decodeUnknownEither(feature.definition.schema)(rawConfig, {
    onExcessProperty: "error",
  });
  if (Either.isRight(decoded)) {
    const value = decoded.right;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return Effect.succeed(value as Readonly<Record<string, unknown>>);
    }
    return Effect.succeed(rawConfig);
  }

  const details = ParseResult.ArrayFormatter.formatErrorSync(decoded.left)
    .map((issue) => issue.message)
    .join("; ");
  return Effect.fail(
    new AppFeatureSelectorMatchedNothingError({
      message: details.length > 0 ? `Invalid app feature config: ${details}` : "Invalid app feature config",
      feature: feature.definition.id,
    }),
  );
};

const conflictFromCause = (
  cause: Cause.Cause<AppFeatureError>,
): AppFeatureMutationConflictError | undefined => {
  const failure = Cause.failureOption(cause);
  if (failure._tag === "Some" && failure.value instanceof AppFeatureMutationConflictError) {
    return failure.value;
  }
  const defect = Cause.dieOption(cause);
  if (defect._tag === "Some" && defect.value instanceof AppFeatureMutationConflictError) {
    return defect.value;
  }
  return undefined;
};

type WriteLedger = Map<string, unknown>;

const stableMutationValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableMutationValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableMutationValue(child)]),
    );
  }
  return value;
};

const sameMutationValue = (a: unknown, b: unknown): boolean =>
  JSON.stringify(stableMutationValue(a)) === JSON.stringify(stableMutationValue(b));

const recordWrite = (
  ledger: WriteLedger,
  feature: string,
  serviceName: string,
  field: string,
  key: string,
  value: unknown,
): void => {
  const ledgerKey = `${serviceName}\u0000${field}\u0000${key}`;
  if (ledger.has(ledgerKey)) {
    const existing = ledger.get(ledgerKey);
    if (existing !== value) {
      throw new AppFeatureMutationConflictError({
        message: `App feature ${feature} wrote a conflicting ${field} value for service ${serviceName}`,
        feature,
        service: serviceName,
        field: `${field}.${key}`,
        existing,
        incoming: value,
        remediation: "Resolve the conflicting app-feature mutations so they agree on the value.",
      });
    }
  }
  ledger.set(ledgerKey, value);
};

// Whole-field setter guard: structural equality (not reference) so two features
// setting equal object/array literals stay idempotent while divergent values
// raise MutationConflict. Pre-existing stage-3 draft values are never in the
// ledger, so a single feature overwriting them is not a conflict.
const recordFieldWrite = (
  ledger: WriteLedger,
  feature: string,
  serviceName: string,
  field: string,
  value: unknown,
): void => {
  const ledgerKey = `${serviceName}\u0000${field}`;
  if (ledger.has(ledgerKey)) {
    const existing = ledger.get(ledgerKey);
    if (!sameMutationValue(existing, value)) {
      throw new AppFeatureMutationConflictError({
        message: `App feature ${feature} wrote a conflicting ${field} value for service ${serviceName}`,
        feature,
        service: serviceName,
        field,
        existing,
        incoming: value,
        remediation: "Resolve the conflicting app-feature mutations so they agree on the value.",
      });
    }
  }
  ledger.set(ledgerKey, value);
};

const makeMutators = (
  draft: AppFeatureServiceDraft,
  feature: string,
  ledger: WriteLedger,
): AppFeatureServiceMutators => ({
  service: viewOf(draft),
  addEnv: (name, value) => {
    recordWrite(ledger, feature, draft.serviceName, "environment", name, value);
    draft.environment[name] = value;
  },
  addMount: (mount) => {
    draft.mounts.push({ ...mount });
  },
  setAppMount: (mount) => {
    recordFieldWrite(ledger, feature, draft.serviceName, "appMount", mount);
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
    recordFieldWrite(ledger, feature, draft.serviceName, "healthcheck", healthcheck);
    draft.healthcheck = { ...healthcheck };
  },
  setCerts: (certs) => {
    recordFieldWrite(ledger, feature, draft.serviceName, "certs", certs);
    draft.certs = { ...certs };
  },
  setEntrypoint: (entrypoint) => {
    recordFieldWrite(ledger, feature, draft.serviceName, "entrypoint", entrypoint);
    draft.entrypoint = Array.isArray(entrypoint) ? [...entrypoint] : entrypoint;
  },
  setCommand: (command) => {
    recordFieldWrite(ledger, feature, draft.serviceName, "command", command);
    draft.command = Array.isArray(command) ? [...command] : command;
  },
  setArtifact: (artifact) => {
    recordFieldWrite(ledger, feature, draft.serviceName, "artifact", artifact);
    draft.artifact = { ...artifact };
  },
  setUser: (user) => {
    recordFieldWrite(ledger, feature, draft.serviceName, "user", user);
    draft.user = user;
  },
  setWorkingDirectory: (path) => {
    recordFieldWrite(ledger, feature, draft.serviceName, "workingDirectory", path);
    draft.workingDirectory = path;
  },
});

const makeContext = (
  feature: OrderedAppFeature,
  input: ComposeAppFeaturesInput,
  config: Readonly<Record<string, unknown>>,
  selectedNames: ReadonlyArray<string>,
  ledger: WriteLedger,
): AppFeatureContext => {
  const byName = new Map(input.services.map((service) => [service.serviceName, service]));
  const selected = selectedNames
    .map((name) => byName.get(name))
    .filter((draft): draft is AppFeatureServiceDraft => draft !== undefined);
  const selectedSet = new Set(selectedNames);

  return {
    featureId: feature.definition.id,
    appName: input.appName,
    appRoot: input.appRoot,
    config,
    selected: selected.map(viewOf),
    forEachSelected: (mutate) => {
      for (const draft of selected) mutate(makeMutators(draft, feature.definition.id, ledger));
    },
    select: (name) => {
      if (!selectedSet.has(name)) return undefined;
      const draft = byName.get(name);
      return draft === undefined ? undefined : makeMutators(draft, feature.definition.id, ledger);
    },
  };
};

interface ActivationPlan {
  readonly feature: OrderedAppFeature;
  readonly triggeredByServices: ReadonlyArray<string>;
  readonly selectedServices: ReadonlyArray<string>;
}

const hasExplicitTrigger = (feature: AppFeatureDefinition): boolean => {
  const services = feature.activatedBy?.services;
  return services?.type !== undefined || services?.hasFeature !== undefined;
};

const detectCycle = (plans: ReadonlyArray<ActivationPlan>): AppFeatureCycleError | undefined => {
  const adjacency = new Map<string, Set<string>>();
  for (const plan of plans) adjacency.set(plan.feature.definition.id, new Set<string>());

  for (const left of plans) {
    const selected = new Set(left.selectedServices);
    for (const right of plans) {
      if (left.feature.definition.id === right.feature.definition.id) continue;
      // Edges only target features with an EXPLICIT activatedBy trigger: an
      // unconditionally-active feature has no service trigger another feature's
      // mutation could satisfy, so it cannot be a cycle participant target.
      if (!hasExplicitTrigger(right.feature.definition)) continue;
      if (right.triggeredByServices.some((service) => selected.has(service))) {
        adjacency.get(left.feature.definition.id)?.add(right.feature.definition.id);
      }
    }
  }

  const order = plans.map((plan) => plan.feature.definition.id);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (node: string): ReadonlyArray<string> | undefined => {
    state.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const color = state.get(next) ?? 0;
      if (color === 1) {
        const start = stack.indexOf(next);
        return stack.slice(start);
      }
      if (color === 0) {
        const cycle = visit(next);
        if (cycle !== undefined) return cycle;
      }
    }
    stack.pop();
    state.set(node, 2);
    return undefined;
  };

  for (const node of order) {
    if ((state.get(node) ?? 0) === 0) {
      const cycle = visit(node);
      if (cycle !== undefined) {
        return new AppFeatureCycleError({
          message: `App features form a mutation cycle: ${cycle.join(" -> ")}`,
          cycle,
          remediation:
            "Break the mutual app-feature mutation so no two features mutate each other's triggers.",
        });
      }
    }
  }

  return undefined;
};

const dedupe = <T>(values: ReadonlyArray<T>): ReadonlyArray<T> => {
  const seen = new Set<T>();
  const output: T[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      output.push(value);
    }
  }
  return output;
};

export const composeAppFeatures = (
  input: ComposeAppFeaturesInput,
): Effect.Effect<ComposeAppFeaturesResult, AppFeatureError> =>
  Effect.gen(function* () {
    const ordered: ReadonlyArray<OrderedAppFeature> = input.features
      .map((feature, index) => ({ ...feature, index }))
      .sort(
        (left, right) => left.definition.priority - right.definition.priority || left.index - right.index,
      );

    const activations: ActivationPlan[] = [];
    for (const feature of ordered) {
      const triggeredByServices = triggeredBy(feature.definition, input.services);
      if (triggeredByServices.length === 0) continue;
      const selectedServices = yield* selectServices(feature.definition, input);
      if (selectedServices.length === 0) {
        return yield* Effect.fail(
          new AppFeatureSelectorMatchedNothingError({
            message: `App feature ${feature.definition.id} activated but selected no service`,
            feature: feature.definition.id,
            remediation: "Adjust the feature selectors so they match at least one service draft.",
          }),
        );
      }
      activations.push({ feature, triggeredByServices, selectedServices });
    }

    const cycle = detectCycle(activations);
    if (cycle !== undefined) return yield* Effect.fail(cycle);

    const ledger: WriteLedger = new Map();
    const activatedFeatures: ActivatedAppFeature[] = [];
    const globalServices: string[] = [];
    const providerCapabilities: Array<keyof ProviderCapabilities> = [];

    for (const plan of activations) {
      const config = yield* decodeFeatureConfig(plan.feature);
      const context = makeContext(plan.feature, input, config, plan.selectedServices, ledger);
      const applyExit = yield* Effect.exit(Effect.suspend(() => plan.feature.definition.apply(context)));
      if (applyExit._tag === "Failure") {
        const conflict = conflictFromCause(applyExit.cause);
        if (conflict !== undefined) return yield* Effect.fail(conflict);
        return yield* Effect.failCause(applyExit.cause);
      }

      activatedFeatures.push({
        id: plan.feature.definition.id,
        ...(plan.feature.pluginId === undefined ? {} : { pluginId: plan.feature.pluginId }),
        priority: plan.feature.definition.priority,
        selectedServices: plan.selectedServices,
        triggeredByServices: plan.triggeredByServices,
      });

      for (const service of plan.feature.definition.requires?.globalServices ?? [])
        globalServices.push(service);
      for (const capability of plan.feature.definition.requires?.providerCapabilities ?? [])
        providerCapabilities.push(capability);
    }

    return {
      activatedFeatures,
      requires: {
        globalServices: dedupe(globalServices),
        providerCapabilities: dedupe(providerCapabilities),
      },
    };
  });
