import { expect, test } from "bun:test";
import { REDACTED, createRedactor } from "@lando/sdk/secrets";

import { isCompleteEnvReference } from "../../src/secrets/env-placeholder.ts";

/** The documented reference bodies, one per accepted spelling. */
const REFERENCES = ["${TOKEN}", "${TOKEN?}", "$${TOKEN}", "$${TOKEN?}", "$TOKEN", "$Token_9"] as const;

/** Every quoted/escaped wrapper a complete reference may wear, keyed by its wrapper. */
const WRAPPERS = [
  { name: "bare", wrap: (reference: string) => reference },
  { name: "double-quoted", wrap: (reference: string) => `"${reference}"` },
  { name: "escaped once", wrap: (reference: string) => `\\"${reference}\\"` },
  { name: "escaped twice", wrap: (reference: string) => `\\\\"${reference}\\\\"` },
] as const;

const KEEP_VALUES = WRAPPERS.flatMap(({ wrap }) => REFERENCES.map(wrap));

const MASK_VALUES = [
  { value: "'${TOKEN}'", note: "single-quoted placeholder" },
  { value: "'$TOKEN'", note: "single-quoted bare reference" },
  { value: "\\${TOKEN}", note: "escaped dollar with braces" },
  { value: "\\$TOKEN", note: "escaped dollar" },
  { value: '\\"$TOKEN"', note: "unequal backslash runs" },
  { value: "${bad canary}", note: "malformed body" },
  { value: "${BAD-NAME}", note: "hyphen in the identifier" },
  { value: "${9TOKEN}", note: "leading digit" },
  { value: "$1", note: "positional parameter" },
  { value: "$$TOKEN", note: "doubled dollar without braces" },
  { value: "${TOKEN", note: "truncated braces" },
  { value: "$${TOKEN", note: "truncated doubled braces" },
  { value: "${TOKEN}x", note: "suffixed placeholder" },
  { value: "$${TOKEN}x", note: "suffixed doubled placeholder" },
  { value: "$TOKEN.b", note: "suffixed bare reference" },
  { value: '"$TOKEN"suffix', note: "suffixed quoted reference" },
  { value: "${TOKEN??}", note: "doubled question mark" },
] as const;

test.each(["secretAssignment", "signedQueryParam"] as const)(
  "%s grammar keeps every complete reference at a verified terminator",
  (name) => {
    const redactor = createRedactor("secrets");
    const prefix = name === "secretAssignment" ? "token=" : "?token=";
    // Each grammar has its own stop class; only that class verifies a terminator.
    const stop = name === "secretAssignment" ? "," : "&";
    for (const value of KEEP_VALUES) {
      const input = prefix + value;
      expect(redactor.redactPrefix(input)).toBe(input);
      const terminated = `${input}${stop}${name === "secretAssignment" ? "" : "next=1"}`;
      expect(redactor.redactPrefix(terminated)).toBe(terminated);
    }
  },
);

/** Unterminated quoted values survive the pattern stage so the detector can hold them. */
const UNTERMINATED_VALUES = [
  { value: '"$TOKEN\\"', note: "unequal backslash runs, trailing" },
  { value: '"hunter2', note: "unterminated double quote" },
  { value: "'hunter2", note: "unterminated single quote" },
] as const;

test.each(["secretAssignment", "signedQueryParam"] as const)(
  "%s grammar leaves an unterminated quoted value intact for the detector",
  (name) => {
    const redactor = createRedactor("secrets");
    const prefix = name === "secretAssignment" ? "token=" : "?token=";
    for (const { value, note } of UNTERMINATED_VALUES) {
      // The prefix stage never partially masks an open quote.
      expect(redactor.redactPrefix(prefix + value), note).toBe(prefix + value);
      // Complete text closes it instead.
      expect(redactor.redactString(prefix + value), note).toBe(`${prefix}${REDACTED}`);
    }
  },
);

test.each(["secretAssignment", "signedQueryParam"] as const)(
  "%s grammar masks every incomplete or malformed value",
  (name) => {
    const redactor = createRedactor("secrets");
    const prefix = name === "secretAssignment" ? "token=" : "?token=";
    for (const { value, note } of MASK_VALUES) {
      const output = redactor.redactPrefix(prefix + value);
      expect(output, note).toContain(REDACTED);
      expect(output, note).not.toContain(`${REDACTED}}`);
    }
  },
);

test("the mask never leaves a partial reference or a stray closing brace", () => {
  // Given malformed doubled-brace values that must be masked whole.
  const redactor = createRedactor("secrets");
  for (const value of ["$${bad canary}", "$${TOKEN", "$${TOKEN}x", "$${TOKEN}.x"]) {
    // When the assignment grammar redacts the value.
    // Then neither a partial reference nor any trailing bytes survive.
    expect(redactor.redactPrefix(`token=${value}`)).toBe(`token=${REDACTED}`);
  }
});

test("a doubled-brace reference at a closing brace is kept whole", () => {
  const redactor = createRedactor("secrets");
  for (const input of ["token=$${TOKEN}}", "token=${TOKEN}}", "{token=$TOKEN}"])
    expect(redactor.redactPrefix(input)).toBe(input);
});

test("isCompleteEnvReference accepts exactly one documented reference", () => {
  for (const value of KEEP_VALUES) expect(isCompleteEnvReference(value), value).toBe(true);
  for (const { value, note } of MASK_VALUES) expect(isCompleteEnvReference(value), note).toBe(false);
  expect(isCompleteEnvReference("")).toBe(false);
  // A trailing space, newline, or suffix is not part of any reference.
  for (const value of ["$TOKEN\n", "${TOKEN}\n", '"$TOKEN" ', "$TOKEN,", "${TOKEN}}"])
    expect(isCompleteEnvReference(value), JSON.stringify(value)).toBe(false);
});

/** Complete `${secret:...}` references the rendered Landofile must keep readable. */
const SECRET_REFERENCES = [
  "${secret:DB_PASSWORD}",
  "$${secret:DB_PASSWORD}",
  "${secret:store://bucket/path}",
  "$${secret:store://bucket/path/more/seg?version=latest}",
] as const;

test("isCompleteEnvReference accepts one complete secret reference in every form", () => {
  for (const reference of SECRET_REFERENCES)
    for (const { wrap } of WRAPPERS)
      expect(isCompleteEnvReference(wrap(reference)), wrap(reference)).toBe(true);
  for (const { value, note } of [
    { value: "${secret:}", note: "empty reference" },
    { value: "${secret:not a ref}", note: "spaces in the reference" },
    { value: "${secret:store://onlyone}", note: "single URI segment" },
    { value: "${secret:store://a/b/c/d/e}", note: "too many URI segments" },
    { value: "${secret:DB_PASSWORD}x", note: "suffixed reference" },
    { value: "prefix ${secret:DB_PASSWORD}", note: "prefixed reference" },
    { value: "${secret:DB_PASSWORD", note: "truncated reference" },
    { value: "'${secret:DB_PASSWORD}'", note: "single-quoted reference" },
  ] as const)
    expect(isCompleteEnvReference(value), note).toBe(false);
});

test.each(["secretAssignment", "signedQueryParam"] as const)(
  "%s grammar keeps a complete secret reference",
  (name) => {
    const redactor = createRedactor("secrets");
    const prefix = name === "secretAssignment" ? "token=" : "?token=";
    for (const reference of SECRET_REFERENCES)
      for (const { wrap } of WRAPPERS) {
        const input = prefix + wrap(reference);
        expect(redactor.redactPrefix(input), input).toBe(input);
      }
  },
);

test.each(["secrets", "telemetry", "transcript"] as const)(
  "registered reference literals stay authoritative for %s",
  (profile) => {
    // Given a registered reference in either value tier.
    for (const options of [{ values: ["${TOKEN}"] }, { authoritativeValues: ["${TOKEN}"] }]) {
      const redactor = createRedactor(profile, options);
      const input = "token=${TOKEN}";
      // When the profile redacts the reference.
      const output = redactor.redactString(input);
      // Then registered values win, including on the secrets profile's bounded path.
      expect(output).toBe(`token=${REDACTED}`);
      if (profile === "secrets")
        expect(redactor.redactStringBounded?.(input, 4096)).toBe(`token=${REDACTED}`);
    }
    // A registered value that is only part of the reference still wins.
    const partial = createRedactor(profile, { values: ["$TOKEN"] });
    expect(partial.redactString('token="$TOKEN"')).not.toContain("$TOKEN");
  },
);

test.each(["secrets", "telemetry", "transcript"] as const)(
  "%s masks a sensitive query parameter after a preserved reference",
  (profile) => {
    // Given a complete reference followed by another sensitive query parameter.
    const redactor = createRedactor(profile);
    const input = "?token=$TOKEN&sig=private-canary";
    // When the query is redacted through the public profile.
    const output = redactor.redactString(input);
    // Then the reference survives and the next parameter is still visited.
    expect(output).toBe(`?token=$TOKEN&sig=${REDACTED}`);
  },
);

test("object secret fields remain masked even when they contain a reference", () => {
  expect(createRedactor("secrets").redactValue({ token: "$TOKEN" })).toEqual({ token: REDACTED });
  expect(createRedactor("secrets").redactValue({ token: 'PASSWORD="$TOKEN"' })).toEqual({
    token: REDACTED,
  });
});

test("bounded assignments share complete-reference and malformed-value behavior", () => {
  const redactor = createRedactor("secrets");
  for (const value of [...KEEP_VALUES, ...MASK_VALUES.map(({ value }) => value)]) {
    const input = `token=${value}`;
    expect(redactor.redactStringBounded?.(input, 4096)).toBe(redactor.redactString(input));
  }
});
