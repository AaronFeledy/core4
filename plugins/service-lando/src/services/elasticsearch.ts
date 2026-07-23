import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { PortablePath, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { addServicePortEndpoints } from "./_port-helpers.ts";

const DEFAULT_IMAGE = "docker.elastic.co/elasticsearch/elasticsearch:8.17.0";
const DEFAULT_PORT = 9200;
const DATA_TARGET = PortablePath.make("/usr/share/elasticsearch/data");
export const ELASTICSEARCH_FEATURE_ID = "service-lando.elasticsearch";

const appNameFor = (ctx: ServiceFeatureContext): string => {
  if (ctx.appName !== undefined && ctx.appName.length > 0) return ctx.appName;
  return basename(ctx.appRoot) || "app";
};

const applyElasticsearchFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  const port = service.port ?? DEFAULT_PORT;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.addEnv("discovery.type", "single-node");
  ctx.addEnv("xpack.security.enabled", "false");
  ctx.addEnv("http.port", String(port));
  ctx.addEnv("ES_JAVA_OPTS", "-Xms512m -Xmx512m");
  ctx.addStorage({
    store: `${appName}-elasticsearch-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  addServicePortEndpoints(ctx, { port, protocol: "tcp" });
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

export const elasticsearchServiceFeature: ServiceFeatureDefinition = {
  id: ELASTICSEARCH_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: (ctx) =>
    Effect.try({
      try: () => applyElasticsearchFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "elasticsearch service feature failed to apply",
          feature: ELASTICSEARCH_FEATURE_ID,
          cause,
        }),
    }),
};

const resolveElasticsearchServiceType: ServiceType["resolve"] = (input) =>
  Effect.succeed({
    base: "lando",
    normalizedConfig: { ...input.service, type: "elasticsearch" },
    features: [{ id: ELASTICSEARCH_FEATURE_ID }],
  });

export const elasticsearch8ServiceType: ServiceType = {
  id: "elasticsearch:8",
  name: "elasticsearch",
  base: "lando",
  schema: Schema.Unknown,
  resolve: resolveElasticsearchServiceType,
};

export const elasticsearchServiceType: ServiceType = {
  id: "elasticsearch",
  name: "elasticsearch",
  base: "lando",
  schema: Schema.Unknown,
  resolve: resolveElasticsearchServiceType,
};
