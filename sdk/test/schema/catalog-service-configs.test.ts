import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LocalStackServiceConfig } from "@lando/sdk/schema/services/localstack";
import { MAILHOG_DEPRECATION_NOTICE, MailhogServiceConfig } from "@lando/sdk/schema/services/mailhog";
import { MailpitServiceConfig } from "@lando/sdk/schema/services/mailpit";
import { MinIOServiceConfig } from "@lando/sdk/schema/services/minio";
import { RabbitMQServiceConfig } from "@lando/sdk/schema/services/rabbitmq";
import { TomcatServiceConfig } from "@lando/sdk/schema/services/tomcat";
import { VarnishServiceConfig } from "@lando/sdk/schema/services/varnish";

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

  test.each(["tomcat", "tomcat:9", "tomcat:10", "tomcat:11"] as const)(
    "Given Tomcat type %s, when decoding shared service fields, then it succeeds",
    (type) => {
      // Given
      const input = {
        type,
        image: "tomcat:11-jre21",
        port: 8080,
        webroot: "/usr/local/tomcat/webapps/ROOT",
        certs: true,
      };

      // When
      const result = strictDecode(TomcatServiceConfig, input);

      // Then
      expect(result._tag).toBe("Right");
    },
  );

  test.each(["varnish", "varnish:6", "varnish:7"] as const)(
    "Given Varnish type %s with a backend, when decoding, then it succeeds",
    (type) => {
      // Given
      const input = {
        type,
        image: "varnish:7",
        port: 80,
        backend: "appserver",
      };

      // When
      const result = strictDecode(VarnishServiceConfig, input);

      // Then
      expect(result._tag).toBe("Right");
    },
  );

  test("Given Varnish without a backend, when decoding, then it fails", () => {
    // Given / When
    const result = strictDecode(VarnishServiceConfig, { type: "varnish", image: "varnish:7" });

    // Then
    expect(result._tag).toBe("Left");
  });

  test.each([
    ["MinIOServiceConfig", MinIOServiceConfig, { type: "minio", image: "minio/minio", port: 9000 }],
    [
      "LocalStackServiceConfig",
      LocalStackServiceConfig,
      { type: "localstack", image: "localstack/localstack", port: 4566 },
    ],
    ["MailpitServiceConfig", MailpitServiceConfig, { type: "mailpit", image: "axllent/mailpit", port: 1025 }],
    ["MailhogServiceConfig", MailhogServiceConfig, { type: "mailhog", image: "mailhog/mailhog", port: 1025 }],
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
    ["MailpitServiceConfig", MailpitServiceConfig, { type: "mailhog" }],
    ["MailhogServiceConfig", MailhogServiceConfig, { type: "mailpit" }],
    ["TomcatServiceConfig", TomcatServiceConfig, { type: "varnish" }],
    ["VarnishServiceConfig", VarnishServiceConfig, { type: "tomcat", backend: "appserver" }],
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
    ["MailpitServiceConfig", MailpitServiceConfig, { type: "mailpit", smtpPort: 1025 }],
    ["MailhogServiceConfig", MailhogServiceConfig, { type: "mailhog", smtpPort: 1025 }],
    ["TomcatServiceConfig", TomcatServiceConfig, { type: "tomcat", servletPort: 8080 }],
    ["VarnishServiceConfig", VarnishServiceConfig, { type: "varnish", backend: "appserver", vclPort: 80 }],
  ] as const)(
    "Given %s with an unknown key, when strictly decoding, then it fails",
    (_name, schema, input) => {
      // Given / When
      const result = strictDecode(schema, input);

      // Then
      expect(result._tag).toBe("Left");
    },
  );

  test("Given the MailHog notice, when inspected, then it names mailpit as the 5.0.0 replacement", () => {
    // Given / When / Then
    expect(MAILHOG_DEPRECATION_NOTICE.since).toBe("4.2.0");
    expect(MAILHOG_DEPRECATION_NOTICE.removeIn).toBe("5.0.0");
    expect(MAILHOG_DEPRECATION_NOTICE.replacement).toBe("mailpit");
    expect(MAILHOG_DEPRECATION_NOTICE.severity).toBe("warn");
  });
});
