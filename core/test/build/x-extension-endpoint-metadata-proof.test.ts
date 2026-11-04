import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { evolveHistoricalEndpointMetadata } from "./x-extension-endpoint-metadata-proof.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

const bytes = await Bun.file(
  new URL("./fixtures/x-extension-endpoint-metadata.delta.json", import.meta.url),
).bytes();
const delta = wireObject(JSON.parse(new TextDecoder().decode(bytes)));
if (!Array.isArray(delta.additions)) throw new TypeError("Missing endpoint additions");

test("pins the endpoint metadata delta independently of live schemas", () => {
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "86acf75bd1f839145ee9e087d533e4e4bdb262af42eadba34c2ff5e23f510a7e",
  );
  expect(delta.provenance).toEqual({
    commit: "f71c279070a2a98f78528acb2c7cf7aa6bf1b350",
    sources: { "sdk/src/schema/endpoint.ts": "d1e992efa00c8f76d39291374e59c84971ecae8f" },
  });
  expect(delta.additions).toHaveLength(6);
});

for (const [index, entry] of delta.additions.entries()) {
  const pair = wireObject(entry);
  const before = wireObject(pair.before);
  const after = wireObject(pair.after);
  test(`replays only the optional endpoint fields for projection ${index}`, () => {
    const input = structuredClone(before);
    expect(evolveHistoricalEndpointMetadata(input)).toEqual(after);
    expect(input).toEqual(before);
    expect(after.required).toEqual(before.required);
    const properties = Object.fromEntries(
      Object.entries(wireObject(after.properties)).filter(
        ([key]) =>
          key !== "primary" && (key !== "appProtocol" || "appProtocol" in wireObject(before.properties)),
      ),
    );
    expect(normalizeJsonSchema({ ...after, properties })).toEqual(before);
  });
  test(`does not hide an unrelated historical constraint in projection ${index}`, () => {
    const changed = { ...before, minProperties: 999 };
    expect(evolveHistoricalEndpointMetadata(changed)).toEqual(normalizeJsonSchema(changed));
  });
}
