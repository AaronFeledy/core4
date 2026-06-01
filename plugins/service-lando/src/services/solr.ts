import { PortablePath, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";

import { decodeServicePlan } from "./_schema-helpers.ts";
import { appNameFor, buildLandoEnv } from "./env.ts";

const DEFAULT_IMAGE = "solr:9";
const DEFAULT_PORT = 8983;
const DATA_TARGET = PortablePath.make("/var/solr");
const CORE_NAME = /^[A-Za-z0-9._-]+$/;

const validateCoreName = (core: string): void => {
  if (!CORE_NAME.test(core)) {
    throw new Error(
      `Invalid Solr core name ${JSON.stringify(core)}. Use only letters, numbers, dots, underscores, and dashes.`,
    );
  }
};

const defaultCommand = (port: number, cores: readonly string[]): string[] => {
  if (cores.length === 0) {
    return ["solr-foreground", "-p", String(port)];
  }
  for (const core of cores) validateCoreName(core);
  return [
    "bash",
    "-c",
    'port="$1"; shift; for core in "$@"; do precreate-core "$core"; done; exec solr-foreground -p "$port"',
    "lando-solr-precreate",
    String(port),
    ...cores,
  ];
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

    return decodeServicePlan({
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
      endpoints: [{ port, protocol: "http", name }],
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
