import { describe, expect, test } from "bun:test";

import { Result, Schema } from "effect";

import { AbsolutePath } from "@lando/sdk/schema";
import { TaskStartEvent } from "../../src/events/task.ts";
import { JSON_SCHEMA_NAMES, publicSchemaRegistry } from "../../src/schema/index.ts";
import {
  PUBLIC_SCHEMA_CONTRACT_FIXTURES,
  assertPublicSchemaContractCoverage,
  publicSchemaHappyPathFixture,
} from "./public-schema-contracts.ts";

describe("public schema contracts", () => {
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
    expect([...Object.keys(PUBLIC_SCHEMA_CONTRACT_FIXTURES)]).toEqual([...JSON_SCHEMA_NAMES]);
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
