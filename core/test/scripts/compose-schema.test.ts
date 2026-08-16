import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  collectComposeServiceKeyPaths,
  collectComposeTopLevelKeyPaths,
  compareComposeCoverage,
  diffComposeSchemaKeyPaths,
  formatComposeSchemaDiffMarkdown,
} from "../../../scripts/compose-schema.ts";

const fixturePath = resolve(import.meta.dirname, "fixtures/compose-schema.json");

describe("compose schema walker", () => {
  test("enumerates service paths through refs, unions, arrays, and pattern maps", async () => {
    const schema: unknown = await Bun.file(fixturePath).json();

    expect(collectComposeServiceKeyPaths(schema)).toEqual([
      "depends_on",
      "depends_on.*",
      "depends_on.*.condition",
      "image",
      "labels",
      "labels.*",
      "volumes",
      "volumes.type",
      "volumes.volume",
      "volumes.volume.subpath",
      "x-*",
    ]);
  });

  test("enumerates only project-level keys for top-level coverage", async () => {
    const schema: unknown = await Bun.file(fixturePath).json();

    expect(collectComposeTopLevelKeyPaths(schema)).toEqual(["name", "services", "version", "x-*"]);
  });

  test("reports unclassified schema paths and stale matrix entries", () => {
    expect(compareComposeCoverage(["image", "working_dir"], ["image", "obsolete"])).toEqual({
      missingFromMatrix: ["working_dir"],
      missingFromSchema: ["obsolete"],
    });
  });
});

const omitKey = (record: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([entryKey]) => entryKey !== key));

describe("compose schema diff reporter", () => {
  const buildBumpedSchema = (base: Record<string, unknown>): Record<string, unknown> => {
    const next = structuredClone(base);
    const root = next.properties as Record<string, unknown>;
    next.properties = { ...omitKey(root, "version"), configs: { type: "object" } };
    const defs = next.$defs as Record<string, Record<string, unknown>>;
    const service = defs.service;
    if (service === undefined) throw new Error("expected a service definition in the compose schema");
    const serviceProps = service.properties as Record<string, unknown>;
    service.properties = { ...omitKey(serviceProps, "image"), restart: { type: "string" } };
    return next;
  };

  test("lists added and removed service and top-level key paths across a synthetic bump", async () => {
    const oldSchema = (await Bun.file(fixturePath).json()) as Record<string, unknown>;
    const newSchema = buildBumpedSchema(oldSchema);

    expect(diffComposeSchemaKeyPaths(oldSchema, newSchema)).toEqual({
      addedServicePaths: ["restart"],
      removedServicePaths: ["image"],
      addedTopLevelPaths: ["configs"],
      removedTopLevelPaths: ["version"],
    });
  });

  test("renders the diff as PR-body markdown naming each changed path", async () => {
    const oldSchema = (await Bun.file(fixturePath).json()) as Record<string, unknown>;
    const newSchema = buildBumpedSchema(oldSchema);

    const markdown = formatComposeSchemaDiffMarkdown(diffComposeSchemaKeyPaths(oldSchema, newSchema));

    expect(markdown).toContain("restart");
    expect(markdown).toContain("image");
    expect(markdown).toContain("configs");
    expect(markdown).toContain("version");
  });

  test("renders an explicit no-change summary when the schema is unchanged", async () => {
    const schema = (await Bun.file(fixturePath).json()) as Record<string, unknown>;

    const diff = diffComposeSchemaKeyPaths(schema, structuredClone(schema));
    expect(diff).toEqual({
      addedServicePaths: [],
      removedServicePaths: [],
      addedTopLevelPaths: [],
      removedTopLevelPaths: [],
    });
    expect(formatComposeSchemaDiffMarkdown(diff)).toContain("No key path changes");
  });
});
