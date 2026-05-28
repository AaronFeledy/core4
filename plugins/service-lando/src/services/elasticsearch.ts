import { Schema } from "effect";

import { PortablePath, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import { appNameFor, buildLandoEnv } from "./env.ts";

const DEFAULT_IMAGE = "docker.elastic.co/elasticsearch/elasticsearch:8.17.0";
const DEFAULT_PORT = 9200;
const DATA_TARGET = PortablePath.make("/usr/share/elasticsearch/data");

export const elasticsearch8ServiceType: ServiceTypeShape = {
  id: "elasticsearch:8",
  toServicePlan: (input) => {
    const { name, service, provider = ProviderId.make("lando"), primary = false, metadata, host } = input;
    const appName = appNameFor(input);

    const port = service.port ?? DEFAULT_PORT;

    const environment = buildLandoEnv({
      serviceName: name,
      serviceType: "elasticsearch",
      appName,
      host,
      extraDefaults: {
        "discovery.type": "single-node",
        "xpack.security.enabled": "false",
        "http.port": String(port),
        ES_JAVA_OPTS: "-Xms512m -Xmx512m",
      },
      userEnv: service.environment ?? {},
    });

    return Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: "elasticsearch",
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
          store: `${appName}-elasticsearch-data`,
          target: DATA_TARGET,
          readOnly: false,
        },
      ],
      endpoints: [{ port, protocol: "tcp", name }],
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

export const elasticsearchServiceType: ServiceTypeShape = {
  id: "elasticsearch",
  toServicePlan: (input) =>
    elasticsearch8ServiceType.toServicePlan({
      ...input,
      service: { ...input.service },
    }),
};
