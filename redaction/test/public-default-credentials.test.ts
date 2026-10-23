import { expect, test } from "bun:test";
import { Effect } from "effect";
import { collectSecretEnvValues, createStandaloneRedactor, makeRedactionService } from "../src/service.ts";

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
