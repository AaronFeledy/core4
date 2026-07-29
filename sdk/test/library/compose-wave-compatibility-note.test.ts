import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import * as SchemaExports from "@lando/sdk/schema";

const repoRoot = new URL("../../..", import.meta.url).pathname;
const compatibilityDoc = readFileSync(join(repoRoot, "sdk/API_COMPATIBILITY.md"), "utf8");

const compatibilityNotesSection = (): string => {
  const [, afterHeading = ""] = compatibilityDoc.split("## Compatibility notes");
  const [section = ""] = afterHeading.split("\n## ");
  return section;
};

const bullets = (section: string): ReadonlyArray<string> =>
  section
    .split(/\n(?=- )/)
    .map((bullet) => bullet.trim())
    .filter((bullet) => bullet.startsWith("- "));

const backtickedNames = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(/`([^`]+)`/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));

describe("Compose service-key vocabulary wave compatibility note", () => {
  test("documents the Compose service-key vocabulary wave and the composeBuild replacement in one entry", () => {
    const matchingBullets = bullets(compatibilityNotesSection()).filter(
      (bullet) => bullet.includes("Compose service-key vocabulary") && bullet.includes("composeBuild"),
    );

    expect(matchingBullets).toHaveLength(1);
    expect(matchingBullets[0]).not.toContain("COMPOSE_REJECTED_TOP_LEVEL_KEYS");
  });

  test("publishes every promised Compose runtime-knob schema through the public barrel", () => {
    // Given
    const runtimeKnobBullet = bullets(compatibilityNotesSection()).find((bullet) =>
      bullet.includes("additively exports the Compose per-container runtime knob field schemas"),
    );
    if (runtimeKnobBullet === undefined) {
      throw new Error("Compatibility notes must keep the Compose runtime-knob export bullet");
    }
    const listStart = runtimeKnobBullet.indexOf("(");
    const listEnd = runtimeKnobBullet.indexOf("). These are");

    // When / Then
    expect(listStart).toBeGreaterThanOrEqual(0);
    expect(listEnd).toBeGreaterThan(listStart);
    const promisedExports = backtickedNames(runtimeKnobBullet.slice(listStart + 1, listEnd));
    expect(promisedExports.length).toBeGreaterThan(0);
    for (const exportName of promisedExports) {
      expect(Object.hasOwn(SchemaExports, exportName), exportName).toBe(true);
    }
    expect(Schema.decodeUnknownSync(SchemaExports.ComposeRestartField)("always")).toBe("always");
    expect(() => Schema.decodeUnknownSync(SchemaExports.ComposeRestartField)("sometimes")).toThrow();
    expect(Schema.decodeUnknownSync(SchemaExports.ComposeDeployField)({ resources: {} })).toEqual({
      resources: {},
    });
    expect(Object.hasOwn(SchemaExports, "ComposeServiceKnobFields")).toBe(false);
  });

  test("publishes the exact preserved-path capability schemas through the public barrel", () => {
    const capabilityBullet = bullets(compatibilityNotesSection()).find(
      (bullet) =>
        bullet.includes("ComposePreservedPathKey") &&
        bullet.includes("ComposePreservedPathCapabilities") &&
        bullet.includes("composePreservedPaths"),
    );

    expect(capabilityBullet).toBeDefined();
    expect(Object.hasOwn(SchemaExports, "ComposePreservedPathKey")).toBe(true);
    expect(Object.hasOwn(SchemaExports, "ComposePreservedPathCapabilities")).toBe(true);
    expect(
      Schema.decodeUnknownSync(SchemaExports.ComposePreservedPathKey)("healthcheck.start_interval"),
    ).toBe("healthcheck.start_interval");
    expect(() =>
      Schema.decodeUnknownSync(SchemaExports.ComposePreservedPathKey)("healthcheck.start_period"),
    ).toThrow();
    expect(Object.hasOwn(SchemaExports, "ComposeServiceKnobFields")).toBe(false);
  });
});
