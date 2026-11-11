import { expect, test } from "bun:test";
import { composeService } from "@lando/engine/services/feature";
import {
  ARTIFACT_REFRESH_EXTENSION,
  ProviderId,
  STOCK_TAG_REFRESH_AFTER_MS,
  ServiceConfig,
  ServiceName,
} from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

import { PHP_FEATURE_ID, phpServiceFeature } from "../src/services/php.ts";
import { phpResolution } from "./support/php-resolution.ts";

const planFor = (config: unknown) => {
  const authored = Schema.decodeUnknownSync(ServiceConfig)(config);
  const resolution = phpResolution(authored);
  const feature = resolution.features.find(({ id }) => id === PHP_FEATURE_ID);
  if (feature === undefined) throw new Error("missing PHP feature");
  return Effect.runPromise(
    composeService({
      appRoot: "/srv/apps/php-refresh",
      appSlug: "php-refresh",
      base: {
        name: ServiceName.make("appserver"),
        type: "php:8.4",
        provider: ProviderId.make("test"),
        primary: true,
        defaultFeatures: [],
      },
      baseKind: "lando",
      normalizedConfig: authored,
      resolutionMetadata: resolution.metadata,
      features: [{ ...feature, definition: phpServiceFeature }],
    }),
  );
};

test("stock PHP checks its floating tag weekly", async () => {
  const plan = await planFor({ type: "php:8.4" });
  expect(plan.extensions[ARTIFACT_REFRESH_EXTENSION]).toEqual({ afterMs: STOCK_TAG_REFRESH_AFTER_MS });
});

test("a custom PHP image is not put on the weekly check", async () => {
  const plan = await planFor({ type: "php:8.4", image: "php:8.4.12-apache-bookworm" });
  expect(plan.extensions[ARTIFACT_REFRESH_EXTENSION]).toBeUndefined();
});
