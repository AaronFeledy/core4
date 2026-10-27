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
