import { expect, test } from "bun:test";
import { createPayloadRedactor } from "@lando/sdk/secrets";
import { Effect } from "effect";
import {
  collectPublicCredentialValues,
  collectSecretEnvValues,
  createStandaloneRedactor,
  makeRedactionService,
} from "../src/service.ts";

test.each([
  { MARIADB_USER: "magento", MARIADB_PASSWORD: "magento", MARIADB_DATABASE: "shop" },
  { POSTGRES_USER: "magento", POSTGRES_PASSWORD: "magento", POSTGRES_DB: "shop" },
  {
    MONGO_INITDB_ROOT_USERNAME: "magento",
    MONGO_INITDB_ROOT_PASSWORD: "magento",
    MONGO_INITDB_DATABASE: "shop",
  },
  { LANDO_DB_USER: "magento", LANDO_DB_PASSWORD: "magento", LANDO_DB_NAME: "shop" },
  { MYSQL_USER: "magento", MYSQL_ROOT_PASSWORD: "magento" },
  { LANDO_DB_USER: "magento", LANDO_DB_ROOT_PASSWORD: "magento" },
  { MYSQL_USER: "shop", MYSQL_PASSWORD: "magento", MYSQL_DATABASE: "magento" },
])("excludes a password published as its own tuple's identity: %j", (env) => {
  expect(collectSecretEnvValues({ ...env, PROJECT_PASSWORD: "magento" })).toEqual([]);
});

test.each([
  { MYSQL_USER: "magento", MYSQL_PASSWORD: "magento-dev", MYSQL_DATABASE: "magento" },
  { MYSQL_USER: "Magento", MYSQL_PASSWORD: "magento-dev", MYSQL_DATABASE: "shop" },
  { APP_NAME: "magento-dev", DB_PASSWORD: "magento-dev" },
  { OWNER_USER: "magento-dev", OWNER_PASSWORD: "magento-dev" },
  { MYSQL_USER: "magento-dev", POSTGRES_PASSWORD: "magento-dev" },
  { MYSQL_USER: "magento-dev", MARIADB_PASSWORD: "magento-dev" },
  { PGPASSWORD: "magento-dev", DB_PASSWORD: "magento-dev" },
  { MYSQL_PWD: "magento-dev", DB_PASSWORD: "magento-dev" },
])("keeps passwords without an exact same-tuple identity match: %j", (env) => {
  expect(collectSecretEnvValues(env)).toContain("magento-dev");
});

test("excludes public values supplied by the enclosing scope", () => {
  expect(
    collectSecretEnvValues({ PMA_PASSWORD: "magento", API_TOKEN: "private-token" }, new Set(["magento"])),
  ).toEqual(["private-token"]);
});

test("compares tuple identities case-sensitively without treating empty values as public", () => {
  expect(collectSecretEnvValues({ MYSQL_USER: "Magento", MYSQL_PASSWORD: "magento" })).toEqual(["magento"]);
  expect(collectPublicCredentialValues({ MYSQL_USER: "", MYSQL_PASSWORD: "" }).size).toBe(0);
});

test("preserves package names in payload output with public credential values", () => {
  const values = collectSecretEnvValues({ MYSQL_USER: "magento", MYSQL_PASSWORD: "magento" });
  const payload = createPayloadRedactor(() => values);
  const text = "mage-os/magento-coding-standard --magento-init-params lando exec appserver -- echo magento";
  expect(Buffer.concat([payload.write(new TextEncoder().encode(text)), payload.flush()]).toString()).toBe(
    text,
  );
});

test("explicit registration still masks a public credential value", async () => {
  const service = makeRedactionService();
  const redactor = await Effect.runPromise(
    service.forProfile("secrets", {
      sourceEnv: { MYSQL_USER: "magento", MYSQL_PASSWORD: "magento" },
    }),
  );
  await Effect.runPromise(service.registerValues(["magento"]));
  expect(redactor.redactString("echo magento")).toBe("echo [redacted]");
});

test("excludes only exact published defaults when collecting secret environment values", () => {
  // Given
  const sourceEnv = {
    DB_PASSWORD: "lando",
    MINIO_SECRET: "landolando",
    UPPER_PASSWORD: "LANDO",
    PADDED_PASSWORD: " lando ",
    SUFFIX_PASSWORD: "lando-custom",
    PREFIX_PASSWORD: "mylando",
    CUSTOM_PASSWORD: "private-password",
  };
  // When
  const values = collectSecretEnvValues(sourceEnv);
  // Then
  expect(values).toEqual(["LANDO", " lando ", "lando-custom", "mylando", "private-password"]);
});

test("keeps ordinary Lando output visible when source environment uses published defaults", () => {
  // Given
  const redactor = createStandaloneRedactor("secrets", { sourceEnv: { DB_PASSWORD: "lando" } });
  const output =
    "hello lando world; provider-lando failed; Run `lando doctor`; /home/aaron/.cache/lando/logs";
  // When
  const redacted = redactor.redactString(output);
  // Then
  expect(redacted).toBe(output);
});

test("masks a published default when explicitly registered after service redactor construction", async () => {
  // Given
  const service = makeRedactionService();
  const redactor = await Effect.runPromise(service.forProfile("secrets"));
  // When
  await Effect.runPromise(service.registerValues(["lando"]));
  // Then
  expect(redactor.redactString("hello lando world")).toBe("hello [redacted] world");
});

test.each(["redactionTokens", "authoritativeTokens"] as const)(
  "masks published defaults supplied through %s",
  (option) => {
    // Given
    const redactor = createStandaloneRedactor("secrets", { [option]: ["lando", "landolando"] });
    // When
    const output = redactor.redactString("lando landolando");
    // Then
    expect(output).toBe("[redacted] [redacted]");
  },
);

test("masks explicitly resolved published defaults", async () => {
  // Given
  const service = makeRedactionService();
  await Effect.runPromise(service.registerValues(["lando"]));
  // When
  const redactor = await Effect.runPromise(service.forProfile("secrets"));
  // Then
  expect(redactor.redactString("hello lando world")).toBe("hello [redacted] world");
});

test("preserves pattern and deep-key masking for published defaults", () => {
  // Given
  const redactor = createStandaloneRedactor("secrets", { sourceEnv: { DB_PASSWORD: "lando" } });
  // When
  const output = redactor.redactValue({ password: "lando", output: "password=lando http://user:lando@host" });
  // Then
  expect(output).toEqual({ password: "[redacted]", output: "password=[redacted] http://[redacted]@host" });
});
