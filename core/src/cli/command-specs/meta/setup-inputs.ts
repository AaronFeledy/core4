/**
 * `meta:setup` input/result contract and flag accessors.
 *
 * The command receives an opaque input object; these accessors read the parsed
 * flags off it defensively (the input shape is not statically known here) and
 * expose the machine result schema. `sourceInstallDir` derives the in-repo
 * install dir used when the caller did not supply one.
 */
import { fileURLToPath } from "node:url";
import { SetupProviderSwitchResultSchema } from "@lando/engine/operations/setup-provider-switch";
import {
  HostChangeOutcome,
  HostChangePlanEntry,
  PrivilegeCredentialStatus,
  ProviderId,
  TrustStoreChange,
} from "@lando/sdk/schema";
import { Schema } from "effect";

import type { SetupNetworkTrustProbe } from "../../commands/setup-network-trust";

const SetupAppliedResultSchema = Schema.Struct({
  dryRun: Schema.Literal(false),
  providerSwitch: Schema.optionalKey(SetupProviderSwitchResultSchema),
  providerId: Schema.String,
  installDir: Schema.String,
  fileSyncStatus: Schema.Literals(["deferred", "installed", "satisfied", "unavailable"]),
  networkCaInjectionConfigured: Schema.Boolean.annotate({
    description:
      "Host-global CA injection configuration: true when setup resolved at least one host CA file and network.ca.injectIntoServices is enabled, so configured host CAs are set to inject into eligible type: lando services. This is setup-level configuration, not the CA set of any particular service; content de-duplication and per-service security.inheritNetworkCa opt-out are resolved when an app is planned.",
  }),
  trustStores: Schema.optionalKey(Schema.Array(TrustStoreChange)).annotate({
    description:
      "Every host trust store the certificate authority manages, as setup left it. Present whenever setup ran a certificate authority; after a trust-installing run each store that does not trust the local CA is also reported as a CA_TRUST_INCOMPLETE warning.",
  }),
  hostChanges: Schema.Array(HostChangeOutcome).annotate({
    description:
      "One row per host change setup planned: applied, already satisfied, declined, skipped, or stale.",
  }),
});
export type SetupAppliedResult = typeof SetupAppliedResultSchema.Type;
export type FileSyncStatus = SetupAppliedResult["fileSyncStatus"];

const SetupPlanResultSchema = Schema.Struct({
  dryRun: Schema.Literal(true),
  providerId: Schema.String,
  selectionSource: Schema.Literals(["flag", "landofile", "env", "config", "default", "prompt"]).annotate({
    description:
      "Where the provider choice came from. A dry run never prompts, so it reports the default instead.",
  }),
  elevation: PrivilegeCredentialStatus.annotate({
    description:
      "How a real run would get administrator access. Named for what it reports, not secret material, so redaction keeps its detail.",
  }),
  changes: Schema.Array(HostChangePlanEntry).annotate({
    description:
      "Every host change a real run with the same flags would plan, with the approval that run would reach without asking. Nothing was changed.",
  }),
  notices: Schema.Array(Schema.String),
});
export type SetupPlanResult = typeof SetupPlanResultSchema.Type;

/** `dryRun` tells a plan (`lando setup --dry-run`, nothing changed) from a finished setup. */
export const SetupResultSchema = Schema.Union([SetupAppliedResultSchema, SetupPlanResultSchema]);
export type SetupResult = typeof SetupResultSchema.Type;

export const sourceInstallDir = (): string =>
  fileURLToPath(new URL("../../../../../", import.meta.url)).replace(/[\\/]$/u, "");

export const inputInstallDir = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null || !("installDir" in input)) return undefined;
  const installDir = input.installDir;
  return typeof installDir === "string" ? installDir : undefined;
};

const inputFlags = (input: unknown): Record<string, unknown> | undefined => {
  if (typeof input !== "object" || input === null || !("flags" in input)) return undefined;
  const flags = (input as { flags?: unknown }).flags;
  return typeof flags === "object" && flags !== null ? (flags as Record<string, unknown>) : undefined;
};

export const inputProviderFlag = (input: unknown): ProviderId | undefined => {
  const provider = inputFlags(input)?.provider;
  return typeof provider === "string" && provider.length > 0 ? ProviderId.make(provider) : undefined;
};

export const inputSkipFileSync = (input: unknown): boolean => inputFlags(input)?.["skip-file-sync"] === true;

export const inputStringFlag = (input: unknown, name: string): string | undefined => {
  const value = inputFlags(input)?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

export const inputBooleanFlag = (input: unknown, name: string): boolean => inputFlags(input)?.[name] === true;

export const inputNetworkProbe = (input: unknown): SetupNetworkTrustProbe | undefined => {
  if (typeof input !== "object" || input === null || !("_networkProbe" in input)) return undefined;
  const probe = input._networkProbe;
  return typeof probe === "function" ? (probe as SetupNetworkTrustProbe) : undefined;
};

export const contributedSetupInputFlags = (input: unknown): Record<string, unknown> | undefined =>
  inputFlags(input);
