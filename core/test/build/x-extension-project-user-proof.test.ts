import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { JsonSchema } from "../../../scripts/schema-compatibility/model.ts";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { evolveHistoricalProjectUser, projectUserDelta } from "./x-extension-project-user-proof.ts";

const serviceWithUser = (user: JsonSchema) => ({
  type: "object",
  properties: {
    type: { type: "string" },
    image: { type: "string" },
    ports: {},
    user,
  },
  required: ["type"],
  additionalProperties: false,
});

test("pins the reviewed project-user delta bytes and producer source provenance", async () => {
  // Given the separate, immutable reviewed delta.
  const bytes = await Bun.file(
    new URL("./fixtures/x-extension-project-user.delta.json", import.meta.url),
  ).bytes();
  // When its bytes and provenance are inspected without consulting live schemas.
  // Then neither a live schema change nor a recapture can redefine this expectation.
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "7e1dc43fce5ebc1662f2985a8608add20777cac4d5579a8bc9bf84f2ac5d17fd",
  );
  expect(projectUserDelta.provenance).toEqual({
    commit: "c762c55baece4fedc5d2bf80590909f7426691ca",
    sources: { "sdk/src/schema/landofile.ts": "3bbd68d93c19d867d5259505e63058ed6df2b3dc" },
  });
  expect(projectUserDelta.pointer).toBe("/properties/services/additionalProperties/properties/projectUser");
});

for (const projection of ["plain", "directive"] as const) {
  const { witness, field } = projectUserDelta[projection];
  const historical = serviceWithUser(witness);

  test(`adds only the reviewed optional ${projection} project user`, () => {
    // Given a service with the exact reviewed user contract and an unrelated sibling.
    const input = {
      ...historical,
      properties: { ...historical.properties, sibling: { minLength: 7 } },
    };
    const before = structuredClone(input);
    // When project-user evolution follows the other historical deltas.
    const evolved = evolveHistoricalProjectUser(input, projection);
    // Then the complete object changes only by the optional addition, without mutating its input.
    expect(evolved).toEqual(
      normalizeJsonSchema({
        ...input,
        properties: { ...input.properties, projectUser: field },
      }),
    );
    expect(input).toEqual(before);
  });

  test(`preserves an already constrained ${projection} project user`, () => {
    // Given a service whose project user is independently tightened.
    const input = {
      ...historical,
      properties: { ...historical.properties, projectUser: { type: "number", minimum: 7 } },
    };
    // When the optional-field delta runs again.
    const evolved = evolveHistoricalProjectUser(input, projection);
    // Then it leaves the existing constraint intact rather than replacing it.
    expect(evolved).toEqual(normalizeJsonSchema(input));
  });

  test(`rejects an altered ${projection} service user`, () => {
    // Given a service whose user contract differs from the reviewed witness.
    const input = serviceWithUser({ ...witness, minLength: 999 });
    // When the delta attempts to recognize the service.
    const evolved = evolveHistoricalProjectUser(input, projection);
    // Then it cannot claim the current subtree by adding the new field.
    expect(evolved).toEqual(normalizeJsonSchema(input));
  });

  test(`does not add a ${projection} project user to an unrelated object`, () => {
    // Given a same-shaped user node outside a service object.
    const input = { type: "object", properties: { user: witness, image: { type: "string" } } };
    // When project-user evolution visits it.
    const evolved = evolveHistoricalProjectUser(input, projection);
    // Then the unrelated contract is unchanged.
    expect(evolved).toEqual(normalizeJsonSchema(input));
  });
}
