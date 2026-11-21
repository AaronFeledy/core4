import { expect, test } from "bun:test";
import { ServiceLauncherMarker, ServiceLaunchers, getJsonSchema } from "@lando/sdk/schema";
import { Result, Schema } from "effect";

const validTable = { ":local-bin2": ["env", "NAME=value"] } as const;

test.each([
  { table: { ":local-bin2": ["env", "NAME=value"] }, valid: true },
  { table: { ":host": ["env"] }, valid: false },
  { table: { ":Bad": ["env"] }, valid: false },
  { table: { local: ["env"] }, valid: false },
  { table: { ":local": [] }, valid: false },
  { table: { ":local": [""] }, valid: false },
])("validates launcher table $table", ({ table, valid }) => {
  expect(Schema.is(ServiceLaunchers)(table)).toBe(valid);
});

test.each([":local-bin", ":node-install-run", ":a", ":a1-b2"] as const)(
  "accepts and round-trips marker %s",
  (marker) => {
    // Given / When
    const decoded = Schema.decodeUnknownSync(ServiceLauncherMarker)(marker);
    // Then
    expect(decoded).toBe(marker);
    expect(Schema.encodeSync(ServiceLauncherMarker)(decoded)).toBe(marker);
  },
);

test.each([":host", ":Host", ":Bad", "local", ":", ":1", ":-a", ":a_b"] as const)(
  "rejects marker %j",
  (marker) => {
    // Given / When
    const decoded = Schema.decodeUnknownResult(ServiceLauncherMarker)(marker);
    // Then
    // :host matches the marker grammar but is reserved only on the table; marker alone accepts it.
    if (marker === ":host") expect(Result.isSuccess(decoded)).toBe(true);
    else expect(Result.isFailure(decoded)).toBe(true);
  },
);

test("round-trips a valid launcher table through encode/decode", () => {
  // Given / When
  const decoded = Schema.decodeUnknownSync(ServiceLaunchers)(validTable);
  const encoded = Schema.encodeSync(ServiceLaunchers)(decoded);
  // Then
  expect(encoded).toEqual(validTable);
  expect(Schema.decodeUnknownSync(ServiceLaunchers)(encoded)).toEqual(decoded);
});

test("publishes ServiceLauncherMarker pattern grammar", () => {
  // Given / When
  const json = getJsonSchema("ServiceLauncherMarker");
  // Then
  expect(json).toMatchObject({
    type: "string",
    pattern: "^:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
  });
  expect(json.title).toBe("Service Launcher Marker");
});

test("publishes ServiceLaunchers key grammar, :host exclusion, and nonempty prefix", () => {
  // Given / When
  const json = getJsonSchema("ServiceLaunchers");
  // Then
  expect(json.type).toBe("object");
  expect(json.propertyNames).toMatchObject({
    pattern: "^:[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
    not: { const: ":host" },
  });
  expect(json.title).toBe("Service Launchers");

  const valueSchema = json.additionalProperties;
  expect(valueSchema).toEqual(
    expect.objectContaining({
      type: "array",
      minItems: 1,
    }),
  );
  const serialized = JSON.stringify(valueSchema);
  expect(serialized).toContain('"minLength":1');
  expect(serialized).toMatch(/"prefixItems"/);
});
