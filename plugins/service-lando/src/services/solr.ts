import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { PortablePath, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

const DEFAULT_IMAGE = "solr:9";
const DEFAULT_PORT = 8983;
const DATA_TARGET = PortablePath.make("/var/solr");
const CORE_NAME = /^[A-Za-z0-9._-]+$/;
export const SOLR_FEATURE_ID = "service-lando.solr";

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

const appNameFor = (ctx: ServiceFeatureContext): string => {
  if (ctx.appName !== undefined && ctx.appName.length > 0) return ctx.appName;
  return basename(ctx.appRoot) || "app";
};

const applySolrFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  const port = service.port ?? DEFAULT_PORT;
  const cores = service.cores ?? [];

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.setCommand(service.command ?? defaultCommand(port, cores));
  ctx.addStorage({
    store: `${appName}-solr-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  ctx.addEndpoint({ port, protocol: "http", name: ctx.serviceName });
  ctx.setHealthcheck({
    kind: "command",
    command: ["bash", "-c", `curl -sf http://localhost:${port}/solr/admin/info/system`],
    intervalSeconds: 15,
    timeoutSeconds: 10,
    retries: 5,
    startPeriodSeconds: 60,
  });

  for (const dependency of service.dependsOn ?? []) {
    ctx.addDependency({ service: ServiceName.make(dependency), condition: "started" });
  }

  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
  if (service.workingDirectory !== undefined) ctx.setWorkingDirectory(service.workingDirectory);
  if (service.user !== undefined) ctx.setUser(service.user);
};

export const solrServiceFeature: ServiceFeatureDefinition = {
  id: SOLR_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: (ctx) =>
    Effect.try({
      try: () => applySolrFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "solr service feature failed to apply",
          feature: SOLR_FEATURE_ID,
          cause,
        }),
    }),
};

export const solr9ServiceType: ServiceType = {
  id: "solr:9",
  name: "solr",
  base: "lando",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: { ...input.service, type: "solr" },
      features: [{ id: SOLR_FEATURE_ID }],
    }),
};

export const solrServiceType: ServiceType = {
  id: "solr",
  name: "solr",
  base: "lando",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: { ...input.service, type: "solr" },
      features: [{ id: SOLR_FEATURE_ID }],
    }),
};
