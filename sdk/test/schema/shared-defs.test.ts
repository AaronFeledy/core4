import { expect, test } from "bun:test";
import { getJsonSchema } from "@lando/sdk/schema";

import { pruneUnusedDefinitions } from "../../src/schema/json-schema-definitions.ts";

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
