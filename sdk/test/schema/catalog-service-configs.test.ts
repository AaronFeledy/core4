import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LocalStackServiceConfig } from "@lando/sdk/schema/services/localstack";
import { MinIOServiceConfig } from "@lando/sdk/schema/services/minio";
import { RabbitMQServiceConfig } from "@lando/sdk/schema/services/rabbitmq";

const strictDecode = (schema: Schema.Schema.AnyNoContext, input: unknown) =>
  Schema.decodeUnknownEither(schema, { onExcessProperty: "error" })(input);

describe("catalog service config schemas", () => {
  test.each(["rabbitmq", "rabbitmq:3", "rabbitmq:4"] as const)(
    "Given RabbitMQ type %s, when decoding shared service fields, then it succeeds",
    (type) => {
      // Given
      const input = {
        type,
        image: "rabbitmq:4-management",
        port: 5672,
        environment: { RABBITMQ_DEFAULT_USER: "lando" },
      };

      // When
      const result = strictDecode(RabbitMQServiceConfig, input);

      // Then
      expect(result._tag).toBe("Right");
    },
  );

  test.each([
    ["MinIOServiceConfig", MinIOServiceConfig, { type: "minio", image: "minio/minio", port: 9000 }],
    [
      "LocalStackServiceConfig",
      LocalStackServiceConfig,
      { type: "localstack", image: "localstack/localstack", port: 4566 },
    ],
  ] as const)("Given %s shared service fields, when decoding, then it succeeds", (_name, schema, input) => {
    // Given / When
    const result = strictDecode(schema, input);

    // Then
    expect(result._tag).toBe("Right");
  });

  test.each([
    ["RabbitMQServiceConfig", RabbitMQServiceConfig, { type: "minio" }],
    ["MinIOServiceConfig", MinIOServiceConfig, { type: "rabbitmq" }],
    ["LocalStackServiceConfig", LocalStackServiceConfig, { type: "minio" }],
  ] as const)("Given %s with another catalog type, when decoding, then it fails", (_name, schema, input) => {
    // Given / When
    const result = strictDecode(schema, input);

    // Then
    expect(result._tag).toBe("Left");
  });

  test.each([
    ["RabbitMQServiceConfig", RabbitMQServiceConfig, { type: "rabbitmq", buckets: ["data"] }],
    ["MinIOServiceConfig", MinIOServiceConfig, { type: "minio", consolePort: 9001 }],
    ["LocalStackServiceConfig", LocalStackServiceConfig, { type: "localstack", services: ["s3"] }],
  ] as const)(
    "Given %s with an unknown key, when strictly decoding, then it fails",
    (_name, schema, input) => {
      // Given / When
      const result = strictDecode(schema, input);

      // Then
      expect(result._tag).toBe("Left");
    },
  );
});
