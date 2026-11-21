import { expect, test } from "bun:test";
import { getEditorJsonSchema } from "@lando/sdk/schema";
import { assertEditorSchemaNaming, editorNamingFindings } from "../../src/schema/editor-naming.ts";

test("checks named properties through recursive references without treating dictionary keys as fields", () => {
  const variant = (key: string) => ({
    anyOf: ["one", "two"].map((value) => ({ properties: { [key]: { const: value } }, required: [key] })),
  });
  const condition = { type: "boolean", description: "Checked when the step runs at invocation time." };
  expect(
    editorNamingFindings({
      GlobalConfig: { properties: { agentEnv: { type: "object" } } },
      LandofileShape: {
        properties: {
          agentEnv: { type: "boolean" },
          fixtures: { additionalProperties: { $ref: "#/definitions/fixture" } },
          oldVariant: variant("type"),
          newVariant: variant("kind"),
          includes: { items: { properties: { when: { type: "boolean" } } } },
          events: { properties: { "post-start": { items: { properties: { if: condition } } } } },
          tooling: { additionalProperties: { properties: { if: condition } } },
          services: {
            additionalProperties: {
              properties: {
                depends_on: { additionalProperties: { properties: { condition: { type: "string" } } } },
              },
            },
          },
        },
        definitions: {
          fixture: {
            properties: {
              bad_key: { type: "string" },
              _tag: { type: "string" },
              connectTimeout: { type: "integer" },
              retryDelayMs: { type: "integer" },
              hostIp: { type: "string" },
              host_ip: { type: "string" },
              unless: { type: "boolean" },
              "x-extension": { type: "string" },
              children: { items: { $ref: "#/definitions/fixture" } },
            },
          },
        },
      },
    }),
  ).toEqual([
    "LandofileShape.agentEnv shared-type",
    "LandofileShape.fixtures.*._tag tag",
    "LandofileShape.fixtures.*.bad_key casing",
    "LandofileShape.fixtures.*.connectTimeout time-unit",
    "LandofileShape.fixtures.*.hostIp|host_ip twin",
    "LandofileShape.fixtures.*.host_ip casing",
    "LandofileShape.fixtures.*.unless condition",
    "LandofileShape.includes.[].when condition",
    "LandofileShape.oldVariant.type discriminator",
    "LandofileShape.tooling.*.if condition",
  ]);
});

test("fails publication for new findings and stale debt", () => {
  const LandofileShape = getEditorJsonSchema("LandofileShape");
  const GlobalConfig = getEditorJsonSchema("GlobalConfig");
  expect(() => assertEditorSchemaNaming({ LandofileShape, GlobalConfig })).not.toThrow();
  expect(() =>
    assertEditorSchemaNaming({
      LandofileShape: { properties: { new_key: { type: "number" } } },
      GlobalConfig,
    }),
  ).toThrow(/New: LandofileShape\.new_key casing/u);
  expect(() => assertEditorSchemaNaming({ LandofileShape, GlobalConfig: {} })).toThrow(
    /Remove stale debt #2108: LandofileShape\.agentEnv shared-type/u,
  );
});
