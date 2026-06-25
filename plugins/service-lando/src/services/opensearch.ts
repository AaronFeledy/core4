import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { PortablePath, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

const DEFAULT_IMAGE = "opensearchproject/opensearch:2";
const DEFAULT_PORT = 9200;
const DATA_TARGET = PortablePath.make("/usr/share/opensearch/data");
export const OPENSEARCH_FEATURE_ID = "service-lando.opensearch";

export const OPENSEARCH_SERVICE_DESCRIPTION =
  "OpenSearch is an Apache 2.0-licensed fork of Elasticsearch 7.10 maintained by " +
  "the OpenSearch Project. It exposes the same cluster-health and indices APIs " +
  "as elasticsearch, but ships under Apache 2.0 rather than the Elastic License " +
  "v2 (ELv2/SSPL) that Elasticsearch adopted after 7.10. Default local-dev " +
  "configuration is single-node with the security plugin disabled and is not " +
  "production-suitable.";

const appNameFor = (ctx: ServiceFeatureContext): string => {
  if (ctx.appName !== undefined && ctx.appName.length > 0) return ctx.appName;
  return basename(ctx.appRoot) || "app";
};

const applyOpenSearchFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  const port = service.port ?? DEFAULT_PORT;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.addEnv("discovery.type", "single-node");
  ctx.addEnv("DISABLE_SECURITY_PLUGIN", "true");
  ctx.addEnv("DISABLE_INSTALL_DEMO_CONFIG", "true");
  ctx.addEnv("http.port", String(port));
  ctx.addEnv("OPENSEARCH_JAVA_OPTS", "-Xms512m -Xmx512m");
  ctx.addStorage({
    store: `${appName}-opensearch-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  ctx.addEndpoint({ port, protocol: "http", name: ctx.serviceName });
  ctx.setHealthcheck({
    kind: "command",
    command: ["bash", "-c", `curl -sf http://localhost:${port}/_cluster/health`],
    intervalSeconds: 15,
    timeoutSeconds: 10,
    retries: 5,
    startPeriodSeconds: 90,
  });

  for (const dependency of service.dependsOn ?? []) {
    ctx.addDependency({ service: ServiceName.make(dependency), condition: "started" });
  }

  if (service.command !== undefined) ctx.setCommand(service.command);
  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
  if (service.workingDirectory !== undefined) ctx.setWorkingDirectory(service.workingDirectory);
  if (service.user !== undefined) ctx.setUser(service.user);
};

export const opensearchServiceFeature: ServiceFeatureDefinition = {
  id: OPENSEARCH_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: (ctx) =>
    Effect.try({
      try: () => applyOpenSearchFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "opensearch service feature failed to apply",
          feature: OPENSEARCH_FEATURE_ID,
          cause,
        }),
    }),
};

const resolveOpenSearchServiceType: ServiceType["resolve"] = (input) =>
  Effect.succeed({
    base: "lando",
    normalizedConfig: { ...input.service, type: "opensearch" },
    features: [{ id: OPENSEARCH_FEATURE_ID }],
  });

export const opensearch2ServiceType: ServiceType = {
  id: "opensearch:2",
  name: "opensearch",
  base: "lando",
  schema: Schema.Unknown,
  resolve: resolveOpenSearchServiceType,
};

export const opensearchServiceType: ServiceType = {
  id: "opensearch",
  name: "opensearch",
  base: "lando",
  schema: Schema.Unknown,
  resolve: resolveOpenSearchServiceType,
};
