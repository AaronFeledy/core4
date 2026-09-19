import { expect, test } from "bun:test";
import { yamlRoundTripCorpus } from "@lando/sdk/test";
import { isYamlPlainSafe, quoteYamlScalar, yamlMappingKeyText, yamlScalarText } from "@lando/sdk/yaml";

test("quoteYamlScalar always double-quotes with JSON escapes", () => {
  // Given: strings with quotes, whitespace, backslashes, and a control character.
  const values = ["plain", "", '"q"', "line\nbreak", "\ttab", "back\\slash", "\u0001"];
  // When / Then: quoting produces the JSON-escaped double-quoted scalar.
  for (const value of values) expect(quoteYamlScalar(value)).toBe(JSON.stringify(value));
  expect(quoteYamlScalar("\u0001")).toBe('"\\u0001"');
});

test("isYamlPlainSafe rejects the Bun.YAML core danger list", () => {
  // Given: core-resolved values, indicators, and shapes outside the allowlist.
  const values = [
    "",
    "~",
    "foo:",
    "true",
    "True",
    "TRUE",
    "false",
    "False",
    "FALSE",
    "null",
    "Null",
    "NULL",
    "0",
    "-1",
    "+5",
    "007",
    "0x10",
    "0o17",
    "-0xAF",
    "+0o17",
    "1.0",
    ".5",
    "1e5",
    "1.",
    "-.5e-2",
    ".inf",
    ".Inf",
    ".INF",
    "-.Inf",
    "+.INF",
    ".nan",
    ".NaN",
    ".NAN",
    "-",
    ":",
    "?",
    "---",
    "...",
    "[redacted]",
    "a: b",
    "*anchor",
    "&anchor",
    "!tag",
    "%dir",
    "@at",
    "#hash",
    "a#b",
    "|",
    ">",
    "[x]",
    "{x}",
    "'q'",
    '"dq"',
    " lead",
    "trail ",
    "\ttab",
    "line\nbreak",
    "back\\slash",
    "\u0001",
    "--flag=1",
  ];
  // When / Then: the fail-closed policy rejects each value.
  for (const value of values) expect(isYamlPlainSafe(value), JSON.stringify(value)).toBe(false);
});

test("isYamlPlainSafe keeps the fixture-critical plain set", () => {
  // Given: fixture spellings within the exact allowlist (which excludes a#b).
  const values = [
    "8080:80",
    ":host",
    "./x",
    "/abs",
    "docker.io/n:1",
    "yes",
    "no",
    "on",
    "off",
    "y",
    "n",
    "0b101",
    "12_000",
    "2026-09-19",
    "--",
    "a-b_c.d",
  ];
  // When / Then: each spelling stays plain.
  for (const value of values) expect(isYamlPlainSafe(value), value).toBe(true);
});

test("yamlScalarText emits plain iff Bun.YAML.parse returns the identical string", () => {
  // Given: the shared danger-value corpus.
  for (const value of yamlRoundTripCorpus) {
    // When: the policy emits a value in mapping and sequence contexts.
    const text = yamlScalarText(value);
    // Then: both YAML parses preserve the string, and quoting follows the predicate.
    expect(Bun.YAML.parse(`k: ${text}`)).toEqual({ k: value });
    expect(Bun.YAML.parse(`- ${text}`)).toEqual([value]);
    expect(text).toBe(isYamlPlainSafe(value) ? value : quoteYamlScalar(value));
  }
});

test("yamlMappingKeyText quotes ambiguous and non-allowlisted keys", () => {
  // Given: ambiguous keys and allowlisted keys.
  const quoted = ["true", "Yes", "no", "on", "off", "y", "n", "Null", "8080", "a b", "a:b", "", "<<", "foo:"];
  const plain = ["db", "telemetry.enabled", "x_y/z"];
  // When / Then: keys use their stricter ambiguity policy.
  for (const key of quoted) expect(yamlMappingKeyText(key)).toBe(JSON.stringify(key));
  for (const key of plain) expect(yamlMappingKeyText(key)).toBe(key);
});
