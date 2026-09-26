import { expect, test } from "bun:test";
import { Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";
import { serviceTypes } from "../src/index.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const catalog = [...serviceTypes.entries()].filter(([type]) => type !== "node");

for (const endpoints of [
  [],
  [{ _tag: "internal", name: "authored", protocol: "http", port: 18080 }],
] as const) {
  test.each(catalog)(
    `%s preserves exactly the authored endpoints ${JSON.stringify(endpoints)}`,
    async (type, serviceType) => {
      // Given: ports must not leak into an explicit endpoint list either.
      const service = Schema.decodeUnknownSync(ServiceConfig)({
        type,
        home: false,
        ports: ["18081:8081"],
        endpoints,
        ...(type === "lando" || type === "compose" ? { image: "alpine:3" } : {}),
        ...(type.startsWith("varnish") ? { backend: "origin" } : {}),
      });
      // When
      const plan = await composeServicePlan({
        serviceType,
        service,
        appRoot: "/srv/app",
        serviceName: "worker",
        metadata: { resolvedAt: "2026-09-23T00:00:00Z", source: "/srv/app/.lando.yml", runtime: 4 },
      });
      // Then
      expect(plan.endpoints).toEqual(endpoints);
    },
  );
}
