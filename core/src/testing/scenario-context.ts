import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect } from "effect";

import { NotImplementedError } from "@lando/sdk/errors";
import type { LandoEvent } from "@lando/sdk/services";

import { CORE_VERSION } from "../version.ts";
import { type TestRuntime, makeTestRuntime } from "./test-runtime.ts";

export interface ScenarioVariable {
  readonly value: string;
  readonly display?: string;
}

export interface ScenarioRunResult {
  readonly command: ReadonlyArray<string>;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly events: ReadonlyArray<LandoEvent>;
}

export interface ScenarioTranscriptFrame {
  readonly kind: "run" | "event" | "message";
  readonly data: unknown;
}

export interface ScenarioTranscript {
  readonly frames: ReadonlyArray<ScenarioTranscriptFrame>;
  readonly append: (frame: ScenarioTranscriptFrame) => Effect.Effect<void>;
}

export interface ScenarioFixtures {
  readonly use: (name: string) => Effect.Effect<string, NotImplementedError>;
}

export interface ScenarioContext {
  readonly guideId: string;
  readonly scenarioId: string;
  readonly variant: Readonly<Record<string, never>>;
  readonly testDir: string;
  readonly runtime: TestRuntime;
  readonly vars: Map<string, ScenarioVariable>;
  readonly runCli: (command: string | ReadonlyArray<string>) => Effect.Effect<ScenarioRunResult, unknown>;
  readonly shell: (command: string) => Effect.Effect<never, NotImplementedError>;
  readonly events: ReadonlyArray<LandoEvent>;
  readonly transcript: ScenarioTranscript;
  readonly fixtures: ScenarioFixtures;
}

export const ScenarioContext = Context.GenericTag<ScenarioContext>("@lando/core/ScenarioContext");

export interface WithScenarioContextOptions {
  readonly guideId: string;
  readonly scenarioId: string;
  readonly vars?: ReadonlyMap<string, ScenarioVariable>;
  readonly runtime?: TestRuntime;
  readonly runCli?: (command: ReadonlyArray<string>) => Promise<ScenarioRunResult>;
}

const parseCommand = (command: string | ReadonlyArray<string>): ReadonlyArray<string> =>
  typeof command === "string" ? command.trim().split(/\s+/).filter(Boolean) : command;

const shellNotImplemented = (command: string): NotImplementedError =>
  new NotImplementedError({
    message: `<Run shell=\"${command}\"> is not implemented in Alpha 2`,
    commandId: "guide.run.shell",
    specSection: "§19.4",
    remediation:
      'Use `<Run command="…">` for Alpha 2 guide scenarios. Shell runners ship in Phase 3 Beta — see `spec/ROADMAP.md`.',
  });

const fixturesNotImplemented = (name: string): NotImplementedError =>
  new NotImplementedError({
    message: `<UseFixture name=\"${name}\"> is implemented by the fixture-copy discipline story`,
    commandId: "guide.fixture.use",
    specSection: "§19.9",
    remediation:
      "Fixture copying is implemented by the Alpha 2 fixture-copy discipline story; keep fixture sources immutable per §19.9.",
  });

const captureWrite = (stream: typeof process.stdout | typeof process.stderr) => {
  const chunks: string[] = [];
  const original = stream.write.bind(stream) as typeof stream.write;
  (stream as unknown as { write: typeof stream.write }).write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof stream.write;

  return {
    content: () => chunks.join(""),
    restore: () => {
      (stream as unknown as { write: typeof stream.write }).write = original;
    },
  };
};

const createDefaultRunCli =
  (testDir: string, events: LandoEvent[]): ScenarioContext["runCli"] =>
  (command) =>
    Effect.tryPromise(async () => {
      const args = parseCommand(command);
      if (args.length === 1 && (args[0] === "version" || args[0] === "--version" || args[0] === "-v")) {
        return {
          command: args,
          stdout: `${CORE_VERSION}\n`,
          stderr: "",
          exitCode: 0,
          events: [...events],
        } satisfies ScenarioRunResult;
      }

      const stdout = captureWrite(process.stdout);
      const stderr = captureWrite(process.stderr);
      const previousCwd = process.cwd();
      const previousExitCode = process.exitCode;

      try {
        process.chdir(testDir);
        process.exitCode = undefined;
        const cli = await import("../cli/index.ts");
        await cli.runCli({ argv: args, rootUrl: new URL("../../bin/lando.ts", import.meta.url).href });

        return {
          command: args,
          stdout: stdout.content(),
          stderr: stderr.content(),
          exitCode: typeof process.exitCode === "number" ? process.exitCode : 0,
          events: [...events],
        } satisfies ScenarioRunResult;
      } finally {
        process.chdir(previousCwd);
        process.exitCode = previousExitCode;
        stdout.restore();
        stderr.restore();
      }
    });

const createRunCli = (
  testDir: string,
  events: LandoEvent[],
  transcriptFrames: ScenarioTranscriptFrame[],
  override?: (command: ReadonlyArray<string>) => Promise<ScenarioRunResult>,
): ScenarioContext["runCli"] => {
  const runner =
    override === undefined
      ? createDefaultRunCli(testDir, events)
      : (command: string | ReadonlyArray<string>) => Effect.tryPromise(() => override(parseCommand(command)));

  return (command) =>
    runner(command).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          transcriptFrames.push({ kind: "run", data: result });
        }),
      ),
    );
};

const makeScenarioContext = (options: WithScenarioContextOptions, testDir: string): ScenarioContext => {
  const runtime = options.runtime ?? makeTestRuntime({ bootstrap: "provider" });
  const events: LandoEvent[] = [];
  const transcriptFrames: ScenarioTranscriptFrame[] = [];

  return {
    guideId: options.guideId,
    scenarioId: options.scenarioId,
    variant: {},
    testDir,
    runtime,
    vars: new Map(options.vars ?? []),
    runCli: createRunCli(testDir, events, transcriptFrames, options.runCli),
    shell: (command) => Effect.fail(shellNotImplemented(command)),
    events,
    transcript: {
      frames: transcriptFrames,
      append: (frame) => Effect.sync(() => transcriptFrames.push(frame)),
    },
    fixtures: {
      use: (name) => Effect.fail(fixturesNotImplemented(name)),
    },
  };
};

export const withScenarioContext = <A, E, R>(
  options: WithScenarioContextOptions,
  body: (context: ScenarioContext) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | unknown, R> =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.tryPromise(() =>
        mkdtemp(join(tmpdir(), `lando-scenario-${options.guideId}-${options.scenarioId}-`)),
      ),
      (testDir) =>
        process.env.KEEP_SCENARIO_DIRS === "1"
          ? Effect.void
          : Effect.promise(() => rm(testDir, { recursive: true, force: true })),
    ).pipe(
      Effect.flatMap((testDir) => {
        const context = makeScenarioContext(options, testDir);
        return body(context).pipe(Effect.provideService(ScenarioContext, context));
      }),
    ),
  );
