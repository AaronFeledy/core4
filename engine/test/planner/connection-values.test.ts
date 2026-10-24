import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type CurrentExecutableAppPlan,
  type DatabaseConnection,
  PortNumber,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { Effect } from "effect";
import { validateConnectionValues } from "../../src/planner/connection-values.ts";
import { attachEffectiveTooling, effectiveToolingForPlan } from "../../src/planner/effective-tooling.ts";
import { servicePlanFromDraft, toAppFeatureDraft } from "../../src/planner/extensions.ts";
import { composeAppFeatures } from "../../src/services/app-feature.ts";
import { composeService } from "../../src/services/feature.ts";

const connection: DatabaseConnection = {
  family: "postgres",
  port: PortNumber.make(5544),
  creds: {
    user: "dbuser",
    database: "appdb",
    password: { _tag: "SecretRef", reference: "TOKEN" },
  },
};
const compose = () =>
  composeService({
    base: {
      name: ServiceName.make("db"),
      type: "postgres",
      provider: ProviderId.make("test"),
      primary: true,
      connection,
      defaultFeatures: [],
    },
    baseKind: "lando",
    appRoot: "/tmp/connection",
    normalizedConfig: {},
    features: [
      {
        id: "db-env",
        definition: {
          id: "db-env",
          priority: 1,
          apply: (ctx) =>
            Effect.sync(() => {
              if (ctx.connection === undefined) throw new Error("missing connection");
              ctx.addEnv("POSTGRES_PASSWORD", ctx.connection.creds.password);
              ctx.addEnv("LANDO_DB_PASSWORD", ctx.connection.creds.password);
            }),
        },
      },
    ],
  });

test("carries typed connection through service and app feature views and finalization", async () => {
  // Given
  const service = await Effect.runPromise(compose());
  const draft = toAppFeatureDraft(
    "db",
    service,
    { base: "lando", normalizedConfig: {}, features: [], connection },
    [],
  );
  // When
  await Effect.runPromise(
    composeAppFeatures({
      appRoot: "/tmp/connection",
      services: [draft],
      features: [
        {
          id: "app",
          definition: {
            id: "app",
            priority: 1,
            apply: (ctx) =>
              Effect.sync(() =>
                ctx.forEachSelected((selected) => {
                  const value = selected.service.connection?.creds.password;
                  if (value === undefined) throw new Error("missing app view connection");
                  selected.addEnv("CLIENT", value);
                }),
              ),
          },
        },
      ],
    }),
  );
  const finalized = servicePlanFromDraft(draft, [], service.metadata, service.extensions);
  // Then
  expect(finalized.connection).toEqual(connection);
  expect(finalized.environment.CLIENT).toEqual(connection.creds.password);
});

test("rejects a feature overwrite that disagrees with canonical database facts without displaying values", async () => {
  // Given
  const service = await Effect.runPromise(compose());
  const changed: ServicePlan = {
    ...service,
    environment: { ...service.environment, POSTGRES_PASSWORD: "private-override" },
  };
  // When
  const error = await Effect.runPromise(
    validateConnectionValues("/tmp/connection", { db: changed }).pipe(Effect.flip),
  );
  // Then
  expect(error._tag).toBe("LandofileValidationError");
  expect(error.issues[0]?.path).toEqual(["services", "db", "environment", "POSTGRES_PASSWORD"]);
  expect(JSON.stringify(error)).not.toContain("private-override");
});

test("retains generated bound client environments through plan serialization and spreads", async () => {
  // Given
  const service = await Effect.runPromise(compose());
  const plan: CurrentExecutableAppPlan = {
    valueModel: 1,
    id: AppId.make("connection"),
    name: "connection",
    slug: "connection",
    root: AbsolutePath.make("/tmp/connection"),
    provider: service.provider,
    services: { [service.name]: service },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata: service.metadata,
    extensions: {},
  };
  const attached = attachEffectiveTooling(plan, {
    psql: { service: "db", cmd: "psql", env: { PGPASSWORD: connection.creds.password } },
  });
  // When
  const copied: CurrentExecutableAppPlan = { ...structuredClone(attached) };
  // Then
  expect(effectiveToolingForPlan(copied)?.psql?.env?.PGPASSWORD).toEqual(connection.creds.password);
});
