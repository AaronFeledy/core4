import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { PortablePath, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { addServicePortEndpoints } from "./_port-helpers.ts";

const DEFAULT_IMAGE = "getmeili/meilisearch:v1.11";
const DEFAULT_PORT = 7700;
const DATA_TARGET = PortablePath.make("/meili_data");

export const MEILISEARCH_FEATURE_ID = "service-lando.meilisearch";

/**
 * Dev-environment default master key, deterministic so users can hit
 * `MEILI_MASTER_KEY=lando` in shell snippets and scenario tooling.
 *
 * This is a dev default, not a real
 * secret; it is redacted in `lando info` / event surfaces
 * when the publishing layer adds it to the `redact:` token set. Users
 * who need a non-default key set `environment.MEILI_MASTER_KEY` in their
 * Landofile.
 */
export const MEILISEARCH_DEFAULT_MASTER_KEY = "lando" as const;

export const MEILISEARCH_SERVICE_DESCRIPTION = `Meilisearch is an MIT-licensed search engine with a typo-tolerant, ranked search HTTP API. The default local-dev configuration disables telemetry (MEILI_NO_ANALYTICS=true), runs in development mode (MEILI_ENV=development), and seeds a deterministic master key (MEILI_MASTER_KEY=${MEILISEARCH_DEFAULT_MASTER_KEY}) that is redacted from event surfaces. Override via services.<name>.environment.MEILI_MASTER_KEY in the Landofile for a non-default key.`;

const appNameFor = (ctx: ServiceFeatureContext): string => {
  if (ctx.appName !== undefined && ctx.appName.length > 0) return ctx.appName;
  return basename(ctx.appRoot) || "app";
};

const applyMeilisearchFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  const port = service.port ?? DEFAULT_PORT;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.addEnv("MEILI_MASTER_KEY", MEILISEARCH_DEFAULT_MASTER_KEY);
  ctx.addEnv("MEILI_NO_ANALYTICS", "true");
  ctx.addEnv("MEILI_ENV", "development");
  ctx.addEnv("MEILI_HTTP_ADDR", `0.0.0.0:${port}`);
  ctx.addStorage({
    store: `${appName}-meilisearch-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  addServicePortEndpoints(ctx, { port, protocol: "http" });
  ctx.setHealthcheck({
    kind: "command",
    command: ["sh", "-c", `curl -sf http://localhost:${port}/health`],
    intervalSeconds: 10,
    timeoutSeconds: 5,
    retries: 5,
    startPeriodSeconds: 30,
  });

  for (const dependency of service.dependsOn ?? []) {
    ctx.addDependency({ service: ServiceName.make(dependency), condition: "started" });
  }

  if (service.command !== undefined) ctx.setCommand(service.command);
  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
  if (service.workingDirectory !== undefined) ctx.setWorkingDirectory(service.workingDirectory);
  if (service.user !== undefined) ctx.setUser(service.user);
};

export const meilisearchServiceFeature: ServiceFeatureDefinition = {
  id: MEILISEARCH_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: (ctx) =>
    Effect.try({
      try: () => applyMeilisearchFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "meilisearch service feature failed to apply",
          feature: MEILISEARCH_FEATURE_ID,
          cause,
        }),
    }),
};

const resolveMeilisearchService: ServiceType["resolve"] = (input) =>
  Effect.succeed({
    base: "lando",
    normalizedConfig: { ...input.service, type: "meilisearch" },
    features: [{ id: MEILISEARCH_FEATURE_ID }],
  });

export const meilisearch1ServiceType: ServiceType = {
  id: "meilisearch:1",
  name: "meilisearch",
  base: "lando",
  schema: Schema.Unknown,
  resolve: resolveMeilisearchService,
};

/** Alias: `type: meilisearch` resolves to the meilisearch:1 image line. */
export const meilisearchServiceType: ServiceType = {
  id: "meilisearch",
  name: "meilisearch",
  base: "lando",
  schema: Schema.Unknown,
  resolve: resolveMeilisearchService,
};
