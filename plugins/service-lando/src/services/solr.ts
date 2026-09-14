import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError } from "@lando/sdk/errors";
import { PortablePath } from "@lando/sdk/schema";
import type {
  ServiceFeatureContext,
  ServiceFeatureDefinition,
  ServiceImageIdentity,
  ServiceType,
} from "@lando/sdk/services";

import { addServicePortEndpoints } from "./_port-helpers.ts";
import { resolveBindSource } from "./_volume-helpers.ts";

const DEFAULT_IMAGE = "solr:9";
const DEFAULT_PORT = 8983;
const DATA_TARGET = PortablePath.make("/var/solr");
const CORE_NAME = /^[A-Za-z0-9._-]+$/;
export const SOLR_FEATURE_ID = "service-lando.solr";
export const SOLR_CONFIG_TARGET = PortablePath.make("/etc/lando/solr/conf");

const PRECREATE_SCRIPT =
  'port="$1"; shift; for core in "$@"; do precreate-core "$core"; done; exec solr-foreground -p "$port"';
const PRECREATE_WITH_CONFIG_SCRIPT =
  'port="$1"; shift; for core in "$@"; do precreate-core "$core" && mkdir -p /var/solr/data/"$core"/conf && cp -a /etc/lando/solr/conf/. /var/solr/data/"$core"/conf/ || exit 1; done; exec solr-foreground -p "$port"';

const validateCoreName = (core: string): void => {
  if (!CORE_NAME.test(core)) {
    throw new Error(
      `Invalid Solr core name ${JSON.stringify(core)}. Use only letters, numbers, dots, underscores, and dashes.`,
    );
  }
};

const defaultCommand = (port: number, cores: readonly string[], hasConfigDir: boolean): string[] => {
  if (cores.length === 0) {
    return ["solr-foreground", "-p", String(port)];
  }
  for (const core of cores) validateCoreName(core);
  return [
    "bash",
    "-c",
    hasConfigDir ? PRECREATE_WITH_CONFIG_SCRIPT : PRECREATE_SCRIPT,
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
  const configDir = service.config?.dir;
  const hasConfigDir = typeof configDir === "string" && configDir.length > 0;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  ctx.setCommand(service.command ?? defaultCommand(port, cores, hasConfigDir));
  ctx.addStorage({
    store: `${appName}-solr-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  if (hasConfigDir) {
    ctx.addMount({
      type: "bind",
      source: resolveBindSource(configDir, ctx.appRoot),
      target: SOLR_CONFIG_TARGET,
      readOnly: true,
    });
  }
  addServicePortEndpoints(ctx, { port, protocol: "http" });
  ctx.setHealthcheck({
    kind: "command",
    command: ["bash", "-c", `curl -sf http://localhost:${port}/solr/admin/info/system`],
    intervalSeconds: 15,
    timeoutSeconds: 10,
    retries: 5,
    startPeriodSeconds: 60,
  });

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

const IDENTITY: ServiceImageIdentity = {
  defaultUser: "solr",
  homes: { solr: "/var/solr", root: "/root" },
};

export const solr9ServiceType: ServiceType = {
  id: "solr:9",
  name: "solr",
  base: "lando",
  identity: IDENTITY,
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
  identity: IDENTITY,
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "lando",
      normalizedConfig: { ...input.service, type: "solr" },
      features: [{ id: SOLR_FEATURE_ID }],
    }),
};
