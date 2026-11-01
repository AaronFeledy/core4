import { Effect, Schema } from "effect";

import { ServiceTypeError } from "@lando/sdk/errors";
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
  launcherAuthority,
  plannedPort,
  servicePortEndpoints,
} from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { isAppRelativeSource, resolveBindSource } from "./_volume-helpers.ts";

const DEFAULT_IMAGE = "solr:9";
const VERSIONS = ["9"] as const;
const ARTIFACTS = { "9": DEFAULT_IMAGE } as const;
export const SOLR_LISTENER = {
  port: 8983,
  daemon: "Solr",
  when: "All Solr services; stop-port reservation follows the effective launcher",
  launcher: { setting: (port: number) => `-p ${port}` },
} as const;
export const DEFAULT_PORT = SOLR_LISTENER.port;
const DATA_TARGET = PortablePath.make("/var/solr");
const CORE_NAME = /^[A-Za-z0-9._-]+$/u;
const RESERVED_CORE_NAMES = new Set([".", ".."]);
const CORE_NAME_REMEDIATION =
  'Use letters, numbers, dots, underscores, and dashes. "." and ".." are reserved, and "/" and "\\" are not allowed. Rename the core to a plain directory name.';
export const SOLR_FEATURE_ID = "service-lando.solr";
export const SOLR_CONFIG_TARGET = PortablePath.make("/etc/lando/solr/conf");

const CORE_FOREGROUND_SCRIPT =
  'mode=(); if solr start --help 2>&1 | grep -q -- "--user-managed"; then mode=(--user-managed); fi; exec solr-foreground -p "$port" "${mode[@]}"';
const PRECREATE_SCRIPT = `port="$1"; shift; for core in "$@"; do precreate-core "$core"; done; ${CORE_FOREGROUND_SCRIPT}`;
const PRECREATE_WITH_CONFIG_SCRIPT = `port="$1"; shift; for core in "$@"; do precreate-core "$core" && mkdir -p /var/solr/data/"$core"/conf && cp -a /etc/lando/solr/conf/. /var/solr/data/"$core"/conf/ || exit 1; done; ${CORE_FOREGROUND_SCRIPT}`;

/**
 * A Solr core name that names exactly one directory under `/var/solr/data`.
 * Anything that could resolve somewhere else is refused, so a core can never
 * precreate or overlay config outside its own data directory.
 */
export const SolrCoreName = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((core) => CORE_NAME.test(core) && !RESERVED_CORE_NAMES.has(core), {
      identifier: "SolrCoreName",
      description: "Solr core name resolving to a single directory under /var/solr/data.",
    }),
  ),
);

const isSolrCoreName = Schema.is(SolrCoreName);

const coreNameRejection = (core: string): string =>
  `${JSON.stringify(core)} is not a usable Solr core directory name.`;

const rejectUnsafeCores = (
  serviceType: string,
  cores: ReadonlyArray<string>,
): ServiceTypeError | undefined => {
  const index = cores.findIndex((core) => !isSolrCoreName(core));
  const core = cores[index];
  if (core === undefined) return undefined;
  return new ServiceTypeError({
    serviceType,
    message: coreNameRejection(core),
    issues: [{ path: ["cores", index], message: coreNameRejection(core), suggestion: CORE_NAME_REMEDIATION }],
    remediation: CORE_NAME_REMEDIATION,
  });
};

const validateCoreName = (core: string, index: number): void => {
  if (!isSolrCoreName(core))
    throw new ServiceConfigIssue(["cores", index], coreNameRejection(core), CORE_NAME_REMEDIATION);
};

const defaultCommand = (port: number, cores: readonly string[], hasConfigDir: boolean): string[] => {
  if (cores.length === 0) {
    return ["solr-foreground", "-p", String(port)];
  }
  cores.forEach(validateCoreName);
  return [
    "bash",
    "-c",
    hasConfigDir ? PRECREATE_WITH_CONFIG_SCRIPT : PRECREATE_SCRIPT,
    "lando-solr-precreate",
    String(port),
    ...cores,
  ];
};

const solrListener = (service: ServiceConfig): ListenerContract => {
  if (service.command !== undefined) return SOLR_LISTENER;
  const port = plannedPort(service, SOLR_LISTENER);
  const authored = service.environment?.STOP_PORT;
  const stopPort =
    authored === undefined
      ? port - 1000
      : typeof authored === "string" && /^[0-9]+$/.test(authored)
        ? Number(authored)
        : Number.NaN;
  if (!Number.isInteger(stopPort) || stopPort < 1 || stopPort > 65535) {
    throw new ServiceConfigIssue(
      authored === undefined ? ["port"] : ["environment", "STOP_PORT"],
      authored === undefined
        ? `Solr port ${port} derives STOP_PORT ${stopPort}, which is not valid for graceful shutdown.`
        : "STOP_PORT requires a literal TCP port number from 1 to 65535.",
      authored === undefined
        ? "Set port: above 1000, or set STOP_PORT to a distinct TCP port number from 1 to 65535."
        : "Set STOP_PORT to a distinct TCP port number from 1 to 65535, or remove it and set port: above 1000.",
    );
  }
  return { ...SOLR_LISTENER, reserved: [{ port: stopPort, use: "loopback stop listener (STOP_PORT)" }] };
};

const applySolrFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  assertListenerConfig(service, solrListener(service));
  const port = plannedPort(service, SOLR_LISTENER);
  const cores = service.cores ?? [];
  const configDir = service.config?.dir;
  const hasConfigDir = typeof configDir === "string" && configDir.length > 0;

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  if (service.command !== undefined) {
    ctx.setCommand(service.command);
    ctx.setListenerAuthority(launcherAuthority(SOLR_LISTENER, port));
  } else {
    ctx.setCommand(defaultCommand(port, cores, hasConfigDir));
  }
  ctx.addStorage(
    {
      store: `${appName}-solr-data`,
      target: DATA_TARGET,
      readOnly: false,
    },
    // The image ships /var/solr owned by solr, and a fresh volume inherits
    // that. Any other planned user needs the tree prepared for it, because
    // init-var-solr, precreate-core, and the config overlay all write here.
    { seededOwners: ["solr", "8983"] },
  );
  if (hasConfigDir) {
    ctx.addMount({
      type: "bind",
      source: resolveBindSource(configDir, ctx.appRoot),
      ...(isAppRelativeSource(configDir) ? { relativeTo: "app" as const } : {}),
      target: SOLR_CONFIG_TARGET,
      readOnly: true,
    });
  }
  ctx.setHealthcheck(
    commandHealthcheck(["bash", "-c", `curl -sf http://localhost:${port}/solr/admin/info/system`], 60, {
      intervalSeconds: 15,
      timeoutSeconds: 10,
    }),
  );

  applyAuthoredProcessFields(ctx, ["entrypoint", "workingDirectory", "user"]);
};

export const solrServiceFeature: ServiceFeatureDefinition = {
  id: SOLR_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  validateEffective: serviceFeatureValidateEffective(SOLR_FEATURE_ID, (ctx) => {
    assertListenerConfig(ctx.normalizedConfig, solrListener(ctx.normalizedConfig));
    return { handledServiceFields: [] };
  }),
  declareEndpoints: (ctx) =>
    Effect.sync(() =>
      servicePortEndpoints(ctx, {
        port: plannedPort(ctx.normalizedConfig, SOLR_LISTENER),
        protocol: "http",
      }),
    ),
  apply: serviceFeatureApply(SOLR_FEATURE_ID, "solr service feature failed to apply", applySolrFeature),
};

const IDENTITY: ServiceImageIdentity = {
  defaultUser: "solr",
  homes: { solr: "/home/solr", root: "/root" },
  preparedHomes: ["solr"],
};

const resolveSolr =
  (serviceType: string): ServiceType["resolve"] =>
  (input) => {
    const rejection = rejectUnsafeCores(serviceType, input.service.cores ?? []);
    if (rejection !== undefined) return Effect.fail(rejection);
    return Effect.succeed({
      base: "lando",
      normalizedConfig: { ...input.service, type: "solr" },
      features: [{ id: SOLR_FEATURE_ID }],
    });
  };

export const solr9ServiceType: ServiceType = {
  id: "solr:9",
  name: "solr",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: IDENTITY,
  schema: Schema.Unknown,
  resolve: resolveSolr("solr:9"),
};

export const solrServiceType: ServiceType = {
  id: "solr",
  name: "solr",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: IDENTITY,
  schema: Schema.Unknown,
  resolve: resolveSolr("solr"),
};
