import { afterEach, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  collectSecretEnvValues,
  createStandaloneRedactor,
  makeRedactionService,
  registerRedactionValues,
  resetRegisteredRedactionValuesForTesting,
} from "../src/service.ts";

afterEach(resetRegisteredRedactionValuesForTesting);

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

test("keeps a published default visible when registered after standalone construction", async () => {
  // Given
  const redactor = createStandaloneRedactor("secrets");
  // When
  await Effect.runPromise(registerRedactionValues(["lando"]));
  // Then
  expect(redactor.redactString("hello lando world")).toBe("hello lando world");
});

test.each(["redactionTokens", "authoritativeTokens"] as const)(
  "keeps published defaults supplied through %s visible",
  (option) => {
    // Given
    const redactor = createStandaloneRedactor("secrets", { [option]: ["lando", "landolando"] });
    // When
    const output = redactor.redactString("lando landolando");
    // Then
    expect(output).toBe("lando landolando");
  },
);

test("keeps published defaults retrieved from a secret store visible", async () => {
  // Given
  const service = makeRedactionService({
    id: "defaults",
    list: Effect.succeed(["password"]),
    get: () => Effect.succeed("lando"),
    has: () => Effect.succeed(true),
  });
  // When
  const redactor = await Effect.runPromise(service.forProfile("secrets"));
  // Then
  expect(redactor.redactString("hello lando world")).toBe("hello lando world");
});

test("preserves pattern and deep-key masking for published defaults", () => {
  // Given
  const redactor = createStandaloneRedactor("secrets", { sourceEnv: { DB_PASSWORD: "lando" } });
  // When
  const output = redactor.redactValue({ password: "lando", output: "password=lando http://user:lando@host" });
  // Then
  expect(output).toEqual({ password: "[redacted]", output: "password=[redacted] http://[redacted]@host" });
});
