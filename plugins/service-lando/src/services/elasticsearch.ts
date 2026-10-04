import { Effect, Schema } from "effect";

import { PortablePath } from "@lando/sdk/schema";
import type {
  ServiceFeatureContext,
  ServiceFeatureDefinition,
  ServiceImageIdentity,
  ServiceType,
} from "@lando/sdk/services";
import { serviceFeatureApply } from "./_feature-helpers.ts";

import { appNameFor } from "../app-name.ts";
import { addServicePortEndpoints } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

const DEFAULT_IMAGE = "docker.elastic.co/elasticsearch/elasticsearch:8.17.0";
const VERSIONS = ["8"] as const;
const ARTIFACTS = { "8": DEFAULT_IMAGE } as const;
const DEFAULT_PORT = 9200;
const DATA_TARGET = PortablePath.make("/usr/share/elasticsearch/data");
export const ELASTICSEARCH_FEATURE_ID = "service-lando.elasticsearch";

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

  applyAuthoredProcessFields(ctx);
};

export const elasticsearchServiceFeature: ServiceFeatureDefinition = {
  id: ELASTICSEARCH_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: serviceFeatureApply(
    ELASTICSEARCH_FEATURE_ID,
    "elasticsearch service feature failed to apply",
    applyElasticsearchFeature,
  ),
};

const IDENTITY: ServiceImageIdentity = {
  defaultUser: "elasticsearch",
  homes: { elasticsearch: "/usr/share/elasticsearch", root: "/root" },
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
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: IDENTITY,
  schema: Schema.Unknown,
  resolve: resolveElasticsearchServiceType,
};

export const elasticsearchServiceType: ServiceType = {
  id: "elasticsearch",
  name: "elasticsearch",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: IDENTITY,
  schema: Schema.Unknown,
  resolve: resolveElasticsearchServiceType,
};
