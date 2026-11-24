import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { packageCacheDeltas } from "./fixtures/x-extension-package-cache.delta.ts";
import { evolveHistoricalPackageCache } from "./x-extension-package-cache-proof.ts";

test("pins the independently modeled packageCache projections", () => {
  expect(createHash("sha256").update(JSON.stringify(packageCacheDeltas)).digest("hex")).toBe(
    "6fb605256ee3db85d0d136334b65fcdba7cd694b699de3053ecaa22c7b10c549",
  );
});

for (const { mode, field, witness: extraArgs } of packageCacheDeltas) {
  const service = {
    type: "object",
    properties: { type: { type: "string" }, image: { type: "string" }, ports: {}, extraArgs },
    required: ["type"],
    additionalProperties: false,
  };
  const unrelated = { type: "object", properties: { extraArgs } };
  test(`adds only optional packageCache to the reviewed ${mode} service`, () => {
    const historical = { anyOf: [unrelated, service] };
    const before = structuredClone(historical);
    const evolved = evolveHistoricalPackageCache(historical);
    expect(evolved).toEqual(
      normalizeJsonSchema({
        anyOf: [unrelated, { ...service, properties: { ...service.properties, packageCache: field } }],
      }),
    );
    expect(historical).toEqual(before);
  });
  test(`preserves a tampered ${mode} packageCache so the drift stays detectable`, () => {
    const input = { ...service, properties: { ...service.properties, packageCache: { type: "number" } } };
    const evolved = evolveHistoricalPackageCache(input);
    expect(evolved).toEqual(normalizeJsonSchema(input));
    expect(evolved).not.toEqual(evolveHistoricalPackageCache(service));
  });
  test(`does not change an unreviewed ${mode} projection`, () => {
    const input = { ...service, properties: { ...service.properties, extraArgs: { minItems: 7 } } };
    expect(evolveHistoricalPackageCache(input)).toEqual(normalizeJsonSchema(input));
  });
}
