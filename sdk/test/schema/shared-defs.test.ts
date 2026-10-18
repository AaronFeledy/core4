import { expect, test } from "bun:test";
import { getJsonSchema } from "@lando/sdk/schema";
import { Predicate } from "effect";

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
    expect(Predicate.isObject(document.properties)).toBe(true);
    expect(Predicate.isObject(document.$defs)).toBe(true);
    expect(Predicate.isObject(pruned.$defs)).toBe(true);
    if (
      !Predicate.isObject(document.properties) ||
      !Predicate.isObject(document.$defs) ||
      !Predicate.isObject(pruned.$defs)
    )
      return;
    for (const [field, contract] of contracts) {
      const { $schema: _schema, $defs: _defs, ...standalone } = getJsonSchema(contract);
      expect(standalone.$ref).toBeUndefined();
      expect(document.properties[field]).toMatchObject({ $ref: `#/$defs/${contract}` });
      expect(document.$defs[contract]).toEqual(standalone);
      expect(pruned.$defs[contract]).toEqual(standalone);
      expect(document.properties[field]).not.toHaveProperty("anyOf");
    }
  },
);

test.each([
  ["MysqlServiceConfig", "routes", "RouteInput"],
  ["PhpServiceConfig", "endpoints", "EndpointInput"],
  ["ServiceConfigInput", "logs", "LogSourceInput"],
] as const)("%s shares its %s item contract", (name, field, contract) => {
  // Given
  const document = getJsonSchema(name);
  const { $schema: _schema, $defs: _defs, ...standalone } = getJsonSchema(contract);
  // When
  const properties = document.properties;
  // Then
  expect(Predicate.isObject(properties)).toBe(true);
  expect(Predicate.isObject(document.$defs)).toBe(true);
  if (!Predicate.isObject(properties) || !Predicate.isObject(document.$defs)) return;
  expect(properties[field]).toMatchObject({ items: { $ref: `#/$defs/${contract}` } });
  expect(document.$defs[contract]).toEqual(standalone);
});
