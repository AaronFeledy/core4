import { expect, test } from "bun:test";
import { ServiceConfig } from "@lando/sdk/schema";
import { Schema } from "effect";

import { php83ServiceType } from "../src/services/php.ts";
import { apacheLauncherDirectives } from "./support/apache-directives.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

test.each([
  { via: "apache", port: undefined, effective: 80, protocol: "http" },
  { via: "apache", port: 80, effective: 80, protocol: "http" },
  { via: "apache", port: 8123, effective: 8123, protocol: "http" },
  { via: "fpm", port: undefined, effective: 9000, protocol: "tcp" },
  { via: "fpm", port: 9070, effective: 9070, protocol: "tcp" },
] as const)("aligns declaration, launcher and probe for PHP %j", async (input) => {
  // Given: the owned PHP launcher, including an explicitly authored default port.
  const service = Schema.decodeUnknownSync(ServiceConfig)({
    type: "php:8.3",
    via: input.via,
    ...(input.port === undefined ? {} : { port: input.port }),
  });
  // When: declaration and application run through the real service composer.
  const plan = await composeServicePlan({
    serviceType: php83ServiceType,
    service,
    appRoot: "/srv/apps/php-listener",
    metadata: { resolvedAt: "2026-10-24T00:00:00Z", source: "php-listener.test.ts", runtime: 4 },
  });
  // Then: all consumers describe the same listener without changing Apache's default shape.
  expect(plan.endpoints).toEqual([
    { _tag: "internal", name: "web", primary: true, port: input.effective, protocol: input.protocol },
  ]);
  expect(plan.healthcheck?.command).toEqual(["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${input.effective}`]);
  switch (input.via) {
    case "apache": {
      const directives = apacheLauncherDirectives(plan.command, "apache2-foreground");
      expect(directives.filter((line) => line.startsWith("Listen "))).toEqual(
        input.port === undefined ? [] : [`Listen ${input.port}`],
      );
      break;
    }
    case "fpm":
      expect(plan.command?.[2]).toContain(`listen = ${input.effective}\\n`);
      break;
    default: {
      const exhaustive: never = input;
      throw new Error(`Unexpected PHP mode: ${exhaustive}`);
    }
  }
});

test.each([undefined, 8123])("omits listener and probe for CLI even with port %s", async (port) => {
  // Given: a CLI-only service, with or without an authored port.
  const service = Schema.decodeUnknownSync(ServiceConfig)({
    type: "php:8.3",
    via: "cli",
    ...(port === undefined ? {} : { port }),
  });
  // When: compose the CLI service without authored healthcheck overrides.
  const plan = await composeServicePlan({
    serviceType: php83ServiceType,
    service,
    appRoot: "/srv/apps/php-listener",
    metadata: { resolvedAt: "2026-10-24T00:00:00Z", source: "php-listener.test.ts", runtime: 4 },
  });
  // Then: the idle command cannot acquire a fictitious HTTP listener or TCP probe.
  expect(plan.command).toEqual(["sh", "-c", "tail -f /dev/null"]);
  expect(plan.endpoints).toEqual([]);
  expect(plan.healthcheck).toBeUndefined();
});
