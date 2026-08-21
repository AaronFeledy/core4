import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { LandofileShape, ServiceConfig, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type {
  AppFeatureContext,
  AppFeatureServiceMutators,
  AppFeatureServiceView,
  ServiceBuildStepIntent,
  ServiceType,
} from "@lando/sdk/services";

import {
  PHP_DB_CLIENT_FEATURE_ID,
  PHP_DB_CLIENT_REMEDIATION,
  PHP_MONGOSH_RELEASE,
  detectPhpDbClients,
  phpDbClientBuildSteps,
  phpDbClientFeature,
  resolvePhpDbClient,
} from "../src/services/php-db-client.ts";
import { PHP_FEATURE_ID, php82ServiceType, phpServiceFeature } from "../src/services/php.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const BuildSteps = Schema.Struct({
  buildSteps: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        command: Schema.Unknown,
        phase: Schema.optional(Schema.String),
        dependsOn: Schema.optional(Schema.Array(Schema.String)),
        buildKeyInputs: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
      }),
    ),
  ),
});

const metadata = {
  resolvedAt: "2026-08-21T00:00:00Z",
  source: "/srv/apps/php-db-client/.lando.yml",
  runtime: 4 as const,
};

const composePhpPlan = (
  overrides: Record<string, unknown> = {},
  serviceType: ServiceType = php82ServiceType,
) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "php-db-client",
    services: { web: { type: serviceType.id, ...overrides } },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return composeServicePlan({
    serviceType,
    service,
    appRoot: "/srv/apps/php-db-client",
    appName: "php-db-client",
    serviceName: "web",
    metadata,
    featureOverrides: new Map([[PHP_FEATURE_ID, phpServiceFeature]]),
  });
};

const resolvePhp = (overrides: Record<string, unknown> = {}, serviceType: ServiceType = php82ServiceType) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "php-db-client",
    services: { web: { type: serviceType.id, ...overrides } },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return Effect.runPromise(
    serviceType.resolve({
      name: "web",
      service,
      appRoot: "/srv/apps/php-db-client",
      appName: "php-db-client",
      metadata,
    }),
  );
};

const buildStepsFor = (plan: ServicePlan) =>
  Schema.decodeUnknownSync(BuildSteps)(plan.extensions["@lando/core/service-features"]).buildSteps ?? [];

const expectRejectsToThrow = async (promise: Promise<unknown>, pattern: RegExp): Promise<void> => {
  let rejected = false;
  await promise.then(
    () => undefined,
    (error: unknown) => {
      rejected = true;
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(pattern);
    },
  );
  expect(rejected).toBe(true);
};

const unusedMutators = {
  addEnv: () => undefined,
  addMount: () => undefined,
  setAppMount: () => undefined,
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
  addDependency: () => undefined,
} satisfies Omit<AppFeatureServiceMutators, "service" | "addBuildStep">;

const viewOf = (input: {
  readonly serviceName: string;
  readonly serviceType: string;
  readonly featureIds?: ReadonlyArray<string>;
  readonly image?: string;
  readonly db_client?: unknown;
}): AppFeatureServiceView => ({
  serviceName: input.serviceName,
  serviceType: input.serviceType,
  base: "lando",
  primary: false,
  featureIds: input.featureIds ?? [],
  normalizedConfig: Schema.decodeUnknownSync(ServiceConfig)({
    type: input.serviceType,
    ...(input.image === undefined ? {} : { image: input.image }),
    ...(input.db_client === undefined ? {} : { db_client: input.db_client }),
  }),
});

const applyFeature = (views: ReadonlyArray<AppFeatureServiceView>) => {
  const steps = new Map<string, Array<ServiceBuildStepIntent>>();
  for (const view of views) steps.set(view.serviceName, []);
  const mutatorsFor = (view: AppFeatureServiceView): AppFeatureServiceMutators => ({
    service: view,
    addBuildStep: (step) => {
      steps.get(view.serviceName)?.push(step);
    },
    ...unusedMutators,
  });
  const context: AppFeatureContext = {
    featureId: phpDbClientFeature.id,
    appName: "php-db-client",
    appRoot: "/srv/apps/php-db-client",
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
  Effect.runSync(phpDbClientFeature.apply(context));
  return steps;
};

describe("PHP db_client option", () => {
  test("Given omitted db_client, when resolving, then it selects auto", () => {
    expect(resolvePhpDbClient(undefined)).toEqual({ mode: "auto" });
  });

  test("Given db_client auto, when resolving, then it selects auto", () => {
    expect(resolvePhpDbClient("auto")).toEqual({ mode: "auto" });
  });

  test("Given db_client false, when resolving, then it disables clients", () => {
    expect(resolvePhpDbClient(false)).toEqual({ mode: "disabled" });
  });

  test("Given every supported explicit family version, when resolving, then it selects that client", () => {
    expect(resolvePhpDbClient("mariadb:11.4")).toEqual({
      mode: "explicit",
      family: "mariadb",
      version: "11.4",
    });
    expect(resolvePhpDbClient("mysql:8.0")).toEqual({ mode: "explicit", family: "mysql", version: "8.0" });
    expect(resolvePhpDbClient("postgres:16")).toEqual({
      mode: "explicit",
      family: "postgres",
      version: "16",
    });
    expect(resolvePhpDbClient("mongodb:7")).toEqual({ mode: "explicit", family: "mongodb", version: "7" });
  });

  test("Given an unknown db_client, when resolving the PHP service, then it fails closed with remediation", async () => {
    await expectRejectsToThrow(resolvePhp({ db_client: "nope" }), /Unsupported database client/);
    await expectRejectsToThrow(
      resolvePhp({ db_client: "nope" }),
      new RegExp(PHP_DB_CLIENT_REMEDIATION.replaceAll("|", "\\|")),
    );
  });

  test("Given invalid db_client on a custom image, when resolving, then it still fails closed", async () => {
    await expectRejectsToThrow(
      resolvePhp({ image: "php:8.2-apache-bookworm", db_client: "oracle:19" }),
      /Unsupported database client/,
    );
  });

  test("Given mysql mariadb postgres and mongodb siblings, when detecting, then it installs one sorted client per family", () => {
    const detected = detectPhpDbClients([
      viewOf({ serviceName: "sql", serviceType: "mysql" }),
      viewOf({ serviceName: "maria", serviceType: "mariadb" }),
      viewOf({ serviceName: "pg", serviceType: "postgres" }),
      viewOf({ serviceName: "mongo", serviceType: "mongodb" }),
      viewOf({ serviceName: "sql2", serviceType: "mysql" }),
      viewOf({ serviceName: "mssql", serviceType: "mssql" }),
    ]);
    expect(detected.map((entry) => entry.family)).toEqual(["mariadb", "mongodb", "mysql", "postgres"]);
  });

  test("Given duplicate families at different versions, when detecting, then it keeps the highest supported version", () => {
    const detected = detectPhpDbClients([
      viewOf({ serviceName: "old", serviceType: "mariadb:10.6" }),
      viewOf({ serviceName: "new", serviceType: "mariadb:11.4" }),
    ]);
    expect(detected).toEqual([{ family: "mariadb", version: "11.4" }]);
  });

  test("Given mssql only, when detecting, then it installs nothing", () => {
    expect(detectPhpDbClients([viewOf({ serviceName: "db", serviceType: "mssql" })])).toEqual([]);
  });

  test("Given auto with database siblings, when the AppFeature applies, then PHP receives sorted db-client build steps", () => {
    const steps = applyFeature([
      viewOf({
        serviceName: "web",
        serviceType: "php:8.2",
        featureIds: [PHP_FEATURE_ID],
        db_client: "auto",
      }),
      viewOf({ serviceName: "db", serviceType: "mysql" }),
      viewOf({ serviceName: "pg", serviceType: "postgres" }),
      viewOf({ serviceName: "mssql", serviceType: "mssql" }),
    ]);
    const ids = (steps.get("web") ?? []).map((step) => step.id);
    expect(ids).toEqual(["service-lando.php:db-client:mysql", "service-lando.php:db-client:postgres"]);
    expect(steps.get("db")).toEqual([]);
  });

  test("Given db_client false, when the AppFeature applies, then it adds no db-client steps", () => {
    const steps = applyFeature([
      viewOf({
        serviceName: "web",
        serviceType: "php:8.2",
        featureIds: [PHP_FEATURE_ID],
        db_client: false,
      }),
      viewOf({ serviceName: "db", serviceType: "mysql" }),
    ]);
    expect(steps.get("web")).toEqual([]);
  });

  test("Given an explicit client without siblings, when the AppFeature applies, then it still installs that client", () => {
    const steps = applyFeature([
      viewOf({
        serviceName: "web",
        serviceType: "php:8.2",
        featureIds: [PHP_FEATURE_ID],
        db_client: "mariadb:11.4",
      }),
      viewOf({ serviceName: "cache", serviceType: "redis" }),
    ]);
    const installed = steps.get("web") ?? [];
    expect(installed).toHaveLength(1);
    expect(installed[0]?.id).toBe("service-lando.php:db-client:mariadb");
    expect(String(installed[0]?.command)).toContain("mariadb-client");
    expect(String(installed[0]?.command)).toContain("DEBIAN_FRONTEND=noninteractive");
    expect(String(installed[0]?.command)).not.toMatch(/[\r\n]/);
  });

  test("Given a custom image, when the AppFeature applies, then it skips install for valid auto and explicit values", () => {
    const autoSteps = applyFeature([
      viewOf({
        serviceName: "web",
        serviceType: "php:8.2",
        featureIds: [PHP_FEATURE_ID],
        image: "php:8.2-apache-bookworm",
        db_client: "auto",
      }),
      viewOf({ serviceName: "db", serviceType: "mysql" }),
    ]);
    const explicitSteps = applyFeature([
      viewOf({
        serviceName: "web",
        serviceType: "php:8.2",
        featureIds: [PHP_FEATURE_ID],
        image: "php:8.2-apache-bookworm",
        db_client: "postgres:16",
      }),
    ]);
    expect(autoSteps.get("web")).toEqual([]);
    expect(explicitSteps.get("web")).toEqual([]);
  });

  test("Given generated client steps, when inspecting commands, then they are single-line signed installs with build-key identity", () => {
    const [mysql, mongo] = phpDbClientBuildSteps([
      { family: "mysql", version: "8.4" },
      { family: "mongodb", version: "7" },
    ]);
    expect(mysql?.id).toBe("service-lando.php:db-client:mysql");
    expect(mysql?.phase).toBe("build");
    expect(mysql?.dependsOn).toEqual(["service-lando.php:prerequisites"]);
    expect(String(mysql?.command)).toContain("mysql-community-client");
    expect(String(mysql?.command)).toContain("mysql-8.4-lts");
    expect(String(mysql?.command)).not.toMatch(/[\r\n]/);
    expect(mysql?.buildKeyInputs).toMatchObject({
      dbClient: {
        family: "mysql",
        version: "8.4",
        source: { kind: "apt", package: "mysql-community-client" },
      },
    });

    expect(mongo?.id).toBe("service-lando.php:db-client:mongodb");
    expect(String(mongo?.command)).toContain(PHP_MONGOSH_RELEASE.artifacts.amd64.sha256);
    expect(String(mongo?.command)).toContain(PHP_MONGOSH_RELEASE.artifacts.arm64.url);
    expect(String(mongo?.command)).not.toMatch(/[\r\n]/);
    expect(mongo?.buildKeyInputs).toMatchObject({
      dbClient: {
        family: "mongodb",
        version: "7",
        source: { kind: "archive", packageVersion: PHP_MONGOSH_RELEASE.version },
      },
    });
  });

  test("Given different requested versions, when building steps, then buildKeyInputs change", () => {
    const [left] = phpDbClientBuildSteps([{ family: "postgres", version: "15" }]);
    const [right] = phpDbClientBuildSteps([{ family: "postgres", version: "16" }]);
    expect(left?.buildKeyInputs).not.toEqual(right?.buildKeyInputs);
    expect(String(left?.command)).toContain("postgresql-client-15");
    expect(String(right?.command)).toContain("postgresql-client-16");
  });

  test("Given stock PHP planning without AppFeature, when composing a single service, then it does not invent db-client steps", async () => {
    const plan = await composePhpPlan();
    expect(buildStepsFor(plan).map((step) => step.id)).not.toContain("service-lando.php:db-client:mysql");
  });

  test("the AppFeature id is the registered contribution", () => {
    expect(phpDbClientFeature.id).toBe(PHP_DB_CLIENT_FEATURE_ID);
    expect(phpDbClientFeature.activatedBy).toEqual({ services: { hasFeature: PHP_FEATURE_ID } });
    expect(phpDbClientFeature.selectors).toEqual({
      hasFeature: [PHP_FEATURE_ID],
      types: ["mariadb", "mongodb", "mysql", "postgres"],
    });
  });
});
