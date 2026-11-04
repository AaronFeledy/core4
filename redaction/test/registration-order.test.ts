import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createStandaloneRedactor, makeRedactionOwner, makeRedactionService } from "../src/service.ts";

test("a value registered after construction is redacted in later output", async () => {
  // Given: an already retained redactor and a store that never lists values.
  const service = makeRedactionService();
  const redactor = await Effect.runPromise(service.forProfile("secrets"));
  // When
  await Effect.runPromise(service.registerValues(["late-registration-canary", "☃"]));
  // Then: registration is authoritative, including short values.
  expect(redactor.redactString("late-registration-canary")).toBe("[redacted]");
  expect(redactor.redactValue({ value: "☃" })).toEqual({ value: "[redacted]" });
});

test("standalone redactor does not inherit another runtime's registered value", async () => {
  // Given
  const secret = "standalone-registered-canary";
  await Effect.runPromise(makeRedactionService().registerValues([secret]));
  // When
  const redactor = createStandaloneRedactor("secrets");
  // Then
  expect(redactor.redactString(secret)).toBe(secret);
});

test("retained standalone redactor remains pure after later registration", async () => {
  // Given
  const service = makeRedactionService();
  const redactor = createStandaloneRedactor("secrets");
  const secret = "standalone-late-canary";
  // When
  await Effect.runPromise(service.registerValues([secret]));
  // Then
  expect(redactor.redactString(secret)).toBe(secret);
  expect(redactor.redactValue({ value: secret })).toEqual({ value: secret });
});

test.each(["service", "standalone"] as const)(
  "%s redactor reuses prepared tokens until a new value is registered",
  async (mode) => {
    // Given
    const service = makeRedactionService();
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
    expect(redactor.redactString(secret)).toBe(mode === "service" ? "[redacted]" : secret);
    expect(preparations).toBe(prepared + (mode === "service" ? 1 : 0));
    await Effect.runPromise(service.registerValues([secret, ""]));
    expect(redactor.redactString(secret)).toBe(mode === "service" ? "[redacted]" : secret);
    expect(preparations).toBe(prepared + (mode === "service" ? 1 : 0));
  },
);

test("nonempty unsafe registrations authoritatively suppress containing details", async () => {
  const service = makeRedactionService();
  const redactor = await Effect.runPromise(service.forProfile("secrets"));
  const ansi = "\u001b[32mvisible text\u001b[0m";
  // When
  await Effect.runPromise(service.registerValues([" ", "\t", "32", "0;1", "1234", ""]));
  expect(redactor.redactString("visible text")).toBe("[redacted]");
  expect(redactor.redactString(ansi)).toBe("[redacted]");
  expect(redactor.redactString("1234")).toBe("[redacted]");
});

test("unsafe registrations rebuild a retained redactor but empty registrations do not", async () => {
  // Given
  const service = makeRedactionService();
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
  await Effect.runPromise(service.registerValues(["32", "0;1", "1234", ""]));
  redactor.redactString("rebuild-filter-canary");
  // Then
  expect(preparations).toBe(prepared + 1);
  expect(redactor.redactString("\u001b[32mvisible text\u001b[0m")).toBe("[redacted]");
  await Effect.runPromise(service.registerValues([""]));
  redactor.redactString("rebuild-filter-canary");
  expect(preparations).toBe(prepared + 1);
});

test("disposing one owner clears only its registrations and retained redactor", async () => {
  // Given: one registered value, so a size-keyed cache would collide with the next one.
  const first = "generation-first-canary";
  const second = "generation-second-canary";
  const owner = makeRedactionOwner();
  const other = makeRedactionService();
  await Effect.runPromise(owner.service.registerValues([first]));
  await Effect.runPromise(other.registerValues([second]));
  const retained = await Effect.runPromise(owner.service.forProfile("secrets"));
  const otherRedactor = await Effect.runPromise(other.forProfile("secrets"));
  expect(retained.redactString(first)).toBe("[redacted]");
  // When
  owner.dispose();
  const cleared = retained.redactString(first);
  // Then
  expect(cleared).toBe(first);
  expect(retained.redactString(first)).toBe(first);
  expect(retained.redactString(second)).toBe(second);
  expect(otherRedactor.redactString(second)).toBe("[redacted]");
  expect(createStandaloneRedactor("secrets").redactString(first)).toBe(first);
});
