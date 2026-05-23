import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect } from "effect";

import { GuideFixtureNotFoundError, GuideFixtureSymlinkError, NotImplementedError } from "@lando/core/errors";
import { ScenarioContext, withScenarioContext } from "@lando/core/testing";

const withTempCwd = async <A>(body: (root: string) => Promise<A>): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), "lando-fixtures-"));
  const previous = process.cwd();
  process.chdir(root);
  try {
    return await body(root);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
};

describe("withScenarioContext", () => {
  test("provides a scoped ScenarioContext and removes testDir after success", async () => {
    let cleanupSawTestDir = false;
    const result = await Effect.runPromise(
      withScenarioContext({ guideId: "node-postgres", scenarioId: "happy-path" }, (context) =>
        Effect.gen(function* () {
          const provided = yield* ScenarioContext;
          expect(provided).toBe(context);
          expect(context.guideId).toBe("node-postgres");
          expect(context.scenarioId).toBe("happy-path");
          expect(context.variant).toEqual({});
          expect(existsSync(context.testDir)).toBe(true);

          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              cleanupSawTestDir = existsSync(context.testDir);
            }),
          );
          yield* context.transcript.append({ kind: "note", data: "before run" });
          const run = yield* context.runCli(["version"]);

          return {
            testDir: context.testDir,
            run,
            transcriptFrames: context.transcript.frames,
            processRunnerCalls: context.runtime.calls.processRunner.length,
          };
        }),
      ),
    );

    expect(result.run.exitCode).toBe(0);
    expect(result.run.stdout).toContain("0.0.0");
    expect(result.run.command).toEqual(["version"]);
    expect(result.transcriptFrames).toHaveLength(2);
    expect(result.processRunnerCalls).toBe(0);
    expect(cleanupSawTestDir).toBe(true);
    expect(existsSync(result.testDir)).toBe(false);
  });

  test("forwards answers to the default init runner", async () => {
    const result = await Effect.runPromise(
      withScenarioContext({ guideId: "node-postgres", scenarioId: "init-answers" }, (context) =>
        Effect.gen(function* () {
          const run = yield* context.runCli(["init", "--full", "--no-interactive"], {
            answers: { name: "answers-app" },
          });
          const exists = yield* Effect.promise(() =>
            Bun.file(join(context.testDir, "answers-app", ".lando.yml")).exists(),
          );
          return { run, exists };
        }),
      ),
    );

    expect(result.run.exitCode).toBe(0);
    expect(result.run.command).toEqual(["init", "--full", "--no-interactive", "--answer=name=answers-app"]);
    expect(result.exists).toBe(true);
  });

  test("forwards runCli options to custom overrides", async () => {
    let captured:
      | {
          readonly command: ReadonlyArray<string>;
          readonly options?: { readonly answers?: Readonly<Record<string, string>> };
        }
      | undefined;

    await Effect.runPromise(
      withScenarioContext(
        {
          guideId: "node-postgres",
          scenarioId: "override-options",
          runCli: async (command, options) => {
            captured = { command, options };
            return {
              command,
              stdout: "",
              stderr: "",
              exitCode: 0,
              events: [],
            };
          },
        },
        (context) => context.runCli(["version"], { answers: { name: "override-app" } }),
      ),
    );

    expect(captured).toEqual({
      command: ["version"],
      options: { answers: { name: "override-app" } },
    });
  });

  test("preserves testDir when KEEP_SCENARIO_DIRS=1", async () => {
    const previous = process.env.KEEP_SCENARIO_DIRS;
    process.env.KEEP_SCENARIO_DIRS = "1";
    let testDir = "";

    try {
      testDir = await Effect.runPromise(
        withScenarioContext({ guideId: "node-postgres", scenarioId: "kept" }, (context) =>
          Effect.succeed(context.testDir),
        ),
      );
      expect(existsSync(testDir)).toBe(true);
    } finally {
      if (previous === undefined) {
        process.env.KEEP_SCENARIO_DIRS = undefined;
      } else {
        process.env.KEEP_SCENARIO_DIRS = previous;
      }
      await rm(testDir, { recursive: true, force: true });
    }
  });

  test("shell runner fails with Alpha 2 remediation", async () => {
    const exit = await Effect.runPromiseExit(
      withScenarioContext({ guideId: "node-postgres", scenarioId: "shell" }, (context) =>
        context.shell("echo hi"),
      ),
    );
    expect(exit._tag).toBe("Failure");
    const failure = Cause.failureOption(exit.cause);
    expect(failure._tag).toBe("Some");
    const error = failure._tag === "Some" ? failure.value : undefined;
    expect(error).toBeInstanceOf(NotImplementedError);
    expect(error instanceof NotImplementedError ? error.commandId : undefined).toBe("guide.run.shell");
    expect(error instanceof NotImplementedError ? error.remediation : undefined).toContain("Phase 3 Beta");
  });

  test("fixtures.use deep-copies per-guide fixtures before mutation and does not re-copy", async () => {
    const result = await withTempCwd(async () => {
      const guideFixture = join("docs", "guides", "node-postgres", "fixtures", "app");
      const sharedFixture = join("docs", "guides", "fixtures", "app");
      await mkdir(join(guideFixture, "nested"), { recursive: true });
      await mkdir(sharedFixture, { recursive: true });
      await writeFile(join(guideFixture, "nested", "config.txt"), "per-guide");
      await writeFile(join(sharedFixture, "config.txt"), "shared");

      return await Effect.runPromise(
        withScenarioContext({ guideId: "node-postgres", scenarioId: "fixture-copy" }, (context) =>
          Effect.promise(async () => {
            const copied = await Effect.runPromise(context.fixtures.use("app"));
            const copiedFile = join(copied, "nested", "config.txt");
            const firstContent = await readFile(copiedFile, "utf8");
            await writeFile(copiedFile, "mutated copy");
            const secondCopied = await Effect.runPromise(context.fixtures.use("app"));

            return {
              copied,
              secondCopied,
              firstContent,
              copiedContent: await readFile(copiedFile, "utf8"),
              sourceContent: await readFile(join(guideFixture, "nested", "config.txt"), "utf8"),
              sharedContent: await readFile(join(sharedFixture, "config.txt"), "utf8"),
            };
          }),
        ),
      );
    });

    expect(result.secondCopied).toBe(result.copied);
    expect(result.firstContent).toBe("per-guide");
    expect(result.copiedContent).toBe("mutated copy");
    expect(result.sourceContent).toBe("per-guide");
    expect(result.sharedContent).toBe("shared");
  });

  test("fixtures.use fails missing fixtures with candidate paths", async () => {
    const exit = await withTempCwd(async (root) =>
      Effect.runPromiseExit(
        withScenarioContext({ guideId: "node-postgres", scenarioId: "missing-fixture" }, (context) =>
          context.fixtures.use("missing"),
        ),
      ).then((result) => ({ root, result })),
    );

    expect(exit.result._tag).toBe("Failure");
    const failure = exit.result._tag === "Failure" ? Cause.failureOption(exit.result.cause) : undefined;
    expect(failure?._tag).toBe("Some");
    const error = failure?._tag === "Some" ? failure.value : undefined;
    expect(error).toBeInstanceOf(GuideFixtureNotFoundError);
    if (error instanceof GuideFixtureNotFoundError) {
      expect(error.name).toBe("GuideFixtureNotFoundError");
      expect(error.fixtureName).toBe("missing");
      expect(error.candidates).toEqual([
        join(exit.root, "docs", "guides", "node-postgres", "fixtures", "missing"),
        join(exit.root, "docs", "guides", "fixtures", "missing"),
      ]);
    }
  });

  test("fixtures.use rejects non-directory fixture candidates without falling back to shared", async () => {
    const exit = await withTempCwd(async () => {
      const perGuideFixturesDir = join("docs", "guides", "node-postgres", "fixtures");
      const perGuideRegularFileAtAppName = join(perGuideFixturesDir, "app");
      const sharedFallbackDir = join("docs", "guides", "fixtures", "app");
      await mkdir(perGuideFixturesDir, { recursive: true });
      await writeFile(perGuideRegularFileAtAppName, "not a directory");
      await mkdir(sharedFallbackDir, { recursive: true });
      await writeFile(join(sharedFallbackDir, "config.txt"), "shared");

      return await Effect.runPromiseExit(
        withScenarioContext({ guideId: "node-postgres", scenarioId: "non-dir-fixture" }, (context) =>
          context.fixtures.use("app"),
        ),
      );
    });

    expect(exit._tag).toBe("Failure");
    const failure = exit._tag === "Failure" ? Cause.failureOption(exit.cause) : undefined;
    const error = failure?._tag === "Some" ? failure.value : undefined;
    expect((error as { _tag?: string } | undefined)?._tag).toBe("FileIoError");
    expect((error as { message?: string } | undefined)?.message ?? "").toContain("is not a directory");
  });

  test("fixtures.use rejects symbolic links inside fixtures", async () => {
    const exit = await withTempCwd(async () => {
      const guideFixture = join("docs", "guides", "node-postgres", "fixtures", "symlinked");
      await mkdir(guideFixture, { recursive: true });
      await writeFile(join(guideFixture, "target.txt"), "target");
      await symlink("target.txt", join(guideFixture, "link.txt"));

      return await Effect.runPromiseExit(
        withScenarioContext({ guideId: "node-postgres", scenarioId: "symlink-fixture" }, (context) =>
          context.fixtures.use("symlinked"),
        ),
      );
    });

    expect(exit._tag).toBe("Failure");
    const failure = exit._tag === "Failure" ? Cause.failureOption(exit.cause) : undefined;
    expect(failure?._tag).toBe("Some");
    const error = failure?._tag === "Some" ? failure.value : undefined;
    expect(error).toBeInstanceOf(GuideFixtureSymlinkError);
    expect(error.name).toBe("GuideFixtureSymlinkError");
    expect(error.fixtureName).toBe("symlinked");
    expect(
      error instanceof GuideFixtureSymlinkError ? error.path.endsWith(join("symlinked", "link.txt")) : false,
    ).toBe(true);
  });
});
