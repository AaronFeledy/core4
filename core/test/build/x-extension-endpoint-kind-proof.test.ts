import { expect, test } from "bun:test";
import { normalizeJsonSchema } from "../../../scripts/schema-compatibility/normalize.ts";
import { REVIEWED_WHOLE_EXPRESSION_PATTERN } from "./x-extension-authoring-projection-proof.ts";
import { FIXTURE_PATH, parseCapturedExtension, schemaAt } from "./x-extension-closed-record.ts";
import { evolveHistoricalEndpointKind } from "./x-extension-endpoint-kind-proof.ts";
import { evolveHistoricalEndpointMetadata } from "./x-extension-endpoint-metadata-proof.ts";
import { wireObject } from "./x-extension-wire-proof.ts";

test("preserves an unreviewed endpoint expression constraint during wire shorthand evolution", async () => {
  const capture = parseCapturedExtension(await Bun.file(FIXTURE_PATH).json());
  const metadata = evolveHistoricalEndpointMetadata(normalizeJsonSchema(capture.landofile));
  const endpoints = schemaAt(metadata, "$.services.additionalProperties.endpoints");
  const items = wireObject(endpoints.items);
  if (!Array.isArray(items.anyOf)) throw new TypeError("Missing historical endpoint arms");
  const expression = { type: "string", pattern: REVIEWED_WHOLE_EXPRESSION_PATTERN, minLength: 999 };
  const evolved = evolveHistoricalEndpointKind(
    { properties: { endpoints: { ...endpoints, items: { anyOf: [...items.anyOf, expression] } } } },
    "wire",
  );
  const evolvedItems = schemaAt(evolved, "$.endpoints.items");
  expect(evolvedItems.anyOf).toContainEqual(expression);
  expect(evolvedItems.anyOf).not.toContainEqual({ type: "string" });
});
