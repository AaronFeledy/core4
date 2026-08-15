import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { renderComposeSchemaDiffReport } from "../../../scripts/report-compose-schema-diff.ts";

const fixturePath = resolve(import.meta.dirname, "fixtures/compose-schema.json");

describe("compose schema diff report", () => {
  test("renders markdown listing added and removed key paths for a synthetic bump", async () => {
    const omitKey = (record: Record<string, unknown>, key: string): Record<string, unknown> =>
      Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));
    const oldSchema = (await Bun.file(fixturePath).json()) as Record<string, unknown>;
    const newSchema = structuredClone(oldSchema);
    const root = newSchema.properties as Record<string, unknown>;
    newSchema.properties = { ...omitKey(root, "version"), configs: { type: "object" } };
    const service = (newSchema.$defs as Record<string, Record<string, unknown>>).service;
    if (service === undefined) throw new Error("expected a service definition in the compose schema");
    const serviceProps = service.properties as Record<string, unknown>;
    service.properties = { ...omitKey(serviceProps, "image"), restart: { type: "string" } };

    const markdown = renderComposeSchemaDiffReport(oldSchema, newSchema);

    expect(markdown).toContain("restart");
    expect(markdown).toContain("image");
    expect(markdown).toContain("configs");
    expect(markdown).toContain("version");
  });

  test("renders a no-change summary for an unchanged schema", async () => {
    const schema = (await Bun.file(fixturePath).json()) as Record<string, unknown>;

    expect(renderComposeSchemaDiffReport(schema, structuredClone(schema))).toContain("No key path changes");
  });
});
