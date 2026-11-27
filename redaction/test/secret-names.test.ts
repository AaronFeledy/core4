import { expect, test } from "bun:test";
import { collectSecretEnvValues, collectSecretStructuralValues } from "../src/service.ts";

test("collects env-specific keys without collecting tokenizer settings", () => {
  const env = {
    stripeSecretKey: "sk_test_canary",
    cacheKey: "cache-private",
    TOKENIZERS_PARALLELISM: "false",
  };
  expect(collectSecretEnvValues(env)).toEqual(["sk_test_canary", "cache-private"]);
});

test("structural collection excludes weak words and metadata while retaining public-value rules", () => {
  expect(
    collectSecretStructuralValues(
      {
        key: "storage-name",
        defaultSecretStore: "env",
        rootPassword: "root-private",
        password: "lando",
        clientSecret: "public",
      },
      new Set(["public"]),
    ),
  ).toEqual(["root-private"]);
});

test("collects secret-named string members from flat JSON environment maps", () => {
  const env = {
    LANDO_SERVICE_DEFAULTS_ENVIRONMENT: ' {"API_TOKEN":"trace-private","REGION":"region-public"}',
    LANDO_SERVICE_DEFAULTS_LABELS: '{"clientSecret":"label-private","password":"lando","cacheKey":"public"}',
    OTHER_MAP: '{"cacheKey":"cache-private"}',
    MALFORMED: '{"API_TOKEN":"invalid-private"',
    NESTED: '{"API_TOKEN":"nested-map-private","child":{"API_TOKEN":"nested-private"}}',
    ARRAY: '[{"API_TOKEN":"array-private"}]',
  };

  expect(collectSecretEnvValues(env, new Set(["public"]))).toEqual([
    "trace-private",
    "label-private",
    "cache-private",
  ]);
});
