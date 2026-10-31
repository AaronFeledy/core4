import { expect, test } from "bun:test";
import { ServiceConfig } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { apacheServiceFeature } from "../src/services/apache.ts";
import { localstackServiceFeature } from "../src/services/localstack.ts";
import { minioServiceFeature } from "../src/services/minio.ts";
import { mssqlServiceFeature, mssqlServiceType } from "../src/services/mssql.ts";
import { rabbitmqServiceType } from "../src/services/rabbitmq.ts";
import { recordFeatureContext } from "./support/record-feature-context.ts";

const reference = { _tag: "SecretRef", reference: "PASSWORD" } as const;

test("MSSQL healthcheck reads SQLCMDPASSWORD internally without a password argv", async () => {
  // Given
  const resolution = await Effect.runPromise(
    mssqlServiceType.resolve({
      name: "db",
      appRoot: "/srv/app",
      metadata: { resolvedAt: "2026-10-23T00:00:00Z", source: "/srv/app/.lando.yml", runtime: 4 },
      service: Schema.decodeUnknownSync(ServiceConfig)({
        type: "mssql",
        environment: { SA_PASSWORD: reference },
      }),
    }),
  );
  const { ctx, calls } = recordFeatureContext({
    serviceType: "mssql",
    config: resolution.features[0]?.config ?? {},
    normalizedConfig: resolution.normalizedConfig,
    connection: resolution.connection,
  });
  // When
  await Effect.runPromise(mssqlServiceFeature.apply(ctx));
  // Then
  expect(calls).toContainEqual(["addEnv", "SQLCMDPASSWORD", reference]);
  expect(calls).toContainEqual([
    "setHealthcheck",
    expect.objectContaining({
      command: [
        "/bin/bash",
        "-c",
        'export SQLCMDPASSWORD="$SA_PASSWORD"; exec "$@"',
        "lando-mssql-health",
        "/opt/mssql-tools18/bin/sqlcmd",
        "-S",
        "localhost,1433",
        "-U",
        "sa",
        "-C",
        "-b",
        "-r1",
        "-d",
        "master",
        "-l",
        "2",
        "-t",
        "5",
        "-Q",
        "IF NOT EXISTS (SELECT 1 FROM sys.databases WHERE name = N'app' AND state_desc = 'ONLINE' AND HAS_DBACCESS(name) = 1) THROW 50000, 'Database is not accessible', 1;",
      ],
    }),
  ]);
});

test.each([
  { feature: apacheServiceFeature, key: "APACHE_DOCUMENT_ROOT" },
  { feature: localstackServiceFeature, key: "GATEWAY_LISTEN" },
])("$key fails closed when a plan-time literal setting carries a binding", async ({ feature, key }) => {
  const { ctx } = recordFeatureContext({
    serviceType: "example",
    config: {},
    normalizedConfig: { environment: { [key]: reference } },
  });
  await expect(Effect.runPromise(feature.apply(ctx))).rejects.toThrow("requires literal text");
});

test("MinIO retains reference authority with explicit component encoding in its client URL", async () => {
  const { ctx, calls } = recordFeatureContext({
    serviceType: "minio",
    config: { consolePort: 9001 },
    normalizedConfig: {
      image: "example.test/minio:fixture",
      environment: { MINIO_ROOT_PASSWORD: reference },
    },
  });
  await Effect.runPromise(minioServiceFeature.apply(ctx));
  expect(calls).toContainEqual([
    "addEnv",
    "MC_HOST_local",
    {
      _tag: "BoundText",
      parts: ["http://lando:", { reference: "PASSWORD", encoding: "uri-component" }, "@127.0.0.1:9000"],
    },
  ]);
});

test("RabbitMQ rejects unresolved bindings rather than serializing a password onto client argv", async () => {
  await expect(
    Effect.runPromise(
      rabbitmqServiceType.resolve({
        name: "queue",
        appRoot: "/srv/app",
        metadata: { resolvedAt: "2026-10-23T00:00:00Z", source: "/srv/app/.lando.yml", runtime: 4 },
        service: Schema.decodeUnknownSync(ServiceConfig)({
          type: "rabbitmq",
          environment: { RABBITMQ_DEFAULT_PASS: reference },
        }),
      }),
    ),
  ).rejects.toThrow("requires literal text");
});
