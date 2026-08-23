import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { ServiceTypeError } from "@lando/sdk/errors";
import { LandofileShape, type ProviderCapabilities, ServiceName } from "@lando/sdk/schema";
import { MssqlServiceConfig } from "@lando/sdk/schema/services/mssql";
import type { ServiceType, ServiceTypeHostFacts } from "@lando/sdk/services";

import {
  MSSQL_FEATURE_ID,
  mssql2019ServiceType,
  mssql2022ServiceType,
  mssqlServiceFeature,
  mssqlServiceType,
} from "../src/services/mssql.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-08-20T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const featureOverrides = new Map([[MSSQL_FEATURE_ID, mssqlServiceFeature]]);

const SQLCMD = "/opt/mssql-tools18/bin/sqlcmd";
const ARCH_REMEDIATION =
  "upstream SQL Server images are amd64-only; use an amd64 host or a provider with architecture emulation";

const defaultRootPassword = (appName: string, serviceName: string): string =>
  `Lando!${createHash("sha256").update(`${appName}:${serviceName}:root`).digest("hex").slice(0, 24)}`;

const hostFacts = (arch: string): ServiceTypeHostFacts => ({
  os: "linux",
  user: "lando",
  uid: "1000",
  gid: "1000",
  home: "/home/lando",
  arch,
});

const providerCapabilities = (architectureEmulation: boolean): ProviderCapabilities => ({
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceLogSources: true,
  serviceHealth: "none",
  hostReachability: "none",
  sharedCrossAppNetwork: false,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: false,
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none",
  serviceFileCopy: "none",
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
  hostPortPublish: "none",
  routeProvider: false,
  tlsCertificates: "none",
  rootless: true,
  privilegedServices: false,
  architectureEmulation,
  composeSpec: "none",
  providerExtensions: [],
});

const serviceConfig = (serviceDefinition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { database: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("database")];
  if (service === undefined) throw new Error("database service missing");
  return service;
};

const planMssqlService = async (serviceType: ServiceType, serviceDefinition: Record<string, unknown>) =>
  composeServicePlan({
    serviceType,
    service: serviceConfig(serviceDefinition),
    appRoot: "/srv/apps/myapp",
    appName: "myapp",
    serviceName: "database",
    metadata,
    host: hostFacts("x64"),
    featureOverrides,
  });

const resolveMssqlService = (
  serviceType: ServiceType,
  serviceDefinition: Record<string, unknown>,
  host: ServiceTypeHostFacts = hostFacts("x64"),
  capabilities?: ProviderCapabilities,
) =>
  Effect.runPromise(
    serviceType.resolve({
      name: "database",
      service: serviceConfig(serviceDefinition),
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      metadata,
      host,
      ...(capabilities === undefined ? {} : { capabilities }),
    }),
  );

describe("mssql ServiceType", () => {
  for (const [id, image, serviceType] of [
    ["mssql:2019", "mcr.microsoft.com/mssql/server:2019-latest", mssql2019ServiceType],
    ["mssql:2022", "mcr.microsoft.com/mssql/server:2022-latest", mssql2022ServiceType],
    ["mssql", "mcr.microsoft.com/mssql/server:2022-latest", mssqlServiceType],
  ] as const) {
    describe(id, () => {
      test("plans the catalog defaults", async () => {
        const plan = await planMssqlService(serviceType, { type: id });
        const rootPassword = defaultRootPassword("myapp", "database");

        expect(serviceType.id).toBe(id);
        expect(serviceType.base).toBe("lando");
        expect(serviceType.schema).toBe(MssqlServiceConfig);
        expect(plan.type).toBe("mssql");
        expect(plan.artifact).toEqual({ kind: "ref", ref: image });
        expect(plan.endpoints).toEqual([{ _tag: "internal", port: 1433, protocol: "tcp", name: "database" }]);
        expect(plan.storage).toHaveLength(1);
        expect(plan.storage[0]?.store).toBe("myapp-mssql-data");
        expect(String(plan.storage[0]?.target)).toBe("/var/opt/mssql");
        expect(plan.storage[0]?.readOnly).toBe(false);
        expect(plan.environment).toMatchObject({
          ACCEPT_EULA: "Y",
          MSSQL_PID: "Developer",
          SA_PASSWORD: rootPassword,
        });
        expect(plan.environment.MSSQL_SA_PASSWORD).toBeUndefined();
        expect(plan.environment.LANDO_DB_USER).toBe("lando");
        expect(plan.environment.LANDO_DB_PASSWORD).toBe("lando");
        expect(plan.environment.LANDO_DB_NAME).toBe("myapp");
        expect(plan.environment.LANDO_DB_ROOT_PASSWORD).toBe(rootPassword);
        expect(plan.healthcheck).toEqual({
          kind: "command",
          command: [SQLCMD, "-S", "localhost", "-U", "sa", "-P", rootPassword, "-C", "-Q", "SELECT 1"],
          intervalSeconds: 10,
          timeoutSeconds: 5,
          retries: 5,
          startPeriodSeconds: 30,
        });
      });

      test("resolves default creds and sqlcmd tooling as literal argv", async () => {
        const resolution = await resolveMssqlService(serviceType, { type: id });
        const rootPassword = defaultRootPassword("myapp", "database");

        expect(resolution.normalizedConfig.creds).toEqual({
          user: "lando",
          password: "lando",
          database: "myapp",
          rootPassword,
        });
        expect(resolution.tooling).toEqual({
          sqlcmd: {
            service: "database",
            cmd: [SQLCMD, "-S", "localhost", "-U", "sa", "-C"],
            env: { SQLCMDPASSWORD: rootPassword },
          },
        });
        expect(resolution.normalizedConfig.environment?.LANDO_DB_USER).toBeUndefined();
        expect(resolution.normalizedConfig.environment?.LANDO_DB_PASSWORD).toBeUndefined();
        expect(resolution.normalizedConfig.environment?.LANDO_DB_NAME).toBeUndefined();
        expect(resolution.normalizedConfig.environment?.LANDO_DB_ROOT_PASSWORD).toBeUndefined();
      });

      test("authored creds win over defaults", async () => {
        const creds = {
          user: "appuser",
          password: "app-secret",
          database: "appdb",
          rootPassword: "pa'ss; rm -rf /",
        };
        const plan = await planMssqlService(serviceType, { type: id, creds });
        const resolution = await resolveMssqlService(serviceType, { type: id, creds });

        expect(plan.environment.SA_PASSWORD).toBe(creds.rootPassword);
        expect(plan.environment.LANDO_DB_USER).toBe(creds.user);
        expect(plan.environment.LANDO_DB_PASSWORD).toBe(creds.password);
        expect(plan.environment.LANDO_DB_NAME).toBe(creds.database);
        expect(plan.environment.LANDO_DB_ROOT_PASSWORD).toBe(creds.rootPassword);
        expect(resolution.normalizedConfig.creds).toEqual(creds);
        expect(resolution.tooling?.sqlcmd).toEqual({
          service: "database",
          cmd: [SQLCMD, "-S", "localhost", "-U", "sa", "-C"],
          env: { SQLCMDPASSWORD: creds.rootPassword },
        });
        expect(plan.healthcheck?.command).toEqual([
          SQLCMD,
          "-S",
          "localhost",
          "-U",
          "sa",
          "-P",
          creds.rootPassword,
          "-C",
          "-Q",
          "SELECT 1",
        ]);
      });

      test("SA_PASSWORD environment drives sqlcmd tooling and healthcheck", async () => {
        const saPassword = "Env!sa-password-123";
        const plan = await planMssqlService(serviceType, {
          type: id,
          environment: { SA_PASSWORD: saPassword },
        });
        const resolution = await resolveMssqlService(serviceType, {
          type: id,
          environment: { SA_PASSWORD: saPassword },
        });

        expect(plan.environment.SA_PASSWORD).toBe(saPassword);
        expect(resolution.normalizedConfig.creds?.rootPassword).toBe(saPassword);
        expect(resolution.tooling?.sqlcmd).toEqual({
          service: "database",
          cmd: [SQLCMD, "-S", "localhost", "-U", "sa", "-C"],
          env: { SQLCMDPASSWORD: saPassword },
        });
        expect(plan.healthcheck?.command).toEqual([
          SQLCMD,
          "-S",
          "localhost",
          "-U",
          "sa",
          "-P",
          saPassword,
          "-C",
          "-Q",
          "SELECT 1",
        ]);
      });

      test("authored environment overrides MSSQL_PID", async () => {
        const plan = await planMssqlService(serviceType, {
          type: id,
          environment: { MSSQL_PID: "Express" },
        });

        expect(plan.environment).toMatchObject({
          ACCEPT_EULA: "Y",
          MSSQL_PID: "Express",
        });
      });

      test("preserves authored runtime overrides", async () => {
        const plan = await planMssqlService(serviceType, {
          type: id,
          image: "mcr.microsoft.com/mssql/server:custom",
          port: 14333,
          command: ["/opt/mssql/bin/sqlservr"],
          user: "1000:1000",
        });

        expect(plan.artifact).toEqual({ kind: "ref", ref: "mcr.microsoft.com/mssql/server:custom" });
        expect(plan.endpoints).toEqual([
          { _tag: "internal", port: 14333, protocol: "tcp", name: "database" },
        ]);
        expect(plan.command).toEqual(["/opt/mssql/bin/sqlservr"]);
        expect(plan.user).toBe("1000:1000");
      });
    });
  }

  test("declares supported versions and artifacts", () => {
    expect(mssqlServiceType.versions).toEqual(["2019", "2022"]);
    expect(mssqlServiceType.artifacts).toEqual({
      "2019": "mcr.microsoft.com/mssql/server:2019-latest",
      "2022": "mcr.microsoft.com/mssql/server:2022-latest",
    });
  });

  test("x64 host.arch succeeds without emulation", async () => {
    const resolution = await resolveMssqlService(mssqlServiceType, { type: "mssql" }, hostFacts("x64"));
    expect(resolution.base).toBe("lando");
  });

  test("amd64 host.arch succeeds without emulation", async () => {
    const resolution = await resolveMssqlService(mssqlServiceType, { type: "mssql" }, hostFacts("amd64"));
    expect(resolution.base).toBe("lando");
  });

  test("x86_64 host.arch succeeds without emulation", async () => {
    const resolution = await resolveMssqlService(mssqlServiceType, { type: "mssql" }, hostFacts("x86_64"));
    expect(resolution.base).toBe("lando");
  });

  test("arm64 succeeds when architectureEmulation is true", async () => {
    const resolution = await resolveMssqlService(
      mssqlServiceType,
      { type: "mssql" },
      hostFacts("arm64"),
      providerCapabilities(true),
    );
    expect(resolution.base).toBe("lando");
  });

  test("arm64 without emulation fails closed in resolve", async () => {
    const result = await Effect.runPromise(
      mssqlServiceType
        .resolve({
          name: "database",
          service: serviceConfig({ type: "mssql" }),
          appRoot: "/srv/apps/myapp",
          appName: "myapp",
          metadata,
          host: hostFacts("arm64"),
        })
        .pipe(Effect.either),
    );

    expect(result._tag).toBe("Left");
    if (result._tag !== "Left") throw new Error("expected arm64 without emulation to fail");
    expect(result.left).toBeInstanceOf(ServiceTypeError);
    expect(result.left.message).toContain(ARCH_REMEDIATION);
  });

  test("arm64 with architectureEmulation false fails closed in resolve", async () => {
    const result = await Effect.runPromise(
      mssqlServiceType
        .resolve({
          name: "database",
          service: serviceConfig({ type: "mssql" }),
          appRoot: "/srv/apps/myapp",
          appName: "myapp",
          metadata,
          host: hostFacts("arm64"),
          capabilities: providerCapabilities(false),
        })
        .pipe(Effect.either),
    );

    expect(result._tag).toBe("Left");
    if (result._tag !== "Left") throw new Error("expected arm64 without emulation to fail");
    expect(result.left).toBeInstanceOf(ServiceTypeError);
    expect(result.left.message).toContain(ARCH_REMEDIATION);
  });
});
