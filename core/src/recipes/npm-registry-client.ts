import { httpJsonFetch } from "@lando/engine/services/json-fetch";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { DownloadFetchError, RecipeSourceError, causeMessage } from "@lando/sdk/errors";
import { Schema } from "effect";
import { npmRegistryConfigSnapshot } from "./npm-registry-config";
import type { NpmRegistryConfig } from "./npm-registry-config";
import type { NpmRegistryClient } from "./npm-source";
import { defaultTarballRecipeFetcher } from "./tarball-source";

const Packument = Schema.Struct({
  "dist-tags": Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  versions: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        dist: Schema.Struct({
          tarball: Schema.String,
          integrity: Schema.optionalKey(Schema.String),
          shasum: Schema.optionalKey(Schema.String),
        }),
        name: Schema.optionalKey(Schema.String),
        version: Schema.optionalKey(Schema.String),
        landoPlugin: Schema.optionalKey(
          Schema.Struct({
            name: Schema.optionalKey(Schema.String),
            version: Schema.optionalKey(Schema.String),
            requires: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
          }),
        ),
      }),
    ),
  ),
});

const failureDetail = (cause: unknown, config: NpmRegistryConfig): string =>
  createStandaloneRedactor("secrets", { authoritativeTokens: config.redactionTokens }).redactString(
    causeMessage(cause),
  );

const displayRegistry = (registry: string): string => {
  const url = new URL(registry);
  url.username = "";
  url.password = "";
  return url.href;
};

const isAuthStatus = (status: number | undefined): boolean => status === 401 || status === 403;

export const defaultNpmRegistryClient = (
  registryUrl?: string,
  fetchJson: typeof httpJsonFetch = httpJsonFetch,
  snapshot: () => Promise<NpmRegistryConfig> = npmRegistryConfigSnapshot(),
): NpmRegistryClient => ({
  fetchPackument: async (packageName) => {
    const config = await snapshot();
    const registry = config.registryFor(packageName, registryUrl);
    const encoded = packageName.replace(/\//gu, "%2f");
    const url = `${registry.replace(/\/+$/u, "")}/${encoded}`;
    const authorization = config.authorizationFor(url, registry);
    let response: Awaited<ReturnType<typeof httpJsonFetch>>;
    try {
      response = await fetchJson(url, {
        headers: [
          { name: "accept", value: "application/json" },
          ...(authorization === undefined ? [] : [{ name: "authorization", value: authorization }]),
        ],
        redactionTokens: config.redactionTokens,
        redirect: "follow",
      });
    } catch (cause) {
      throw new RecipeSourceError({
        message: `Could not fetch npm metadata for "${packageName}" from ${displayRegistry(registry)}: ${failureDetail(cause, config)}`,
        source: packageName,
        kind: "registry-failed",
        remediation: "Check the npm registry URL, network access, and certificate trust, then retry.",
      });
    }
    if (response.status === 404) {
      throw new RecipeSourceError({
        message: `npm package "${packageName}" was not found in the registry ${displayRegistry(registry)}.`,
        source: packageName,
        kind: "package-not-found",
        remediation: `Check the package name and scope.${authorization === undefined ? ` Private packages need a token. ${config.authRemediation(registry)}` : ""}`,
      });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RecipeSourceError({
        message: `npm registry ${displayRegistry(registry)} returned HTTP ${response.status} for "${packageName}".`,
        source: packageName,
        kind: isAuthStatus(response.status) ? "auth" : "registry-failed",
        remediation: isAuthStatus(response.status)
          ? config.authRemediation(registry)
          : "Check the npm registry URL and network access, then retry.",
      });
    }
    try {
      return Schema.decodeUnknownSync(Packument)(JSON.parse(new TextDecoder().decode(response.bytes)));
    } catch {
      throw new RecipeSourceError({
        message: `Invalid npm metadata for "${packageName}".`,
        source: packageName,
        kind: "registry-failed",
        remediation: "Check that your npm registry returns full package metadata as JSON, then retry.",
      });
    }
  },
  fetchTarball: async (resolved, fetcher = defaultTarballRecipeFetcher) => {
    const config = await snapshot();
    const registry = config.registryFor(resolved.packageName, registryUrl);
    const authorization = config.authorizationFor(resolved.dist.tarball, registry);
    try {
      return await fetcher.fetch(resolved.dist.tarball, {
        ...(authorization === undefined ? {} : { authorization }),
        redactionTokens: config.redactionTokens,
      });
    } catch (cause) {
      const auth = cause instanceof DownloadFetchError && isAuthStatus(cause.status);
      throw new RecipeSourceError({
        message: `Could not download npm tarball for "${resolved.packageName}": ${failureDetail(cause, config)}`,
        source: resolved.packageName,
        kind: auth ? "auth" : "download-failed",
        remediation: auth
          ? config.authRemediation(registry)
          : "Check the tarball URL, network access, and certificate trust, then retry.",
      });
    }
  },
});
