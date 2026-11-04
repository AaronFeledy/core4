import { importAuthorModule } from "@lando/landofile/author-modules";
import { Cause, Effect, Result, Schema } from "effect";

import { GlobalAppError, GlobalServiceCapabilityError, GlobalServiceCollisionError } from "@lando/sdk/errors";
import {
  type GlobalServiceContribution,
  type ParsedPendingSite,
  type PluginManifest,
  ProviderCapabilities,
  ServiceConfig,
} from "@lando/sdk/schema";

import { type GlobalPolicy, emptyGlobalPolicy, globalContributionPolicy } from "../global-app/enablement.ts";

export interface PendingGlobalServiceContribution {
  readonly contribution: GlobalServiceContribution;
  readonly plugin: string;
}

export const collectGlobalServiceContributions = (
  manifests: ReadonlyArray<PluginManifest>,
): ReadonlyArray<PendingGlobalServiceContribution> => {
  const out: Array<PendingGlobalServiceContribution> = [];
  for (const manifest of manifests) {
    const contributions = manifest.contributes?.globalServices ?? [];
    for (const contribution of contributions) {
      out.push({ contribution, plugin: manifest.name });
    }
  }
  return out;
};

const PROVIDER_CAPABILITY_KEYS: ReadonlySet<keyof ProviderCapabilities> = new Set(
  Object.keys(ProviderCapabilities.fields) as ReadonlyArray<keyof ProviderCapabilities>,
);

const isCapabilitySatisfied = (
  providerCapabilities: ProviderCapabilities,
  key: keyof ProviderCapabilities,
): boolean => {
  const value = providerCapabilities[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value !== "none";
  if (Array.isArray(value)) return value.length > 0;
  return false;
};

const formatList = (values: ReadonlyArray<string>): string =>
  values.length === 1 ? `\`${values[0]}\`` : values.map((entry) => `\`${entry}\``).join(", ");

const buildRemediation = (
  contributionId: string,
  providerId: string,
  missing: ReadonlyArray<string>,
): string => {
  const capabilityList = formatList(missing);
  return [
    `Global service \`${contributionId}\` requires provider capabilities ${capabilityList}, but host provider \`${providerId}\` does not advertise them.`,
    "Select a compatible host provider with `lando setup --provider=<id>`,",
    `or disable the contribution with \`lando global:disable ${contributionId}\` if your applications no longer require it.`,
  ].join(" ");
};

export interface GlobalServiceValidationInput {
  readonly manifests?: ReadonlyArray<PluginManifest>;
  readonly contributions?: ReadonlyArray<PendingGlobalServiceContribution>;
  readonly providerCapabilities: ProviderCapabilities;
  readonly providerId: string;
}

export interface GlobalServiceValidationResult {
  readonly accepted: ReadonlyArray<PendingGlobalServiceContribution>;
  readonly rejected: ReadonlyArray<GlobalServiceCapabilityError>;
}

export const validateGlobalServiceContributions = (
  input: GlobalServiceValidationInput,
): GlobalServiceValidationResult => {
  const contributions = input.contributions ?? collectGlobalServiceContributions(input.manifests ?? []);
  const accepted: Array<PendingGlobalServiceContribution> = [];
  const rejected: Array<GlobalServiceCapabilityError> = [];

  for (const pending of contributions) {
    const required = pending.contribution.requires?.providerCapabilities ?? [];
    const missing: Array<string> = [];
    for (const key of required) {
      if (!PROVIDER_CAPABILITY_KEYS.has(key as keyof ProviderCapabilities)) {
        missing.push(key);
        continue;
      }
      if (!isCapabilitySatisfied(input.providerCapabilities, key as keyof ProviderCapabilities)) {
        missing.push(key);
      }
    }

    if (missing.length === 0) {
      accepted.push(pending);
      continue;
    }

    rejected.push(
      new GlobalServiceCapabilityError({
        message: `Global service ${pending.contribution.id} requires provider capabilities ${formatList(missing)} which provider ${input.providerId} does not advertise.`,
        id: pending.contribution.id,
        plugin: pending.plugin,
        missing,
        providerId: input.providerId,
        remediation: buildRemediation(pending.contribution.id, input.providerId, missing),
      }),
    );
  }

  return { accepted, rejected };
};

const collisionMessage = (id: string, plugins: ReadonlyArray<string>): string =>
  `Global service id ${id} is contributed by multiple plugins: ${formatList(plugins)}.`;

const collisionRemediation = (id: string, plugins: ReadonlyArray<string>): string =>
  `Uninstall one of ${formatList(plugins)} so only one plugin contributes global service ${id}.`;

const resolvePendingGlobalContributions = (
  contributions: ReadonlyArray<PendingGlobalServiceContribution>,
): Effect.Effect<ReadonlyArray<PendingGlobalServiceContribution>, GlobalServiceCollisionError> => {
  const byId = new Map<string, PendingGlobalServiceContribution>();
  const pluginsById = new Map<string, Set<string>>();

  for (const pending of contributions) {
    const id = pending.contribution.id;
    byId.set(id, pending);
    const plugins = pluginsById.get(id) ?? new Set<string>();
    plugins.add(pending.plugin);
    pluginsById.set(id, plugins);
  }

  const collision = [...pluginsById.entries()]
    .filter(([, plugins]) => plugins.size > 1)
    .sort(([left], [right]) => left.localeCompare(right))[0];

  if (collision !== undefined) {
    const [id, pluginSet] = collision;
    const plugins = [...pluginSet].sort((left, right) => left.localeCompare(right));
    return Effect.fail(
      new GlobalServiceCollisionError({
        message: collisionMessage(id, plugins),
        id,
        plugins,
        remediation: collisionRemediation(id, plugins),
      }),
    );
  }

  return Effect.succeed(
    [...byId.values()].sort((left, right) => left.contribution.id.localeCompare(right.contribution.id)),
  );
};

export const resolveGlobalServiceContributions = (
  manifests: ReadonlyArray<PluginManifest>,
): Effect.Effect<ReadonlyArray<PendingGlobalServiceContribution>, GlobalServiceCollisionError> =>
  resolvePendingGlobalContributions(collectGlobalServiceContributions(manifests));

export interface GlobalServiceModuleLoader {
  readonly load: (entry: PendingGlobalServiceContribution) => Effect.Effect<ServiceConfig, GlobalAppError>;
}

const loaderError = (message: string, remediation: string, cause?: unknown): GlobalAppError =>
  new GlobalAppError({
    message,
    operation: "regenerateDist",
    remediation,
    ...(cause === undefined ? {} : { cause }),
  });

export const defaultGlobalServiceModuleLoader: GlobalServiceModuleLoader = {
  load: Effect.fn("GlobalServiceLoader.load")(function* (entry) {
    const moduleSpecifier = entry.contribution.module?.trim();
    if (moduleSpecifier === undefined || moduleSpecifier === "") {
      return yield* Effect.fail(
        loaderError(
          `Global service ${entry.contribution.id} from plugin ${entry.plugin} does not declare a module.`,
          `Update plugin ${entry.plugin} to declare a module for global service ${entry.contribution.id}, or uninstall the plugin.`,
        ),
      );
    }

    const loadedModule: unknown = yield* Effect.tryPromise({
      try: () => importAuthorModule(moduleSpecifier),
      catch: (cause) =>
        loaderError(
          `Unable to load global service ${entry.contribution.id} module ${moduleSpecifier}.`,
          `Verify plugin ${entry.plugin} declares a resolvable module for global service ${entry.contribution.id}.`,
          cause,
        ),
    });

    const exported = (loadedModule as { readonly default?: unknown }).default;
    if (!Effect.isEffect(exported)) {
      return yield* Effect.fail(
        loaderError(
          `Global service ${entry.contribution.id} module ${moduleSpecifier} must default-export an Effect.`,
          `Update plugin ${entry.plugin} so the global service module default export yields a ServiceConfig.`,
        ),
      );
    }

    const decoded = yield* (exported as Effect.Effect<unknown, unknown>).pipe(
      Effect.mapError((cause) =>
        loaderError(
          `Global service ${entry.contribution.id} module ${moduleSpecifier} failed.`,
          `Fix plugin ${entry.plugin}'s global service module or uninstall the plugin.`,
          cause,
        ),
      ),
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(ServiceConfig)(value).pipe(
          Effect.mapError((cause) =>
            loaderError(
              `Global service ${entry.contribution.id} module ${moduleSpecifier} did not return a valid ServiceConfig.`,
              `Update plugin ${entry.plugin} so global service ${entry.contribution.id} returns a valid ServiceConfig.`,
              cause,
            ),
          ),
        ),
      ),
    );

    return decoded;
  }),
};

export const GlobalContributionStateSchema = Schema.Struct({
  id: Schema.String,
  plugin: Schema.String,
  enabled: Schema.Boolean,
  state: Schema.Literals(["enabled", "disabled", "blocked", "unverified"]),
  source: Schema.Literals(["default", "plugin", "contribution"]),
  capabilitySource: Schema.Literals(["declared", "runtime", "unavailable"]),
  reasons: Schema.Array(Schema.String),
  requiredServices: Schema.Array(Schema.String),
  dependencyEvidence: Schema.Literals(["resolved", "unavailable"]),
  summary: Schema.optionalKey(Schema.String),
  commands: Schema.Array(Schema.String),
});
export type GlobalContributionState = typeof GlobalContributionStateSchema.Type;

type MutableGlobalContributionState = {
  -readonly [K in keyof GlobalContributionState]: GlobalContributionState[K];
};

export interface GlobalResolutionIssue {
  readonly id: string;
  readonly kind: "module" | "conflict" | "dependency" | "cycle";
  readonly cause: GlobalAppError;
}

export interface GlobalResolution {
  readonly policy: GlobalPolicy;
  readonly contributions: ReadonlyArray<PendingGlobalServiceContribution>;
  readonly entries: ReadonlyArray<GlobalContributionState>;
  /** Defaults admitted for authored composition before effective dependency validation. */
  readonly composableServices: Record<string, ServiceConfig>;
  readonly directlyExcludedIds: ReadonlyArray<string>;
  readonly services: Record<string, ServiceConfig>;
  readonly excludedIds: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<GlobalResolutionIssue>;
}

export interface ResolveGlobalServicesInput {
  readonly manifests?: ReadonlyArray<PluginManifest>;
  readonly contributions?: ReadonlyArray<PendingGlobalServiceContribution>;
  readonly policy: GlobalPolicy;
  readonly providerCapabilities?: ProviderCapabilities;
  readonly capabilitySource?: "declared" | "runtime";
  readonly providerId: string;
  readonly loadServiceConfig: GlobalServiceModuleLoader["load"];
}

const graphError = (message: string, remediation: string): GlobalAppError =>
  new GlobalAppError({
    operation: "resolution",
    message,
    remediation,
  });

export interface EffectiveGlobalServices {
  readonly services: Record<string, ServiceConfig>;
  readonly excludedIds: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<GlobalResolutionIssue>;
  readonly reasons: Readonly<Record<string, ReadonlyArray<string>>>;
}

const resolveServiceGraph = (
  services: Readonly<Record<string, ServiceConfig>>,
  unavailable: ReadonlyMap<string, boolean>,
  requireKnownDependencies: boolean,
  pendingSites: ReadonlyArray<ParsedPendingSite> = [],
): EffectiveGlobalServices => {
  const configs = new Map(Object.entries(services));
  const required = new Map(
    [...configs].map(
      ([id, config]) =>
        [
          id,
          [
            ...new Set(
              (config.dependsOn ?? [])
                .filter(
                  (dependency, index) =>
                    dependency.required !== false &&
                    !pendingSites.some(
                      (site) =>
                        site.path.length === 5 &&
                        site.path[0] === "services" &&
                        site.path[1] === id &&
                        site.path[2] === "dependsOn" &&
                        site.path[3] === index &&
                        site.path[4] === "service",
                    ),
                )
                .map((dependency) => String(dependency.service)),
            ),
          ].sort(),
        ] as const,
    ),
  );
  const excluded = new Set(unavailable.keys());
  const invalid = new Set([...unavailable].filter(([, isInvalid]) => isInvalid).map(([id]) => id));
  const errors: GlobalResolutionIssue[] = [];
  const reasons = new Map<string, ReadonlyArray<string>>();
  const visited = new Set<string>();
  const visit = (id: string, path: ReadonlyArray<string>): void => {
    const cycleAt = path.indexOf(id);
    if (cycleAt >= 0) {
      const cycle = path.slice(cycleAt);
      for (const member of cycle) {
        if (errors.some((issue) => issue.id === member && issue.kind === "cycle")) continue;
        excluded.add(member);
        invalid.add(member);
        reasons.set(member, [`dependency-cycle:${cycle.join(",")}`]);
        errors.push({
          id: member,
          kind: "cycle",
          cause: graphError(
            `Global services have a required dependency cycle: ${cycle.join(" -> ")}.`,
            "Remove the required dependency cycle from the effective service configuration.",
          ),
        });
      }
      return;
    }
    if (visited.has(id)) return;
    for (const dependency of required.get(id) ?? [])
      if (configs.has(dependency)) visit(dependency, [...path, id]);
    visited.add(id);
  };
  for (const id of configs.keys()) visit(id, []);

  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, dependencies] of required) {
      const missing = dependencies.filter(
        (dependency) => excluded.has(dependency) || (requireKnownDependencies && !configs.has(dependency)),
      );
      if (missing.length === 0) continue;
      if (!excluded.has(id)) {
        excluded.add(id);
        reasons.set(
          id,
          missing.map((dependency) => `dependency-unavailable:${dependency}`),
        );
        changed = true;
      }
      const invalidDependencies = missing.filter(
        (dependency) =>
          invalid.has(dependency) ||
          (requireKnownDependencies && !configs.has(dependency) && !unavailable.has(dependency)),
      );
      if (invalid.has(id) || invalidDependencies.length === 0) continue;
      invalid.add(id);
      errors.push({
        id,
        kind: "dependency",
        cause: graphError(
          `Global service ${id} requires unavailable service(s): ${invalidDependencies.join(", ")}.`,
          `Enable or provide the required services, change the authored dependencies, or disable ${id}.`,
        ),
      });
      changed = true;
    }
  }
  return {
    services: Object.fromEntries([...configs].filter(([id]) => !excluded.has(id))),
    excludedIds: [...excluded].sort(),
    errors,
    reasons: Object.fromEntries(reasons),
  };
};

/** Authored configuration is authoritative for dependencies; eligibility still owns catalog IDs. */
export const resolveEffectiveGlobalServices = (
  resolution: GlobalResolution,
  services: Readonly<Record<string, ServiceConfig>>,
  pendingSites: ReadonlyArray<ParsedPendingSite> = [],
): EffectiveGlobalServices => {
  const direct = new Set(resolution.directlyExcludedIds);
  const unavailable = new Map(
    resolution.entries
      .filter((row) => direct.has(row.id))
      .map(
        (row) =>
          [
            row.id,
            row.state === "disabled" ||
              resolution.errors.some(
                (issue) => issue.id === row.id && (issue.kind === "module" || issue.kind === "conflict"),
              ),
          ] as const,
      ),
  );
  return resolveServiceGraph(
    Object.fromEntries(Object.entries(services).filter(([id]) => !direct.has(id))),
    unavailable,
    true,
    pendingSites,
  );
};

export const assertEffectiveGlobalServices = (
  resolution: GlobalResolution,
  services: Readonly<Record<string, ServiceConfig>>,
  ids?: ReadonlyArray<string>,
  pendingSites: ReadonlyArray<ParsedPendingSite> = [],
): Effect.Effect<void, GlobalAppError> => {
  const selected = ids === undefined ? undefined : new Set(ids);
  const issue = resolveEffectiveGlobalServices(resolution, services, pendingSites).errors.find(
    (entry) => selected === undefined || selected.has(entry.id),
  );
  return issue === undefined ? Effect.void : Effect.fail(issue.cause);
};

/** Project diagnostics from the same composed graph admitted to the runtime planner. */
export const projectEffectiveGlobalResolution = (
  resolution: GlobalResolution,
  services: Readonly<Record<string, ServiceConfig>>,
  pendingSites: ReadonlyArray<ParsedPendingSite> = [],
): GlobalResolution => {
  const effective = resolveEffectiveGlobalServices(resolution, services, pendingSites);
  const direct = new Set(resolution.directlyExcludedIds);
  const admitted = new Set(Object.keys(effective.services));
  const entries = resolution.entries.map((row): GlobalContributionState => {
    if (direct.has(row.id)) return row;
    const config = Object.hasOwn(services, row.id) ? services[row.id] : undefined;
    const pending = pendingSites.some(
      (site) =>
        site.path.length === 5 &&
        site.path[0] === "services" &&
        site.path[1] === row.id &&
        site.path[2] === "dependsOn" &&
        typeof site.path[3] === "number" &&
        site.path[4] === "service",
    );
    return {
      ...row,
      state: admitted.has(row.id) ? "enabled" : "blocked",
      reasons: [
        ...(admitted.has(row.id) ? [] : (effective.reasons[row.id] ?? ["configuration-absent"])),
        ...(pending ? ["dependency-pending"] : []),
      ],
      requiredServices:
        config === undefined
          ? []
          : [
              ...new Set(
                (config.dependsOn ?? [])
                  .filter((dependency) => dependency.required !== false)
                  .map((dependency) => String(dependency.service)),
              ),
            ].sort(),
      dependencyEvidence: pending ? "unavailable" : "resolved",
    };
  });
  return {
    ...resolution,
    entries,
    services: effective.services,
    excludedIds: [
      ...new Set([
        ...effective.excludedIds,
        ...entries.filter((row) => row.state !== "enabled").map((row) => row.id),
      ]),
    ].sort(),
    errors: [
      ...resolution.errors.filter((issue) => issue.kind === "module" || issue.kind === "conflict"),
      ...effective.errors,
    ],
  };
};

/** One eligibility decision for generated configuration, authored composition, and runtime admission. */
export const resolveGlobalServices = Effect.fn("GlobalServices.resolve")(function* (
  input: ResolveGlobalServicesInput,
): Effect.fn.Return<GlobalResolution, GlobalServiceCollisionError> {
  const contributions = yield* resolvePendingGlobalContributions(
    input.contributions ?? collectGlobalServiceContributions(input.manifests ?? []),
  );
  const rows = new Map<string, MutableGlobalContributionState>();
  const configs = new Map<string, ServiceConfig>();
  const errors: GlobalResolutionIssue[] = [];
  const capabilitySource =
    input.providerCapabilities === undefined ? "unavailable" : (input.capabilitySource ?? "runtime");
  for (const entry of contributions) {
    const preference = globalContributionPolicy(entry, input.policy);
    const row: MutableGlobalContributionState = {
      id: entry.contribution.id,
      plugin: entry.plugin,
      ...preference,
      state: preference.enabled ? "enabled" : "disabled",
      capabilitySource,
      reasons: preference.enabled ? [] : ["policy-disabled"],
      requiredServices: [],
      dependencyEvidence: "unavailable",
      commands: [...(entry.contribution.commands ?? [])],
      ...(entry.contribution.summary === undefined ? {} : { summary: entry.contribution.summary }),
    };
    rows.set(row.id, row);
    if (!preference.enabled) continue;
    const requirements = entry.contribution.requires?.providerCapabilities ?? [];
    if (requirements.length > 0 && input.providerCapabilities === undefined) {
      row.state = "unverified";
      row.reasons = requirements.map((capability) => `capability-unverified:${capability}`);
      continue;
    }
    if (input.providerCapabilities !== undefined) {
      const missing =
        validateGlobalServiceContributions({
          contributions: [entry],
          providerCapabilities: input.providerCapabilities,
          providerId: input.providerId,
        }).rejected[0]?.missing ?? [];
      if (missing.length > 0) {
        row.state = "blocked";
        row.reasons = missing.map((capability) => `capability-missing:${capability}`);
      }
    }
  }
  for (const entry of contributions) {
    const row = rows.get(entry.contribution.id);
    if (row?.enabled !== true) continue;
    for (const conflict of entry.contribution.conflicts ?? []) {
      const other = rows.get(conflict);
      if (other?.enabled !== true) continue;
      row.state = "blocked";
      row.reasons = [...new Set([...row.reasons, `conflict:${conflict}`])];
      other.state = "blocked";
      other.reasons = [...new Set([...other.reasons, `conflict:${row.id}`])];
      for (const affected of [row, other])
        if (!errors.some((issue) => issue.id === affected.id && issue.kind === "conflict"))
          errors.push({
            id: affected.id,
            kind: "conflict",
            cause: graphError(
              `Global contribution ${row.id} conflicts with enabled contribution ${conflict}.`,
              `Disable ${row.id} or ${conflict} before enabling this combination.`,
            ),
          });
    }
  }

  for (const entry of contributions) {
    const row = rows.get(entry.contribution.id);
    if (row?.state !== "enabled") continue;
    const loaded = yield* Effect.result(Effect.suspend(() => input.loadServiceConfig(entry))).pipe(
      Effect.catchCauseIf(
        (cause) => Cause.hasDies(cause) && !Cause.hasInterrupts(cause),
        (cause) =>
          Effect.succeed(
            Result.fail(
              loaderError(
                `Global contribution ${row.id} module failed unexpectedly.`,
                `Repair the service module in ${row.plugin}, then retry.`,
                cause,
              ),
            ),
          ),
      ),
    );
    if (loaded._tag === "Failure") {
      row.state = "blocked";
      row.reasons = ["module-error"];
      errors.push({ id: row.id, kind: "module", cause: loaded.failure });
      continue;
    }
    configs.set(row.id, loaded.success);
    row.dependencyEvidence = "resolved";
    row.requiredServices = [
      ...new Set(
        (loaded.success.dependsOn ?? [])
          .filter((dependency) => dependency.required !== false)
          .map((dependency) => String(dependency.service)),
      ),
    ].sort();
  }

  const directlyExcludedIds = [...rows.values()]
    .filter((row) => row.state !== "enabled")
    .map((row) => row.id)
    .sort();
  const composableServices = Object.fromEntries(configs);

  const graph = resolveServiceGraph(
    composableServices,
    new Map(
      [...rows.values()]
        .filter((row) => row.state !== "enabled")
        .map(
          (row) => [row.id, row.state === "disabled" || errors.some((issue) => issue.id === row.id)] as const,
        ),
    ),
    false,
  );
  errors.push(...graph.errors);
  for (const [id, reasons] of Object.entries(graph.reasons)) {
    const row = rows.get(id);
    if (row === undefined) continue;
    row.state = "blocked";
    row.reasons = reasons;
  }
  const entries = [...rows.values()].sort((left, right) => left.id.localeCompare(right.id));
  return {
    policy: input.policy,
    contributions,
    entries,
    composableServices,
    directlyExcludedIds,
    services: Object.fromEntries(
      entries
        .filter((row) => row.state === "enabled")
        .flatMap((row) => {
          const config = configs.get(row.id);
          return config === undefined ? [] : [[row.id, config] as const];
        }),
    ),
    excludedIds: entries.filter((row) => row.state !== "enabled").map((row) => row.id),
    errors,
  };
});

/** Capability blocks retain intent; invalid modules, conflicts, and required graphs are failures. */
export const assertGlobalResolution = (
  resolution: GlobalResolution,
  ids?: ReadonlyArray<string>,
  options: { readonly directOnly?: boolean } = {},
): Effect.Effect<void, GlobalAppError> => {
  const selected = ids === undefined ? undefined : new Set(ids);
  const issue = resolution.errors.find(
    (entry) =>
      (selected === undefined || selected.has(entry.id)) &&
      (!options.directOnly || entry.kind === "module" || entry.kind === "conflict"),
  );
  return issue === undefined ? Effect.void : Effect.fail(issue.cause);
};

export interface GlobalServiceMaterializationInput {
  readonly manifests: ReadonlyArray<PluginManifest>;
  readonly providerCapabilities?: ProviderCapabilities;
  readonly providerId: string;
  readonly loadServiceConfig: GlobalServiceModuleLoader["load"];
  readonly policy?: GlobalPolicy;
}

export const materializeGlobalServices = Effect.fnUntraced(function* (
  input: GlobalServiceMaterializationInput,
): Effect.fn.Return<Record<string, ServiceConfig>, GlobalServiceCollisionError | GlobalAppError> {
  const resolution = yield* resolveGlobalServices({ ...input, policy: input.policy ?? emptyGlobalPolicy() });
  yield* assertGlobalResolution(resolution);
  return resolution.services;
});
