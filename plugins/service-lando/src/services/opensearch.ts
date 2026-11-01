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

const DEFAULT_IMAGE = "opensearchproject/opensearch:2";
const VERSIONS = ["2"] as const;
const ARTIFACTS = { "2": DEFAULT_IMAGE } as const;
export const DEFAULT_PORT = 9200;
export const DEFAULT_TRANSPORT_PORT = 9300;
export const OPENSEARCH_LISTENER = {
  port: DEFAULT_PORT,
  daemon: "OpenSearch",
  variables: ["http.port"],
  reserved: [{ port: DEFAULT_TRANSPORT_PORT, use: "transport listener" }],
} as const satisfies ListenerContract;
const DATA_TARGET = PortablePath.make("/usr/share/opensearch/data");
export const OPENSEARCH_FEATURE_ID = "service-lando.opensearch";

export const OPENSEARCH_SERVICE_DESCRIPTION =
  "OpenSearch is an Apache 2.0-licensed fork of Elasticsearch 7.10 maintained by " +
  "the OpenSearch Project. It exposes the same cluster-health and indices APIs " +
  "as elasticsearch, but ships under Apache 2.0 rather than the Elastic License " +
  "v2 (ELv2/SSPL) that Elasticsearch adopted after 7.10. Default local-dev " +
  "configuration is single-node with the security plugin disabled and is not " +
  "production-suitable.";

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

const opensearchListener = (service: ServiceConfig): ListenerContract => {
  const transport = transportPort(service);
  return {
    ...OPENSEARCH_LISTENER,
    reserved: [{ port: transport, use: "transport listener" }],
  };
};

const applyOpenSearchFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  assertListenerConfig(service, opensearchListener(service));
  const port = plannedPort(service, OPENSEARCH_LISTENER);
  const transport = transportPort(service);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.addEnv("discovery.type", "single-node");
  ctx.addEnv("DISABLE_SECURITY_PLUGIN", "true");
  ctx.addEnv("DISABLE_INSTALL_DEMO_CONFIG", "true");
  ctx.addEnv("http.port", String(port));
  ctx.addEnv("transport.port", String(transport));
  ctx.addEnv("OPENSEARCH_JAVA_OPTS", "-Xms512m -Xmx512m");
  ctx.addStorage({
    store: `${appName}-opensearch-data`,
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

export const opensearchServiceFeature: ServiceFeatureDefinition = {
  id: OPENSEARCH_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  validateEffective: serviceFeatureValidateEffective(OPENSEARCH_FEATURE_ID, (ctx) => {
    assertListenerConfig(ctx.normalizedConfig, opensearchListener(ctx.normalizedConfig));
    return { handledServiceFields: [] };
  }),
  declareEndpoints: (ctx) =>
    Effect.sync(() =>
      servicePortEndpoints(ctx, {
        port: plannedPort(ctx.normalizedConfig, OPENSEARCH_LISTENER),
        protocol: "http",
      }),
    ),
  apply: serviceFeatureApply(
    OPENSEARCH_FEATURE_ID,
    "opensearch service feature failed to apply",
    applyOpenSearchFeature,
  ),
};

const IDENTITY: ServiceImageIdentity = {
  defaultUser: "opensearch",
  homes: { opensearch: "/usr/share/opensearch", root: "/root" },
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
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: IDENTITY,
  schema: Schema.Unknown,
  resolve: resolveOpenSearchServiceType,
};

export const opensearchServiceType: ServiceType = {
  id: "opensearch",
  name: "opensearch",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: IDENTITY,
  schema: Schema.Unknown,
  resolve: resolveOpenSearchServiceType,
};
