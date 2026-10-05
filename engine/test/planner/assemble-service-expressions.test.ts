import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { ConfigExpressionError } from "@lando/sdk/errors";
import { type LandofileShape, ServiceName } from "@lando/sdk/schema";
import { FileSystem, PluginRegistry, type ServiceType } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Result, Schema } from "effect";
import { planApp } from "../../src/planner/assemble.ts";
import { effectiveToolingForPlan } from "../../src/planner/effective-tooling.ts";
import { serviceCredsScopeForPlan } from "../../src/planner/landofile-scopes.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import { collectAppPlanRedactionTokens } from "../../src/services/app-plan-redaction.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";

/** Publishes creds the way the catalog database types do: defaults, authored `creds:` wins. */
const databaseType: ServiceType = {
  id: "expression-database",
  name: "expression-database",
  base: "l337",
  schema: Schema.Unknown,
  resolve: (input) => {
    const creds = {
      user: "lando",
      password: "s3cret-pw",
      database: "appdb",
      ...input.service.creds,
    };
    return Effect.succeed({
      base: "l337" as const,
      normalizedConfig: {
        ...input.service,
        creds,
        environment: { ...input.service.environment, DB_PASSWORD: creds.password },
      },
      features: [],
    });
  },
};

/**
 * Reads its environment while resolving and copies a value into contributed
 * tooling, the way the RabbitMQ type builds `rabbitmqadmin`. The value must be
 * concrete by then.
 */
const appType: ServiceType = {
  id: "expression-app",
  name: "expression-app",
  base: "l337",
  schema: Schema.Unknown,
  resolve: (input) =>
    Effect.succeed({
      base: "l337" as const,
      normalizedConfig: { ...input.service },
      features: [],
      tooling: {
        dburl: {
          description: "Print the database URL the type saw while resolving.",
          service: input.name,
          cmd: ["echo", input.service.environment?.DATABASE_URL ?? "<none>"],
        },
      },
    }),
};

const serviceTypes = new Map([databaseType, appType].map((type) => [type.id, type]));

const plan = Effect.fnUntraced(
  function* (landofile: LandofileShape, withFileSystem = false) {
    const registry = yield* PluginRegistry;
    const fileSystem = withFileSystem ? yield* FileSystem : undefined;
    return yield* planApp(
      {
        ...registry,
        loadServiceType: (id) => {
          const type = serviceTypes.get(id);
          return type === undefined ? registry.loadServiceType(id) : Effect.succeed(type);
        },
      },
      undefined,
      undefined,
      fileSystem,
      undefined,
      undefined,
      landofile,
      TestRuntimeProvider.capabilities,
    );
  },
  Effect.provide(PluginRegistryLayer.layer),
  Effect.provide(BunFileSystem.layer),
);

const DATABASE_URL =
  "postgresql://{{ services.database.creds.user }}:{{ services.database.creds.password }}@database:5432/{{ services.database.creds.database }}";
const RESOLVED_URL = "postgresql://lando:s3cret-pw@database:5432/appdb";

const withAppRoot = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-service-expression-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const failure = async (landofile: LandofileShape): Promise<ConfigExpressionError> => {
  const result = await Effect.runPromise(plan(landofile).pipe(Effect.result));
  if (!Result.isFailure(result)) throw new Error("Expected a ConfigExpressionError");
  expect(result.failure).toBeInstanceOf(ConfigExpressionError);
  return result.failure as ConfigExpressionError;
};

test("resolves services.<name>.creds.* before the reading service's type runs, whatever the declaration order", () =>
  withAppRoot(async (root) => {
    const landofile = rememberLandofileAppRoot(
      {
        name: "Creds Demo",
        services: {
          // Declared before the database it reads from.
          [ServiceName.make("web")]: {
            type: appType.id,
            home: false as const,
            environment: {
              DATABASE_URL,
              APP_HOST: "{{ app.name }}.{{ proxy.defaultDomain }}",
              DB_LABEL: "{{ app.name }}:{{ services.database.creds.user }}",
            },
          },
          [ServiceName.make("database")]: { type: databaseType.id, home: false as const },
        },
        tooling: {
          psql: { service: "web", cmd: "psql -U {{ services.database.creds.user }}" },
        },
        "x-creds": "{{ services.database.creds.database }}",
      },
      root,
    );
    const app = await Effect.runPromise(plan(landofile));
    expect(Object.keys(app.services)).toEqual(["web", "database"]);
    expect(app.services[ServiceName.make("web")]?.environment).toMatchObject({
      DATABASE_URL: RESOLVED_URL,
      APP_HOST: "creds-demo.lndo.site",
      DB_LABEL: "creds-demo:lando",
    });
    const tooling = effectiveToolingForPlan(app);
    expect(tooling?.psql?.cmd).toBe("psql -U lando");
    // The type saw the resolved value while resolving, so derived tooling is concrete too.
    expect(tooling?.dburl?.cmd).toEqual(["echo", RESOLVED_URL]);
    expect(app.extensions.compose).toMatchObject({ "x-creds": "appdb" });
    expect(landofile.services[ServiceName.make("web")]?.environment?.DATABASE_URL).toBe(DATABASE_URL);
    // The interpolated password stays redactable through the plan's secret-shaped env values.
    expect(collectAppPlanRedactionTokens(app)).toContain("s3cret-pw");
    expect(serviceCredsScopeForPlan(app)).toEqual({
      web: {},
      database: { creds: { user: "lando", password: "s3cret-pw", database: "appdb" } },
    });
  }));

test("lets authored creds: win, including creds derived from another service's", () =>
  withAppRoot(async (root) => {
    const landofile = rememberLandofileAppRoot(
      {
        name: "Creds Demo",
        services: {
          [ServiceName.make("replica")]: {
            type: databaseType.id,
            home: false as const,
            creds: {
              user: "replicator",
              password: "{{ services.primary.creds.password }}",
              database: "{{ app.slug }}-replica",
            },
          },
          [ServiceName.make("primary")]: {
            type: databaseType.id,
            home: false as const,
            creds: { user: "owner", password: "pw-{{ app.slug }}", database: "main" },
          },
          [ServiceName.make("web")]: {
            type: appType.id,
            home: false as const,
            environment: {
              REPLICA_URL:
                "db://{{ services.replica.creds.user }}:{{ services.replica.creds.password }}@replica/{{ services.replica.creds.database }}",
            },
          },
        },
      },
      root,
    );
    const app = await Effect.runPromise(plan(landofile));
    expect(app.services[ServiceName.make("web")]?.environment.REPLICA_URL).toBe(
      "db://replicator:pw-creds-demo@replica/creds-demo-replica",
    );
    expect(app.services[ServiceName.make("replica")]?.environment.DB_PASSWORD).toBe("pw-creds-demo");
  }));

test("fails at the value path when the referenced service does not exist", () =>
  withAppRoot(async (root) => {
    const error = await failure(
      rememberLandofileAppRoot(
        {
          name: "Creds Demo",
          services: {
            [ServiceName.make("web")]: {
              type: appType.id,
              home: false as const,
              environment: { DATABASE_URL: "{{ services.nope.creds.user }}" },
            },
          },
        },
        root,
      ),
    );
    expect(error).toMatchObject({
      _tag: "ConfigExpressionError",
      expression: "{{ services.nope.creds.user }}",
      path: "services.web.environment.DATABASE_URL",
      filePath: `${root}/.lando.yml`,
    });
    expect(error.remediation).toContain("services.<name>.creds.user");
  }));

test("fails when the referenced service publishes no credentials", () =>
  withAppRoot(async (root) => {
    const error = await failure(
      rememberLandofileAppRoot(
        {
          name: "Creds Demo",
          services: {
            [ServiceName.make("web")]: {
              type: appType.id,
              home: false as const,
              environment: { CACHE_PASSWORD: "{{ services.cache.creds.password }}" },
            },
            [ServiceName.make("cache")]: { type: appType.id, home: false as const },
          },
        },
        root,
      ),
    );
    expect(error).toMatchObject({
      path: "services.web.environment.CACHE_PASSWORD",
      expression: "{{ services.cache.creds.password }}",
    });
  }));

test("rejects a service that reads its own credentials and a pair that read each other's", () =>
  withAppRoot(async (root) => {
    const self = await failure(
      rememberLandofileAppRoot(
        {
          name: "Creds Demo",
          services: {
            [ServiceName.make("database")]: {
              type: databaseType.id,
              home: false as const,
              environment: { SELF: "{{ services.database.creds.user }}" },
            },
          },
        },
        root,
      ),
    );
    expect(self).toMatchObject({ path: "services.database", expression: "services.database.creds" });
    expect(self.message).toContain("reads its own credentials");

    const mutual = await failure(
      rememberLandofileAppRoot(
        {
          name: "Creds Demo",
          services: {
            [ServiceName.make("a")]: {
              type: databaseType.id,
              home: false as const,
              creds: { user: "a", password: "{{ services.b.creds.password }}", database: "a" },
            },
            [ServiceName.make("b")]: {
              type: databaseType.id,
              home: false as const,
              creds: { user: "b", password: "{{ services.a.creds.password }}", database: "b" },
            },
          },
        },
        root,
      ),
    );
    expect(mutual).toMatchObject({ path: "services.a" });
    expect(mutual.message).toContain("reference each other's credentials");
  }));

test("requires a literal service name in a services reference", () =>
  withAppRoot(async (root) => {
    const error = await failure(
      rememberLandofileAppRoot(
        {
          name: "Creds Demo",
          services: {
            [ServiceName.make("web")]: {
              type: appType.id,
              home: false as const,
              environment: { USER: "{{ services[app.name].creds.user }}" },
            },
          },
        },
        root,
      ),
    );
    expect(error).toMatchObject({ path: "services.web.environment.USER" });
    expect(error.message).toContain("name the service literally");
  }));

test("keeps a literal credential that happens to contain an expression opener", () =>
  withAppRoot(async (root) => {
    const landofile = rememberLandofileAppRoot(
      {
        name: "Creds Demo",
        services: {
          [ServiceName.make("database")]: {
            type: databaseType.id,
            home: false as const,
            creds: { user: "lando", password: "pw{{literal", database: "appdb" },
          },
          [ServiceName.make("web")]: {
            type: appType.id,
            home: false as const,
            environment: { PW: "{{ services.database.creds.password }}" },
          },
        },
      },
      root,
    );
    const app = await Effect.runPromise(plan(landofile));
    expect(app.services[ServiceName.make("web")]?.environment.PW).toBe("pw{{literal");
  }));

test("never interpolates values that arrive through env files, even when they equal an authored site", () =>
  withAppRoot(async (root) => {
    await writeFile(join(root, "web.env"), `FROM_FILE=${DATABASE_URL}\nAPP_FROM_FILE={{ app.name }}\n`);
    const landofile = rememberLandofileAppRoot(
      {
        name: "Creds Demo",
        services: {
          [ServiceName.make("web")]: {
            type: appType.id,
            home: false as const,
            envFile: ["web.env"],
            environment: { DATABASE_URL },
          },
          [ServiceName.make("database")]: { type: databaseType.id, home: false as const },
        },
      },
      root,
    );
    const app = await Effect.runPromise(plan(landofile, true));
    expect(app.services[ServiceName.make("web")]?.environment).toMatchObject({
      DATABASE_URL: RESOLVED_URL,
      FROM_FILE: DATABASE_URL,
      APP_FROM_FILE: "{{ app.name }}",
    });
  }));

test("treats a value the identity pass produced as data, not as a second expression", () =>
  withAppRoot(async (root) => {
    const previous = process.env.LANDO_TEST_NESTED_EXPRESSION;
    process.env.LANDO_TEST_NESTED_EXPRESSION = "{{ services.database.creds.password }}";
    // Restore a value no test removes rather than deleting the key (see core/AGENTS.md).
    try {
      const landofile = rememberLandofileAppRoot(
        {
          name: "Creds Demo",
          services: {
            [ServiceName.make("web")]: {
              type: appType.id,
              home: false as const,
              environment: {
                FROM_HOST: "{{ env.LANDO_TEST_NESTED_EXPRESSION }}:{{ app.slug }}",
                DIRECT: "{{ services.database.creds.user }}",
              },
            },
            [ServiceName.make("database")]: { type: databaseType.id, home: false as const },
          },
        },
        root,
      );
      const app = await Effect.runPromise(plan(landofile));
      expect(app.services[ServiceName.make("web")]?.environment).toMatchObject({
        FROM_HOST: "{{ services.database.creds.password }}:creds-demo",
        DIRECT: "lando",
      });
    } finally {
      process.env.LANDO_TEST_NESTED_EXPRESSION = previous ?? "";
    }
  }));
