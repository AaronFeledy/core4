import { expect, test } from "bun:test";
import {
  REDACTED,
  createPayloadRedactor,
  isPublicDefaultCredential,
  isUsableExactRedactionValue,
} from "@lando/sdk/secrets";
import { Effect } from "effect";
import { createStandaloneRedactor, makeRedactionOwner, makeRedactionService } from "../src/service.ts";

test("registry tiers refresh retained string and payload redactors on substring upgrade", () => {
  const owner = makeRedactionOwner();
  const service = owner.service;
  const strings = Effect.runSync(service.forProfile("secrets"));
  const getValues = Effect.runSync(service.payloadValues());
  Effect.runSync(service.registerValues(["wordpress"], { match: "whole-token" }));
  const initial = getValues();
  expect([...initial.wholeToken]).toContain("wordpress");
  expect([...initial.substring]).not.toContain("wordpress");
  expect(strings.redactString("wordpress wordpress-seo")).toBe("[redacted] wordpress-seo");
  const payload = createPayloadRedactor(getValues);
  expect(payload.write(new TextEncoder().encode("wordpress")).length).toBe(0);

  Effect.runSync(service.registerValues(["wordpress"]));
  const output = payload.write(new TextEncoder().encode("-seo!"));
  expect(new TextDecoder().decode(output)).toBe("[redacted]-seo!");
  expect(strings.redactString("wordpress-seo")).toBe("[redacted]-seo");
  expect(getValues()).not.toBe(initial);
  expect([...getValues().wholeToken]).not.toContain("wordpress");
  owner.dispose();
  expect(strings.redactString("wordpress")).toBe("wordpress");
  expect([...getValues().substring, ...getValues().wholeToken]).toEqual([]);
});

test("profile and standalone caches distinguish whole-token values from substring values", () => {
  const service = makeRedactionService();
  const options = { wholeTokenValues: ["wordpress"] };
  const whole = createStandaloneRedactor("secrets", options);
  const substring = createStandaloneRedactor("secrets", { redactionTokens: ["wordpress"] });
  const empty = createStandaloneRedactor("secrets");
  const profile = Effect.runSync(service.forProfile("secrets", options));
  const payload = createPayloadRedactor(Effect.runSync(service.payloadValues(options)));
  const text = "wordpress wordpress-seo!";
  expect(whole.redactString(text)).toBe("[redacted] wordpress-seo!");
  expect(profile.redactString(text)).toBe("[redacted] wordpress-seo!");
  expect(substring.redactString(text)).toBe("[redacted] [redacted]-seo!");
  expect(empty.redactString(text)).toBe(text);
  expect(new TextDecoder().decode(payload.write(new TextEncoder().encode(text)))).toBe(
    "[redacted] wordpress-seo!",
  );
});

test.each(["32", "1234", "0;1", " \t"])("unusable whole-token registration never suppresses %j", (value) => {
  const service = makeRedactionService();
  Effect.runSync(service.registerValues([value], { match: "whole-token" }));
  const profile = Effect.runSync(service.forProfile("secrets"));
  const standalone = createStandaloneRedactor("secrets", { wholeTokenValues: [value] });
  const text = `\u001b[32mvisible ${value}\u001b[0m`;
  expect(profile.redactString(text)).toBe(text);
  expect(standalone.redactString(text)).toBe(text);
  expect(profile.redactStringBounded?.(text, 1000)).toBe(text);
  const values = Effect.runSync(service.payloadValues())();
  expect([...values.substring, ...values.wholeToken]).toEqual([]);
});

test("payload values combine resolved values, tokens and late registrations without heuristic defaults", async () => {
  // Given
  const service = makeRedactionService();
  await Effect.runPromise(service.registerValues(["store-value"]));
  const getValues = await Effect.runPromise(
    service.payloadValues({
      redactionTokens: ["plan-value"],
      sourceEnv: { DB_PASSWORD: "landolando", AGENT_TOKEN: "agent-value" },
    }),
  );
  const redactor = createPayloadRedactor(getValues);
  const initial = getValues();
  // When
  await Effect.runPromise(service.registerValues(["late-value"]));
  const bytes = redactor.write(
    new TextEncoder().encode("store-value plan-value agent-value late-value landolando!"),
  );
  // Then
  expect(new TextDecoder().decode(bytes)).toBe(`${REDACTED} ${REDACTED} ${REDACTED} ${REDACTED} landolando!`);
  expect(getValues()).not.toBe(initial);
  expect(getValues()).toBe(getValues());
});

test.each([
  "lando",
  "landolando",
  "",
  " \t",
  "32",
  "1234",
  "38;2;255;0;0",
  "a",
  "☃",
  "12345678",
  "private-value",
  "LANDO",
  " lando ",
] as const)("payload masks exactly the usable values the string layer masks for %j", async (value) => {
  // Given
  const text = `<>${value}<>`;
  const masked = `<>${REDACTED}<>`;
  for (const source of ["resolved", "plan", "env", "registered"] as const) {
    const service = makeRedactionService();
    if (source === "resolved") await Effect.runPromise(service.registerValues([value]));
    const options = {
      redactionTokens: source === "plan" ? [value] : [],
      sourceEnv: source === "env" ? { AGENT_TOKEN: value } : {},
    };
    const getValues = await Effect.runPromise(service.payloadValues(options));
    const strings = await Effect.runPromise(service.forProfile("secrets", options));
    // When
    if (source === "registered") await Effect.runPromise(service.registerValues([value]));
    const payload = createPayloadRedactor(getValues);
    const bytes = new TextEncoder().encode(text);
    const first = payload.write(bytes.subarray(0, 9));
    const second = payload.write(bytes.subarray(9));
    const output = Buffer.concat([first, second, payload.flush()]).toString();
    // Then: heuristic sources drop public defaults; explicit sources keep them.
    const heuristic = source === "env";
    const authority = source === "resolved" || source === "registered";
    const eligible = authority
      ? value.length > 0
      : value.trim().length > 0 &&
        isUsableExactRedactionValue(value) &&
        !(heuristic && isPublicDefaultCredential(value));
    expect(output).toBe(eligible ? masked : text);
    if (authority && value.length > 0 && !isUsableExactRedactionValue(value))
      expect(strings.redactString(text)).toBe(REDACTED);
    else if (eligible) expect(strings.redactString(text)).toBe(masked);
    else expect(strings.redactString(text)).toBe(text);
  }
});
