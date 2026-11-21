import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planRedactionValues } from "@lando/redaction/plan-values";
import { ConfigExpressionError } from "@lando/sdk/errors";
import { type LandofileShape, PortNumber, ServiceName } from "@lando/sdk/schema";
import {
  FileSystem,
  PluginRegistry,
  type ServiceFeatureDefinition,
  type ServiceType,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Result, Schema } from "effect";
import { effectiveToolingForPlan } from "../../src/planner/effective-tooling.ts";
import { serviceCredsScopeForPlan } from "../../src/planner/landofile-scopes.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { compileTestLandofile } from "../compiled-landofile.ts";
import { planApp } from "../plan-app.ts";
import { appRootOf, withAppRoot as withAppRootProvenance } from "../provenance-support.ts";

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
      features: [{ id: "expression-database.creds" }],
      connection: { family: "postgres", port: PortNumber.make(5432), creds },
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
    Effect.sync(() => {
      const url = input.service.environment?.DATABASE_URL ?? "<none>";
      if (typeof url !== "string") throw new TypeError("This fixture expects a literal URL");
      return {
        base: "l337" as const,
        normalizedConfig: { ...input.service },
        features: [],
        tooling: {
          dburl: {
            description: "Print the database URL the type saw while resolving.",
            service: input.name,
            cmd: ["echo", url],
          },
        },
      };
    }),
};

const serviceTypes = new Map([databaseType, appType].map((type) => [type.id, type]));
const credentialFeature: ServiceFeatureDefinition = {
  id: "expression-database.creds",
  schema: Schema.Unknown,
  priority: 600,
  validateEffective: () => Effect.succeed({ handledServiceFields: ["creds"] }),
  apply: () => Effect.void,
};

const plan = Effect.fnUntraced(
  function* (landofile: LandofileShape, withFileSystem = false, kind: "user" | "global" = "user") {
    const registry = yield* PluginRegistry;
    const fileSystem = withFileSystem ? yield* FileSystem : undefined;
    return yield* planApp(
      {
        landofile: yield* compileTestLandofile(landofile, appRootOf(landofile) ?? process.cwd()),
        providerCapabilities: TestRuntimeProvider.capabilities,
        kind,
      },
      Layer.mergeAll(
        Layer.succeed(PluginRegistry, {
          ...registry,
          loadServiceType: (id) => {
            const type = serviceTypes.get(id);
            return type === undefined ? registry.loadServiceType(id) : Effect.succeed(type);
          },
          loadServiceFeature: (id) =>
            id === credentialFeature.id ? Effect.succeed(credentialFeature) : registry.loadServiceFeature(id),
        }),
        fileSystem === undefined ? Layer.empty : Layer.succeed(FileSystem, fileSystem),
      ),
    );
  },
  Effect.provide(PluginRegistryLayer.layer),
  Effect.provide(BunFileSystem.layer),
);

const DATABASE_URL =
  "postgresql://{{ services.database.creds.user }}:{{ services.database.creds.password }}@database:5432/{{ services.database.creds.database }}";

const urlApp = (root: string, hostname?: string, enabled = true) =>
  withAppRootProvenance(
    {
      name: "Public URLs",
      router: { enabled },
      services: {
        [ServiceName.make("web")]: {
          type: "compose",
          image: "nginx:alpine",
          home: false as const,
          environment: { APP_URL: "{{ service.url }}", PEER: "{{ services.peer.url }}" },
        },
        [ServiceName.make("peer")]: {
          type: "compose",
          image: "nginx:alpine",
          home: false as const,
          environment: { PEER: "{{ services.web.url }}" },
        },
      },
      proxy: {
        [ServiceName.make("web")]: hostname === undefined ? [] : [`${hostname}:80`],
        [ServiceName.make("peer")]: ["peer.test:80"],
      },
    },
    root,
  );

test("plans mutually referencing and self-referencing service URLs without credential cycles", () =>
  withAppRoot(async (root) => {
    const app = await Effect.runPromise(plan(urlApp(root, "web.test")));
    expect(app.services[ServiceName.make("web")]?.environment).toMatchObject({
      APP_URL: { _tag: "RouteText", parts: [{ service: "web", encoding: "raw" }] },
      PEER: { _tag: "RouteText", parts: [{ service: "peer", encoding: "raw" }] },
    });
    expect(app.services[ServiceName.make("peer")]?.environment.PEER).toEqual({
      _tag: "RouteText",
      parts: [{ service: "web", encoding: "raw" }],
    });
  }));

test.each([
  { kind: "user", enabled: true, reason: /no route/ },
  { kind: "user", hostname: "*.test", enabled: true, reason: /wildcard/ },
  { kind: "user", hostname: "web.test", enabled: false, reason: /disabled/ },
  { kind: "global", hostname: "web.test", enabled: true, reason: /global/ },
] as const)("locates unavailable public URL bindings ($reason)", (row) =>
  withAppRoot(async (root) => {
    const result = await Effect.runPromise(
      plan(urlApp(root, "hostname" in row ? row.hostname : undefined, row.enabled), false, row.kind).pipe(
        Effect.result,
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "ConfigExpressionError",
        path: ["services", "web", "environment", "APP_URL"],
        filePath: expect.stringContaining(".lando.yml"),
        message: expect.stringMatching(row.reason),
      },
    });
  }),
);
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
  if (!(result.failure instanceof ConfigExpressionError)) throw result.failure;
  return result.failure;
};

test("rejects a boolean result in the deferred service-credential pass", () =>
  withAppRoot(async (root) => {
    // Given
    const landofile = withAppRootProvenance(
      {
        name: "typed",
        services: {
          [ServiceName.make("database")]: { type: databaseType.id, image: "alpine:3.22" },
          [ServiceName.make("web")]: {
            type: appType.id,
            image: "alpine:3.22",
            framework: "{{ eq(services.database.creds.user, 'lando') }}",
          },
        },
      },
      root,
    );
    // When
    const error = await failure(landofile);
    // Then
    expect(error).toMatchObject({
      _tag: "ConfigExpressionError",
      path: ["services", "web", "framework"],
      expression: "{{ eq(services.database.creds.user, 'lando') }}",
      remediation: expect.stringMatching(/\S/),
    });
  }));

test("resolves services.<name>.creds.* before the reading service's type runs, whatever the declaration order", () =>
  withAppRoot(async (root) => {
    const landofile = withAppRootProvenance(
      {
        name: "Creds Demo",
        services: {
          // Declared before the database it reads from.
          [ServiceName.make("web")]: {
            type: appType.id,
            image: "alpine:3.22",
            home: false as const,
            environment: {
              DATABASE_URL,
              APP_HOST: "{{ app.name }}.{{ proxy.defaultDomain }}",
              DB_LABEL: "{{ app.name }}:{{ services.database.creds.user }}",
            },
          },
          [ServiceName.make("database")]: {
            type: databaseType.id,
            image: "alpine:3.22",
            home: false as const,
          },
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
    expect(planRedactionValues(app).substring).toContain("s3cret-pw");
    expect(serviceCredsScopeForPlan(app)).toEqual({
      web: { url: { _tag: "RouteText", parts: [{ service: "web", encoding: "raw" }] } },
      database: {
        url: { _tag: "RouteText", parts: [{ service: "database", encoding: "raw" }] },
        port: PortNumber.make(5432),
        creds: { user: "lando", password: "s3cret-pw", database: "appdb" },
      },
    });
  }));

test("lets authored creds: win, including creds derived from another service's", () =>
  withAppRoot(async (root) => {
    const landofile = withAppRootProvenance(
      {
        name: "Creds Demo",
        services: {
          [ServiceName.make("replica")]: {
            type: databaseType.id,
            image: "alpine:3.22",
            home: false as const,
            creds: {
              user: "replicator",
              password: "{{ services.primary.creds.password }}",
              database: "{{ app.slug }}-replica",
            },
          },
          [ServiceName.make("primary")]: {
            type: databaseType.id,
            image: "alpine:3.22",
            home: false as const,
            creds: { user: "owner", password: "pw-{{ app.slug }}", database: "main" },
          },
          [ServiceName.make("web")]: {
            type: appType.id,
            image: "alpine:3.22",
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
      withAppRootProvenance(
        {
          name: "Creds Demo",
          services: {
            [ServiceName.make("web")]: {
              type: appType.id,
              image: "alpine:3.22",
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
      path: ["services", "web", "environment", "DATABASE_URL"],
      filePath: `${root}/.lando.yml`,
    });
    expect(error.remediation).toContain("context values");
  }));

test("fails when the referenced service publishes no credentials", () =>
  withAppRoot(async (root) => {
    const error = await failure(
      withAppRootProvenance(
        {
          name: "Creds Demo",
          services: {
            [ServiceName.make("web")]: {
              type: appType.id,
              image: "alpine:3.22",
              home: false as const,
              environment: { CACHE_PASSWORD: "{{ services.cache.creds.password }}" },
            },
            [ServiceName.make("cache")]: { type: appType.id, image: "alpine:3.22", home: false as const },
          },
        },
        root,
      ),
    );
    expect(error).toMatchObject({
      path: ["services", "web", "environment", "CACHE_PASSWORD"],
      expression: "{{ services.cache.creds.password }}",
    });
  }));

test("requires a literal service name in a services reference", () =>
  withAppRoot(async (root) => {
    const error = await failure(
      withAppRootProvenance(
        {
          name: "Creds Demo",
          services: {
            [ServiceName.make("web")]: {
              type: appType.id,
              image: "alpine:3.22",
              home: false as const,
              environment: { USER: "{{ services[app.name].creds.user }}" },
            },
          },
        },
        root,
      ),
    );
    expect(error).toMatchObject({ path: ["services", "web", "environment", "USER"] });
    expect(error.message).toContain("name the service literally");
  }));

test("keeps a literal credential that happens to contain an expression opener", () =>
  withAppRoot(async (root) => {
    const landofile = withAppRootProvenance(
      {
        name: "Creds Demo",
        services: {
          [ServiceName.make("database")]: {
            type: databaseType.id,
            image: "alpine:3.22",
            home: false as const,
            creds: { user: "lando", password: "pw{{{{literal", database: "appdb" },
          },
          [ServiceName.make("web")]: {
            type: appType.id,
            image: "alpine:3.22",
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
    const landofile = withAppRootProvenance(
      {
        name: "Creds Demo",
        services: {
          [ServiceName.make("web")]: {
            type: appType.id,
            image: "alpine:3.22",
            home: false as const,
            envFile: ["web.env"],
            environment: { DATABASE_URL },
          },
          [ServiceName.make("database")]: {
            type: databaseType.id,
            image: "alpine:3.22",
            home: false as const,
          },
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
      const landofile = withAppRootProvenance(
        {
          name: "Creds Demo",
          services: {
            [ServiceName.make("web")]: {
              type: appType.id,
              image: "alpine:3.22",
              home: false as const,
              environment: {
                FROM_HOST: "{{ env.LANDO_TEST_NESTED_EXPRESSION }}:{{ app.slug }}",
                DIRECT: "{{ services.database.creds.user }}",
              },
            },
            [ServiceName.make("database")]: {
              type: databaseType.id,
              image: "alpine:3.22",
              home: false as const,
            },
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
