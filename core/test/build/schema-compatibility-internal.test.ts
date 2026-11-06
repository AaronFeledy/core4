import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { compareArtifactSets } from "../../../scripts/check-schema-compatibility.ts";
import {
  type SchemaArtifact,
  loadWorkingSchemaArtifacts,
} from "../../../scripts/schema-compatibility-artifacts.ts";
import { parseCompatibilityExceptions } from "../../../scripts/schema-compatibility/exceptions.ts";
import { INTERNAL_PERSISTED_STORES } from "../../../scripts/schema-compatibility/internal-stores.ts";
import { loadBasePersistedStoreVersions } from "../../../scripts/schema-compatibility/store-versions.ts";

const surface = "persisted:scratch-registry";
const artifact = (statuses: readonly string[], version: number) => ({
  surface,
  polarity: "input" as const,
  schema: {
    type: "array",
    items: { type: "object", properties: { status: { type: "string", enum: statuses } } },
  },
  persistedState: { store: "scratch-registry" as const, version },
});

test("rejects internal persisted narrowing even with an exception when the version stays unchanged", () => {
  const before = new Map([[surface, artifact(["running", "stopping"], 1)]]);
  const after = new Map([[surface, artifact(["running"], 1)]]);

  const findings = compareArtifactSets(before, after, {
    exceptions: [
      {
        surface,
        changeKind: "enum-narrowed",
        path: "$.items.status",
        justification: "Migrate stopping records to running.",
        persistedState: { store: "scratch-registry", version: 1 },
      },
    ],
  });

  expect(findings).toEqual([expect.objectContaining({ verdict: "breaking", accepted: false })]);
  expect(findings[0]?.message).toContain("has not advanced from baseline 1");
});

test.each([false, true])(
  "requires a matching exception after an internal version bump: exception %s",
  (recorded) => {
    const before = new Map([[surface, artifact(["running", "stopping"], 1)]]);
    const after = new Map([[surface, artifact(["running"], 2)]]);
    const exceptions = parseCompatibilityExceptions(
      JSON.stringify([
        {
          surface,
          changeKind: "enum-narrowed",
          path: "$.items.status",
          justification: "Version 2 migrates historical stopping entries to running.",
          persistedState: { store: "scratch-registry", version: 2 },
        },
      ]),
      "fixture",
    );

    const findings = compareArtifactSets(before, after, { exceptions: recorded ? exceptions : [] });

    expect(findings).toEqual([expect.objectContaining({ verdict: "breaking", accepted: recorded })]);
  },
);

test("accepts internal input widening without a bump or exception", () => {
  const before = new Map([[surface, artifact(["running"], 1)]]);
  const after = new Map([[surface, artifact(["running", "stopping"], 1)]]);

  const findings = compareArtifactSets(before, after, { exceptions: [] });

  expect(findings).toEqual([expect.objectContaining({ verdict: "compatible", changeKind: "enum-widened" })]);
});

test.each([1, 2])("requires a version bump for unknown internal changes: current version %s", (version) => {
  const before = new Map([[surface, { ...artifact([], 1), schema: { type: "string", pattern: "^a" } }]]);
  const after = new Map([[surface, { ...artifact([], version), schema: { type: "string", pattern: "^b" } }]]);

  const findings = compareArtifactSets(before, after, {
    exceptions: [
      {
        surface,
        changeKind: "unsupported-keyword",
        path: "$.pattern",
        justification: "Migrate historical prefix a to b.",
        persistedState: { store: "scratch-registry", version },
      },
    ],
  });

  expect(findings).toEqual([expect.objectContaining({ verdict: "unknown", accepted: version > 1 })]);
});

test("uses recorded baseline versions without requiring historical source files", async () => {
  const artifacts = new Map<string, SchemaArtifact>([
    [
      "schema:AppPlan",
      { ...artifact([], 7), persistedState: { store: "applied-state" as const, version: 7 } },
    ],
    [
      "schema:TunnelSession",
      { ...artifact([], 5), persistedState: { store: "tunnel-registry" as const, version: 5 } },
    ],
    [surface, artifact([], 3)],
  ]);

  const versions = await loadBasePersistedStoreVersions("/unused", "unused", artifacts);

  expect(versions).toEqual({ "applied-state": 7, "tunnel-registry": 5, "scratch-registry": 3 });
});

test("loads generated bucket inputs with versions and the nullable handoff wrapper", async () => {
  const artifacts = await loadWorkingSchemaArtifacts(resolve(import.meta.dir, "../../.."));

  for (const { id, version } of INTERNAL_PERSISTED_STORES) {
    expect(artifacts.get(`persisted:${id}`)).toMatchObject({
      polarity: "input",
      persistedState: { store: id, version },
    });
  }
  expect(artifacts.get("persisted:update-handoff-receipt")?.schema.anyOf).toContainEqual({ type: "null" });
});
