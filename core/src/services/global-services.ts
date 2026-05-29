import { GlobalServiceCapabilityError } from "@lando/sdk/errors";
import type { GlobalServiceContribution, PluginManifest, ProviderCapabilities } from "@lando/sdk/schema";

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

const PROVIDER_CAPABILITY_KEYS: ReadonlySet<keyof ProviderCapabilities> = new Set([
  "artifactBuild",
  "artifactPull",
  "buildSecrets",
  "buildSsh",
  "multiServiceApply",
  "serviceExec",
  "serviceLogs",
  "serviceHealth",
  "hostReachability",
  "sharedCrossAppNetwork",
  "persistentStorage",
  "bindMounts",
  "bindMountPerformance",
  "copyMounts",
  "hostPortPublish",
  "routeProvider",
  "tlsCertificates",
  "rootless",
  "privilegedServices",
  "composeSpec",
  "providerExtensions",
]);

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
