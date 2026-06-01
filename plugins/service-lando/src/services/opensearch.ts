import { PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import { decodeServicePlan } from "./_schema-helpers.ts";
import { appNameFor, buildLandoEnv } from "./env.ts";

const DEFAULT_IMAGE = "opensearchproject/opensearch:2";
const DEFAULT_PORT = 9200;
const DATA_TARGET = PortablePath.make("/usr/share/opensearch/data");

export const OPENSEARCH_SERVICE_DESCRIPTION =
  "OpenSearch is an Apache 2.0-licensed fork of Elasticsearch 7.10 maintained by " +
  "the OpenSearch Project. It exposes the same cluster-health and indices APIs " +
  "as elasticsearch, but ships under Apache 2.0 rather than the Elastic License " +
  "v2 (ELv2/SSPL) that Elasticsearch adopted after 7.10. Default local-dev " +
  "configuration is single-node with the security plugin disabled and is not " +
  "production-suitable.";

export const opensearch2ServiceType: ServiceTypeShape = {
  id: "opensearch:2",
  toServicePlan: (input) => {
    const { name, service, provider = ProviderId.make("lando"), primary = false, metadata, host } = input;
    const appName = appNameFor(input);

    const port = service.port ?? DEFAULT_PORT;

    const environment = buildLandoEnv({
      serviceName: name,
      serviceType: "opensearch",
      appName,
      host,
      extraDefaults: {
        "discovery.type": "single-node",
        DISABLE_SECURITY_PLUGIN: "true",
        DISABLE_INSTALL_DEMO_CONFIG: "true",
        "http.port": String(port),
        OPENSEARCH_JAVA_OPTS: "-Xms512m -Xmx512m",
      },
      userEnv: service.environment ?? {},
    });

    return decodeServicePlan({
      name: ServiceName.make(name),
      type: "opensearch",
      provider,
      primary: service.primary ?? primary,
      artifact: { kind: "ref", ref: service.image ?? DEFAULT_IMAGE },
      command: service.command,
      entrypoint: service.entrypoint,
      environment,
      workingDirectory: service.workingDirectory,
      appMount: undefined,
      mounts: [],
      storage: [
        {
          store: `${appName}-opensearch-data`,
          target: DATA_TARGET,
          readOnly: false,
        },
      ],
      endpoints: [{ port, protocol: "http", name }],
      routes: [],
      dependsOn: (service.dependsOn ?? []).map((dependency) => ({
        service: ServiceName.make(dependency),
        condition: "started",
      })),
      healthcheck: {
        kind: "command",
        command: ["bash", "-c", `curl -sf http://localhost:${port}/_cluster/health`],
        intervalSeconds: 15,
        timeoutSeconds: 10,
        retries: 5,
        startPeriodSeconds: 90,
      },
      hostAliases: [],
      metadata,
      extensions: {},
    });
  },
};

export const opensearchServiceType: ServiceTypeShape = {
  id: "opensearch",
  toServicePlan: (input) =>
    opensearch2ServiceType.toServicePlan({
      ...input,
      service: { ...input.service },
    }),
};
