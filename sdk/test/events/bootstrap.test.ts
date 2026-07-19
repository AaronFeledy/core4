import { describe, expect, test } from "bun:test";

import { Either, Schema } from "effect";
import * as AST from "effect/SchemaAST";

import { LandoEvent, PostBootstrapEvent } from "@lando/sdk/events";

const timestamp = "2026-07-19T00:00:00.000Z";
const levels = ["minimal", "plugins", "commands", "provider", "app", "tooling"] as const;

describe("bootstrap lifecycle event schemas", () => {
  for (const level of levels) {
    for (const phase of ["Pre", "Post"] as const) {
      test(`${phase.toLowerCase()} bootstrap ${level} owns a level-specific tagged schema`, async () => {
        // Given: the public events entry point and the canonical per-level export name.
        const events = await import("@lando/sdk/events");
        const schemaName = `${phase}Bootstrap${level[0]?.toUpperCase()}${level.slice(1)}Event`;
        const candidate: unknown = Object.getOwnPropertyDescriptor(events, schemaName)?.value;

        // When: the level-specific schema export is inspected.
        expect(Schema.isSchema(candidate), `${schemaName} must be exported from @lando/sdk/events`).toBe(
          true,
        );

        // Then: its schema owns the exact tag without a legacy level property.
        if (!Schema.isSchema(candidate)) return;
        expect(AST.isTypeLiteral(candidate.ast)).toBe(true);
        if (!AST.isTypeLiteral(candidate.ast)) return;
        const properties = candidate.ast.propertySignatures;
        const tag = properties.find((property) => property.name === "_tag")?.type;
        expect(tag !== undefined && AST.isLiteral(tag) ? tag.literal : undefined).toBe(
          `${phase.toLowerCase()}-bootstrap-${level}`,
        );
        expect(properties.some((property) => property.name === "level")).toBe(false);
        expect(AST.isUnion(LandoEvent.ast)).toBe(true);
        if (AST.isUnion(LandoEvent.ast)) expect(LandoEvent.ast.types).toContain(candidate.ast);
      });
    }
  }

  test("aggregate post-bootstrap remains distinct from per-level completion", () => {
    // Given: the aggregate completion payload after all required levels finish.
    const payload = { _tag: "post-bootstrap", timestamp };

    // When: the payload is decoded without a level field.
    const decoded = Schema.decodeUnknownEither(PostBootstrapEvent)(payload, {
      onExcessProperty: "error",
    });

    // Then: aggregate completion remains a public member of the closed event union.
    expect(Either.isRight(decoded), String(Either.getLeft(decoded))).toBe(true);
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(PostBootstrapEvent)(
          { ...payload, level: "app" },
          {
            onExcessProperty: "error",
          },
        ),
      ),
    ).toBe(true);
  });

  test("legacy level-bearing pre-bootstrap schema is not publicly exported", async () => {
    // Given: the public events entry point after adopting per-level event names.
    const events = await import("@lando/sdk/events");

    // When: the removed broad pre-bootstrap export is inspected.
    const legacy: unknown = Object.getOwnPropertyDescriptor(events, "PreBootstrapEvent")?.value;

    // Then: callers cannot construct the obsolete level-bearing event shape.
    expect(legacy).toBeUndefined();
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(LandoEvent)({
          _tag: "pre-bootstrap",
          level: "app",
          timestamp,
        }),
      ),
    ).toBe(true);
  });
});
