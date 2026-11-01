import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { JsonValue } from "../../../scripts/schema-compatibility/model.ts";
import delta from "./fixtures/x-extension-native-init.delta.json";
import { evolveHistoricalNativeInit } from "./x-extension-native-init-proof.ts";

const landofileWithInit = (init: JsonValue) => ({
  properties: {
    services: {
      additionalProperties: {
        properties: { init, image: { type: "string" } },
        required: ["type"],
        additionalProperties: false,
      },
    },
    init: { type: "number" },
  },
});

test("pins the approved native-init delta independently of live schemas", async () => {
  const bytes = await Bun.file(
    new URL("./fixtures/x-extension-native-init.delta.json", import.meta.url),
  ).bytes();
  const digest = createHash("sha256").update(bytes).digest("hex");
  expect(digest).toBe("0afb1459d2a73326ff094fe1cf31aa63ddc20134619fee8305c1e2e30894ec6d");
  expect(delta.provenance).toEqual({
    commit: "618de04eebeb503c5f40ecd58fe84135baa187a5",
    sources: {
      "sdk/src/schema/compose-knob-scalars.ts": "6e0864cc0ce187aa16193b489da9a7e1219b4e3f",
    },
  });
  expect(delta.pointer).toBe("/properties/services/additionalProperties/properties/init");
});

test("replays only the exact optional service init node without mutating historical input", () => {
  const input = landofileWithInit({ anyOf: [{ type: "boolean" }, { type: "string" }] });
  const serialized = JSON.stringify(input);
  const output = evolveHistoricalNativeInit(input);
  expect(output).toEqual(landofileWithInit(delta.after));
  expect(JSON.stringify(input)).toBe(serialized);
  expect(() => evolveHistoricalNativeInit(output)).toThrow(TypeError);
});

test.each([
  {},
  { type: "boolean" },
  { anyOf: [{ type: "boolean" }, { type: "string", minLength: 1 }] },
  { anyOf: [{ type: "boolean" }, { type: "string" }], default: true },
  delta.after,
  null,
] satisfies readonly JsonValue[])("rejects unapproved historical init constraints: %j", (init) => {
  const input = landofileWithInit(init);
  expect(() => evolveHistoricalNativeInit(input)).toThrow(TypeError);
});

test.each([
  {},
  { properties: { init: delta.before } },
  { properties: { services: { additionalProperties: { properties: { renamedInit: delta.before } } } } },
])("rejects missing or moved service init targets: %j", (input) => {
  expect(() => evolveHistoricalNativeInit(input)).toThrow(TypeError);
});

test("the approved init pattern accepts only complete ASCII boolean spellings", () => {
  const branch = delta.after.anyOf.find((entry) => entry.pattern !== undefined);
  if (branch?.pattern === undefined) throw new TypeError("Missing approved init spelling pattern");
  const pattern = new RegExp(branch.pattern);
  for (const value of ["true", "FALSE", "TrUe", "ON", "off", "YeS", "nO", "0", "1"])
    expect(pattern.test(value), value).toBe(true);
  for (const value of ["", "enabled", "2", " true", "true ", "true\n", "oﬀ", "yes\r\n"])
    expect(pattern.test(value), value).toBe(false);
});
