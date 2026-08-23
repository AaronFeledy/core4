import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { REDACTED } from "@lando/sdk/secrets";
import { RuntimeProviderRegistry, type RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { infoForPlan } from "../../src/operations/info.ts";

const SECRET_VALUE = "supersecret-canary-value";
const providerId = ProviderId.make("test");

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-08-22T00:00:00Z"),
  source: "info-creds-test",
  runtime: 4 as const,
};

const makeService = (environment: Readonly<Record<string, string>>): ServicePlan => ({
  name: ServiceName.make("postgres"),
  type: "postgres",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "postgres:16-alpine" },
  command: ["postgres"],
  environment,
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const makePlan = (environment: Readonly<Record<string, string>>): AppPlan => {
  const service = makeService(environment);
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

const provide = (plan: AppPlan) => {
  const provider: RuntimeProviderShape = {
    ...TestRuntimeProvider,
    inspect: (target) =>
      Effect.succeed({
        app: plan.id,
        service: target.service,
        providerId,
        status: "running",
        state: "running",
      }),
  };
  return Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(provider.capabilities),
    select: () => Effect.succeed(provider),
  });
};

const infoForEnvironment = (environment: Readonly<Record<string, string>>) => {
  const plan = makePlan(environment);
  return Effect.runPromise(infoForPlan(plan).pipe(Effect.provide(provide(plan))));
};

describe("infoForPlan creds from LANDO_DB_*", () => {
  test("emits redacted creds when LANDO_DB_USER, PASSWORD, and NAME are present", async () => {
    const result = await infoForEnvironment({
      LANDO_DB_USER: "dbuser",
      LANDO_DB_PASSWORD: SECRET_VALUE,
      LANDO_DB_NAME: "appdb",
      POSTGRES_PASSWORD: SECRET_VALUE,
    });

    expect(result.services[0]?.creds).toEqual({
      user: "dbuser",
      password: REDACTED,
      database: "appdb",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  test("includes redacted rootPassword when LANDO_DB_ROOT_PASSWORD is defined", async () => {
    const result = await infoForEnvironment({
      LANDO_DB_USER: "dbuser",
      LANDO_DB_PASSWORD: SECRET_VALUE,
      LANDO_DB_NAME: "appdb",
      LANDO_DB_ROOT_PASSWORD: SECRET_VALUE,
    });

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

  test("fills missing user or database with empty string when emitting creds", async () => {
    const result = await infoForEnvironment({
      LANDO_DB_PASSWORD: SECRET_VALUE,
    });

    expect(result.services[0]?.creds).toEqual({
      user: "",
      password: REDACTED,
      database: "",
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });
});
