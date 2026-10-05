import { Effect, Schema } from "effect";

import { PortablePath } from "@lando/sdk/schema";
import type {
  ServiceFeatureContext,
  ServiceFeatureDefinition,
  ServiceImageIdentity,
  ServiceType,
} from "@lando/sdk/services";
import { commandHealthcheck, serviceFeatureApply } from "./_feature-helpers.ts";

import { appNameFor } from "../app-name.ts";
import { addServicePortEndpoints } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";

const DEFAULT_IMAGE = "opensearchproject/opensearch:2";
const VERSIONS = ["2"] as const;
const ARTIFACTS = { "2": DEFAULT_IMAGE } as const;
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
  addServicePortEndpoints(ctx, { port, protocol: "http" });
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
