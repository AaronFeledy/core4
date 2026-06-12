import { describe, expect, test } from "bun:test";

import { releasePackageNames } from "../../../scripts/prepare-npm-dev-packages";
import { RELEASE_STAGES, runRelease } from "../../../scripts/release";

describe("release orchestrator", () => {
  test("defines and runs all release stages in the required fixed order", async () => {
    const observed: Array<string> = [];
    const observeStage = (stageId: string): void => {
      if (observed.at(-1) !== stageId) observed.push(stageId);
    };

    await runRelease({
      target: "all",
      runner: {
        spawn: async ({ stageId }) => {
          observeStage(stageId);
        },
        shell: async ({ stageId }) => {
          observeStage(stageId);
        },
      },
      logger: (line) => {
        const skippedStage = line.match(/^\[release\] skip (\d+-[a-z-]+)/)?.[1];
        if (skippedStage) observeStage(skippedStage);
      },
    });

    expect(RELEASE_STAGES.map((stage) => stage.id)).toEqual([
      "1-codegen",
      "2-typecheck",
      "3-lint-format",
      "4-test-gates",
      "5-schema-artifacts",
      "6-library-bundle",
      "7-compile",
      "8-strip",
      "9-sign",
      "10-notarize",
      "11-manifest",
      "12-provenance-sbom",
      "13-publish",
    ]);
    expect(observed).toEqual(RELEASE_STAGES.map((stage) => stage.id));
  });

  test("halts on the first failed stage with a tagged release error", async () => {
    const observed: Array<string> = [];

    await expect(
      runRelease({
        target: "all",
        runner: {
          spawn: async ({ stageId }) => {
            observed.push(stageId);
            if (stageId === "4-test-gates") throw new Error("boom");
          },
          shell: async ({ stageId }) => {
            observed.push(stageId);
          },
        },
        logger: () => {},
      }),
    ).rejects.toMatchObject({
      _tag: "ReleaseStageError",
      stageId: "4-test-gates",
      artifactFamily: "binary+library",
      commandSummary: "bun --no-orphans test",
      remediation: "Fix the failed release stage and rerun scripts/release.ts from a clean tree.",
    });

    expect(observed).toEqual(["1-codegen", "2-typecheck", "3-lint-format", "4-test-gates"]);
  });

  test("uses spawn for argv-precise stages and shell for shell-shaped publish work", async () => {
    const spawnStages: Array<{ stageId: string; cmd: ReadonlyArray<string> }> = [];
    const shellStages: Array<string> = [];

    await runRelease({
      target: "library",
      runner: {
        spawn: async ({ stageId, cmd }) => {
          spawnStages.push({ stageId, cmd });
        },
        shell: async ({ stageId, script }) => {
          shellStages.push(`${stageId}:${script}`);
        },
      },
      logger: () => {},
    });

    expect(spawnStages).toContainEqual({ stageId: "1-codegen", cmd: ["bun", "run", "scripts/codegen.ts"] });
    expect(spawnStages.filter(({ stageId }) => stageId === "6-library-bundle")).toEqual(
      releasePackageNames.map((packageName) => ({
        stageId: "6-library-bundle",
        cmd: ["bun", "run", `--filter=${packageName}`, "build"],
      })),
    );
    expect(spawnStages).not.toContainEqual({ stageId: "6-library-bundle", cmd: ["bun", "run", "build"] });
    expect(shellStages.some((entry) => entry.startsWith("13-publish:before_latest="))).toBe(true);
    expect(shellStages.some((entry) => entry.startsWith("1-codegen:"))).toBe(false);
  });

  test("skips artifact-family stages without changing stage order", async () => {
    const logs: Array<string> = [];

    await runRelease({
      target: "binary",
      runner: {
        spawn: async ({ stageId }) => {
          logs.push(`run:${stageId}`);
        },
        shell: async ({ stageId }) => {
          logs.push(`run:${stageId}`);
        },
      },
      logger: (line) => logs.push(line),
    });

    expect(logs.filter((line) => line.startsWith("[release] skip 6-library-bundle"))).toHaveLength(1);
    expect(logs.filter((line) => line.startsWith("[release] skip 13-publish"))).toHaveLength(1);
    expect(logs).not.toContain("run:13-publish");
    const binaryStageOutcomes = logs
      .map((line) => line.match(/^run:(.+)$/)?.[1] ?? line.match(/^\[release\] skip (\d+-[a-z-]+)/)?.[1])
      .filter((stageId): stageId is string => stageId !== undefined)
      .filter((stageId) => RELEASE_STAGES.some((stage) => stage.id === stageId && stage.forBinary));
    expect(binaryStageOutcomes).toEqual(
      RELEASE_STAGES.filter((stage) => stage.forBinary).map((stage) => stage.id),
    );
  });
});
