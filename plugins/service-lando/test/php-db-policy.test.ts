import { expect, test } from "bun:test";
import { AppFeatureMutationConflictError } from "@lando/sdk/errors";
import { ServiceConfig } from "@lando/sdk/schema";
import type { AppFeatureServiceView, ServiceBuildStepIntent } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { phpDbClientFeature } from "../src/services/php-db-client.ts";
import { PHP_RUNTIME_POLICY_KEY } from "../src/services/php-runtime-policy.ts";
import { PHP_FEATURE_ID } from "../src/services/php.ts";
import { phpResolution } from "./support/php-resolution.ts";
import { recordFeatureContext } from "./support/record-feature-context.ts";

type PhpDraft = AppFeatureServiceView & { readonly buildSteps: ServiceBuildStepIntent[] };
const php = (name: string, config: Readonly<Record<string, unknown>> = {}): PhpDraft => {
  const service = Schema.decodeUnknownSync(ServiceConfig)({ type: "php:8.3", ...config });
  const resolved = phpResolution(service, name);
  return {
    primary: false,
    buildSteps: [],
    serviceName: name,
    serviceType: "php:8.3",
    base: "lando",
    featureIds: [PHP_FEATURE_ID],
    normalizedConfig: service,
    resolutionMetadata: resolved.metadata,
  };
};
const apply = (services: readonly PhpDraft[]) =>
  phpDbClientFeature.apply({
    featureId: phpDbClientFeature.id,
    appRoot: "/srv/php-db-policy",
    selected: services,
    config: {},
    select: () => undefined,
    forEachSelected: (mutate) => {
      for (const service of services) {
        const { ctx } = recordFeatureContext({
          serviceType: "test",
          normalizedConfig: service.normalizedConfig,
          config: {},
        });
        mutate({
          ...ctx,
          service,
          addBuildStep: (step) => {
            service.buildSteps.push(step);
          },
        });
      }
    },
  });

test.each([undefined, {}, { [PHP_RUNTIME_POLICY_KEY]: { baseFamily: "private-secret-payload" } }])(
  "DB clients reject missing/malformed policy before touching earlier senders %j",
  async (resolutionMetadata) => {
    // Given
    const first = php("first", { db_client: "postgres:16" });
    const second = { ...php("second"), resolutionMetadata };
    // When
    const result = await Effect.runPromise(Effect.result(apply([first, second])));
    // Then
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(AppFeatureMutationConflictError);
      expect(result.failure).toMatchObject({ service: "second", field: "resolutionMetadata" });
      expect(JSON.stringify(result.failure)).not.toContain("private-secret-payload");
    }
    expect(first.buildSteps).toEqual([]);
    expect(second.buildSteps).toEqual([]);
  },
);

test("DB clients honor resolved ownership rather than a contradictory normalized image", async () => {
  // Given
  const stock = {
    ...php("stock", { db_client: "postgres:16" }),
    normalizedConfig: Schema.decodeUnknownSync(ServiceConfig)({
      type: "php:8.3",
      image: "acme/php:8",
      db_client: "postgres:16",
    }),
  };
  const external = {
    ...php("external", { image: "php:8.2-cli-bullseye", db_client: "postgres:16" }),
    normalizedConfig: Schema.decodeUnknownSync(ServiceConfig)({ type: "php:8.3", db_client: "postgres:16" }),
  };
  // When
  await Effect.runPromise(apply([stock, external]));
  // Then
  expect(stock.buildSteps.map(({ id }) => id)).toEqual(["service-lando.php:db-client:postgres"]);
  expect(external.buildSteps).toEqual([]);
});

test.each(["auto", false, "postgres:16"])(
  "DB detection runs only once when eligible stock selection needs it (%j)",
  async (selection) => {
    // Given
    const services = [
      php("one", { db_client: selection }),
      php("two", { db_client: selection }),
      php("three", { image: "acme/php:8", db_client: "auto" }),
    ];
    let reads = 0;
    const database: PhpDraft = {
      ...php("database"),
      featureIds: [],
      get serviceType() {
        reads++;
        return "postgres";
      },
    };
    // When
    await Effect.runPromise(apply([...services, database]));
    // Then
    expect(reads).toBe(selection === "auto" ? 1 : 0);
    expect(services[0]?.buildSteps).toHaveLength(selection === false ? 0 : 1);
    expect(services[1]?.buildSteps).toHaveLength(selection === false ? 0 : 1);
    expect(services[2]?.buildSteps).toEqual([]);
  },
);
