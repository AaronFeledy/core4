import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Effect } from "effect";

import { appNameFor } from "../src/app-name.ts";
import { mysqlServiceType } from "../src/services/mysql.ts";
import { rabbitmqServiceType } from "../src/services/rabbitmq.ts";
import { type ComposeServicePlanArgs, composeServicePlan } from "./support/compose-harness.ts";

describe("appNameFor", () => {
  test.each([
    { appName: "authored", appRoot: "/srv/fallback", expected: "authored" },
    { appName: "", appRoot: "/srv/fallback/", expected: "fallback" },
    { appName: undefined, appRoot: "/srv/fallback", expected: "fallback" },
    { appName: "", appRoot: "/", expected: "app" },
    { appName: undefined, appRoot: "", expected: "app" },
    { appName: " ", appRoot: "/srv/fallback", expected: " " },
  ])("resolves $expected when appName is $appName and appRoot is $appRoot", (input) => {
    const actual = appNameFor(input);

    expect(actual).toBe(input.expected);
  });
});

describe("app-name consumers", () => {
  test("keeps RabbitMQ's resolver-specific route policy when the app name is empty", async () => {
    const input = {
      name: "queue",
      service: { type: "rabbitmq" },
      appName: "",
      appRoot: "/srv/fallback",
      metadata: { resolvedAt: "2026-10-02T00:00:00Z", source: "/srv/fallback/.lando.yml", runtime: 4 },
    } satisfies Parameters<typeof rabbitmqServiceType.resolve>[0];

    const resolution = await Effect.runPromise(rabbitmqServiceType.resolve(input));

    expect(resolution.normalizedConfig.routes).toEqual([{ hostname: "queue..lndo.site", endpoint: 15672 }]);
  });

  test.each([
    { appName: "authored", expected: "authored" },
    { appName: "", expected: "fallback" },
    { appName: undefined, expected: "fallback" },
  ])("uses $expected for credentials, storage and environment when appName is $appName", async (input) => {
    const args = {
      serviceType: mysqlServiceType,
      service: { type: "mysql" },
      serviceName: "db",
      appRoot: "/srv/fallback",
      metadata: { resolvedAt: "2026-10-02T00:00:00Z", source: "/srv/fallback/.lando.yml", runtime: 4 },
      ...(input.appName === undefined ? {} : { appName: input.appName }),
    } satisfies ComposeServicePlanArgs;

    const plan = await composeServicePlan(args);

    expect(plan.environment.MYSQL_DATABASE).toBe(input.expected);
    expect(plan.environment.LANDO_APP_NAME).toBe(input.expected);
    expect(plan.environment.MYSQL_ROOT_PASSWORD).toBe(
      `lando-${createHash("sha256").update(`${input.expected}:db:root`).digest("hex").slice(0, 24)}`,
    );
    expect(plan.storage[0]?.store).toBe(`${input.expected}-db-mysql-data`);
  });
});
