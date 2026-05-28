import { Schema } from "effect";

import { PortablePath, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import { appNameFor, buildLandoEnv } from "./env.ts";

const DEFAULT_IMAGE = "solr:9";
const DEFAULT_PORT = 8983;
const DATA_TARGET = PortablePath.make("/var/solr");

const defaultCommand = (port: number, cores: readonly string[]): string[] => {
  if (cores.length === 0) {
    return ["solr-foreground", "-p", String(port)];
  }
  const precreates = cores.map((c) => `precreate-core ${c}`).join(" && ");
  return ["bash", "-c", `${precreates} && exec solr-foreground -p ${port}`];
};

export const solr9ServiceType: ServiceTypeShape = {
  id: "solr:9",
  toServicePlan: (input) => {
    const { name, service, provider = ProviderId.make("lando"), primary = false, metadata, host } = input;
    const appName = appNameFor(input);

    const environment = buildLandoEnv({
      serviceName: name,
      serviceType: "solr",
      appName,
      host,
      userEnv: service.environment ?? {},
    });

    const port = service.port ?? DEFAULT_PORT;
    const cores = service.cores ?? [];

    return Schema.decodeUnknownSync(ServicePlan)({
      name: ServiceName.make(name),
      type: "solr",
      provider,
      primary: service.primary ?? primary,
      artifact: { kind: "ref", ref: service.image ?? DEFAULT_IMAGE },
      command: service.command ?? defaultCommand(port, cores),
      entrypoint: service.entrypoint,
      environment,
      workingDirectory: service.workingDirectory,
      appMount: undefined,
      mounts: [],
      storage: [
        {
          store: `${appName}-solr-data`,
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
        command: ["bash", "-c", `curl -sf http://localhost:${port}/solr/admin/info/system`],
        intervalSeconds: 15,
        timeoutSeconds: 10,
        retries: 5,
        startPeriodSeconds: 60,
      },
      hostAliases: [],
      metadata,
      extensions: {},
    });
  },
};

/** Alias: `type: solr` resolves to the solr:9 image. */
export const solrServiceType: ServiceTypeShape = {
  id: "solr",
  toServicePlan: (input) =>
    solr9ServiceType.toServicePlan({
      ...input,
      service: { ...input.service },
    }),
};
