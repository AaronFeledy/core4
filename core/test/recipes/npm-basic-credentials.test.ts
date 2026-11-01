import { expect, test } from "bun:test";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { parseNpmRegistryConfig } from "../../src/recipes/npm-registry-config";

const encoded = Buffer.from('alice:p@ss:\\$"word').toString("base64");

test.each([
  [`//npm.test/:_authToken=parent\n//npm.test/team/:_auth=${encoded}`, `Basic ${encoded}`],
  [`//npm.test/team/:_auth=${encoded}\n//npm.test/team/:_authToken=child`, "Bearer child"],
  [
    `//npm.test/team/:_auth=${encoded}\n//npm.test/team/:username=wrong\n//npm.test/team/:_password=eA==`,
    `Basic ${encoded}`,
  ],
  ["//npm.test/:username=parent\n//npm.test/team/:_password=c2VjcmV0", undefined],
  ["//npm.test/:_password=c2VjcmV0\n//npm.test/team/:username=child", undefined],
  ["//npm.test/team/:_auth=${MISSING}", undefined],
  ["//npm.test/team/:username=alice\n//npm.test/team/:_password=${MISSING}", undefined],
  ["//npm.test/team/:_auth=!!!!", undefined],
  ["//npm.test/team/:_auth=/w==", undefined],
  [`//npm.test/team/:_auth=${Buffer.from("alice:bad\npassword").toString("base64")}`, undefined],
] as const)("resolves scope-local credentials for %s", (text, expected) => {
  const config = parseNpmRegistryConfig(text);

  const authorization = config.authorizationFor("https://npm.test/team/pkg", "https://npm.test/team/");

  expect(authorization).toBe(expected);
});

test("registers raw, decoded, encoded and header Basic values before snapshot use", () => {
  const password = 'punctuation:@\\$"secret';
  const config = parseNpmRegistryConfig(
    `//npm.test/:username=alice\n//npm.test/:_password=${Buffer.from(password).toString("base64")}`,
  );

  const credential = config.credentialFor("https://npm.test/pkg", "https://npm.test/");

  expect(credential).toEqual({
    kind: "basic",
    username: "alice",
    password,
    authorization: `Basic ${Buffer.from(`alice:${password}`).toString("base64")}`,
  });
  for (const value of [
    password,
    `alice:${password}`,
    Buffer.from(password).toString("base64"),
    Buffer.from(`alice:${password}`).toString("base64"),
    `Basic ${Buffer.from(`alice:${password}`).toString("base64")}`,
  ])
    expect(config.redactionTokens).toContain(value);
});

test("suppresses Basic credentials on cross-host tarballs", () => {
  const config = parseNpmRegistryConfig(`//npm.test/:_auth=${encoded}\n//other.test/:_auth=${encoded}`);

  const authorization = config.authorizationFor("https://other.test/archive.tgz", "https://npm.test/");

  expect(authorization).toBeUndefined();
});

test("registers Basic values even when a same-key Bearer token wins", () => {
  const password = "lower-precedence-basic-secret";
  const auth = Buffer.from(`alice:${password}`).toString("base64");
  const config = parseNpmRegistryConfig(`//npm.test/:_authToken=chosen-token\n//npm.test/:_auth=${auth}`);

  const authorization = config.authorizationFor("https://npm.test/pkg", "https://npm.test/");

  expect(authorization).toBe("Bearer chosen-token");
  for (const value of [password, `alice:${password}`, auth, `Basic ${auth}`])
    expect(config.redactionTokens).toContain(value);
});

test("offers a copy-pasteable scoped token assignment", () => {
  const config = parseNpmRegistryConfig("");

  const remediation = config.authRemediation("https://npm.test/team/");

  expect(remediation.split("\n")).toContain("//npm.test/team/:_authToken=${NPM_TOKEN}");
});

test.each(["_auth", "_password"])("decoded %s passwords preserve literal placeholder-like bytes", (field) => {
  const password = "p${w}ord-canary";
  const value = Buffer.from(field === "_auth" ? `alice:${password}` : password).toString("base64");
  const config = parseNpmRegistryConfig(`//npm.test/:username=alice\n//npm.test/:${field}=${value}`);

  const credential = config.credentialFor("https://npm.test/", "https://npm.test/");

  expect(credential).toMatchObject({ kind: "basic", username: "alice", password });
  expect(config.redactionTokens).toContain(password);
});

test.each(["", "\n//npm.test/:_password=c2VjcmV0"])(
  "bare usernames are not secret values with pair %s",
  (pair) => {
    const config = parseNpmRegistryConfig(`//npm.test/:username=developer${pair}`);
    const redactor = createStandaloneRedactor("secrets", { authoritativeTokens: config.redactionTokens });

    const output = redactor.redactString("Installed plugin for developer on developer-ci");

    expect(config.redactionTokens).not.toContain("developer");
    expect(output).toBe("Installed plugin for developer on developer-ci");
  },
);
