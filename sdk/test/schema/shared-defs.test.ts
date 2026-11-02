import { expect, test } from "bun:test";
import { AppMountInput, EndpointInput, LogSourceInput, RouteInput, getJsonSchema } from "@lando/sdk/schema";
import { Schema } from "effect";

import { pruneUnusedDefinitions } from "../../src/schema/json-schema-definitions.ts";

test.each([
  [
    "EndpointInput",
    () => Schema.decodeUnknownSync(EndpointInput)(true),
    'Expected an internal or published endpoint object with "_tag"',
  ],
  [
    "RouteInput",
    () => Schema.decodeUnknownSync(RouteInput)(true),
    "Expected a non-empty route shorthand string or route object",
  ],
  [
    "AppMountInput",
    () => Schema.decodeUnknownSync(AppMountInput)(true),
    "Expected false, a destination string, or an app-mount object",
  ],
  [
    "LogSourceInput",
    () => Schema.decodeUnknownSync(LogSourceInput)(true),
    "Expected a log source object with an absolute path",
  ],
] as const)(
  "%s retains useful expected-form diagnostics alongside its shared identifier",
  (_name, decode, expected) => {
    // Given / When / Then
    expect(decode).toThrow(expected);
  },
);

test.each(["MysqlServiceConfig", "PhpServiceConfig"] as const)(
  "%s references shared Landofile field definitions without inlining their unions",
  (name) => {
    // Given
    const document = getJsonSchema(name);
    const contracts = [
      ["healthcheck", "HealthcheckInput"],
      ["appMount", "AppMountInput"],
    ] as const;

    // When
    const pruned = pruneUnusedDefinitions(structuredClone(document));

    // Then
    for (const [field, contract] of contracts) {
      const { $schema: _schema, $defs: _defs, ...standalone } = getJsonSchema(contract);
      expect(standalone.$ref).toBeUndefined();
      expect(document).toHaveProperty(["properties", field, "$ref"], `#/$defs/${contract}`);
      expect(document).toHaveProperty(["$defs", contract], standalone);
      expect(pruned).toHaveProperty(["$defs", contract], standalone);
      expect(document).not.toHaveProperty(["properties", field, "anyOf"]);
    }
  },
);

test.each([
  ["MysqlServiceConfig", "routes", "RouteInput"],
  ["PhpServiceConfig", "endpoints", "EndpointInput"],
  ["ServiceConfigInput", "logs", "LogSourceInput"],
] as const)("%s shares its %s item contract", (name, field, contract) => {
  // Given
  const { $schema: _schema, $defs: _defs, ...standalone } = getJsonSchema(contract);
  // When
  const document = getJsonSchema(name);
  // Then
  expect(document).toHaveProperty(["properties", field, "items", "$ref"], `#/$defs/${contract}`);
  expect(document).toHaveProperty(["$defs", contract], standalone);
});
