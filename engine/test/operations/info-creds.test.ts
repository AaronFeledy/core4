import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer, Schema } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type DatabaseConnection,
  PortNumber,
  ProviderId,
  ServiceInfo,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { REDACTED } from "@lando/sdk/secrets";
import {
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
  SecretStore,
  type ServiceRuntimeInfo,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { infoForPlan } from "../../src/operations/info.ts";

const SECRET_VALUE = "supersecret-canary-value";
const providerId = ProviderId.make("test");

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-08-22T00:00:00Z"),
  source: "info-creds-test",
  runtime: 4 as const,
};

const makeService = (
  environment: Readonly<Record<string, string>>,
  connection?: DatabaseConnection,
): ServicePlan => ({
  name: ServiceName.make("postgres"),
  type: "postgres",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "postgres:16-alpine" },
  command: ["postgres"],
  environment,
  ...(connection === undefined ? {} : { connection }),
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const makePlan = (
  environment: Readonly<Record<string, string>>,
  connection?: DatabaseConnection,
): AppPlan => {
  const service = makeService(environment, connection);
  return {
    id: AppId.make("info-creds-app"),
    name: "info-creds-app",
    slug: "info-creds-app",
    root: AbsolutePath.make("/tmp/info-creds-app"),
    provider: providerId,
    services: { [service.name]: service },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const provide = (plan: AppPlan, publications: ServiceRuntimeInfo["publications"] = { status: "unknown" }) => {
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    inspect: (target) =>
      Effect.succeed({
        app: plan.id,
        service: target.service,
        providerId,
        status: "running",
        state: "running",
        publications,
      }),
  };
  return Layer.succeed(
    RuntimeProviderRegistry,
    RuntimeProviderRegistry.of({
      appliedPlansFor: () => Effect.succeed([]),
      resolveAppliedPlan: () => Effect.succeed(undefined),
      resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    }),
  );
};

const infoForEnvironment = (
  environment: Readonly<Record<string, string>>,
  connection?: DatabaseConnection,
) => {
  const plan = makePlan(environment, connection);
  return Effect.runPromise(infoForPlan(plan).pipe(Effect.provide(provide(plan))));
};

const connection: DatabaseConnection = {
  family: "postgres",
  port: PortNumber.make(5544),
  creds: { user: "dbuser", database: "appdb", password: { _tag: "SecretRef", reference: "TEST" } },
};

describe("infoForPlan creds from connection facts", () => {
  test.each([true, false])(
    "enriches only the canonical PostgreSQL TCP listener when facts exist: %s",
    async (hasFacts) => {
      // Given canonical nondefault facts and misleading environment values / host ports.
      const environment = {
        POSTGRES_USER: "environment-user",
        POSTGRES_DB: "environment-db",
        POSTGRES_PASSWORD: SECRET_VALUE,
        LANDO_DB_USER: "environment-lando-user",
        LANDO_DB_NAME: "environment-lando-db",
      };
      const facts: DatabaseConnection = {
        ...connection,
        creds: {
          user: "canonical user",
          database: "canonical/db",
          password: { _tag: "SecretRef", reference: "fake://Vault/password" },
        },
      };
      const base = makePlan(environment);
      const service: ServicePlan = {
        ...makeService(environment, hasFacts ? facts : undefined),
        endpoints: [
          { _tag: "published", protocol: "tcp", port: 5544, publication: { hostPort: 6543 } },
          { _tag: "published", protocol: "tcp", port: 7777, publication: { hostPort: 5544 } },
          { _tag: "published", protocol: "udp", port: 5544, publication: { hostPort: 6544 } },
        ],
      };
      const plan = { ...base, services: { postgres: service } };
      const storeCalls: string[] = [];
      const store = Layer.succeed(
        SecretStore,
        SecretStore.of({
          id: "observation-canary",
          get: (reference) =>
            Effect.sync(() => {
              storeCalls.push(reference);
              return SECRET_VALUE;
            }),
          has: (reference) =>
            Effect.sync(() => {
              storeCalls.push(reference);
              return true;
            }),
          list: Effect.sync(() => {
            storeCalls.push("list");
            return [];
          }),
        }),
      );
      // When observing live publications through the operation, never executing secrets.
      const result = await Effect.runPromise(
        infoForPlan(plan).pipe(
          Effect.provide(
            Layer.merge(
              provide(plan, {
                status: "present",
                bindings: [
                  { port: 5544, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 6543 },
                  { port: 7777, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 5544 },
                  { port: 5544, transport: "udp", bindAddress: "127.0.0.1", hostPort: 6544 },
                ],
              }),
              store,
            ),
          ),
        ),
      );
      // Then only the matching container listener receives canonical, password-free facts.
      const urls = result.services[0]?.connections.flatMap((row) =>
        row.binding === "assigned" ? [row.url, ...row.alternateUrls] : [],
      );
      expect(urls).toEqual([
        hasFacts ? "postgresql://canonical%20user@postgres:5544/canonical%2Fdb" : "tcp://postgres:5544",
        hasFacts ? "postgresql://canonical%20user@localhost:6543/canonical%2Fdb" : "tcp://localhost:6543",
        "tcp://postgres:7777",
        "tcp://localhost:5544",
        "udp://postgres:5544",
        "udp://localhost:6544",
      ]);
      expect(storeCalls).toEqual([]);
      const encoded = JSON.stringify(result);
      for (const forbidden of [
        SECRET_VALUE,
        "fake://",
        "environment-user",
        "environment-db",
        "environment-lando",
        "postgresql://lando@",
        "localhost:6543/postgres",
      ]) {
        expect(encoded).not.toContain(forbidden);
      }
      expect(result.services[0]?.creds).toEqual(
        hasFacts ? { user: "canonical user", database: "canonical/db", password: REDACTED } : undefined,
      );
    },
  );
  test("emits redacted connection creds without a SecretStore", async () => {
    const result = await infoForEnvironment(
      {
        LANDO_DB_USER: "dbuser",
        LANDO_DB_PASSWORD: SECRET_VALUE,
        LANDO_DB_NAME: "appdb",
        POSTGRES_PASSWORD: SECRET_VALUE,
      },
      connection,
    );

    expect(result.services[0]?.creds).toEqual({
      user: "dbuser",
      password: REDACTED,
      database: "appdb",
    });
    const encoded = Schema.encodeSync(ServiceInfo)(Schema.decodeUnknownSync(ServiceInfo)(result.services[0]));
    expect(encoded.creds).toEqual(result.services[0]?.creds);
    expect(JSON.stringify(encoded)).not.toContain(SECRET_VALUE);
  });

  test("includes redacted rootPassword from a connection", async () => {
    const result = await infoForEnvironment(
      {
        LANDO_DB_USER: "dbuser",
        LANDO_DB_PASSWORD: SECRET_VALUE,
        LANDO_DB_NAME: "appdb",
        LANDO_DB_ROOT_PASSWORD: SECRET_VALUE,
      },
      {
        ...connection,
        creds: { ...connection.creds, rootPassword: { _tag: "SecretRef", reference: "ROOT" } },
      },
    );

    expect(result.services[0]?.creds).toEqual({
      user: "dbuser",
      password: REDACTED,
      database: "appdb",
      rootPassword: REDACTED,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  test("omits creds when no LANDO_DB_USER, NAME, or PASSWORD is present", async () => {
    const result = await infoForEnvironment({
      POSTGRES_USER: "lando",
      POSTGRES_PASSWORD: SECRET_VALUE,
      POSTGRES_DB: "appdb",
    });

    expect(result.services[0]?.creds).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  test("does not infer a connection from historical credential environment strings", async () => {
    const result = await infoForEnvironment({
      LANDO_DB_PASSWORD: SECRET_VALUE,
    });

    expect(result.services[0]?.creds).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });
});
