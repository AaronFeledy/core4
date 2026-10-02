import { expect, test } from "bun:test";
import { Lando3LandofileDetected, LandofileDialectMixError } from "@lando/sdk/errors";
import { Schema } from "effect";
import surface from "../fixtures/sdk-mvp-surface.json";

test("round-trips canonical detection context through its public schema", () => {
  // Given
  const input = new Lando3LandofileDetected({
    appRoot: "/app",
    sourceFile: "/app/.lando.yml",
    message: "legacy",
    remediation: "Run `lando4 app:config:translate --from lando3 --write`.",
  });
  // When
  const result = Schema.decodeUnknownSync(Lando3LandofileDetected)(
    Schema.encodeSync(Lando3LandofileDetected)(input),
  );
  // Then
  expect(result).toMatchObject(input);
  expect(surface.landofileDialectErrorTags[0]).toBe(result._tag);
});

test("round-trips mixed-dialect context through its public schema", () => {
  // Given
  const input = new LandofileDialectMixError({
    appRoot: "/app",
    canonicalFile: "/app/.lando.yml",
    conflictingLayer: "/app/.lando.local.yml",
    message: "mixed",
    remediation: "Run `lando4 app:config:translate --from lando3 --file .lando.local.yml --write`.",
  });
  // When
  const result = Schema.decodeUnknownSync(LandofileDialectMixError)(
    Schema.encodeSync(LandofileDialectMixError)(input),
  );
  // Then
  expect(result).toMatchObject(input);
  expect(surface.landofileDialectErrorTags[1]).toBe(result._tag);
});
