import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Schema } from "effect";

import { GuideFixtureNotFoundError, GuideFixtureSymlinkError, NotImplementedError } from "@lando/core/errors";
import { ScenarioContext, ScenarioContextFactory, withScenarioContext } from "@lando/core/testing";
import { Transcript } from "@lando/sdk/docs/components";

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
          yield* context.transcript.append({
            kind: "verify",
            target: "event",
            matched: true,
            expected: "ready",
            actual: "ready",
          });
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

  test("writes a schema-valid transcript on success", async () => {
    const transcript = await withTempCwd(async (root) => {
      const transcriptPath = join(
        root,
        "dist",
        "transcripts",
        "guides",
        "node-postgres",
        "transcript-green.json",
      );
      await Effect.runPromise(
        withScenarioContext({ guideId: "node-postgres", scenarioId: "transcript-green" }, (context) =>
          Effect.gen(function* () {
            yield* context.runCli(["version"]);
            return undefined;
          }),
        ),
      );
      return JSON.parse(await readFile(transcriptPath, "utf8")) as Record<string, unknown>;
    });

    expect(Schema.decodeUnknownSync(Transcript)(transcript)).toMatchObject({
      guideId: "node-postgres",
      scenarioId: "transcript-green",
      render: true,
      exitStatus: "pass",
    });
    expect(transcript.frames).toEqual([
      expect.objectContaining({ kind: "run", command: ["version"], stdout: "0.0.0\n", exit: 0 }),
    ]);
  });

  test("persists cleanup frames pushed from Effect.addFinalizer", async () => {
    const transcript = await withTempCwd(async (root) => {
      const transcriptPath = join(
        root,
        "dist",
        "transcripts",
        "guides",
        "node-postgres",
        "transcript-cleanup.json",
      );
      await Effect.runPromise(
        withScenarioContext({ guideId: "node-postgres", scenarioId: "transcript-cleanup" }, (context) =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              context.transcript.append({ kind: "cleanup", command: [], exit: 0 }),
            );
            yield* context.runCli(["version"]);
            return undefined;
          }),
        ),
      );
      return JSON.parse(await readFile(transcriptPath, "utf8")) as Record<string, unknown>;
    });

    expect(transcript.frames).toEqual([
      expect.objectContaining({ kind: "run", command: ["version"] }),
      expect.objectContaining({ kind: "cleanup", command: [], exit: 0 }),
    ]);
  });

  test("inspect captures file, json, events, and output without asserting or failing", async () => {
    const result = await withTempCwd(async (root) => {
      const transcriptPath = join(root, "dist", "transcripts", "guides", "static", "inspect-capture.json");
      const frames = await Effect.runPromise(
        withScenarioContext({ guideId: "static", scenarioId: "inspect-capture" }, (context) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => writeFile(join(context.testDir, "notes.txt"), "hello inspect\n"));
            yield* Effect.promise(() =>
              writeFile(join(context.testDir, "config.json"), JSON.stringify({ name: "demo" })),
            );
            yield* Effect.promise(() =>
              writeFile(
                join(context.testDir, ".lando.yml"),
                ["name: static-demo", "services:", "  web:", "    type: static", "    root: .", ""].join(
                  "\n",
                ),
              ),
            );

            yield* context.runCli(["version"]);
            yield* context.inspect({ output: true });
            yield* context.runCli(["start"]);
            yield* context.inspect({ events: true });
            yield* context.inspect({ file: "notes.txt" });
            yield* context.inspect({ json: "config.json" });
            yield* context.inspect({ file: "missing.txt" });

            return context.transcript.frames;
          }),
        ),
      );
      const transcript = JSON.parse(await readFile(transcriptPath, "utf8")) as Record<string, unknown>;
      return { frames, transcript };
    });

    const inspectFrames = result.frames.filter((frame) => frame.kind === "inspect");
    expect(inspectFrames).toEqual([
      { kind: "inspect", target: "output", value: "0.0.0\n" },
      { kind: "inspect", target: "events", value: [{ _tag: "post-start" }] },
      { kind: "inspect", target: "file", value: "hello inspect\n" },
      { kind: "inspect", target: "json", value: { name: "demo" } },
      { kind: "inspect", target: "file", value: null },
    ]);
    expect(Schema.decodeUnknownSync(Transcript)(result.transcript)).toMatchObject({
      guideId: "static",
      scenarioId: "inspect-capture",
      exitStatus: "pass",
    });
  });

  test("writes a redacted failure transcript before removing testDir", async () => {
    const result = await withTempCwd(async (root) => {
      const transcriptPath = join(
        root,
        "dist",
        "transcripts",
        "guides",
        "node-postgres",
        "transcript-red.json",
      );
      const exit = await Effect.runPromiseExit(
        withScenarioContext(
          {
            guideId: "node-postgres",
            scenarioId: "transcript-red",
            runCli: async (command) => ({
              command,
              stdout: `AUTH_TOKEN=secret ${new Date("2026-05-23T12:00:00.000Z").toISOString()}`,
              stderr: "AUTH_TOKEN=secret",
              exitCode: 0,
              events: [],
            }),
          },
          (context) =>
            Effect.gen(function* () {
              const run = yield* context.runCli(["version"]);
              yield* context.transcript.append({
                kind: "verify",
                target: "errorTag",
                matched: false,
                expected: "ExpectedError",
                actual: { token: "secret", runStdout: run.stdout, path: context.testDir },
              });
              return yield* Effect.fail(new Error("expected failure"));
            }),
        ),
      );
      const raw = await readFile(transcriptPath, "utf8");
      return { root, raw, exit };
    });

    expect(result.exit._tag).toBe("Failure");
    const raw = result.raw;
    const transcript = JSON.parse(raw) as Record<string, unknown>;
    expect(transcript.exitStatus).toBe("fail");
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("2026-05-23T12:00:00.000Z");
    expect(raw).not.toContain("lando-scenario-node-postgres-transcript-red");
    expect(raw).toContain("[REDACTED]");
    expect(raw).toContain("<timestamp>");
    expect(raw).toContain("<testDir>");
    expect(transcript.frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "verify", target: "errorTag", matched: false }),
      ]),
    );
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

  test("serves static guide fixture files through the scenario curl shim", async () => {
    const result = await Effect.runPromise(
      withScenarioContext({ guideId: "static", scenarioId: "fetch-known-file" }, (context) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => mkdir(join(context.testDir, "dist"), { recursive: true }));
          yield* Effect.promise(() =>
            writeFile(
              join(context.testDir, ".lando.yml"),
              ["name: static-demo", "services:", "  web:", "    type: static", "    root: dist", ""].join(
                "\n",
              ),
            ),
          );
          yield* Effect.promise(() =>
            writeFile(join(context.testDir, "dist", "index.html"), "hello from lando static\n"),
          );

          yield* context.runCli(["start"]);
          return yield* context.runCli(["curl", "index.html"]);
        }),
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello from lando static\n");
    expect(result.command).toEqual(["curl", "index.html"]);
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

describe("ScenarioContextFactory", () => {
  test("testOnlyFake preserves the canned start/curl scenario shim", async () => {
    const result = await Effect.runPromise(
      ScenarioContextFactory.testOnlyFake({ guideId: "static", scenarioId: "fake-shim" }, (context) =>
        Effect.gen(function* () {
          expect(context.layer).toBe("scenario");
          yield* Effect.promise(() => mkdir(join(context.testDir, "dist"), { recursive: true }));
          yield* Effect.promise(() =>
            writeFile(
              join(context.testDir, ".lando.yml"),
              ["name: static-demo", "services:", "  web:", "    type: static", "    root: dist", ""].join(
                "\n",
              ),
            ),
          );
          yield* Effect.promise(() =>
            writeFile(join(context.testDir, "dist", "index.html"), "hello from lando static\n"),
          );

          const started = yield* context.runCli(["start"]);
          const fetched = yield* context.runCli(["curl", "index.html"]);
          return { started, fetched, events: context.events };
        }),
      ),
    );

    expect(result.started.stdout).toBe("ready\n");
    expect(result.events).toContainEqual({ _tag: "post-start" });
    expect(result.fetched.stdout).toBe("hello from lando static\n");
    expect(result.fetched.exitCode).toBe(0);
  });

  test("scenario layer routes runCli through the real @lando/core/cli seam", async () => {
    const result = await Effect.runPromise(
      ScenarioContextFactory.scenario({ guideId: "node-postgres", scenarioId: "real-seam" }, (context) =>
        Effect.gen(function* () {
          expect(context.layer).toBe("scenario");
          const version = yield* context.runCli(["version"]);
          const init = yield* context.runCli(["init", "--full", "--no-interactive"], {
            answers: { name: "seam-app" },
          });
          const created = yield* Effect.promise(() =>
            Bun.file(join(context.testDir, "seam-app", ".lando.yml")).exists(),
          );
          return { version, init, created };
        }),
      ),
    );

    expect(result.version.stdout).toContain("0.0.0");
    expect(result.init.exitCode).toBe(0);
    expect(result.created).toBe(true);
  });

  test("scenario layer refuses commands outside the in-process allowlist instead of exiting", async () => {
    const result = await Effect.runPromise(
      ScenarioContextFactory.scenario({ guideId: "node-postgres", scenarioId: "guarded" }, (context) =>
        context.runCli(["start"]),
      ),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("ScenarioContextFactory.e2e");
    expect(result.command).toEqual(["start"]);
  });

  test("e2e layer advances the working directory into the app created by init", async () => {
    const stubDir = await mkdtemp(join(tmpdir(), "lando-e2e-initcwd-"));
    const stub = join(stubDir, "lando-stub.sh");
    await writeFile(
      stub,
      [
        "#!/bin/sh",
        'if [ "$1" = "init" ] || [ "$1" = "apps:init" ]; then',
        '  name=""',
        '  for arg in "$@"; do',
        '    case "$arg" in',
        '      --answer=name=*) name="${arg#--answer=name=}" ;;',
        '      --name=*) name="${arg#--name=}" ;;',
        "    esac",
        "  done",
        '  mkdir -p "$name"',
        "  exit 0",
        "fi",
        "pwd",
        "exit 0",
        "",
      ].join("\n"),
    );
    await Bun.spawn(["chmod", "+x", stub]).exited;
    const previous = process.env.LANDO_SCENARIO_E2E_BINARY;
    process.env.LANDO_SCENARIO_E2E_BINARY = stub;
    try {
      const result = await Effect.runPromise(
        ScenarioContextFactory.e2e({ guideId: "node-postgres", scenarioId: "e2e-initcwd" }, (context) =>
          Effect.gen(function* () {
            const init = yield* context.runCli(["init"], { answers: { name: "e2e-app" } });
            const where = yield* context.runCli(["whereami"]);
            return { init, where };
          }),
        ),
      );
      expect(result.init.exitCode).toBe(0);
      expect(result.where.stdout.trim().endsWith(join("e2e-app"))).toBe(true);
    } finally {
      process.env.LANDO_SCENARIO_E2E_BINARY = previous;
      await rm(stubDir, { recursive: true, force: true });
    }
  });

  test("e2e layer spawns the compiled binary and captures stdout/stderr/exit", async () => {
    const stub = join(await mkdtemp(join(tmpdir(), "lando-e2e-stub-")), "lando-stub.sh");
    await writeFile(
      stub,
      ["#!/bin/sh", 'echo "stub-stdout $@"', 'echo "stub-stderr" 1>&2', "exit 7", ""].join("\n"),
    );
    await Bun.spawn(["chmod", "+x", stub]).exited;
    const previous = process.env.LANDO_SCENARIO_E2E_BINARY;
    process.env.LANDO_SCENARIO_E2E_BINARY = stub;
    try {
      const result = await Effect.runPromise(
        ScenarioContextFactory.e2e({ guideId: "node-postgres", scenarioId: "e2e-stub" }, (context) =>
          Effect.gen(function* () {
            expect(context.layer).toBe("e2e");
            return yield* context.runCli(["version", "--json"]);
          }),
        ),
      );
      expect(result.stdout).toContain("stub-stdout version --json");
      expect(result.stderr).toContain("stub-stderr");
      expect(result.exitCode).toBe(7);
    } finally {
      process.env.LANDO_SCENARIO_E2E_BINARY = previous;
      await rm(join(stub, ".."), { recursive: true, force: true });
    }
  });

  test("e2e layer reports a missing compiled binary as a 127 exit result", async () => {
    const previous = process.env.LANDO_SCENARIO_E2E_BINARY;
    process.env.LANDO_SCENARIO_E2E_BINARY = join(tmpdir(), "definitely-not-a-lando-binary-xyz");
    try {
      const result = await Effect.runPromise(
        ScenarioContextFactory.e2e({ guideId: "node-postgres", scenarioId: "e2e-missing" }, (context) =>
          context.runCli(["version"]),
        ),
      );
      expect(result.exitCode).toBe(127);
      expect(result.stderr).toContain("not found");
    } finally {
      process.env.LANDO_SCENARIO_E2E_BINARY = previous;
    }
  });

  test("withScenarioContext stays on the scenario layer with fake behavior for generated guides", async () => {
    const layer = await Effect.runPromise(
      withScenarioContext({ guideId: "node-postgres", scenarioId: "compat" }, (context) =>
        Effect.succeed(context.layer),
      ),
    );
    expect(layer).toBe("scenario");
  });
});
