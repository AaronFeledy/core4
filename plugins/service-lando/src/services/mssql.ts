import { sha256Hex } from "@lando/sdk/digest";

import { Effect, Schema } from "effect";

import { ServiceTypeError } from "@lando/sdk/errors";
import { PortablePath, ServiceName } from "@lando/sdk/schema";
import { MssqlServiceConfig } from "@lando/sdk/schema/services/mssql";
import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";
import {
  addEnvRecord,
  commandHealthcheck,
  serviceFeatureApply,
  serviceTypeResolve,
} from "./_feature-helpers.ts";

import { appNameFor } from "../app-name.ts";
import { connectionFor } from "./_connection-helpers.ts";
import { familyEnvFor, landoDbEnvFor, resolveServiceCreds } from "./_creds-helpers.ts";
import { addServicePortEndpoints, assertListenerConfig, plannedPort } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { mssqlHealthcheck, mssqlStartupCommand } from "./mssql-startup.ts";

const MSSQL_LISTENER = {
  port: 1433,
  variable: "MSSQL_TCP_PORT",
  daemon: "SQL Server",
  reserved: [{ port: 1434, use: "dedicated admin connection" }],
} as const;
const DATA_TARGET = PortablePath.make("/var/opt/mssql");
const SQLCMD = "/opt/mssql-tools18/bin/sqlcmd";
const MssqlFeatureConfig = Schema.Struct({ ownsStartup: Schema.Boolean });
const VERSIONS = ["2019", "2022"] as const;
const ARTIFACTS = {
  "2019": "mcr.microsoft.com/mssql/server:2019-latest",
  "2022": "mcr.microsoft.com/mssql/server:2022-latest",
} as const;
const AMD64_HOST_ARCHES = new Set(["x64", "amd64", "x86_64"]);
export const MSSQL_FEATURE_ID = "service-lando.mssql";

const defaultRootPassword = (appName: string, serviceName: string): string =>
  `Lando!${sha256Hex(`${appName}:${serviceName}:root`).slice(0, 24)}`;

const defaultCreds = (appName: string, serviceName: string) => ({
  user: "sa",
  password: defaultRootPassword(appName, serviceName),
  database: appName,
  rootPassword: defaultRootPassword(appName, serviceName),
});

const sqlcmdToolingArgv = (port: number): readonly string[] => [
  SQLCMD,
  "-S",
  `localhost,${port}`,
  "-U",
  "sa",
  "-C",
];

const hostRunsMssqlWithoutEmulation = (arch: string): boolean => AMD64_HOST_ARCHES.has(arch);

const applyMssqlFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const { creds, port } = connectionFor(ctx);
  const appName = appNameFor(ctx);
  const environment = service.environment ?? {};
  const { ownsStartup } = Schema.decodeUnknownSync(MssqlFeatureConfig)(ctx.config);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? ARTIFACTS["2022"] });
  ctx.addEnv("ACCEPT_EULA", environment.ACCEPT_EULA ?? "Y");
  ctx.addEnv("MSSQL_PID", environment.MSSQL_PID ?? "Developer");
  addEnvRecord(ctx, {
    ...familyEnvFor("mssql", creds),
    ...landoDbEnvFor(creds, port),
    MSSQL_TCP_PORT: String(port),
  });
  ctx.addStorage({
    store: `${appName}-mssql-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  addServicePortEndpoints(ctx, { port, protocol: "tcp" });
  ctx.setHealthcheck(commandHealthcheck([...mssqlHealthcheck(creds.database, port)], 30));
  if (ownsStartup && service.command === undefined && service.entrypoint === undefined) {
    ctx.setCommand([...mssqlStartupCommand(creds.database, port)]);
  }

  applyAuthoredProcessFields(ctx);
};

export const mssqlServiceFeature: ServiceFeatureDefinition = {
  id: MSSQL_FEATURE_ID,
  schema: MssqlFeatureConfig,
  priority: 600,
  apply: serviceFeatureApply(MSSQL_FEATURE_ID, "mssql service feature failed to apply", applyMssqlFeature),
};

const mssqlToolingForConnection: NonNullable<ServiceType["toolingForConnection"]> = (name, connection) =>
  connection.family !== "mssql"
    ? {}
    : {
        sqlcmd: {
          service: name,
          cmd: [...sqlcmdToolingArgv(connection.port)],
          env: { SQLCMDPASSWORD: connection.creds.password },
        },
      };

const makeMssqlServiceType = (id: string, image: string): ServiceType => ({
  id,
  name: "mssql",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  identity: { defaultUser: "mssql", homes: { mssql: "/var/opt/mssql", root: "/root" } },
  schema: MssqlServiceConfig,
  toolingForConnection: mssqlToolingForConnection,
  resolve: (input) => {
    const arch = input.host?.arch ?? process.arch;
    if (
      input.capabilities !== undefined &&
      !hostRunsMssqlWithoutEmulation(arch) &&
      input.capabilities.architectureEmulation !== true
    ) {
      return Effect.fail(
        new ServiceTypeError({
          message: "Upstream SQL Server images are amd64-only.",
          issues: [
            {
              path: ["type"],
              message: "Upstream SQL Server images are amd64-only.",
              suggestion: "Use an amd64 host or a provider with architecture emulation.",
            },
          ],
          serviceType: id,
        }),
      );
    }

    const appName = appNameFor(input);
    const authoredEnv = input.service.environment ?? {};
    return serviceTypeResolve(id, "mssql service type failed to resolve", () => {
      const creds = resolveServiceCreds({
        family: "mssql",
        environment: authoredEnv,
        defaults: defaultCreds(appName, input.name),
        ...(input.service.creds === undefined ? {} : { authored: input.service.creds }),
      });
      const port = plannedPort(input.service, MSSQL_LISTENER);
      assertListenerConfig(input.service, MSSQL_LISTENER);
      return {
        base: "lando",
        connection: { family: "mssql", creds, port },
        normalizedConfig: {
          ...input.service,
          type: "mssql",
          image: input.service.image ?? image,
          creds,
          environment: {
            ...authoredEnv,
            ...familyEnvFor("mssql", creds),
          },
        },
        features: [
          {
            id: MSSQL_FEATURE_ID,
            config: {
              ownsStartup:
                input.service.build === undefined &&
                (input.service.image === undefined || input.service.image === image),
            },
          },
        ],
        tooling: mssqlToolingForConnection(ServiceName.make(input.name), { family: "mssql", creds, port }),
      };
    });
  },
});

export const mssql2019ServiceType = makeMssqlServiceType("mssql:2019", ARTIFACTS["2019"]);
export const mssql2022ServiceType = makeMssqlServiceType("mssql:2022", ARTIFACTS["2022"]);
export const mssqlServiceType = makeMssqlServiceType("mssql", ARTIFACTS["2022"]);
