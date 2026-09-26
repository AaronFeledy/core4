import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  createStandaloneRedactor,
  makeRedactionService,
  registerRedactionValues,
  resetRegisteredRedactionValuesForTesting,
} from "../src/service.ts";

const emptyStore = {
  id: "empty",
  get: () => Effect.succeed(""),
  has: () => Effect.succeed(false),
  list: Effect.succeed([]),
};

beforeEach(() => {
  resetRegisteredRedactionValuesForTesting();
});

afterEach(() => {
  resetRegisteredRedactionValuesForTesting();
});

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

test("whitespace-only and unsafe registrations are not redacted", async () => {
  // Given: a retained redactor and values the exact-value layer must ignore.
  const redactor = createStandaloneRedactor("secrets");
  const ansi = "\u001b[32mvisible text\u001b[0m";
  // When
  await Effect.runPromise(registerRedactionValues([" ", "\t", "32", "0;1", "1234", ""]));
  // Then: those values are not registered, so they neither mask text nor suppress ANSI.
  expect(redactor.redactString("visible text")).toBe("visible text");
  expect(redactor.redactString(ansi)).toBe(ansi);
  expect(redactor.redactString("1234")).toBe("1234");
});

test("unsafe registrations do not rebuild a retained redactor", async () => {
  // Given
  const service = makeRedactionService(emptyStore);
  let preparations = 0;
  const options = {
    redactionTokens: {
      *[Symbol.iterator]() {
        preparations += 1;
        yield "rebuild-filter-canary";
      },
    },
  };
  const redactor = await Effect.runPromise(service.forProfile("secrets", options));
  redactor.redactString("rebuild-filter-canary");
  const prepared = preparations;
  // When
  await Effect.runPromise(service.registerValues([" ", "32", "0;1", "1234", ""]));
  redactor.redactString("rebuild-filter-canary");
  // Then
  expect(preparations).toBe(prepared);
  expect(redactor.redactString("\u001b[32mvisible text\u001b[0m")).toBe("\u001b[32mvisible text\u001b[0m");
});

test("reset drops registered values and a replacement still rebuilds the retained redactor", async () => {
  // Given: one registered value, so a size-keyed cache would collide with the next one.
  const first = "generation-first-canary";
  const second = "generation-second-canary";
  await Effect.runPromise(registerRedactionValues([first]));
  const retained = createStandaloneRedactor("secrets");
  expect(retained.redactString(first)).toBe("[redacted]");
  // When
  resetRegisteredRedactionValuesForTesting();
  const cleared = retained.redactString(first);
  await Effect.runPromise(registerRedactionValues([second]));
  // Then
  expect(cleared).toBe(first);
  expect(retained.redactString(first)).toBe(first);
  expect(retained.redactString(second)).toBe("[redacted]");
  expect(createStandaloneRedactor("secrets").redactString(first)).toBe(first);
});
