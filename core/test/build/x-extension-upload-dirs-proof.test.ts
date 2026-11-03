import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { uploadDirsDeltas } from "./fixtures/x-extension-upload-dirs.delta.ts";
import { evolveHistoricalUploadDirs } from "./x-extension-upload-dirs-proof.ts";

test("pins the independently modeled uploadDirs projections", () => {
  expect(createHash("sha256").update(JSON.stringify(uploadDirsDeltas)).digest("hex")).toBe(
    "d0b24a968ac83248b0e9ecd0b87cb52f6e9886343a475234b169b7e7729de149",
  );
});

for (const { mode, field, witness: consolePort } of uploadDirsDeltas) {
  const historical = {
    type: "object",
    properties: { type: { type: "string" }, image: { type: "string" }, ports: {}, consolePort },
    required: ["type"],
    additionalProperties: false,
  };
  test(`adds only optional uploadDirs to the reviewed ${mode} projection`, () => {
    const before = structuredClone(historical);
    const evolved = evolveHistoricalUploadDirs(historical);
    expect(evolved).toEqual(
      normalizeJsonSchema({
        ...historical,
        properties: { ...historical.properties, uploadDirs: field },
      }),
    );
    expect(historical).toEqual(before);
  });
  test(`preserves already constrained ${mode} uploadDirs`, () => {
    const input = { ...historical, properties: { ...historical.properties, uploadDirs: { maxItems: 2 } } };
    expect(evolveHistoricalUploadDirs(input)).toEqual(normalizeJsonSchema(input));
  });
  test(`does not change an unreviewed ${mode} projection`, () => {
    const input = { ...historical, properties: { ...historical.properties, consolePort: { minimum: 7 } } };
    expect(evolveHistoricalUploadDirs(input)).toEqual(normalizeJsonSchema(input));
  });
}
