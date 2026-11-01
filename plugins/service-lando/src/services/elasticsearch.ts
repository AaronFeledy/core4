import { Effect, Schema } from "effect";

import { PortablePath, type ServiceConfig } from "@lando/sdk/schema";
import type {
  ServiceFeatureContext,
  ServiceFeatureDefinition,
  ServiceImageIdentity,
  ServiceType,
} from "@lando/sdk/services";
import {
  ServiceConfigIssue,
  commandHealthcheck,
  serviceFeatureApply,
  serviceFeatureValidateEffective,
} from "./_feature-helpers.ts";

import { appNameFor } from "../app-name.ts";
import {
  type ListenerContract,
  assertListenerConfig,
  plannedPort,
  servicePortEndpoints,
} from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

const DEFAULT_IMAGE = "docker.elastic.co/elasticsearch/elasticsearch:8.17.0";
const VERSIONS = ["8"] as const;
const ARTIFACTS = { "8": DEFAULT_IMAGE } as const;
export const DEFAULT_PORT = 9200;
export const DEFAULT_TRANSPORT_PORT = 9300;
export const ELASTICSEARCH_LISTENER = {
  port: DEFAULT_PORT,
  daemon: "Elasticsearch",
  variables: ["http.port"],
  reserved: [{ port: DEFAULT_TRANSPORT_PORT, use: "transport listener" }],
} as const satisfies ListenerContract;
const DATA_TARGET = PortablePath.make("/usr/share/elasticsearch/data");
export const ELASTICSEARCH_FEATURE_ID = "service-lando.elasticsearch";

const transportPort = (service: ServiceConfig): number => {
  const authored = service.environment?.["transport.port"];
  if (authored === undefined) return DEFAULT_TRANSPORT_PORT;
  if (typeof authored !== "string" || !/^[0-9]+$/.test(authored)) {
    throw new ServiceConfigIssue(
      ["environment", "transport.port"],
      typeof authored === "string"
        ? `transport.port is ${JSON.stringify(authored)}, which is not a TCP port number.`
        : "transport.port requires a literal TCP port number.",
      "Set transport.port to a single integer from 1 to 65535.",
    );
  }
  const value = Number(authored);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new ServiceConfigIssue(
      ["environment", "transport.port"],
      `transport.port is ${JSON.stringify(authored)}, which is not a TCP port number.`,
      "Set transport.port to a single integer from 1 to 65535.",
    );
  }
  return value;
};

const elasticsearchListener = (service: ServiceConfig): ListenerContract => {
  const transport = transportPort(service);
  return {
    ...ELASTICSEARCH_LISTENER,
    reserved: [{ port: transport, use: "transport listener" }],
  };
};

const applyElasticsearchFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  assertListenerConfig(service, elasticsearchListener(service));
  const port = plannedPort(service, ELASTICSEARCH_LISTENER);
  const transport = transportPort(service);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.addEnv("discovery.type", "single-node");
  ctx.addEnv("xpack.security.enabled", "false");
  ctx.addEnv("http.port", String(port));
  ctx.addEnv("transport.port", String(transport));
  ctx.addEnv("ES_JAVA_OPTS", "-Xms512m -Xmx512m");
  ctx.addStorage({
    store: `${appName}-elasticsearch-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  ctx.setHealthcheck(
    commandHealthcheck(["bash", "-c", `curl -sf http://localhost:${port}/_cluster/health`], 90, {
      intervalSeconds: 15,
      timeoutSeconds: 10,
    }),
  );

  applyAuthoredProcessFields(ctx);
};

export const elasticsearchServiceFeature: ServiceFeatureDefinition = {
  id: ELASTICSEARCH_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  validateEffective: serviceFeatureValidateEffective(ELASTICSEARCH_FEATURE_ID, (ctx) => {
    assertListenerConfig(ctx.normalizedConfig, elasticsearchListener(ctx.normalizedConfig));
    return { handledServiceFields: [] };
  }),
  declareEndpoints: (ctx) =>
    Effect.sync(() =>
      servicePortEndpoints(ctx, {
        port: plannedPort(ctx.normalizedConfig, ELASTICSEARCH_LISTENER),
        protocol: "tcp",
      }),
    ),
  apply: serviceFeatureApply(
    ELASTICSEARCH_FEATURE_ID,
    "elasticsearch service feature failed to apply",
    applyElasticsearchFeature,
  ),
};

const IDENTITY: ServiceImageIdentity = {
  defaultUser: "elasticsearch",
  homes: { elasticsearch: "/usr/share/elasticsearch", root: "/root" },
  preparedHomes: ["elasticsearch"],
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
