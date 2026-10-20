import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type JsonSchema,
  type JsonValue,
  isJsonObject,
  jsonEquals,
} from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import delta from "./fixtures/x-extension-container-user.delta.json";
import {
  FIXTURE_PATH,
  loadNormalizedArtifact,
  parseCapturedExtension,
  repairClosedExtension,
  schemaAt,
  withIntentionalChangesSinceCapture,
} from "./x-extension-closed-record.ts";
import { evolveHistoricalContainerUser } from "./x-extension-container-user-proof.ts";
import { evolveHistoricalServicePort } from "./x-extension-port-proof.ts";
import { evolveHistoricalShorthand } from "./x-extension-shorthand-proof.ts";
import { evolveHistoricalTimestamps } from "./x-extension-timestamps-proof.ts";

const landofileWithUser = (user: JsonValue) => ({
  properties: {
    services: { additionalProperties: { properties: { user, image: { type: "string" } } } },
    user: { type: "number" },
  },
  anyOf: [{ properties: { user: { type: "string" } } }, { const: "sentinel" }],
});

test("pins the reviewed ContainerUser delta bytes and producer source provenance independently", async () => {
  // Given the separate, immutable reviewed delta.
  const bytes = await Bun.file(
    new URL("./fixtures/x-extension-container-user.delta.json", import.meta.url),
  ).bytes();
  // When its bytes and provenance are inspected without consulting live schemas.
  const digest = createHash("sha256").update(bytes).digest("hex");
  // Then neither a live schema change nor a recapture can redefine this expectation.
  expect(digest).toBe("f1792ca59d7b16a23d52e2db0183f2edf4d3aef9e2abbbcb2c9a528909fd60da");
  expect(delta.provenance).toEqual({
    commit: "fe52e912a43511d41c9bfcd430d19e649a927ca4",
    sources: {
      "sdk/src/schema/primitives.ts": "ec2fa3a99aa2c06b357a65e0c8d7b63b48bb6886",
      "sdk/src/schema/landofile.ts": "e712840c70ec4d7bd7969537c44b184748d2facd",
    },
  });
  expect(delta.pointer).toBe("/properties/services/additionalProperties/properties/user");
  expect(delta.before).toEqual({ type: "string" });
  expect(delta.after).toEqual({
    type: "string",
    pattern: "^[A-Za-z0-9_][A-Za-z0-9_.-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)?$",
  });
});

const rejectedUsers: readonly JsonValue[] = [
  { type: "string", pattern: "^.*$" },
  { type: "string", pattern: "" },
  { type: "string", minLength: 1 },
  { type: "string", enum: ["root"] },
  { type: "string", description: "extra key" },
  { type: "number" },
  {},
  null,
  false,
  [],
  "string",
  delta.after,
];
test.each(rejectedUsers.map((user) => ({ user })))(
  "rejects a user node outside the exact before contract: $user",
  ({ user }) => {
    // Given an altered target, with unrelated valid-looking user nodes nearby.
    const input = landofileWithUser(user);
    // When replay is attempted, then it fails closed rather than widening its precondition.
    expect(() => evolveHistoricalContainerUser(input)).toThrow(TypeError);
  },
);

test.each([
  {},
  { properties: null },
  { properties: [] },
  { properties: { user: { type: "string" } } },
  { properties: { services: false } },
  { properties: { services: { additionalProperties: [] } } },
  { properties: { services: { additionalProperties: { properties: null } } } },
  { properties: { services: { additionalProperties: { properties: { renamedUser: { type: "string" } } } } } },
  { services: { additionalProperties: { properties: { user: { type: "string" } } } } },
  { properties: { services: { properties: { web: { properties: { user: { type: "string" } } } } } } },
] satisfies readonly JsonSchema[])("rejects an absent, malformed or moved target: %j", (input) => {
  // Given a wrong ancestor chain and an unrelated user node.
  const historical = { ...input, unrelated: { user: { type: "string" } } };
  // When replay is attempted, then no recursive or permissive role lookup substitutes for the target.
  expect(() => evolveHistoricalContainerUser(historical)).toThrow(TypeError);
});

test("changes only the exact user node without mutating or normalizing its input", () => {
  // Given an exact target alongside unrelated user nodes and union data.
  const input = landofileWithUser({ type: "string" });
  const serialized = JSON.stringify(input);
  // When the reviewed change is replayed.
  const output = evolveHistoricalContainerUser(input);
  // Then only the ancestor chain is copied, and restoring the target restores all serialized bytes.
  expect(output).toEqual(landofileWithUser(delta.after));
  expect(output.anyOf).toBe(input.anyOf);
  expect(JSON.stringify(input)).toBe(serialized);
  const properties = output.properties;
  if (!isJsonObject(properties)) throw new TypeError("Missing properties");
  const services = properties.services;
  if (!isJsonObject(services)) throw new TypeError("Missing services");
  const service = services.additionalProperties;
  if (!isJsonObject(service)) throw new TypeError("Missing service");
  const fields = service.properties;
  if (!isJsonObject(fields)) throw new TypeError("Missing fields");
  expect(properties.user).toBe(input.properties.user);
  expect(fields.image).toBe(input.properties.services.additionalProperties.properties.image);
  const restored = {
    ...output,
    properties: {
      ...properties,
      services: {
        ...services,
        additionalProperties: { ...service, properties: { ...fields, user: { type: "string" } } },
      },
    },
  };
  expect(JSON.stringify(restored)).toBe(serialized);
  expect(() => evolveHistoricalContainerUser(output)).toThrow(TypeError);
});

test.each([
  ["removed pattern", { type: "string" }],
  ["altered pattern", { type: "string", pattern: "^.*$" }],
  ["extra constraint", { ...delta.after, minLength: 999 }],
] as const)("whole-current-subtree equality detects %s", async (_name, user) => {
  // Given the independently repaired historical input and a green current subtree baseline.
  const captured = parseCapturedExtension(await Bun.file(FIXTURE_PATH).json());
  const repaired = repairClosedExtension(withIntentionalChangesSinceCapture(captured.landofile));
  if (!isJsonObject(repaired)) throw new TypeError("Missing repaired Landofile");
  const expected = evolveHistoricalServicePort(
    evolveHistoricalTimestamps(
      evolveHistoricalContainerUser(evolveHistoricalShorthand(normalizeJsonSchema(repaired))),
      "bare",
    ),
  );
  const current = schemaAt(await loadNormalizedArtifact("schema:TemplateRenderContext"), "$.landofile");
  expect(jsonEquals(expected, current)).toBe(true);
  const properties = current.properties;
  if (!isJsonObject(properties)) throw new TypeError("Missing properties");
  const services = properties.services;
  if (!isJsonObject(services)) throw new TypeError("Missing services");
  const service = services.additionalProperties;
  if (!isJsonObject(service)) throw new TypeError("Missing service");
  const fields = service.properties;
  if (!isJsonObject(fields)) throw new TypeError("Missing fields");
  // When the actual current target is mutated, not the historical expectation.
  const mutated = {
    ...current,
    properties: {
      ...properties,
      services: {
        ...services,
        additionalProperties: { ...service, properties: { ...fields, user } },
      },
    },
  };
  // Then the complete comparison rejects every unapproved change.
  expect(jsonEquals(expected, mutated)).toBe(false);
  expect(jsonEquals(current, mutated)).toBe(false);
});
