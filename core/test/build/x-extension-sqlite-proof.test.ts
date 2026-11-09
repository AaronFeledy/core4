import { expect, test } from "bun:test";

import { isJsonObject, jsonEquals } from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import {
  AUTHORING_SQLITE,
  BARE_SQLITE,
  DIRECTIVE_SQLITE,
  evolveHistoricalSqliteTarget,
} from "./x-extension-sqlite-proof.ts";
import { TYPED_EXPRESSION_PATTERN } from "./x-extension-wire-proof.ts";

const serviceProperties = {
  database: { type: "string" },
  image: { type: "string" },
  type: { type: "string" },
  user: { type: "string" },
};

const sqliteProperty = (schema: ReturnType<typeof evolveHistoricalSqliteTarget>) =>
  isJsonObject(schema.properties) ? schema.properties.sqlite : undefined;

test("inserts the bare sqlite object onto a closed service config", () => {
  const historical = {
    type: "object",
    additionalProperties: false,
    properties: serviceProperties,
  };
  const evolved = evolveHistoricalSqliteTarget(historical);
  expect(jsonEquals(sqliteProperty(evolved), BARE_SQLITE)).toBe(true);
  expect(jsonEquals(evolveHistoricalSqliteTarget(evolved), evolved)).toBe(true);
});

test("inserts the authoring sqlite union when a sibling object field is already a union", () => {
  const historical = {
    type: "object",
    additionalProperties: false,
    properties: {
      ...serviceProperties,
      creds: {
        anyOf: [
          { type: "object", additionalProperties: false, properties: {} },
          { type: "string", pattern: TYPED_EXPRESSION_PATTERN },
        ],
      },
    },
  };
  const evolved = evolveHistoricalSqliteTarget(historical);
  expect(jsonEquals(sqliteProperty(evolved), AUTHORING_SQLITE)).toBe(true);
});

test("inserts the directive sqlite envelope when a sibling field already carries override", () => {
  const historical = {
    type: "object",
    additionalProperties: false,
    properties: {
      ...serviceProperties,
      image: {
        anyOf: [
          {
            additionalProperties: false,
            properties: {
              _tag: { enum: ["LandofileOverride"], type: "string" },
              value: { type: "string" },
            },
            required: ["_tag", "value"],
            type: "object",
          },
          { type: "string" },
        ],
      },
    },
  };
  const evolved = evolveHistoricalSqliteTarget(historical);
  expect(jsonEquals(sqliteProperty(evolved), DIRECTIVE_SQLITE)).toBe(true);
});

test("does not insert sqlite onto an unrelated closed object", () => {
  const historical = normalizeJsonSchema({
    type: "object",
    additionalProperties: false,
    properties: { path: { type: "string" }, type: { type: "string" } },
  });
  expect(jsonEquals(evolveHistoricalSqliteTarget(historical), historical)).toBe(true);
});
