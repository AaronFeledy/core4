import { expect, test } from "bun:test";
import { RedactionService } from "@lando/redaction/service";
import { AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import type { CommandSpec } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer, Option, Stream } from "effect";
import { execServiceCommand } from "../../src/operations/exec.ts";
import * as Resolver from "../../src/services/environment-value-resolver.ts";
import { composeService } from "../../src/services/feature.ts";
import * as EnvSecretStore from "../../src/services/secret-store.ts";

test("dispatches typed invocation credentials as concrete provider exec environment", async () => {
  // Given
  const raw = "pg-canary:@/ é";
  const storeLayer = EnvSecretStore.layerWith({ env: { LANDO_SECRET_PASSWORD: raw } });
  const resolver = Resolver.layer.pipe(
    Layer.provide(Layer.mergeAll(storeLayer, RedactionService.layer.pipe(Layer.provide(storeLayer)))),
  );
  const service = await Effect.runPromise(
    composeService({
      base: {
        name: ServiceName.make("db"),
        type: "postgres",
        provider: ProviderId.make("test"),
        primary: true,
        defaultFeatures: [],
      },
      baseKind: "lando",
      appRoot: "/tmp/exec-values",
      normalizedConfig: {},
      features: [],
    }),
  );
  const calls: CommandSpec[] = [];
  // When
  await Effect.runPromise(
    execServiceCommand(
      {
        service,
        provider: {
          ...TestRuntimeProvider,
          execStream: (_target, command) => {
            calls.push(command);
            return Stream.make({ exitCode: 0 });
          },
        },
        target: { app: AppId.make("exec-values"), service: service.name },
        options: {
          command: ["psql"],
          env: {
            PGPASSWORD: { _tag: "SecretRef", reference: "PASSWORD" },
            LANDO_DB_PASSWORD: { _tag: "SecretRef", reference: "PASSWORD" },
            LITERAL: "${secret:PASSWORD}",
          },
        },
      },
      Option.none(),
    ).pipe(Effect.provide(resolver)),
  );
  // Then
  expect(calls[0]?.env).toMatchObject({
    PGPASSWORD: raw,
    LANDO_DB_PASSWORD: raw,
    LITERAL: "${secret:PASSWORD}",
  });
  expect(calls[0]?.command).toEqual(["psql"]);
});
