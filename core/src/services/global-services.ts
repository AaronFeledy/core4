import { Effect, Schema } from "effect";

import { GlobalAppError, GlobalServiceCapabilityError, GlobalServiceCollisionError } from "@lando/sdk/errors";
import {
  type GlobalServiceContribution,
  type PluginManifest,
  ProviderCapabilities,
  ServiceConfig,
} from "@lando/sdk/schema";

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
    `Global service \`${contributionId}\` requires provider capabilities ${capabilityList}, but provider \`${providerId}\` does not advertise them.`,
    `Choose a provider that advertises ${capabilityList} (e.g. set \`provider: docker\` in your Landofile or run \`lando setup --provider=docker\`),`,
    "or uninstall the contributing plugin with `lando meta plugin remove <plugin>`.",
    "If you operate the global app without the dependent service, rerun the failing command with `--keep-global` to skip the missing contribution.",
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

export const resolveGlobalServiceContributions = (
  manifests: ReadonlyArray<PluginManifest>,
): Effect.Effect<ReadonlyArray<PendingGlobalServiceContribution>, GlobalServiceCollisionError> => {
  const byId = new Map<string, PendingGlobalServiceContribution>();
  const pluginsById = new Map<string, Set<string>>();

  for (const pending of collectGlobalServiceContributions(manifests)) {
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
  load: (entry) =>
    Effect.gen(function* () {
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
        try: () => import(moduleSpecifier),
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
          Schema.decodeUnknown(ServiceConfig)(value).pipe(
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

export interface GlobalServiceMaterializationInput {
  readonly manifests: ReadonlyArray<PluginManifest>;
  readonly providerCapabilities: ProviderCapabilities;
  readonly providerId: string;
  readonly loadServiceConfig: GlobalServiceModuleLoader["load"];
}

export const materializeGlobalServices = (
  input: GlobalServiceMaterializationInput,
): Effect.Effect<Record<string, ServiceConfig>, GlobalServiceCollisionError | GlobalAppError> =>
  Effect.gen(function* () {
    const resolved = yield* resolveGlobalServiceContributions(input.manifests);
    const enabled = resolved.filter((entry) => entry.contribution.enabledByDefault !== false);
    const validation = validateGlobalServiceContributions({
      contributions: enabled,
      providerCapabilities: input.providerCapabilities,
      providerId: input.providerId,
    });
    const accepted = [...validation.accepted].sort((left, right) =>
      left.contribution.id.localeCompare(right.contribution.id),
    );
    const entries = yield* Effect.forEach(
      accepted,
      (entry) =>
        input
          .loadServiceConfig(entry)
          .pipe(Effect.map((serviceConfig) => [entry.contribution.id, serviceConfig] as const)),
      { concurrency: 1 },
    );
    const services: Record<string, ServiceConfig> = {};
    for (const [id, serviceConfig] of entries) {
      services[id] = serviceConfig;
    }
    return services;
  });
