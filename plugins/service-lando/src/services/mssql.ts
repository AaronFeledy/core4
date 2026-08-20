import { createHash } from "node:crypto";
import { basename } from "node:path";

import { Effect, Schema } from "effect";

import { ServiceFeatureError, ServiceTypeError } from "@lando/sdk/errors";
import { PortablePath, type ServiceCreds } from "@lando/sdk/schema";
import { MssqlServiceConfig } from "@lando/sdk/schema/services/mssql";
import type {
  ServiceFeatureContext,
  ServiceFeatureDefinition,
  ServiceType,
  ServiceTypeInput,
} from "@lando/sdk/services";

import { addServicePortEndpoints } from "./_port-helpers.ts";

const DEFAULT_PORT = 1433;
const DATA_TARGET = PortablePath.make("/var/opt/mssql");
const SQLCMD = "/opt/mssql-tools18/bin/sqlcmd";
const VERSIONS = ["2019", "2022"] as const;
const ARTIFACTS = {
  "2019": "mcr.microsoft.com/mssql/server:2019-latest",
  "2022": "mcr.microsoft.com/mssql/server:2022-latest",
} as const;
const AMD64_HOST_ARCHES = new Set(["x64", "amd64", "x86_64"]);
const ARCH_REMEDIATION =
  "upstream SQL Server images are amd64-only; use an amd64 host or a provider with architecture emulation";

export const MSSQL_FEATURE_ID = "service-lando.mssql";

const appNameFor = (input: { readonly appName?: string | undefined; readonly appRoot: string }): string => {
  if (input.appName !== undefined && input.appName.length > 0) return input.appName;
  return basename(input.appRoot) || "app";
};

const defaultRootPassword = (appName: string, serviceName: string): string =>
  `Lando!${createHash("sha256").update(`${appName}:${serviceName}:root`).digest("hex").slice(0, 24)}`;

const credsFor = (input: ServiceTypeInput): ServiceCreds => {
  const appName = appNameFor(input);
  const authored = input.service.creds;
  return {
    user: authored?.user ?? "lando",
    password: authored?.password ?? "lando",
    database: authored?.database ?? appName,
    rootPassword: authored?.rootPassword ?? defaultRootPassword(appName, input.name),
  };
};

const sqlcmdArgv = (rootPassword: string, query?: string): readonly string[] => {
  const argv = [SQLCMD, "-S", "localhost", "-U", "sa", "-P", rootPassword, "-C"];
  return query === undefined ? argv : [...argv, "-Q", query];
};

const hostRunsMssqlWithoutEmulation = (arch: string): boolean => AMD64_HOST_ARCHES.has(arch);

const applyMssqlFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const appName = appNameFor(ctx);
  const environment = service.environment ?? {};
  const rootPassword =
    environment.SA_PASSWORD ?? service.creds?.rootPassword ?? defaultRootPassword(appName, ctx.serviceName);

  ctx.setArtifact({ kind: "ref", ref: service.image ?? ARTIFACTS["2022"] });
  ctx.addEnv("ACCEPT_EULA", environment.ACCEPT_EULA ?? "Y");
  ctx.addEnv("MSSQL_PID", environment.MSSQL_PID ?? "Developer");
  ctx.addEnv("SA_PASSWORD", rootPassword);
  ctx.addStorage({
    store: `${appName}-mssql-data`,
    target: DATA_TARGET,
    readOnly: false,
  });
  addServicePortEndpoints(ctx, { port: service.port ?? DEFAULT_PORT, protocol: "tcp" });
  ctx.setHealthcheck({
    kind: "command",
    command: [...sqlcmdArgv(rootPassword, "SELECT 1")],
    intervalSeconds: 10,
    timeoutSeconds: 5,
    retries: 5,
    startPeriodSeconds: 30,
  });

  if (service.command !== undefined) ctx.setCommand(service.command);
  if (service.entrypoint !== undefined) ctx.setEntrypoint(service.entrypoint);
  if (service.workingDirectory !== undefined) ctx.setWorkingDirectory(service.workingDirectory);
  if (service.user !== undefined) ctx.setUser(service.user);
};

export const mssqlServiceFeature: ServiceFeatureDefinition = {
  id: MSSQL_FEATURE_ID,
  schema: Schema.Unknown,
  priority: 600,
  apply: (ctx) =>
    Effect.try({
      try: () => applyMssqlFeature(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : "mssql service feature failed to apply",
          feature: MSSQL_FEATURE_ID,
          cause,
        }),
    }),
};

const makeMssqlServiceType = (id: string, image: string): ServiceType => ({
  id,
  name: "mssql",
  base: "lando",
  versions: VERSIONS,
  artifacts: ARTIFACTS,
  schema: MssqlServiceConfig,
  resolve: (input) => {
    const arch = input.host?.arch ?? process.arch;
    if (!hostRunsMssqlWithoutEmulation(arch) && input.capabilities?.architectureEmulation !== true) {
      return Effect.fail(
        new ServiceTypeError({
          message: ARCH_REMEDIATION,
          serviceType: id,
        }),
      );
    }

    const creds = credsFor(input);
    const rootPassword = creds.rootPassword ?? defaultRootPassword(appNameFor(input), input.name);
    return Effect.succeed({
      base: "lando",
      normalizedConfig: {
        ...input.service,
        type: "mssql",
        image: input.service.image ?? image,
        creds,
      },
      features: [{ id: MSSQL_FEATURE_ID }],
      tooling: {
        sqlcmd: {
          service: input.name,
          cmd: [...sqlcmdArgv(rootPassword)],
        },
      },
    });
  },
});

export const mssql2019ServiceType = makeMssqlServiceType("mssql:2019", ARTIFACTS["2019"]);
export const mssql2022ServiceType = makeMssqlServiceType("mssql:2022", ARTIFACTS["2022"]);
export const mssqlServiceType = makeMssqlServiceType("mssql", ARTIFACTS["2022"]);
