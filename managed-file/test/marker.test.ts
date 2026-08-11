import { describe, expect, test } from "bun:test";

import {
  canCarryFileMarker,
  composeBlock,
  composeFileContent,
  findBlock,
  hasFileMarker,
  insertBlock,
  removeBlock,
  stripFileMarker,
} from "../src/marker.ts";

describe("managed-file ownership markers", () => {
  test("comment and JSON file markers compose, detect, and strip round-trip", () => {
    // Given
    const textBody = "hello world\n";
    const jsonBody = '{"name":"app"}\n';

    // When
    const text = composeFileContent("text", "owner:text", textBody);
    const json = composeFileContent("json", "owner:json", jsonBody);

    // Then
    expect(hasFileMarker("text", text, "owner:text")).toBe(true);
    expect(stripFileMarker("text", text, "owner:text")).toBe(textBody);
    expect(hasFileMarker("json", json, "owner:json")).toBe(true);
    expect(JSON.parse(json)).toEqual({ name: "app", "x-lando-generated": "owner:json" });
    expect(stripFileMarker("json", json, "owner:json")).toBe('{\n  "name": "app"\n}\n');
  });

  test("block helpers preserve user content surrounding a managed region", () => {
    // Given
    const block = composeBlock("#", "owner:block", "OWNED=1\n\n");
    const content = `before\n${block}\nafter\n`;

    // When
    const location = findBlock("#", "owner:block", content);

    // Then
    expect(block).toBe("# >>> lando:owner:block >>>\nOWNED=1\n# <<< lando:owner:block <<<");
    expect(location.found).toBe(true);
    expect(location.slice).toBe(block);
    expect(removeBlock(location)).toBe("before\nafter\n\n");
    expect(insertBlock("before\n", block)).toBe(`before\n${block}\n`);
  });

  test("JSON values without an object marker slot cannot carry file ownership", () => {
    // Given
    const scalar = '"value"\n';
    const malformed = "{not-json";

    // When / Then
    expect(canCarryFileMarker("json", scalar)).toBe(false);
    expect(canCarryFileMarker("json", malformed)).toBe(false);
    expect(hasFileMarker("json", scalar, "owner:json")).toBe(false);
  });
});
