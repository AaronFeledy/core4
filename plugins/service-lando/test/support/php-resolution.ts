import type { ServiceConfig } from "@lando/sdk/schema";
import { Effect } from "effect";
import { php83ServiceType } from "../../src/services/php.ts";

export const phpResolution = (service: ServiceConfig, name = "web") =>
  Effect.runSync(
    php83ServiceType.resolve({
      name,
      service,
      appRoot: "/srv/apps/php-policy",
      metadata: { resolvedAt: "2026-10-29T00:00:00Z", source: "php-policy", runtime: 4 },
    }),
  );
