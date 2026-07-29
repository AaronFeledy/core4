import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import * as SchemaExports from "@lando/sdk/schema";

const repoRoot = new URL("../../..", import.meta.url).pathname;
const compatibilityDocPath = join(repoRoot, "sdk/API_COMPATIBILITY.md");

const compatibilityNotesSection = (): string => {
  const compatibilityDoc = readFileSync(compatibilityDocPath, "utf8");
  const [, afterHeading = ""] = compatibilityDoc.split("## Compatibility notes");
  const [section = ""] = afterHeading.split("\n## ");
  return section;
};

const bullets = (section: string): ReadonlyArray<string> =>
  section
    .split(/\n(?=- )/)
    .map((bullet) => bullet.trim())
    .filter((bullet) => bullet.startsWith("- "));

describe("Compose service-key vocabulary wave compatibility note", () => {
  test("documents the Compose service-key vocabulary wave and the composeBuild replacement in one entry", () => {
    const section = compatibilityNotesSection();
    const matchingBullets = bullets(section).filter(
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
    const listStart = runtimeKnobBullet?.indexOf("(") ?? -1;
    const listEnd = runtimeKnobBullet?.indexOf("). These are") ?? -1;
    const promisedExports =
      listStart < 0 || listEnd < 0
        ? []
        : [...(runtimeKnobBullet?.slice(listStart + 1, listEnd).matchAll(/`([^`]+)`/g) ?? [])].flatMap(
            (match) => (match[1] === undefined ? [] : [match[1]]),
          );

    // When / Then
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
