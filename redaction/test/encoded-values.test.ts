import { expect, test } from "bun:test";
import { REDACTED, createPayloadRedactor } from "@lando/sdk/secrets";
import { Effect } from "effect";
import { createStandaloneRedactor, makeRedactionService } from "../src/service.ts";

const escapedSecret = 'p@ss/"w:\\rd\n?☃';
const variants = [
  ["raw", "p@ss/w:rd", "p@ss/w:rd"],
  ["URL", "p@ss/w:rd", "p%40ss%2Fw%3Ard"],
  ["JSON unchanged", "p@ss/w:rd", "p@ss/w:rd"],
  ["base64 unchanged alphabet", "p@ss/w:rd", "cEBzcy93OnJk"],
  ["escaped raw", escapedSecret, escapedSecret],
  ["UTF-8 URL", escapedSecret, "p%40ss%2F%22w%3A%5Crd%0A%3F%E2%98%83"],
  ["JSON", escapedSecret, 'p@ss/\\"w:\\\\rd\\n?☃'],
  ["base64 padded", escapedSecret, "cEBzcy8idzpccmQKP+KYgw=="],
  ["base64 unpadded", escapedSecret, "cEBzcy8idzpccmQKP+KYgw"],
  ["base64url padded", escapedSecret, "cEBzcy8idzpccmQKP-KYgw=="],
  ["base64url unpadded", escapedSecret, "cEBzcy8idzpccmQKP-KYgw"],
  ["base64 slash", "\uffff", "77+/"],
  ["base64url underscore", "\uffff", "77-_"],
] as const;

for (const source of ["resolved", "registered", "authoritative", "caller", "env"] as const) {
  test.each(variants)(`${source} masks %s in both layers`, async (_name, secret, variant) => {
    // Given
    const service = makeRedactionService();
    if (source === "resolved") await Effect.runPromise(service.registerValues([secret]));
    const options = {
      authoritativeTokens: source === "authoritative" ? [secret] : [],
      redactionTokens: source === "caller" ? [secret] : [],
      sourceEnv: source === "env" ? { APP_SECRET: secret } : {},
    };
    const strings = await Effect.runPromise(service.forProfile("secrets", options));
    const standalone = createStandaloneRedactor("secrets", {
      ...options,
      authoritativeTokens:
        source === "registered" || source === "resolved" ? [secret] : options.authoritativeTokens,
    });
    const getValues = await Effect.runPromise(service.payloadValues(options));
    const initial = getValues();
    const text = `<>${variant}<>`;
    const bytes = new TextEncoder().encode(text);
    // When
    if (source === "registered") await Effect.runPromise(service.registerValues([secret]));
    const stringOutput = strings.redactString(text);
    // Then
    expect(stringOutput).toBe(`<>${REDACTED}<>`);
    expect(strings.redactStringBounded?.(text, 4096)).toBe(`<>${REDACTED}<>`);
    expect(standalone.redactString(text)).toBe(`<>${REDACTED}<>`);
    if (source === "registered") expect(getValues()).not.toBe(initial);
    expect(getValues()).toBe(getValues());
    for (let split = 0; split <= bytes.length; split += 1) {
      const payload = createPayloadRedactor(getValues);
      const output = Buffer.concat([
        payload.write(bytes.subarray(0, split)),
        payload.write(bytes.subarray(split)),
        payload.flush(),
      ]).toString();
      expect(output).toBe(`<>${REDACTED}<>`);
    }
  });
}

test("unusable encoded variants are dropped rather than suppressing strings or corrupting ANSI", async () => {
  // Given: U+33B4 encodes as the unsafe short numeric base64 value 4460.
  const service = makeRedactionService();
  const options = { authoritativeTokens: ["\u33b4"] };
  const strings = await Effect.runPromise(service.forProfile("secrets", options));
  const getValues = await Effect.runPromise(service.payloadValues(options));
  const text = "\u001b[32mvisible 4460\u001b[0m";
  // When
  const payload = createPayloadRedactor(getValues);
  const output = Buffer.concat([payload.write(new TextEncoder().encode(text)), payload.flush()]).toString();
  // Then
  expect([...getValues()]).not.toContain("4460");
  expect(strings.redactString(text)).toBe(text);
  expect(output).toBe(text);
  expect(strings.redactString("<>\u33b4<>")).toBe(`<>${REDACTED}<>`);
});

test.each(["lando", "landolando"])("heuristic default %s keeps encoded forms", async (secret) => {
  // Given
  const options = { sourceEnv: { DB_PASSWORD: secret } };
  const strings = createStandaloneRedactor("secrets", options);
  const service = makeRedactionService();
  const getValues = await Effect.runPromise(service.payloadValues(options));
  const text = `<>${Buffer.from(secret).toString("base64")}<>`;
  // When
  const payload = createPayloadRedactor(getValues);
  const output = Buffer.concat([payload.write(new TextEncoder().encode(text)), payload.flush()]).toString();
  // Then
  expect(strings.redactString(text)).toBe(text);
  expect(output).toBe(text);
});

test("raw unusable authoritative values suppress string details and mask payload bytes", async () => {
  // Given
  const options = { authoritativeTokens: ["32"] };
  const strings = createStandaloneRedactor("secrets", options);
  const service = makeRedactionService();
  const getValues = await Effect.runPromise(service.payloadValues(options));
  const text = "\u001b[32mvisible 32\u001b[0m";
  // When
  const payload = createPayloadRedactor(getValues);
  const output = Buffer.concat([payload.write(new TextEncoder().encode(text)), payload.flush()]).toString();
  // Then
  expect(strings.redactString(text)).toBe(REDACTED);
  expect(strings.redactStringBounded?.(text, 4096)).toBe(REDACTED);
  expect(output).not.toContain("32");
});
