import { expect, test } from "bun:test";
import { collectSecretEnvValues, collectSecretStructuralValues } from "../src/service.ts";

test("collects camelCase, acronym and alias env values without collecting tokenizer settings", () => {
  const env = {
    stripeSecretKey: "sk_test_canary",
    PGPASSWORD: "pg-private",
    MYSQL_PWD: "mysql-private",
    APIToken: "api-private",
    TOKENIZERS_PARALLELISM: "false",
  };
  expect(collectSecretEnvValues(env)).toEqual([
    "sk_test_canary",
    "pg-private",
    "mysql-private",
    "api-private",
  ]);
});

test("structural collection excludes weak words and metadata while retaining public-value rules", () => {
  expect(
    collectSecretStructuralValues(
      {
        key: "storage-name",
        defaultSecretStore: "env",
        rootPassword: "root-private",
        apiToken: "api-private",
        password: "lando",
        clientSecret: "public",
      },
      new Set(["public"]),
    ),
  ).toEqual(["root-private", "api-private"]);
});
