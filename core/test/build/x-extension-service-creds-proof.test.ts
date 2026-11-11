import { expect, test } from "bun:test";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { evolveHistoricalServiceCreds } from "./x-extension-service-creds-proof.ts";

const password = { anyOf: [{ type: "string" }, { type: "object", minProperties: 1 }] };
const framework = { type: "string" };
const historical = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string" },
    image: { type: "string" },
    database: { type: "string" },
    password,
    framework,
    creds: {
      type: "object",
      additionalProperties: false,
      properties: {
        user: { type: "string" },
        password,
        database: { type: "string" },
        rootPassword: password,
      },
      required: ["database", "password", "user"],
    },
  },
};

test("moves published service login fields under creds and adds the matching bucket projection", () => {
  const input = structuredClone(historical);
  const before = structuredClone(input);
  const evolved = evolveHistoricalServiceCreds(input);
  expect(evolved).toEqual(
    normalizeJsonSchema({
      ...input,
      properties: {
        type: input.properties.type,
        image: input.properties.image,
        framework,
        bucket: framework,
        creds: {
          type: "object",
          additionalProperties: false,
          properties: input.properties.creds.properties,
        },
      },
    }),
  );
  expect(input).toEqual(before);
  expect(evolveHistoricalServiceCreds(evolved)).toEqual(evolved);
});

test("preserves an unreviewed creds required array", () => {
  const input = structuredClone(historical);
  input.properties.creds.required = ["user"];
  expect(evolveHistoricalServiceCreds(input)).toEqual(normalizeJsonSchema(input));
});

test("does not treat an unrelated object as a service config", () => {
  const input = { type: "object", properties: { database: { type: "string" }, password } };
  expect(evolveHistoricalServiceCreds(input)).toEqual(normalizeJsonSchema(input));
});

test("drops the historical creds required array from an authoring union branch", () => {
  const expression = { type: "string", pattern: "^expr$" };
  const credsObject = {
    type: "object",
    additionalProperties: false,
    properties: {
      user: { type: "string" },
      password,
      database: { type: "string" },
      rootPassword: password,
    },
    required: ["database", "password", "user"],
  };
  const { required: _required, ...credsWithoutRequired } = credsObject;
  const input = {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string" },
      image: { type: "string" },
      database: { type: "string" },
      password,
      framework,
      creds: { anyOf: [credsObject, expression] },
    },
  };
  const evolved = evolveHistoricalServiceCreds(structuredClone(input));
  expect(evolved).toEqual(
    normalizeJsonSchema({
      ...input,
      properties: {
        type: input.properties.type,
        image: input.properties.image,
        framework,
        bucket: framework,
        creds: { anyOf: [credsWithoutRequired, expression] },
      },
    }),
  );
  expect(evolveHistoricalServiceCreds(evolved)).toEqual(evolved);
});

test("moves directive service login fields without narrowing nested override requirements", () => {
  const override = (value: { readonly [key: string]: unknown }, required: readonly string[]) => ({
    additionalProperties: false,
    properties: {
      _tag: { enum: ["LandofileOverride"], type: "string" },
      value,
    },
    required,
    type: "object",
  });
  const reset = {
    additionalProperties: false,
    properties: { _tag: { enum: ["LandofileReset"], type: "string" } },
    required: ["_tag"],
    type: "object",
  };
  const nested = override({ type: "string" }, ["_tag", "value"]);
  const stringField = { anyOf: [override({ type: "string" }, ["_tag", "value"]), reset, { type: "string" }] };
  const passwordField = {
    anyOf: [
      { additionalProperties: false, properties: { reference: nested }, type: "object" },
      override({ anyOf: [{ type: "string" }] }, ["_tag", "value"]),
      reset,
    ],
  };
  const rootPassword = { anyOf: [override({ anyOf: [{ type: "string" }] }, ["_tag"]), reset] };
  const credsObject = {
    additionalProperties: false,
    properties: {
      database: stringField,
      password: passwordField,
      rootPassword,
      user: stringField,
    },
    type: "object",
  };
  const narrowedString = { anyOf: [override({ type: "string" }, ["_tag"]), reset, { type: "string" }] };
  const narrowedPassword = {
    anyOf: [
      { additionalProperties: false, properties: { reference: nested }, type: "object" },
      override({ anyOf: [{ type: "string" }] }, ["_tag"]),
      reset,
    ],
  };
  const narrowedCreds = {
    ...credsObject,
    properties: {
      ...credsObject.properties,
      database: narrowedString,
      password: narrowedPassword,
      user: narrowedString,
    },
  };
  const input = {
    additionalProperties: false,
    properties: {
      type: { type: "string" },
      image: { type: "string" },
      database: stringField,
      password: passwordField,
      framework,
      creds: {
        anyOf: [override(credsObject, ["_tag"]), reset, credsObject, { pattern: "^expr$", type: "string" }],
      },
    },
    type: "object",
  };
  const evolved = evolveHistoricalServiceCreds(structuredClone(input));
  expect(evolved).toEqual(
    normalizeJsonSchema({
      ...input,
      properties: {
        type: input.properties.type,
        image: input.properties.image,
        framework,
        bucket: framework,
        creds: {
          anyOf: [
            override(narrowedCreds, ["_tag"]),
            reset,
            narrowedCreds,
            { pattern: "^expr$", type: "string" },
          ],
        },
      },
    }),
  );
  expect(evolveHistoricalServiceCreds(evolved)).toEqual(evolved);
});
