/**
 * `meta:setup` input/result contract and flag accessors.
 *
 * The command receives an opaque input object; these accessors read the parsed
 * flags off it defensively (the input shape is not statically known here) and
 * expose the machine result schema. `sourceInstallDir` derives the in-repo
 * install dir used when the caller did not supply one.
 */
import { fileURLToPath } from "node:url";

import { Schema } from "effect";

import { ProviderId } from "@lando/sdk/schema";

import type { SetupNetworkTrustProbe } from "../../../commands/setup-network-trust.ts";

export type FileSyncStatus = "deferred" | "installed" | "satisfied" | "unavailable";

export interface SetupResult {
  readonly providerId: string;
  readonly installDir: string;
  readonly fileSyncStatus: FileSyncStatus;
}

export const SetupResultSchema = Schema.Struct({
  providerId: Schema.String,
  installDir: Schema.String,
  fileSyncStatus: Schema.Literal("deferred", "installed", "satisfied", "unavailable"),
});

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

const inputHostProxyMode = (input: unknown): "auto" | "none" =>
  inputFlags(input)?.["host-proxy"] === "none" ? "none" : "auto";

export const inputNetworkProbe = (input: unknown): SetupNetworkTrustProbe | undefined => {
  if (typeof input !== "object" || input === null || !("_networkProbe" in input)) return undefined;
  const probe = input._networkProbe;
  return typeof probe === "function" ? (probe as SetupNetworkTrustProbe) : undefined;
};

export const shouldDisableHostProxyForSetup = (input: unknown): boolean =>
  inputHostProxyMode(input) === "none";

export const contributedSetupInputFlags = (input: unknown): Record<string, unknown> | undefined =>
  inputFlags(input);
