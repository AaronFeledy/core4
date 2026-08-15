import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  UnsafeGuideIdError,
  emitGuideScenarioTests,
  emitPublicTranscripts,
  parseBuildGuideScenarioArgs,
  resolveContainedClearTarget,
} from "../../../scripts/build-guide-scenarios.ts";

const UNSAFE_ONLY_VALUES = ["../../..", "..", "/etc/passwd", "a/b", "foo..bar", "", "."] as const;

describe("build-guide-scenarios --only guide id safety", () => {
  test("rejects unsafe --only values in both flag forms", () => {
    // Given/When/Then: every unsafe token fails GuideId decode for space and equals forms.
    for (const value of UNSAFE_ONLY_VALUES) {
      expect(() => parseBuildGuideScenarioArgs(["--only", value])).toThrow(UnsafeGuideIdError);
      expect(() => parseBuildGuideScenarioArgs([`--only=${value}`])).toThrow(UnsafeGuideIdError);
    }
  });

  test("accepts a legal kebab-case --only guide id", () => {
    // Given: a GuideId-shaped token.
    // When: both flag forms are parsed.
    // Then: onlyGuide is the decoded id.
    expect(parseBuildGuideScenarioArgs(["--only", "php"])).toEqual({ onlyGuide: "php" });
    expect(parseBuildGuideScenarioArgs(["--only=drupal-cms"])).toEqual({ onlyGuide: "drupal-cms" });
  });
});

describe("build-guide-scenarios clear-target containment", () => {
  test("keeps recursive clears inside each output root and preserves outside sentinels", async () => {
    // Given: isolated roots with a victim guide dir and a sentinel outside both roots.
    const sandbox = await mkdtemp(join(tmpdir(), "lando-guide-clear-"));
    try {
      const testOutput = "test/generated/guides";
      const transcriptOutput = "dist/transcripts/public/guides";
      const victim = "php";
      await mkdir(join(sandbox, testOutput, victim), { recursive: true });
      await mkdir(join(sandbox, transcriptOutput, victim), { recursive: true });
      await writeFile(join(sandbox, testOutput, victim, "stale.test.ts"), "// stale\n", "utf8");
      await writeFile(join(sandbox, transcriptOutput, victim, "stale.json"), "{}\n", "utf8");

      const sentinelPath = join(sandbox, "outside-sentinel.txt");
      await writeFile(sentinelPath, "keep-me\n", "utf8");

      // When: clears run for the victim guide id under each canonical root.
      const testTarget = resolveContainedClearTarget(sandbox, testOutput, victim);
      const transcriptTarget = resolveContainedClearTarget(sandbox, transcriptOutput, victim);
      expect(testTarget).toBe(resolve(sandbox, testOutput, victim));
      expect(transcriptTarget).toBe(resolve(sandbox, transcriptOutput, victim));

      await emitGuideScenarioTests([], sandbox, testOutput, { clearGuideId: victim });
      await emitPublicTranscripts([], sandbox, transcriptOutput, { clearGuideId: victim });

      // Then: victim dirs are gone and the outside sentinel survives.
      expect(await Bun.file(join(sandbox, testOutput, victim, "stale.test.ts")).exists()).toBe(false);
      expect(await Bun.file(join(sandbox, transcriptOutput, victim, "stale.json")).exists()).toBe(false);
      expect(await readFile(sentinelPath, "utf8")).toBe("keep-me\n");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("rejects clear targets that would escape the output root", () => {
    // Given: a sandbox root and traversal-shaped clear ids.
    const root = "/tmp/lando-clear-root";
    const outputRoot = "test/generated/guides";

    // When/Then: GuideId decode rejects escapes before rm.
    expect(() => resolveContainedClearTarget(root, outputRoot, "../outside")).toThrow(UnsafeGuideIdError);
    expect(() => resolveContainedClearTarget(root, outputRoot, "..")).toThrow(UnsafeGuideIdError);
    expect(() => resolveContainedClearTarget(root, outputRoot, "/etc")).toThrow(UnsafeGuideIdError);
  });
});
