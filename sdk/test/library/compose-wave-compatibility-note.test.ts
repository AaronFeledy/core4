import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

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
    expect(matchingBullets[0]).toContain("COMPOSE_REJECTED_TOP_LEVEL_KEYS");
  });
});
