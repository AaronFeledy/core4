import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";
import { php83ServiceType } from "../src/services/php.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const compose = (input: Readonly<Record<string, unknown>>) =>
  composeServicePlan({
    serviceType: php83ServiceType,
    service: Schema.decodeUnknownSync(ServiceConfig)({ type: "php:8.3", ...input }),
    appRoot: "/srv/apps/php-process",
    metadata: { resolvedAt: "2026-10-28T00:00:00Z", source: "php-process", runtime: 4 },
  });

describe("PHP process ownership", () => {
  for (const via of ["apache", "fpm", "cli"]) {
    test.each([
      { entrypoint: ["php", "-v"] },
      { command: ["php", "-v"] },
      { entrypoint: ["php"], command: ["-v"] },
    ])(`preserves the authored process without a generated command for ${via} %j`, async (process) => {
      // Given / When: a stock image has explicit process ownership.
      const plan = await compose({ via, ...process });
      // Then: an entrypoint alone must not acquire default server/keepalive arguments.
      expect(plan.entrypoint).toEqual(process.entrypoint);
      expect(plan.command).toEqual(process.command);
    });
  }

  test.each([
    { via: "apache", executable: "apache2-foreground" },
    { via: "fpm", executable: "php-fpm" },
  ])("keeps the normal $via default without an authored process", async ({ via, executable }) => {
    // Given / When
    const plan = await compose({ via });
    // Then
    expect(plan.command?.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(plan.command?.[2]).toContain(executable);
  });

  test("keeps the CLI idle process as direct argv", async () => {
    // Given / When
    const plan = await compose({ via: "cli" });
    // Then
    expect(plan.command).toEqual(["tail", "-f", "/dev/null"]);
  });
});
