import { describe, expect, test } from "bun:test";

import { Either, Schema } from "effect";

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
      transcriptPath: "/tmp/lando/builds/web.log",
      timestamp: "2026-06-14T00:00:00.000Z",
    });

    expect(oldPayload.transcriptPath).toBeUndefined();
    expect(transcriptPayload.transcriptPath).toBe("/tmp/lando/builds/web.log");
  });

  test("every public schema has a schema contract fixture", () => {
    expect(Object.keys(PUBLIC_SCHEMA_CONTRACT_FIXTURES)).toEqual(JSON_SCHEMA_NAMES);
    expect(() => assertPublicSchemaContractCoverage()).not.toThrow();
  });

  for (const schemaName of JSON_SCHEMA_NAMES) {
    test(`${schemaName} decodes, rejects invalid input, and round-trips through encode/decode`, () => {
      const schema = publicSchemaRegistry[schemaName];
      const decoded = Schema.decodeUnknownEither(schema)(publicSchemaHappyPathFixture(schemaName), {
        onExcessProperty: "error",
      });

      expect(Either.isRight(decoded), schemaName).toBe(true);
      if (Either.isLeft(decoded)) return;

      const invalid = Schema.decodeUnknownEither(schema)(undefined, { onExcessProperty: "error" });
      expect(Either.isLeft(invalid), schemaName).toBe(true);

      const encoded = Schema.encodeEither(schema)(decoded.right);
      expect(Either.isRight(encoded), schemaName).toBe(true);
      if (Either.isLeft(encoded)) return;

      const decodedAgain = Schema.decodeUnknownEither(schema)(encoded.right, {
        onExcessProperty: "error",
      });
      expect(Either.isRight(decodedAgain), schemaName).toBe(true);
    });
  }
});
