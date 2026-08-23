import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { AppFeatureSelectorMatchedNothingError, PhpMyAdminHostsCredsError } from "@lando/sdk/errors";
import { LandofileShape, ServiceConfig, ServiceName } from "@lando/sdk/schema";
import { PhpMyAdminServiceConfig } from "@lando/sdk/schema/services/phpmyadmin";
import type {
  AppFeatureContext,
  AppFeatureServiceMutators,
  AppFeatureServiceView,
  ServiceType,
} from "@lando/sdk/services";

import {
  PHPMYADMIN_FEATURE_ID,
  phpMyAdminWireFeature,
  phpmyadmin5ServiceType,
  phpmyadminLatestServiceType,
  phpmyadminServiceFeature,
  phpmyadminServiceType,
} from "../src/services/phpmyadmin.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-08-19T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const featureOverrides = new Map([[PHPMYADMIN_FEATURE_ID, phpmyadminServiceFeature]]);

const serviceConfig = (serviceDefinition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { pma: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("pma")];
  if (service === undefined) throw new Error("pma service missing");
  return service;
};

const planPhpMyAdminService = async (serviceType: ServiceType, serviceDefinition: Record<string, unknown>) =>
  composeServicePlan({
    serviceType,
    service: serviceConfig(serviceDefinition),
    appRoot: "/srv/apps/myapp",
    appName: "myapp",
    serviceName: "pma",
    metadata,
    featureOverrides,
  });

const resolvePhpMyAdminService = (serviceType: ServiceType, serviceDefinition: Record<string, unknown>) =>
  Effect.runPromise(
    serviceType.resolve({
      name: "pma",
      service: serviceConfig(serviceDefinition),
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      metadata,
    }),
  );

const unusedMutators = {
  addMount: () => undefined,
  setAppMount: () => undefined,
  addBuildStep: () => undefined,
  addStorage: () => undefined,
  addEndpoint: () => undefined,
  addHostAlias: () => undefined,
  setHealthcheck: () => undefined,
  setCerts: () => undefined,
  setEntrypoint: () => undefined,
  setCommand: () => undefined,
  setArtifact: () => undefined,
  setUser: () => undefined,
  setWorkingDirectory: () => undefined,
} satisfies Omit<AppFeatureServiceMutators, "service" | "addEnv" | "addDependency">;

type WireCapture = {
  readonly env: Record<string, string>;
  readonly deps: Array<{ readonly service: string; readonly condition: string; readonly required: boolean }>;
};

const viewOf = (input: {
  readonly serviceName: string;
  readonly serviceType: string;
  readonly hosts?: string | ReadonlyArray<string>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly creds?: { readonly user?: string; readonly password?: string; readonly database?: string };
  readonly healthcheck?: ServiceConfig["healthcheck"];
}): AppFeatureServiceView => ({
  serviceName: input.serviceName,
  serviceType: input.serviceType,
  base: "lando",
  primary: false,
  featureIds: [],
  normalizedConfig: Schema.decodeUnknownSync(ServiceConfig)({
    type: input.serviceType,
    ...(input.hosts === undefined ? {} : { hosts: input.hosts }),
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    ...(input.creds === undefined ? {} : { creds: input.creds }),
    ...(input.healthcheck === undefined ? {} : { healthcheck: input.healthcheck }),
  }),
});

const applyWire = (views: ReadonlyArray<AppFeatureServiceView>) => {
  const captures = new Map<string, WireCapture>();
  for (const view of views) {
    captures.set(view.serviceName, { env: {}, deps: [] });
  }

  const mutatorsFor = (view: AppFeatureServiceView): AppFeatureServiceMutators => {
    const capture = captures.get(view.serviceName);
    if (capture === undefined) throw new Error(`missing capture for ${view.serviceName}`);
    return {
      service: view,
      addEnv: (name, value) => {
        capture.env[name] = value;
      },
      addDependency: (dependency) => {
        capture.deps.push({
          service: dependency.service,
          condition: dependency.condition,
          required: dependency.required,
        });
      },
      ...unusedMutators,
    };
  };

  const context: AppFeatureContext = {
    featureId: phpMyAdminWireFeature.id,
    appName: "myapp",
    appRoot: "/srv/apps/myapp",
    config: {},
    selected: views,
    forEachSelected: (mutate) => {
      for (const view of views) mutate(mutatorsFor(view));
    },
    select: (name) => {
      const view = views.find((candidate) => candidate.serviceName === name);
      return view === undefined ? undefined : mutatorsFor(view);
    },
  };

  return { context, captures };
};

const applyWireExit = (views: ReadonlyArray<AppFeatureServiceView>) => {
  const { context, captures } = applyWire(views);
  return Effect.runPromiseExit(phpMyAdminWireFeature.apply(context)).then((result) => ({ result, captures }));
};

const expectHostsCredsFailure = (result: Awaited<ReturnType<typeof Effect.runPromiseExit>>) => {
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") return;
  expect(result.cause._tag).toBe("Fail");
  if (result.cause._tag !== "Fail") return;
  const error = result.cause.error;
  expect(error).toBeInstanceOf(PhpMyAdminHostsCredsError);
  if (!(error instanceof PhpMyAdminHostsCredsError)) return;
  expect(error._tag).toBe("PhpMyAdminHostsCredsError");
  expect(error.remediation).toContain("creds:");
};

describe("phpmyadmin ServiceType", () => {
  for (const [id, image, serviceType] of [
    ["phpmyadmin:5", "phpmyadmin:5", phpmyadmin5ServiceType],
    ["phpmyadmin:latest", "phpmyadmin:latest", phpmyadminLatestServiceType],
    ["phpmyadmin", "phpmyadmin:latest", phpmyadminServiceType],
  ] as const) {
    describe(id, () => {
      test("plans the catalog defaults", async () => {
        const plan = await planPhpMyAdminService(serviceType, { type: id });

        expect(serviceType.base).toBe("lando");
        expect(serviceType.schema).toBe(PhpMyAdminServiceConfig);
        expect(plan.type).toBe("phpmyadmin");
        expect(plan.artifact).toEqual({ kind: "ref", ref: image });
        expect(plan.endpoints).toEqual([{ _tag: "internal", port: 80, protocol: "http", name: "pma" }]);
        expect(plan.healthcheck).toEqual({
          kind: "command",
          command: ["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/80"],
          intervalSeconds: 10,
          timeoutSeconds: 5,
          retries: 5,
          startPeriodSeconds: 20,
        });
        expect(plan.environment?.PMA_HOST).toBeUndefined();
        expect(plan.environment?.PMA_HOSTS).toBeUndefined();
      });

      test("resolves a default route and enables certs", async () => {
        const resolution = await resolvePhpMyAdminService(serviceType, { type: id });

        expect(resolution.normalizedConfig.routes).toEqual([
          { hostname: "pma.myapp.lndo.site", endpoint: 80 },
        ]);
        expect(resolution.normalizedConfig.certs).toBe(true);
      });

      test("does not discover mysql siblings in resolve", async () => {
        const resolution = await resolvePhpMyAdminService(serviceType, { type: id });

        expect(resolution.normalizedConfig.environment?.PMA_HOSTS).toBeUndefined();
        expect(resolution.normalizedConfig.environment?.PMA_HOST).toBeUndefined();
        expect(resolution.normalizedConfig.dependsOn).toBeUndefined();
      });

      test("authored routes replace the default route", async () => {
        const routes = [{ hostname: "pma.example.test", scheme: "https", endpoint: 80 }] as const;
        const resolution = await resolvePhpMyAdminService(serviceType, { type: id, routes });

        expect(resolution.normalizedConfig.routes).toEqual(routes);
      });

      test("preserves authored runtime overrides", async () => {
        const plan = await planPhpMyAdminService(serviceType, {
          type: id,
          image: "phpmyadmin:custom",
          port: 8080,
          command: ["apache2-foreground"],
          user: "1000:1000",
        });

        expect(plan.artifact).toEqual({ kind: "ref", ref: "phpmyadmin:custom" });
        expect(plan.endpoints).toEqual([{ _tag: "internal", port: 8080, protocol: "http", name: "pma" }]);
        expect(plan.command).toEqual(["apache2-foreground"]);
        expect(plan.user).toBe("1000:1000");
      });
    });
  }

  test("declares supported versions and artifacts", () => {
    expect(phpmyadminServiceType.versions).toEqual(["5", "latest"]);
    expect(phpmyadminServiceType.artifacts).toEqual({
      "5": "phpmyadmin:5",
      latest: "phpmyadmin:latest",
    });
  });
});

describe("phpMyAdmin AppFeature", () => {
  test("wires one mysql sibling with zero-config credentials", async () => {
    const { context, captures } = applyWire([
      viewOf({ serviceName: "pma", serviceType: "phpmyadmin" }),
      viewOf({ serviceName: "database", serviceType: "mysql" }),
    ]);

    await Effect.runPromise(phpMyAdminWireFeature.apply(context));

    expect(captures.get("pma")?.env).toEqual({
      PMA_HOSTS: "database",
      PMA_USER: "lando",
      PMA_PASSWORD: "lando",
    });
    expect(captures.get("pma")?.env.PMA_HOST).toBeUndefined();
    expect(captures.get("pma")?.deps).toEqual([
      { service: "database", condition: "service_started", required: true },
    ]);
    expect(captures.get("database")?.env).toEqual({});
    expect(captures.get("database")?.deps).toEqual([]);
  });

  test("waits for a healthy sibling when that sibling has a healthcheck", async () => {
    const { context, captures } = applyWire([
      viewOf({ serviceName: "pma", serviceType: "phpmyadmin" }),
      viewOf({
        serviceName: "database",
        serviceType: "mysql",
        healthcheck: { kind: "command", command: ["mysqladmin", "ping"] },
      }),
    ]);

    await Effect.runPromise(phpMyAdminWireFeature.apply(context));

    expect(captures.get("pma")?.deps).toEqual([
      { service: "database", condition: "service_healthy", required: true },
    ]);
  });

  test("uses explicit MYSQL_USER and MYSQL_PASSWORD for the single-db case", async () => {
    const { context, captures } = applyWire([
      viewOf({ serviceName: "pma", serviceType: "phpmyadmin" }),
      viewOf({
        serviceName: "database",
        serviceType: "mysql",
        environment: { MYSQL_USER: "alice", MYSQL_PASSWORD: "s3cret" },
      }),
    ]);

    await Effect.runPromise(phpMyAdminWireFeature.apply(context));

    expect(captures.get("pma")?.env).toEqual({
      PMA_HOSTS: "database",
      PMA_USER: "alice",
      PMA_PASSWORD: "s3cret",
    });
  });

  test("prefers authored creds over MYSQL_* environment for the single-db case", async () => {
    const { context, captures } = applyWire([
      viewOf({ serviceName: "pma", serviceType: "phpmyadmin" }),
      viewOf({
        serviceName: "database",
        serviceType: "mysql",
        creds: { user: "dbuser", password: "dbpass", database: "app" },
        environment: { MYSQL_USER: "alice", MYSQL_PASSWORD: "s3cret" },
      }),
    ]);

    await Effect.runPromise(phpMyAdminWireFeature.apply(context));

    expect(captures.get("pma")?.env).toEqual({
      PMA_HOSTS: "database",
      PMA_USER: "dbuser",
      PMA_PASSWORD: "dbpass",
    });
  });

  test("uses MARIADB_USER and MARIADB_PASSWORD when MYSQL_* are absent", async () => {
    const { context, captures } = applyWire([
      viewOf({ serviceName: "pma", serviceType: "phpmyadmin" }),
      viewOf({
        serviceName: "database",
        serviceType: "mariadb",
        environment: { MARIADB_USER: "maria", MARIADB_PASSWORD: "maria-secret" },
      }),
    ]);

    await Effect.runPromise(phpMyAdminWireFeature.apply(context));

    expect(captures.get("pma")?.env).toEqual({
      PMA_HOSTS: "database",
      PMA_USER: "maria",
      PMA_PASSWORD: "maria-secret",
    });
  });

  test("wires mysql and mariadb siblings in stable name order", async () => {
    const { context, captures } = applyWire([
      viewOf({ serviceName: "pma", serviceType: "phpmyadmin" }),
      viewOf({ serviceName: "zdb", serviceType: "mysql" }),
      viewOf({ serviceName: "adb", serviceType: "mariadb" }),
    ]);

    await Effect.runPromise(phpMyAdminWireFeature.apply(context));

    expect(captures.get("pma")?.env.PMA_HOSTS).toBe("adb,zdb");
    expect(captures.get("pma")?.env.PMA_USER).toBe("lando");
    expect(captures.get("pma")?.env.PMA_PASSWORD).toBe("lando");
    expect(captures.get("pma")?.env.PMA_HOST).toBeUndefined();
    expect(captures.get("pma")?.env.PMA_USERS).toBeUndefined();
    expect(captures.get("pma")?.env.PMA_PASSWORDS).toBeUndefined();
    expect(captures.get("pma")?.deps).toEqual([
      { service: "adb", condition: "service_started", required: true },
      { service: "zdb", condition: "service_started", required: true },
    ]);
  });

  test("uses agreed sibling creds when multiple siblings share user and password", async () => {
    const { context, captures } = applyWire([
      viewOf({ serviceName: "pma", serviceType: "phpmyadmin" }),
      viewOf({
        serviceName: "zdb",
        serviceType: "mysql",
        creds: { user: "alice", password: "s3cret", database: "app" },
      }),
      viewOf({
        serviceName: "adb",
        serviceType: "mariadb",
        creds: { user: "alice", password: "s3cret", database: "other" },
      }),
    ]);

    await Effect.runPromise(phpMyAdminWireFeature.apply(context));

    expect(captures.get("pma")?.env).toEqual({
      PMA_HOSTS: "adb,zdb",
      PMA_USER: "alice",
      PMA_PASSWORD: "s3cret",
    });
  });

  test("hosts scalar completely overrides inferred siblings", async () => {
    const { context, captures } = applyWire([
      viewOf({ serviceName: "pma", serviceType: "phpmyadmin", hosts: "remote.example.com" }),
      viewOf({ serviceName: "database", serviceType: "mysql" }),
    ]);

    await Effect.runPromise(phpMyAdminWireFeature.apply(context));

    expect(captures.get("pma")?.env).toEqual({
      PMA_HOSTS: "remote.example.com",
      PMA_USER: "lando",
      PMA_PASSWORD: "lando",
    });
    expect(captures.get("pma")?.deps).toEqual([]);
  });

  test("hosts array completely overrides inferred siblings", async () => {
    const { context, captures } = applyWire([
      viewOf({
        serviceName: "pma",
        serviceType: "phpmyadmin",
        hosts: ["db-a", "db-b"],
        creds: { user: "pmauser", password: "pmapass", database: "pmadb" },
      }),
      viewOf({ serviceName: "database", serviceType: "mysql" }),
    ]);

    await Effect.runPromise(phpMyAdminWireFeature.apply(context));

    expect(captures.get("pma")?.env).toEqual({
      PMA_HOSTS: "db-a,db-b",
      PMA_USER: "pmauser",
      PMA_PASSWORD: "pmapass",
    });
    expect(captures.get("pma")?.deps).toEqual([]);
  });

  test("uses matched sibling creds when hosts names that sibling", async () => {
    const { context, captures } = applyWire([
      viewOf({ serviceName: "pma", serviceType: "phpmyadmin", hosts: "database" }),
      viewOf({
        serviceName: "database",
        serviceType: "mysql",
        creds: { user: "alice", password: "s3cret", database: "app" },
        healthcheck: { kind: "command", command: ["mysqladmin", "ping"] },
      }),
    ]);

    await Effect.runPromise(phpMyAdminWireFeature.apply(context));

    expect(captures.get("pma")?.env).toEqual({
      PMA_HOSTS: "database",
      PMA_USER: "alice",
      PMA_PASSWORD: "s3cret",
    });
    expect(captures.get("pma")?.deps).toEqual([
      { service: "database", condition: "service_healthy", required: true },
    ]);
  });

  test("uses default creds when hosts is unmatched and phpmyadmin has no creds", async () => {
    const { context, captures } = applyWire([
      viewOf({ serviceName: "pma", serviceType: "phpmyadmin", hosts: "remote.example.com" }),
    ]);

    await Effect.runPromise(phpMyAdminWireFeature.apply(context));

    expect(captures.get("pma")?.env).toEqual({
      PMA_HOSTS: "remote.example.com",
      PMA_USER: "lando",
      PMA_PASSWORD: "lando",
    });
    expect(captures.get("pma")?.deps).toEqual([]);
  });

  test("fails tagged when hosts mixes a sibling with an unmatched host and phpmyadmin has no creds", async () => {
    const { result } = await applyWireExit([
      viewOf({ serviceName: "pma", serviceType: "phpmyadmin", hosts: ["database", "remote.example.com"] }),
      viewOf({
        serviceName: "database",
        serviceType: "mysql",
        creds: { user: "alice", password: "s3cret", database: "app" },
      }),
    ]);

    expectHostsCredsFailure(result);
  });

  test("fails tagged when matched sibling creds disagree and phpmyadmin has no creds", async () => {
    const { result } = await applyWireExit([
      viewOf({ serviceName: "pma", serviceType: "phpmyadmin", hosts: ["adb", "zdb"] }),
      viewOf({
        serviceName: "adb",
        serviceType: "mariadb",
        creds: { user: "alice", password: "one", database: "app" },
      }),
      viewOf({
        serviceName: "zdb",
        serviceType: "mysql",
        creds: { user: "bob", password: "two", database: "other" },
      }),
    ]);

    expectHostsCredsFailure(result);
  });

  test("uses phpmyadmin creds when hosts is unmatched", async () => {
    const { context, captures } = applyWire([
      viewOf({
        serviceName: "pma",
        serviceType: "phpmyadmin",
        hosts: "remote.example.com",
        creds: { user: "pmauser", password: "pmapass", database: "pmadb" },
      }),
    ]);

    await Effect.runPromise(phpMyAdminWireFeature.apply(context));

    expect(captures.get("pma")?.env).toEqual({
      PMA_HOSTS: "remote.example.com",
      PMA_USER: "pmauser",
      PMA_PASSWORD: "pmapass",
    });
    expect(captures.get("pma")?.deps).toEqual([]);
  });

  test("fails tagged when no hosts and no mysql or mariadb siblings", async () => {
    const { context } = applyWire([
      viewOf({ serviceName: "pma", serviceType: "phpmyadmin" }),
      viewOf({ serviceName: "appserver", serviceType: "php" }),
    ]);

    const result = await Effect.runPromiseExit(phpMyAdminWireFeature.apply(context));

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.cause._tag).toBe("Fail");
    if (result.cause._tag !== "Fail") return;
    expect(result.cause.error).toBeInstanceOf(AppFeatureSelectorMatchedNothingError);
    expect(result.cause.error._tag).toBe("SelectorMatchedNothing");
    expect(result.cause.error.remediation).toContain("hosts:");
    expect(result.cause.error.remediation).toContain("mysql");
  });
});
