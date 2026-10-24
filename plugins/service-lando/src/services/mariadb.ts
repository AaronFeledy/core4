import { sha256Hex } from "@lando/sdk/digest";
import { DEFAULT_PASSWORD } from "@lando/sdk/secrets";

import { Effect, Schema } from "effect";

import {
  AbsolutePath,
  type Environment,
  type LogSource,
  LogSourceId,
  PortablePath,
  type ServiceCreds,
} from "@lando/sdk/schema";
import { ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import {
  addEnvRecord,
  commandHealthcheck,
  rootIdentity,
  serviceFeatureApply,
  serviceTypeResolve,
} from "./_feature-helpers.ts";

import { appNameFor } from "../app-name.ts";
import { connectionFor } from "./_connection-helpers.ts";
import { familyEnvFor, landoDbEnvFor, resolveServiceCreds } from "./_creds-helpers.ts";
import { assertListenerConfig, plannedPort, servicePortEndpoints } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { addServerConfigMount } from "./_volume-helpers.ts";

const DEFAULT_IMAGE = "mariadb:11.4";
const VERSIONS = ["11.4"] as const;
const ARTIFACTS = { "11.4": DEFAULT_IMAGE } as const;
export const MARIADB_LISTENER = { port: 3306, variable: "MYSQL_TCP_PORT", daemon: "MariaDB" } as const;
const DATA_TARGET = PortablePath.make("/var/lib/mysql");
export const MARIADB_FEATURE_ID = "service-lando.mariadb";
export const MARIADB_CONFIG_TARGET = PortablePath.make("/etc/mysql/conf.d/99-lando.cnf");

const MARIADB_LOG_SOURCES: ReadonlyArray<LogSource> = [
  {
    id: LogSourceId.make("slow-query"),
    label: "MariaDB slow query log",
    path: AbsolutePath.make("/var/lib/mysql/slow.log"),
    stream: "stderr",
    strategy: "follow",
    required: false,
    timestamps: false,
  },
  {
    id: LogSourceId.make("general-query"),
    label: "MariaDB general query log",
    path: AbsolutePath.make("/var/lib/mysql/general.log"),
    stream: "stdout",
    strategy: "follow",
    required: false,
    timestamps: false,
  },
];

const defaultRootPassword = (appName: string, serviceName: string): string =>
  `lando-${sha256Hex(`${appName}:${serviceName}:root`).slice(0, 24)}`;

const mariadbCreds = (
  input: { readonly appName?: string | undefined; readonly appRoot: string },
  serviceName: string,
  service: {
    readonly creds?: ServiceCreds | undefined;
    readonly environment?: Environment | undefined;
    readonly database?: string | undefined;
  },
): ServiceCreds => {
  const appName = appNameFor(input);
  const creds = service.creds;
  return resolveServiceCreds({
    family: "mariadb",
    ...(creds === undefined
      ? {}
      : {
          authored: {
            user: creds.user,
            password: creds.password,
            database: creds.database,
            ...(creds.rootPassword === undefined ? {} : { rootPassword: creds.rootPassword }),
          },
        }),
    ...(service.environment === undefined ? {} : { environment: service.environment }),
    defaults: {
      user: "lando",
      password: DEFAULT_PASSWORD,
      database: appName,
      rootPassword: defaultRootPassword(appName, serviceName),
    },
    ...(service.database === undefined ? {} : { topLevelDatabase: service.database }),
  });
};

const applyMariadbFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  const { creds, port } = connectionFor(ctx);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? DEFAULT_IMAGE });
  addEnvRecord(ctx, {
    ...familyEnvFor("mariadb", creds),
    ...landoDbEnvFor(creds, port),
    MYSQL_TCP_PORT: String(port),
    MYSQL_PWD: creds.password,
  });
  ctx.addStorage({
    store: `${appName}-mariadb-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  ctx.setHealthcheck(
    commandHealthcheck(
      ["mariadb-admin", "ping", "-h", "127.0.0.1", "-P", String(port), "-u", creds.user, "--silent"],
      60,
    ),
  );

  applyAuthoredProcessFields(ctx);

  if (
    addServerConfigMount(ctx, MARIADB_CONFIG_TARGET) &&
    service.command === undefined &&
    service.entrypoint === undefined
  ) {
    ctx.setCommand(["mariadbd", `--port=${port}`]);
  }
};

export const mariadbServiceFeature: ServiceFeatureDefinition = {
  id: MARIADB_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  declareEndpoints: (ctx) =>
    Effect.sync(() => servicePortEndpoints(ctx, { port: connectionFor(ctx).port, protocol: "tcp" })),
  apply: serviceFeatureApply(
    MARIADB_FEATURE_ID,
    "mariadb service feature failed to apply",
    applyMariadbFeature,
  ),
};

const mariadbToolingForConnection: NonNullable<ServiceType["toolingForConnection"]> = (name, connection) =>
  connection.family !== "mariadb"
    ? {}
    : {
        mariadb: {
          description: "Open the MariaDB client for this service.",
          dir: PortablePath.make("/"),
          service: name,
          cmd: [
            "mariadb",
            "-h",
            "127.0.0.1",
            "-P",
            String(connection.port),
            "-u",
            connection.creds.user,
            connection.creds.database,
          ],
          env: { MYSQL_PWD: connection.creds.password },
        },
      };

export const mariadbServiceType: ServiceType = {
  id: "mariadb",
  name: "mariadb",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: rootIdentity(),
  schema: Schema.Unknown,
  toolingForConnection: mariadbToolingForConnection,
  resolve: (input) => {
    return serviceTypeResolve("mariadb", "mariadb service type failed to resolve", () => {
      const creds = mariadbCreds(input, input.name, input.service);
      const port = plannedPort(input.service, MARIADB_LISTENER);
      assertListenerConfig(input.service, MARIADB_LISTENER);
      return {
        base: "lando",
        connection: { family: "mariadb", creds, port },
        normalizedConfig: {
          ...input.service,
          type: "mariadb",
          creds,
          environment: {
            ...input.service.environment,
            ...familyEnvFor("mariadb", creds),
          },
        },
        logSources: MARIADB_LOG_SOURCES,
        features: [{ id: MARIADB_FEATURE_ID }],
        tooling: mariadbToolingForConnection(ServiceName.make(input.name), {
          family: "mariadb",
          creds,
          port,
        }),
      };
    });
  },
};
