import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuideFixtureNotFoundError, GuideFixtureSymlinkError, NotImplementedError } from "@lando/core/errors";
import { ScenarioContext, ScenarioContextFactory, withScenarioContext } from "@lando/core/testing";
import { Transcript } from "@lando/sdk/docs/components";
import { Cause, Effect, Schema } from "effect";

// Scenario commands run the real CLI, including real starts that wait out service readiness.
setDefaultTimeout(30_000);

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

const writeLandofile = (testDir: string, lines: ReadonlyArray<string>): Effect.Effect<void> =>
  Effect.promise(() => writeFile(join(testDir, ".lando.yml"), `${lines.join("\n")}\n`));

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
        withScenarioContext(
          { guideId: "node-postgres", scenarioId: "transcript-green", repositoryRoot: root },
          (context) =>
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
        withScenarioContext(
          { guideId: "node-postgres", scenarioId: "transcript-cleanup", repositoryRoot: root },
          (context) =>
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
        withScenarioContext(
          { guideId: "static", scenarioId: "inspect-capture", repositoryRoot: root },
          (context) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => writeFile(join(context.testDir, "notes.txt"), "hello inspect\n"));
              yield* Effect.promise(() =>
                writeFile(join(context.testDir, "config.json"), JSON.stringify({ name: "demo" })),
              );
              yield* writeLandofile(context.testDir, [
                "name: static-demo",
                "services:",
                "  web:",
                "    type: static",
                "    webroot: .",
              ]);

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
      {
        kind: "inspect",
        target: "events",
        value: expect.arrayContaining([expect.objectContaining({ _tag: "post-start" })]),
      },
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
            repositoryRoot: root,
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
    expect(raw).toContain("[redacted]");
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
          const exists = yield* Effect.promise(() => Bun.file(join(context.testDir, ".lando.yml")).exists());
          return { run, exists };
        }),
      ),
    );

    expect(result.run.exitCode).toBe(0);
    expect(result.run.command).toEqual(["init", "--full", "--no-interactive", "--answer=name=answers-app"]);
    expect(result.exists).toBe(true);
  });

  test("reports success after an earlier in-process CLI failure", async () => {
    const previousExitCode = process.exitCode;

    try {
      const result = await Effect.runPromise(
        withScenarioContext({ guideId: "compose", scenarioId: "failure-then-success" }, (context) =>
          Effect.gen(function* () {
            yield* writeLandofile(context.testDir, [
              "name: rejected-compose-key",
              "services:",
              "  web:",
              "    type: compose",
              "    image: traefik/whoami:v1.10",
              "    container_name: rejected",
            ]);
            const rejected = yield* context.runCli(["app:config", "--format=json"]);

            yield* writeLandofile(context.testDir, [
              "name: accepted-compose-key",
              "services:",
              "  web:",
              "    type: compose",
              "    image: traefik/whoami:v1.10",
            ]);
            const accepted = yield* context.runCli(["app:config", "--format=json"]);
            return { rejected, accepted };
          }),
        ),
      );

      expect(result.rejected.exitCode).toBe(1);
      expect(result.accepted.exitCode).toBe(0);
    } finally {
      process.exitCode = previousExitCode ?? 0;
    }
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
            captured = { command, ...(options === undefined ? {} : { options }) };
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

  test("strips leading lando and lando4 executable tokens from runCli commands", async () => {
    const seen: string[][] = [];

    await Effect.runPromise(
      withScenarioContext(
        {
          guideId: "node-postgres",
          scenarioId: "parse-command-tokens",
          runCli: async (command) => {
            seen.push([...command]);
            return {
              command,
              stdout: "",
              stderr: "",
              exitCode: 0,
              events: [],
            };
          },
        },
        (context) =>
          Effect.gen(function* () {
            yield* context.runCli("lando4 start");
            yield* context.runCli("lando start");
            yield* context.runCli("lando4");
            yield* context.runCli("landofile x");
            yield* context.runCli("lando42 x");
            yield* context.runCli(["lando4", "info"]);
            yield* context.runCli("version");
            return undefined;
          }),
      ),
    );

    expect(seen).toEqual([
      ["start"],
      ["start"],
      [],
      ["landofile", "x"],
      ["lando42", "x"],
      ["info"],
      ["version"],
    ]);
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

  test("shell runner fails with remediation", async () => {
    const exit = await Effect.runPromiseExit(
      withScenarioContext({ guideId: "node-postgres", scenarioId: "shell" }, (context) =>
        context.shell("echo hi"),
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") throw new TypeError("shell runner unexpectedly succeeded");
    const failure = Cause.findErrorOption(exit.cause);
    expect(failure._tag).toBe("Some");
    const error = failure._tag === "Some" ? failure.value : undefined;
    expect(error).toBeInstanceOf(NotImplementedError);
    expect(error instanceof NotImplementedError ? error.message : undefined).toBe(
      `<Run shell="echo hi"> is not implemented`,
    );
    expect(error instanceof NotImplementedError ? error.commandId : undefined).toBe("guide.run.shell");
    expect(error instanceof NotImplementedError ? error.remediation : undefined).toContain("not supported");
  });

  test("fixtures.use deep-copies per-guide fixtures before mutation and does not re-copy", async () => {
    const result = await withTempCwd(async (root) => {
      const guideFixture = join("docs", "guides", "node-postgres", "fixtures", "app");
      const sharedFixture = join("docs", "guides", "fixtures", "app");
      await mkdir(join(guideFixture, "nested"), { recursive: true });
      await mkdir(sharedFixture, { recursive: true });
      await writeFile(join(guideFixture, "nested", "config.txt"), "per-guide");
      await writeFile(join(sharedFixture, "config.txt"), "shared");

      return await Effect.runPromise(
        withScenarioContext(
          { guideId: "node-postgres", scenarioId: "fixture-copy", repositoryRoot: root },
          (context) =>
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
        withScenarioContext(
          { guideId: "node-postgres", scenarioId: "missing-fixture", repositoryRoot: root },
          (context) => context.fixtures.use("missing"),
        ),
      ).then((result) => ({ root, result })),
    );

    expect(exit.result._tag).toBe("Failure");
    const failure = exit.result._tag === "Failure" ? Cause.findErrorOption(exit.result.cause) : undefined;
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
    const exit = await withTempCwd(async (root) => {
      const perGuideFixturesDir = join("docs", "guides", "node-postgres", "fixtures");
      const perGuideRegularFileAtAppName = join(perGuideFixturesDir, "app");
      const sharedFallbackDir = join("docs", "guides", "fixtures", "app");
      await mkdir(perGuideFixturesDir, { recursive: true });
      await writeFile(perGuideRegularFileAtAppName, "not a directory");
      await mkdir(sharedFallbackDir, { recursive: true });
      await writeFile(join(sharedFallbackDir, "config.txt"), "shared");

      return await Effect.runPromiseExit(
        withScenarioContext(
          { guideId: "node-postgres", scenarioId: "non-dir-fixture", repositoryRoot: root },
          (context) => context.fixtures.use("app"),
        ),
      );
    });

    expect(exit._tag).toBe("Failure");
    const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
    const error = failure?._tag === "Some" ? failure.value : undefined;
    expect((error as { _tag?: string } | undefined)?._tag).toBe("FileIoError");
    expect((error as { message?: string } | undefined)?.message ?? "").toContain("is not a directory");
  });

  test("fixtures.use rejects symbolic links inside fixtures", async () => {
    const exit = await withTempCwd(async (root) => {
      const guideFixture = join("docs", "guides", "node-postgres", "fixtures", "symlinked");
      await mkdir(guideFixture, { recursive: true });
      await writeFile(join(guideFixture, "target.txt"), "target");
      await symlink("target.txt", join(guideFixture, "link.txt"));

      return await Effect.runPromiseExit(
        withScenarioContext(
          { guideId: "node-postgres", scenarioId: "symlink-fixture", repositoryRoot: root },
          (context) => context.fixtures.use("symlinked"),
        ),
      );
    });

    expect(exit._tag).toBe("Failure");
    const failure = exit._tag === "Failure" ? Cause.findErrorOption(exit.cause) : undefined;
    expect(failure?._tag).toBe("Some");
    const error = failure?._tag === "Some" ? failure.value : undefined;
    expect(error).toBeInstanceOf(GuideFixtureSymlinkError);
    if (!(error instanceof GuideFixtureSymlinkError)) {
      throw new TypeError("expected GuideFixtureSymlinkError");
    }
    expect(error.name).toBe("GuideFixtureSymlinkError");
    expect(error.fixtureName).toBe("symlinked");
    expect(error.path.endsWith(join("symlinked", "link.txt"))).toBe(true);
  });
});

describe("ScenarioContextFactory", () => {
  test("testOnlyFake starts for real and observes its applied static service", async () => {
    const result = await Effect.runPromise(
      ScenarioContextFactory.testOnlyFake({ guideId: "static", scenarioId: "fake-shim" }, (context) =>
        Effect.gen(function* () {
          expect(context.layer).toBe("scenario");
          yield* Effect.promise(() => mkdir(join(context.testDir, "dist"), { recursive: true }));
          yield* writeLandofile(context.testDir, [
            "name: static-demo",
            "services:",
            "  web:",
            "    type: static",
            "    webroot: /app/dist",
          ]);
          yield* Effect.promise(() =>
            writeFile(join(context.testDir, "dist", "index.html"), "hello from lando static\n"),
          );

          const started = yield* context.runCli(["start"]);
          const fetched = yield* context.runCli(["info", "--format=json"]);
          return { started, fetched };
        }),
      ),
    );

    expect(result.started.exitCode).toBe(0);
    expect(result.started.stdout).toContain("ready: static-demo - web");
    expect(result.started.events.map((event) => event._tag)).toContain("post-start");
    expect(JSON.parse(result.fetched.stdout)).toMatchObject({ ok: true, result: { app: "static-demo" } });
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
          const created = yield* Effect.promise(() => Bun.file(join(context.testDir, ".lando.yml")).exists());
          return { version, init, created };
        }),
      ),
    );

    expect(result.version.stdout).toContain("0.0.0");
    expect(result.init.exitCode).toBe(0);
    expect(result.created).toBe(true);
  });

  test("scenario layer renders a real missing-app failure instead of exiting", async () => {
    const result = await Effect.runPromise(
      ScenarioContextFactory.scenario({ guideId: "node-postgres", scenarioId: "guarded" }, (context) =>
        context.runCli(["start"]),
      ),
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("LandofileNotFoundError");
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

  test("withScenarioContext stays on the in-process scenario layer for generated guides", async () => {
    const layer = await Effect.runPromise(
      withScenarioContext({ guideId: "node-postgres", scenarioId: "compat" }, (context) =>
        Effect.succeed(context.layer),
      ),
    );
    expect(layer).toBe("scenario");
  });

  test("context.hidden suppresses transcript frames emitted inside its scope", async () => {
    const frames = await Effect.runPromise(
      withScenarioContext({ guideId: "node-postgres", scenarioId: "hidden-scope" }, (context) =>
        Effect.gen(function* () {
          yield* context.runCli(["version"]);
          yield* context.hidden(
            Effect.gen(function* () {
              yield* context.runCli(["version"]);
              yield* context.transcript.append({
                kind: "verify",
                target: "event",
                matched: true,
                expected: "ready",
                actual: "ready",
              });
            }),
          );
          yield* context.runCli(["version"]);
          return context.transcript.frames.map((frame) => frame.kind);
        }),
      ),
    );

    expect(frames).toEqual(["run", "run"]);
  });

  test("context.hidden restores transcript recording after a nested failure", async () => {
    const frames = await Effect.runPromise(
      withScenarioContext({ guideId: "node-postgres", scenarioId: "hidden-restore" }, (context) =>
        Effect.gen(function* () {
          yield* Effect.result(
            context.hidden(
              Effect.gen(function* () {
                yield* context.runCli(["version"]);
                return yield* Effect.fail(new Error("boom"));
              }),
            ),
          );
          yield* context.runCli(["version"]);
          return context.transcript.frames.map((frame) => frame.kind);
        }),
      ),
    );

    expect(frames).toEqual(["run"]);
  });
});

describe("in-process lifecycle", () => {
  test("two scenarios do not share materialized global-app state (#2113)", async () => {
    const result = await Effect.runPromise(
      withScenarioContext({ guideId: "static", scenarioId: "global-owner" }, (first) =>
        Effect.gen(function* () {
          yield* first.fixtures.use("static-demo");
          const started = yield* first.runCli(["start", "--format=json"]);
          expect(started.exitCode, started.stdout).toBe(0);
          const other = yield* withScenarioContext(
            { guideId: "static", scenarioId: "global-isolated" },
            (second) => second.runCli(["meta:global:status", "--format=json"]),
          );
          return { other, owner: yield* first.runCli(["meta:global:status", "--format=json"]) };
        }),
      ),
    );
    expect(result.owner.exitCode).toBe(0);
    expect(result.other.exitCode).toBe(0);
    expect(JSON.parse(result.owner.stdout)).toMatchObject({ ok: true, result: { materialized: true } });
    expect(JSON.parse(result.other.stdout)).toMatchObject({ ok: true, result: { materialized: false } });
  });
  const eventsDemo = (preStop: string) => [
    "name: lifecycle-demo",
    "services:",
    "  web:",
    "    type: compose",
    "    image: alpine:3.21",
    "    command: [sleep, infinity]",
    "events:",
    "  pre-stop:",
    `    - cmd: echo ${preStop}`,
    "      service: web",
  ];

  test("stop and destroy run against the recorded applied plan and publish their events", async () => {
    const result = await Effect.runPromise(
      withScenarioContext({ guideId: "events", scenarioId: "applied-lifecycle" }, (context) =>
        Effect.gen(function* () {
          // Given: a started app whose stop hook is then edited.
          yield* writeLandofile(context.testDir, eventsDemo("first-hook"));
          const started = yield* context.runCli("lando start");
          yield* writeLandofile(context.testDir, eventsDemo("edited-hook"));

          // When: the app is stopped, destroyed, and destroyed again.
          const stopped = yield* context.runCli("lando stop");
          const destroyed = yield* context.runCli("lando destroy -y --format=json");
          const again = yield* context.runCli("lando destroy -y --format=json");
          return { started, stopped, destroyed, again, events: context.events };
        }),
      ),
    );

    // Then: each run reports its own events, and the context keeps them all in order.
    const tags = (events: ReadonlyArray<{ readonly _tag: string }>) => events.map((event) => event._tag);
    expect(result.started.exitCode).toBe(0);
    expect(tags(result.started.events)).toContain("post-start");
    expect(tags(result.started.events)).not.toContain("pre-stop");
    expect(result.stopped.exitCode).toBe(0);
    expect(tags(result.stopped.events)).toEqual(
      expect.arrayContaining(["pre-stop", "pre-service-stop", "post-service-stop", "post-stop"]),
    );
    expect(tags(result.stopped.events)).not.toContain("post-start");
    // The stop hook comes from the current Landofile, not the one the app started with.
    expect(`${result.stopped.stdout}${result.stopped.stderr}`).toContain("edited-hook");
    expect(`${result.stopped.stdout}${result.stopped.stderr}`).not.toContain("first-hook");
    expect(result.destroyed.exitCode).toBe(0);
    expect(tags(result.destroyed.events)).toEqual(expect.arrayContaining(["pre-destroy", "post-destroy"]));
    expect(JSON.parse(result.destroyed.stdout)).toMatchObject({ result: { outcome: "destroyed" } });
    expect(result.again.exitCode).toBe(0);
    expect(JSON.parse(result.again.stdout)).toMatchObject({ result: { outcome: "unchanged" } });
    expect(result.events).toEqual([
      ...result.started.events,
      ...result.stopped.events,
      ...result.destroyed.events,
      ...result.again.events,
    ]);
    const all = tags(result.events);
    expect(all.indexOf("post-start")).toBeLessThan(all.indexOf("pre-stop"));
    expect(all.indexOf("post-stop")).toBeLessThan(all.indexOf("pre-destroy"));
  });

  test("start reports the planner's own rejection of an unknown service type", async () => {
    const result = await Effect.runPromise(
      withScenarioContext({ guideId: "node-postgres", scenarioId: "unknown-type" }, (context) =>
        Effect.gen(function* () {
          yield* writeLandofile(context.testDir, [
            "name: unknown-type",
            "services:",
            "  cache:",
            "    type: not-a-real-service-type",
          ]);
          return yield* context.runCli("lando start");
        }),
      ),
    );

    expect(result.exitCode).toBe(1);
    expect(result._tag).toBe("LandofileValidationError");
    expect(result.stderr).toContain("not-a-real-service-type");
  });

  test("string commands run as the argv a shell gives them", async () => {
    const seen: string[][] = [];
    const failure = await Effect.runPromise(
      withScenarioContext(
        {
          guideId: "node-postgres",
          scenarioId: "shell-words",
          runCli: async (command) => {
            seen.push([...command]);
            return { command, stdout: "", stderr: "", exitCode: 0, events: [] };
          },
        },
        (context) =>
          Effect.gen(function* () {
            yield* context.runCli(`lando init --name 'My App' --answer=greeting="hello world" ''`);
            return yield* Effect.flip(context.runCli("lando info | jq ."));
          }),
      ),
    );

    expect(seen).toEqual([["init", "--name", "My App", "--answer=greeting=hello world", ""]]);
    expect(failure).toMatchObject({
      _tag: "GuideCommandSyntaxError",
      reason: "shell-syntax",
      character: "|",
    });
  });
});
