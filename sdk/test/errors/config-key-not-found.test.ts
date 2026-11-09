import { expect, test } from "bun:test";
import { taggedErrorJson } from "@lando/sdk/command-result";
import { ConfigKeyNotFoundError } from "@lando/sdk/errors";
import { Schema } from "effect";

test("config key failures preserve discovery hints through the shared diagnostic projection", () => {
  const fields = {
    message: "Unknown config key.",
    key: "router.httpPor",
    document: "config.yml",
    validKeys: ["httpPort"],
    suggestion: 'Did you mean "httpPort"?',
    remediation: "Use `describe router` to list valid keys.",
  };
  const error = Schema.decodeUnknownSync(ConfigKeyNotFoundError)({
    _tag: "ConfigKeyNotFoundError",
    ...fields,
  });
  expect(taggedErrorJson(error)).toMatchObject({ _tag: "ConfigKeyNotFoundError", ...fields });
  expect(() =>
    Schema.decodeUnknownSync(ConfigKeyNotFoundError)({
      _tag: "ConfigKeyNotFoundError",
      ...fields,
      remediation: " ",
    }),
  ).toThrow();
});
