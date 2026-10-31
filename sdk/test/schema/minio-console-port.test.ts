import { expect, test } from "bun:test";
import {
  DotnetServiceConfig,
  LocalStackServiceConfig,
  MssqlServiceConfig,
  PhpMyAdminServiceConfig,
  PhpServiceConfig,
  RabbitMQServiceConfig,
  TomcatServiceConfig,
  VarnishServiceConfig,
} from "@lando/sdk/schema/services";
import { MailhogServiceConfig } from "@lando/sdk/schema/services/mailhog";
import { MailpitServiceConfig } from "@lando/sdk/schema/services/mailpit";
import { MinIOServiceConfig } from "@lando/sdk/schema/services/minio";
import { MysqlServiceConfig } from "@lando/sdk/schema/services/mysql";
import { Schema } from "effect";

test.each([undefined, 1, 9001, 65535])("accepts optional MinIO consolePort %j", (consolePort) => {
  // Given / When
  const result = Schema.decodeUnknownResult(MinIOServiceConfig)(
    { type: "minio", ...(consolePort === undefined ? {} : { consolePort }) },
    { onExcessProperty: "error" },
  );
  // Then
  expect(result._tag).toBe("Success");
  if (result._tag === "Success") expect(result.success.consolePort).toBe(consolePort);
});

test.each([0, 65536, 1.5, "9001"])("rejects invalid MinIO consolePort %j", (consolePort) => {
  // Given / When
  const result = Schema.decodeUnknownResult(MinIOServiceConfig)(
    { type: "minio", consolePort },
    { onExcessProperty: "error" },
  );
  // Then
  expect(result._tag).toBe("Failure");
});

test.each([
  [MailpitServiceConfig, "mailpit"],
  [MailhogServiceConfig, "mailhog"],
  [MysqlServiceConfig, "mysql"],
  [DotnetServiceConfig, "dotnet"],
  [LocalStackServiceConfig, "localstack"],
  [MssqlServiceConfig, "mssql"],
  [PhpServiceConfig, "php:8.3"],
  [PhpMyAdminServiceConfig, "phpmyadmin"],
  [RabbitMQServiceConfig, "rabbitmq"],
  [TomcatServiceConfig, "tomcat"],
  [VarnishServiceConfig, "varnish"],
] as const)("keeps consolePort exclusive to MinIO: %j", (schema, type) => {
  // Given
  const input = type === "varnish" ? { type, backend: "web" } : { type };
  expect(Schema.decodeUnknownResult(schema)(input, { onExcessProperty: "error" })._tag).toBe("Success");
  // When
  const result = Schema.decodeUnknownResult(schema)(
    { ...input, consolePort: 9001 },
    { onExcessProperty: "error" },
  );
  // Then
  expect(result._tag).toBe("Failure");
});
