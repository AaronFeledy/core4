import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createStandaloneRedactor, makeRedactionService, registerRedactionValues } from "../src/service.ts";

const emptyStore = {
  id: "empty",
  get: () => Effect.succeed(""),
  has: () => Effect.succeed(false),
  list: Effect.succeed([]),
};

test("a value registered after construction is redacted in later output", async () => {
  // Given: an already retained redactor and a store that never lists values.
  const service = makeRedactionService({
    id: "empty",
    get: () => Effect.succeed(""),
    has: () => Effect.succeed(false),
    list: Effect.succeed([]),
  });
  const redactor = await Effect.runPromise(service.forProfile("secrets"));
  // When
  await Effect.runPromise(service.registerValues(["late-registration-canary", "☃"]));
  // Then: registration is authoritative, including short values.
  expect(redactor.redactString("late-registration-canary")).toBe("[redacted]");
  expect(redactor.redactValue({ value: "☃" })).toEqual({ value: "[redacted]" });
});

test("standalone redactor redacts a registered value", async () => {
  // Given
  const secret = "standalone-registered-canary";
  await Effect.runPromise(registerRedactionValues([secret]));
  // When
  const redactor = createStandaloneRedactor("secrets");
  // Then
  expect(redactor.redactString(secret)).toBe("[redacted]");
});

test("retained standalone redactor observes later registration", async () => {
  // Given
  const service = makeRedactionService(emptyStore);
  const redactor = createStandaloneRedactor("secrets");
  const secret = "standalone-late-canary";
  // When
  await Effect.runPromise(service.registerValues([secret]));
  // Then
  expect(redactor.redactString(secret)).toBe("[redacted]");
  expect(redactor.redactValue({ value: secret })).toEqual({ value: "[redacted]" });
});

test.each(["service", "standalone"] as const)(
  "%s redactor reuses prepared tokens until a new value is registered",
  async (mode) => {
    // Given
    const service = makeRedactionService(emptyStore);
    const secret = `cache-registration-${mode}`;
    let preparations = 0;
    const options = {
      redactionTokens: {
        *[Symbol.iterator]() {
          preparations += 1;
          yield "option-cache-canary";
        },
      },
    };
    const redactor =
      mode === "service"
        ? await Effect.runPromise(service.forProfile("secrets", options))
        : createStandaloneRedactor("secrets", options);
    redactor.redactString("option-cache-canary");
    const prepared = preparations;
    // When
    const result = redactor.redactValue({ value: "option-cache-canary" });
    // Then
    expect(result).toEqual({ value: "[redacted]" });
    expect(preparations).toBe(prepared);

    await Effect.runPromise(service.registerValues([secret]));
    expect(redactor.redactString(secret)).toBe("[redacted]");
    expect(preparations).toBe(prepared + 1);
    await Effect.runPromise(service.registerValues([secret, ""]));
    expect(redactor.redactString(secret)).toBe("[redacted]");
    expect(preparations).toBe(prepared + 1);
  },
);
