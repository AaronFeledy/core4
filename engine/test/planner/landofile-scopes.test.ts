import { expect, test } from "bun:test";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { ConfigExpressionError } from "@lando/sdk/errors";
import { AppPlan, ServiceName } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import {
  configExpressionIssuePath,
  deferredSiteKey,
  materializeLandofileScopes,
  materializeServiceScopeSites,
  serviceCredsScopeForPlan,
  serviceScopeContext,
} from "../../src/planner/landofile-scopes.ts";

test("keeps literal dots and numeric string keys in planner lint paths", () => {
  const error = new ConfigExpressionError({
    message: "Missing value.",
    expression: "{{ app.missing }}",
    filePath: "/app/.lando.yml",
    path: ["services", "web.v2", "environment", "0"],
    remediation: "Fix the expression.",
  });
  const path = configExpressionIssuePath(error);
  expect(path).toEqual(["services", "web.v2", "environment", "0"]);
  expect(deferredSiteKey(path)).not.toBe(deferredSiteKey(["services", "web", "v2", "environment", 0]));
});

test("advances recorded identity and connection sites without rescanning produced strings", async () => {
  const before = process.env.LANE_B_ENGINE_DATA;
  process.env.LANE_B_ENGINE_DATA = "{{ services.notAuthored.creds.password }}";
  try {
    const compiled = await Effect.runPromise(
      loadAuthoredDocuments(
        [
          {
            file: "/app/.lando.yml",
            value: {
              name: "demo",
              services: {
                web: {
                  environment: {
                    DATA: "{{ env.LANE_B_ENGINE_DATA }}",
                    URL: "pg://{{ url.encodeComponent(services.db.creds.password) }}:{{ services.db.port }}",
                  },
                },
              },
            },
          },
        ],
        { appRoot: "/app", file: "/app/.lando.yml" },
      ),
    );
    const identity = await Effect.runPromise(
      materializeLandofileScopes({
        landofile: compiled,
        appRoot: "/app",
        landofilePath: "/app/.lando.yml",
        globalConfig: undefined,
      }),
    );
    expect(identity.compiled.stage).toBe("identity-scoped");
    expect(identity.pendingSites).toHaveLength(1);
    const result = await Effect.runPromise(
      materializeServiceScopeSites({
        value: identity.landofile,
        pathPrefix: [],
        deferredSites: identity.pendingSites,
        landofilePath: "/app/.lando.yml",
        context: serviceScopeContext({
          ...identity,
          services: {
            db: {
              creds: { user: "lando", database: "app", password: { _tag: "SecretRef", reference: "DB" } },
              port: 5544,
            },
          },
        }),
      }),
    );
    expect(result).toMatchObject({
      pendingSites: [],
      document: {
        services: {
          web: {
            environment: {
              DATA: "{{ services.notAuthored.creds.password }}",
              URL: {
                _tag: "BoundText",
                parts: ["pg://", { reference: "DB", encoding: "uri-component" }, ":5544"],
              },
            },
          },
        },
      },
    });
  } finally {
    process.env.LANE_B_ENGINE_DATA = before;
  }
});

test("reconstructs trusted scope only from persisted connection facts including port", () => {
  const plan = Schema.decodeUnknownSync(AppPlan)({
    id: "demo",
    name: "demo",
    slug: "demo",
    root: "/app",
    provider: "lando",
    services: {
      db: {
        name: "db",
        type: "postgres",
        provider: "lando",
        primary: true,
        environment: { POSTGRES_PASSWORD: "must-not-be-used" },
        mounts: [],
        endpoints: [],
        routes: [],
        dependsOn: [],
        hostAliases: [],
        metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "/app/.lando.yml", runtime: 4 },
        extensions: {},
        connection: {
          family: "postgres",
          port: 5544,
          creds: { user: "lando", database: "app", password: { _tag: "SecretRef", reference: "DB" } },
        },
      },
    },
    routes: [],
    stores: [],
    fileSync: [],
    metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "/app/.lando.yml", runtime: 4 },
    extensions: {},
  });
  const scope = serviceCredsScopeForPlan(plan);
  expect(scope.db).toEqual({
    creds: { user: "lando", database: "app", password: { _tag: "SecretRef", reference: "DB" } },
    port: 5544,
  });
});

test("locates canonical decode failures without rendering scope values into errors", async () => {
  const compiled = await Effect.runPromise(
    loadAuthoredDocuments(
      [
        {
          file: "/app/.lando.local.yml",
          value: {
            name: "DO_NOT_RENDER_SCOPE_BYTES",
            services: { web: { environment: { BAD: "{{ app }}" } } },
          },
        },
      ],
      { appRoot: "/app", file: "/app/.lando.yml" },
    ),
  );
  const result = await Effect.runPromise(
    Effect.result(
      materializeLandofileScopes({
        landofile: compiled,
        appRoot: "/app",
        landofilePath: "/app/.lando.yml",
        globalConfig: undefined,
      }),
    ),
  );
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure.path).toEqual(["services", "web", "environment", "BAD"]);
    expect(result.failure.filePath).toBe("/app/.lando.local.yml");
    expect(result.failure.message).not.toContain("DO_NOT_RENDER_SCOPE_BYTES");
  }
});

test("locates forbidden binding helpers at the canonical destination", async () => {
  const compiled = await Effect.runPromise(
    loadAuthoredDocuments(
      [
        {
          file: "/app/.lando.yml",
          value: { services: { web: { environment: { BAD: "{{ lower(services.db.creds.password) }}" } } } },
        },
      ],
      { appRoot: "/app", file: "/app/.lando.yml" },
    ),
  );
  const identity = await Effect.runPromise(
    materializeLandofileScopes({
      landofile: compiled,
      appRoot: "/app",
      landofilePath: "/app/.lando.yml",
      globalConfig: undefined,
    }),
  );
  const result = await Effect.runPromise(
    Effect.result(
      materializeServiceScopeSites({
        value: identity.landofile.services?.[ServiceName.make("web")],
        pathPrefix: ["services", "web"],
        deferredSites: identity.pendingSites,
        landofilePath: "/app/.lando.yml",
        context: serviceScopeContext({
          ...identity,
          services: {
            db: {
              creds: { user: "lando", database: "app", password: { _tag: "SecretRef", reference: "DB" } },
              port: 5432,
            },
          },
        }),
      }),
    ),
  );
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result))
    expect(result.failure).toMatchObject({
      _tag: "ConfigExpressionError",
      path: ["services", "web", "environment", "BAD"],
      filePath: "/app/.lando.yml",
    });
});
