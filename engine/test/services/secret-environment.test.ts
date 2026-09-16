import { describe, expect, test } from "bun:test";

import { DateTime, Effect, Layer } from "effect";

import { SecretNotFoundError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { SecretStore, type SecretStoreShape } from "@lando/sdk/services";

import { resolveServiceEnvironmentSecrets } from "../../src/services/secret-environment.ts";

const serviceName = ServiceName.make("web");

const service: ServicePlan = {
  name: serviceName,
  type: "node",
  provider: ProviderId.make("test"),
  primary: true,
  environment: {
    TOKEN: "${secret:API_TOKEN}",
    EMBEDDED: "prefix-${secret:API_TOKEN}",
    PLAIN: "visible",
  },
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-09-11T00:00:00.000Z"),
    source: "secret-environment.test",
    runtime: 4,
  },
  extensions: {},
};

const plan = {
  id: AppId.make("secret-app"),
  root: AbsolutePath.make("/tmp/secret-app"),
  services: { [serviceName]: service },
} as AppPlan;

const store = (secrets: Readonly<Record<string, string>>): SecretStoreShape => ({
  id: "test",
  get: (secret) =>
    secrets[secret] === undefined
      ? Effect.fail(
          new SecretNotFoundError({
            message: `Missing ${secret}.`,
            secret,
            remediation: "Seed the test secret.",
          }),
        )
      : Effect.succeed(secrets[secret]),
  has: (secret) => Effect.succeed(secrets[secret] !== undefined),
  list: Effect.succeed(Object.keys(secrets)),
});

describe("resolveServiceEnvironmentSecrets", () => {
  test("resolves only exact references without mutating the durable plan", async () => {
    // Given
    const original = structuredClone(plan.services[serviceName]?.environment);

    // When
    const resolved = await Effect.runPromise(
      resolveServiceEnvironmentSecrets(plan).pipe(
        Effect.provide(Layer.succeed(SecretStore, store({ API_TOKEN: "resolved-canary" }))),
      ),
    );

    // Then
    expect(resolved[serviceName]).toEqual({
      TOKEN: "resolved-canary",
      EMBEDDED: "prefix-${secret:API_TOKEN}",
      PLAIN: "visible",
    });
    expect(plan.services[serviceName]?.environment).toEqual(original);
    expect(JSON.stringify(plan)).not.toContain("resolved-canary");
  });

  test("fails with the missing secret identity before provider action", async () => {
    // Given/When
    const exit = await Effect.runPromiseExit(
      resolveServiceEnvironmentSecrets(plan).pipe(Effect.provide(Layer.succeed(SecretStore, store({})))),
    );

    // Then
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") expect(String(exit.cause)).toContain("API_TOKEN");
  });
});
