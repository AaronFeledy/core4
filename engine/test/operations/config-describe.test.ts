import { expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { configKeySummary, describeConfigKey } from "../../src/config-write/key-schema.ts";
import { ConfigResultSchema, describeConfig } from "../../src/operations/config.ts";

test("describes a host config key without config sources or services", async () => {
  const result = await Effect.runPromise(describeConfig({ key: "router.httpPort", format: "json" }));
  expect(Schema.decodeUnknownSync(ConfigResultSchema)(result)).toMatchObject({
    subcommand: "describe",
    key: "router.httpPort",
    format: "json",
    summary: "an integer from 1 to 65535",
    schema: { type: "integer", minimum: 1, maximum: 65535 },
  });
});

test.each([undefined, ""])("lists root children for key %j", async (key) => {
  const result = await Effect.runPromise(describeConfigKey("installation", key));
  expect(result.key).toBe("");
  expect(result.keys?.find((child) => child.key === "router")).toMatchObject({ summary: "a mapping" });
});

test("unknown key errors identify the document, siblings, suggestion, and parent command", async () => {
  const result = await Effect.runPromise(
    describeConfigKey("installation", "router.httpPor").pipe(Effect.result),
  );
  expect(Result.isFailure(result) ? result.failure : undefined).toMatchObject({
    _tag: "ConfigKeyNotFoundError",
    key: "router.httpPor",
    document: "config.yml",
    validKeys: expect.arrayContaining(["httpPort", "httpsPort"]),
    suggestion: 'Did you mean "httpPort"?',
    remediation: "Run `lando config describe router` to list the valid keys under router.",
  });
});

test("an unknown intermediate key points at the deepest key that resolved", async () => {
  const result = await Effect.runPromise(
    describeConfigKey("global", "services.web.porst.target").pipe(Effect.result),
  );
  expect(Result.isFailure(result) ? result.failure : undefined).toMatchObject({
    _tag: "ConfigKeyNotFoundError",
    suggestion: 'Did you mean "port"?',
    remediation: "Run `lando global:config describe services.web` to list the valid keys under services.web.",
  });
});

test("malformed paths use the shared config path failure", async () => {
  const result = await Effect.runPromise(describeConfigKey("app", "services..type").pipe(Effect.result));
  expect(Result.isFailure(result) ? result.failure : undefined).toMatchObject({
    _tag: "LandofileWriteValidationError",
    path: "services..type",
    file: "Landofile",
  });
});

test("set remediation can query summaries without loading config", () => {
  expect(configKeySummary("GlobalConfig", "router.httpPort")).toBe("an integer from 1 to 65535");
  expect(configKeySummary("GlobalConfig", "router.nope")).toBeUndefined();
  expect(configKeySummary("GlobalConfig", "router..httpPort")).toBeUndefined();
});

test("host result decoding cannot accept an incomplete describe as a view", () => {
  expect(() =>
    Schema.decodeUnknownSync(ConfigResultSchema)({ subcommand: "describe", format: "json", key: "router" }),
  ).toThrow();
});
