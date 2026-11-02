import { describe, expect, test } from "bun:test";

import { Result, Schema } from "effect";

import { AbsolutePath } from "@lando/sdk/schema";
import { TaskStartEvent } from "../../src/events/task.ts";
import {
  JSON_SCHEMA_NAMES,
  publicSchemaMetadataIndex,
  publicSchemaRegistry,
} from "../../src/schema/index.ts";
import {
  assertPublicSchemaContractCoverage,
  publicSchemaContractTestFile,
  publicSchemaHappyPathFixture,
} from "./public-schema-contracts.ts";
import { GRANDFATHERED_SCHEMA_DESCRIPTION_IDS } from "./public-schema-description-debt.ts";

describe("public schema contracts", () => {
  test.each([
    ["StartAppResult", "sdk/test/schema/app-results.test.ts"],
    ["LandofileShape", "sdk/test/schema/public-schema-contracts.test.ts"],
  ] as const)("%s resolves its contract test file", (schemaName, expectedFile) => {
    // Given / When
    const testFile = publicSchemaContractTestFile(schemaName);
    // Then
    expect(testFile).toBe(expectedFile);
  });

  test("generated descriptions exactly match the shrinking grandfathered ledger", () => {
    // Given the published metadata, detect only the generated fallback, not authored prose.
    const generated = publicSchemaMetadataIndex.filter(({ id, description }) => {
      const title = id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
      return description === `Public Lando schema contract for ${title}.`;
    });
    // When comparing the actual fallback ids to the explicit existing debt,
    // Then both newly undocumented and newly documented schemas require a ledger change.
    const generatedIds: string[] = generated.map(({ id }) => id).sort();
    expect(generatedIds).toEqual([...GRANDFATHERED_SCHEMA_DESCRIPTION_IDS].sort());
  });
  test("TaskStartEvent additively decodes old payloads and branded transcript paths", () => {
    const oldPayload = Schema.decodeUnknownSync(TaskStartEvent)({
      _tag: "task.start",
      taskId: "build:web",
      label: "Build web",
      timestamp: "2026-06-14T00:00:00.000Z",
    });
    const transcriptPayload = Schema.decodeUnknownSync(TaskStartEvent)({
      _tag: "task.start",
      taskId: "build:web",
      label: "Build web",
      transcriptPath: AbsolutePath.make("/tmp/lando/builds/web.log"),
      timestamp: "2026-06-14T00:00:00.000Z",
    });

    expect(oldPayload.transcriptPath).toBeUndefined();
    expect(transcriptPayload.transcriptPath).toBe(AbsolutePath.make("/tmp/lando/builds/web.log"));
  });

  test("every public schema has a schema contract fixture", () => {
    expect(() => assertPublicSchemaContractCoverage()).not.toThrow();
  });

  for (const schemaName of JSON_SCHEMA_NAMES) {
    test(`${schemaName} decodes, rejects invalid input, and round-trips through encode/decode`, () => {
      const schema: Schema.Codec<unknown, unknown> = Schema.make(publicSchemaRegistry[schemaName].ast);
      const decoded = Schema.decodeUnknownResult(schema)(publicSchemaHappyPathFixture(schemaName), {
        onExcessProperty: "error",
      });

      expect(Result.isSuccess(decoded), schemaName).toBe(true);
      if (Result.isFailure(decoded)) return;

      const invalid = Schema.decodeUnknownResult(schema)(undefined, { onExcessProperty: "error" });
      expect(Result.isFailure(invalid), schemaName).toBe(true);

      const encoded = Schema.encodeResult(schema)(decoded.success);
      expect(Result.isSuccess(encoded), schemaName).toBe(true);
      if (Result.isFailure(encoded)) return;

      const decodedAgain = Schema.decodeUnknownResult(schema)(encoded.success, {
        onExcessProperty: "error",
      });
      expect(Result.isSuccess(decodedAgain), schemaName).toBe(true);
    });
  }
});
