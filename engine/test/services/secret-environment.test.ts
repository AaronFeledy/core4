import { describe, expect, test } from "bun:test";

import { DateTime, Effect, Layer } from "effect";

import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { SecretNotFoundError, SecretStoreUnavailableError } from "@lando/sdk/errors";
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
  test("registers resolved values with the redactor before returning", async () => {
    // Given
    const secrets = { ...store({ API_TOKEN: "environment-registration-canary" }), list: Effect.succeed([]) };
    const redaction = makeRedactionService(secrets);
    const redactor = await Effect.runPromise(redaction.forProfile("secrets"));
    // When
    const output = await Effect.runPromise(
      resolveServiceEnvironmentSecrets(plan).pipe(
        Effect.map((environment) => redactor.redactString(environment[serviceName]?.TOKEN ?? "")),
        Effect.provide(
          Layer.mergeAll(Layer.succeed(SecretStore, secrets), Layer.succeed(RedactionService, redaction)),
        ),
      ),
    );
    // Then
    expect(output).toBe("[redacted]");
  });

  test("propagates SecretStoreUnavailableError untouched", async () => {
    // Given
    const failure = new SecretStoreUnavailableError({
      message: "Locked",
      storeId: "vault",
      reason: "locked",
      remediation: "Unlock vault.",
    });
    const secrets = { ...store({}), get: () => Effect.fail(failure) };
    // When
    const error = await Effect.runPromise(
      resolveServiceEnvironmentSecrets(plan).pipe(Effect.flip, Effect.provideService(SecretStore, secrets)),
    );
    // Then
    expect(error).toBe(failure);
  });
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
