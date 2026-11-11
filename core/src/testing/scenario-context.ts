import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as BunFileSystem from "@lando/engine/services/file-system";
import { createStandaloneRedactor } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { Transcript, type TranscriptFrame } from "@lando/sdk/docs/components";
import {
  FileIoError,
  FileNotFoundError,
  GuideFixtureNotFoundError,
  GuideFixtureSymlinkError,
  NotImplementedError,
} from "@lando/sdk/errors";
import { FileSystem, type FileSystemError, type LandoEvent } from "@lando/sdk/services";
import {
  type Cause,
  Clock,
  Console,
  Context,
  DateTime,
  Effect,
  Exit,
  Schema,
  type Scope,
  Stream,
} from "effect";
import { redactDetails } from "../cli/redact";
import { type GuideCommandSyntaxError, guideCommandArgv } from "../docs/guide-compiler/command-argv.ts";
import { withInteractionServiceOverride } from "../interaction/testing-override";
import { makeTestInteractionService } from "./interaction";
import { makeScenarioProvider } from "./scenario-provider.ts";
import { type TestRuntime, makeTestRuntime } from "./test-runtime";

const repoRoot = resolve(dirname(realpathSync(fileURLToPath(import.meta.url))), "../../..");

/**
 * Scenario runner layer used by generated guide tests.
 * `scenario` runs against the source test harness, while `e2e` runs the compiled binary.
 */
export type ScenarioContextLayer = "scenario" | "e2e";

type ScenarioRunnerKind = "scenario" | "e2e" | "testOnlyFake";

/**
 * Variable value made available to a scenario.
 * `display` can carry the reader-facing value when it differs from the raw value.
 */
export interface ScenarioVariable {
  /** Raw value passed to scenario code. */
  readonly value: string;
  /** Optional display value for documentation output. */
  readonly display?: string;
}

/**
 * Captured result from a scenario CLI invocation.
 * It includes normalized command arguments, captured streams, exit status, and recorded events.
 */
export interface ScenarioRunResult {
  /** Optional SDK error tag parsed from command stderr. */
  readonly _tag?: string;
  /** Command arguments after removing a leading `lando`, when present. */
  readonly command: ReadonlyArray<string>;
  /** Captured standard output. */
  readonly stdout: string;
  /** Captured standard error. */
  readonly stderr: string;
  /** Process exit code or in-process command status. */
  readonly exitCode: number;
  /** Redacted events this invocation published; empty for the compiled e2e runner. */
  readonly events: ReadonlyArray<LandoEvent>;
}

/**
 * Options applied to a scenario CLI run.
 * Answers are appended to init commands as `--answer=name=value` flags.
 */
export interface ScenarioRunOptions {
  /** Prompt answers keyed by prompt name. */
  readonly answers?: Readonly<Record<string, string>>;
}

/**
 * Input accepted by the guide `<Inspect>` helper.
 * It records a file, JSON file, event list, or last command output into the transcript.
 */
export interface ScenarioInspectProps {
  /** Text file path, relative to the scenario test directory. */
  readonly file?: string;
  /** JSON file path, relative to the scenario test directory. */
  readonly json?: string;
  /** Records the scenario event list when true. */
  readonly events?: true;
  /** Records the last run frame's stdout when true or when no other target is set. */
  readonly output?: true;
}

/**
 * Transcript frame shape emitted by scenario actions.
 * The concrete frame schema comes from the SDK docs component contract.
 */
export type ScenarioTranscriptFrame = TranscriptFrame;

/**
 * Mutable transcript buffer for a running scenario.
 * Frames are skipped while the context is inside `hidden` execution.
 */
export interface ScenarioTranscript {
  /** Frames recorded so far for this scenario. */
  readonly frames: ReadonlyArray<ScenarioTranscriptFrame>;
  /**
   * Appends a frame unless transcript recording is hidden.
   * @param frame Frame to add to the scenario transcript.
   * @returns An effect that records the frame.
   */
  readonly append: (frame: ScenarioTranscriptFrame) => Effect.Effect<void>;
}

/**
 * Fixture helpers available to guide scenarios.
 * Fixtures are copied into the scenario temp directory and become the working directory.
 */
export interface ScenarioFixtures {
  /**
   * Copies a named fixture into the scenario temp directory.
   * @param name Fixture directory name under the guide fixture search paths.
   * @returns The copied fixture path inside the scenario temp directory.
   */
  readonly use: (
    name: string,
  ) => Effect.Effect<string, GuideFixtureNotFoundError | GuideFixtureSymlinkError | FileSystemError>;
}

/**
 * Runtime state and helpers for one executable guide scenario.
 * The context owns a temp directory, records transcript frames, and exposes CLI, fixture, inspect, and hidden execution helpers.
 */
export interface ScenarioContext {
  /** Guide identifier used for transcript and fixture paths. */
  readonly guideId: string;
  /** Scenario identifier used for transcript output. */
  readonly scenarioId: string;
  /** Runner layer selected for the scenario. */
  readonly layer: ScenarioContextLayer;
  /** Whether the generated guide scenario is reader-visible. */
  readonly render: boolean;
  /** Variant values for the scenario. Currently empty for generated scenarios. */
  readonly variant: Readonly<Record<string, never>>;
  /** Temporary directory that contains the scenario workspace. */
  readonly testDir: string;
  /** Deterministic runtime services available to the scenario. */
  readonly runtime: TestRuntime;
  /** Scenario variables keyed by variable name. */
  readonly vars: Map<string, ScenarioVariable>;
  /**
   * Runs a Lando CLI command in the current scenario working directory.
   * @param command Command string or pre-split argv. A leading `lando` is ignored.
   * @param options Optional prompt answers for init commands.
   * @returns The captured command result and records a run frame.
   */
  readonly runCli: (
    command: string | ReadonlyArray<string>,
    options?: ScenarioRunOptions,
  ) => Effect.Effect<ScenarioRunResult, unknown>;
  /**
   * Rejects shell commands, which are not implemented for guide scenarios.
   * @param command Shell command from a guide `<Run shell="...">` block.
   * @returns A failed effect with `NotImplementedError`.
   */
  readonly shell: (command: string) => Effect.Effect<never, NotImplementedError>;
  /**
   * Records read-only scenario state into the transcript.
   * @param props Target to inspect, such as file, JSON, events, or output.
   * @returns An effect that appends an inspect frame.
   */
  readonly inspect: (props: ScenarioInspectProps) => Effect.Effect<void>;
  /**
   * Runs an effect with transcript recording suppressed.
   * @param effect Effect to run without reader-visible transcript frames.
   * @returns The wrapped effect with hidden depth restored afterward.
   */
  readonly hidden: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * Redacted events published by every in-process CLI invocation in this scenario, in order.
   * Compiled e2e invocations run in a child process and contribute none.
   */
  readonly events: ReadonlyArray<LandoEvent>;
  /** Transcript buffer for this scenario. */
  readonly transcript: ScenarioTranscript;
  /** Fixture helpers for this scenario. */
  readonly fixtures: ScenarioFixtures;
}

/**
 * Effect service tag for the active scenario context.
 * Scenario bodies receive this service automatically from `withScenarioContext` and factory runners.
 */
export const ScenarioContext = Context.Service<ScenarioContext>("@lando/core/ScenarioContext");

/**
 * Options used to create a scenario context.
 * Callers identify the guide and scenario, then may override rendering, variables, runtime, or CLI execution.
 */
export interface WithScenarioContextOptions {
  readonly repositoryRoot?: string;
  /** Guide identifier for fixtures and transcript output. */
  readonly guideId: string;
  /** Scenario identifier for temp directory and transcript output. */
  readonly scenarioId: string;
  /** Whether the scenario should be marked reader-visible in transcripts. Defaults to true. */
  readonly render?: boolean;
  /** Variables available to scenario code. */
  readonly vars?: ReadonlyMap<string, ScenarioVariable>;
  /** Runtime services to expose through the context. Defaults to provider bootstrap test runtime. */
  readonly runtime?: TestRuntime;
  /**
   * Optional CLI runner override used instead of the built-in runners.
   * @param command Parsed command arguments after scenario command normalization.
   * @param options Run options passed by the scenario.
   * @returns A promise for the command result to record.
   */
  readonly runCli?: (
    command: ReadonlyArray<string>,
    options?: ScenarioRunOptions,
  ) => Promise<ScenarioRunResult>;
}

// A string command means the argv a POSIX shell gives it, the same reading the guide compiler emits.
const parseCommand = (
  command: string | ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, GuideCommandSyntaxError> => {
  if (typeof command !== "string") return Effect.succeed(withoutLandoPrefix(command));
  return Effect.fromResult(guideCommandArgv(command)).pipe(Effect.map(withoutLandoPrefix));
};

const withoutLandoPrefix = (argv: ReadonlyArray<string>): ReadonlyArray<string> =>
  argv[0] === "lando" || argv[0] === "lando4" ? argv.slice(1) : argv;

const stringFlagValue = (args: ReadonlyArray<string>, name: string): string | undefined => {
  const equalsPrefix = `--${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg.startsWith(equalsPrefix)) return arg.slice(equalsPrefix.length);
    if (arg === `--${name}`) return args[index + 1];
  }
  return undefined;
};

const errorTagFromStderr = (stderr: string): string | undefined => {
  const match = /code:\s*([A-Za-z0-9_]+)/.exec(stderr) ?? /"code"\s*:\s*"([A-Za-z0-9_]+)"/.exec(stderr);
  return match?.[1];
};

const shellNotImplemented = (command: string): NotImplementedError =>
  new NotImplementedError({
    message: `<Run shell="${command}"> is not implemented`,
    commandId: "guide.run.shell",
    remediation: 'Use `<Run command="…">` for guide scenarios. Shell runners are not supported.',
  });

const fixtureSymlinkError = (name: string, path: string): GuideFixtureSymlinkError =>
  new GuideFixtureSymlinkError({
    message: `Fixture "${name}" contains a symbolic link: ${path}`,
    fixtureName: name,
    path,
  });

const fixtureNotFoundError = (name: string, candidates: ReadonlyArray<string>): GuideFixtureNotFoundError =>
  new GuideFixtureNotFoundError({
    message: `Fixture "${name}" was not found in any candidate path`,
    fixtureName: name,
    candidates: [...candidates],
  });

const fixtureIoError = (path: string, message: string): FileIoError =>
  new FileIoError({
    message,
    path,
    remediation: `Ensure \`${path}\` exists and is readable/writable by this user, then re-run the command.`,
  });

const TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\b|\b\d{10,13}\b/g;

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]),
  );
};

const sanitizeTranscriptValue = (value: unknown, testDir: string): unknown => {
  const redacted = redactDetails(value, createStandaloneRedactor("secrets", { sourceEnv: {} }));
  const sanitize = (input: unknown, key?: string): unknown => {
    if (typeof input === "string") {
      const withPath = input.split(testDir).join("<testDir>");
      const lowerKey = key?.toLowerCase() ?? "";
      return lowerKey === "stderr" || lowerKey.includes("stdout")
        ? withPath.replace(TIMESTAMP_PATTERN, "<timestamp>")
        : withPath;
    }
    if (Array.isArray(input)) return input.map((child) => sanitize(child, key));
    if (input === null || typeof input !== "object") return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        sanitize(child, childKey),
      ]),
    );
  };
  return sanitize(redacted);
};

const persistTranscript = Effect.fnUntraced(function* (
  context: ScenarioContext,
  startedAt: string,
  exit: Exit.Exit<unknown, unknown>,
  repositoryRoot: string,
): Effect.fn.Return<void, import("effect").Cause.UnknownError> {
  const finished = yield* DateTime.now;
  const finishedAt = DateTime.formatIso(finished);
  return yield* Effect.tryPromise(async () => {
    const transcript = Schema.encodeSync(Transcript)({
      guideId: context.guideId,
      scenarioId: context.scenarioId,
      render: context.render,
      startedAt,
      finishedAt,
      durationMs: Math.max(
        0,
        DateTime.toEpochMillis(finished) - DateTime.toEpochMillis(DateTime.makeUnsafe(startedAt)),
      ),
      exitStatus: Exit.isSuccess(exit) ? "pass" : "fail",
      frames: context.transcript.frames,
    });
    const sanitized = sanitizeTranscriptValue(transcript, context.testDir);
    const output = join(
      repositoryRoot,
      "dist",
      "transcripts",
      "guides",
      context.guideId,
      `${context.scenarioId}.json`,
    );
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(stable(sanitized), null, 2)}\n`);
  });
}, Effect.orDie);

const readBytes = Effect.fnUntraced(function* (
  path: string,
): Effect.fn.Return<Uint8Array, FileSystemError, FileSystem> {
  const fileSystem = yield* FileSystem;
  const chunks = yield* Stream.runCollect(fileSystem.read(path));
  const arrays = chunks;
  const total = arrays.reduce((size, chunk) => size + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of arrays) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
});

const copyFixtureDirectory = Effect.fnUntraced(function* (
  name: string,
  source: string,
  target: string,
): Effect.fn.Return<void, GuideFixtureSymlinkError | FileSystemError, FileSystem> {
  const fileSystem = yield* FileSystem;
  const sourceStat = yield* fileSystem.lstat(source);
  if (sourceStat.isSymbolicLink === true) {
    return yield* Effect.fail(fixtureSymlinkError(name, source));
  }
  if (!sourceStat.isDirectory) {
    return yield* Effect.fail(
      fixtureIoError(source, `Fixture "${name}" source is not a directory: ${source}`),
    );
  }

  yield* fileSystem.mkdir(target);
  const entries = yield* fileSystem.readDir(source);
  for (const entry of entries) {
    const childSource = join(source, entry);
    const childTarget = join(target, entry);
    const childStat = yield* fileSystem.lstat(childSource);
    if (childStat.isSymbolicLink === true) {
      return yield* Effect.fail(fixtureSymlinkError(name, childSource));
    }
    if (childStat.isDirectory) {
      yield* copyFixtureDirectory(name, childSource, childTarget);
      continue;
    }
    if (childStat.isFile) {
      yield* fileSystem.write(childTarget, yield* readBytes(childSource));
    }
  }
});

const findFixtureSource = Effect.fnUntraced(function* (
  name: string,
  candidates: ReadonlyArray<string>,
): Effect.fn.Return<
  string,
  GuideFixtureNotFoundError | GuideFixtureSymlinkError | FileSystemError,
  FileSystem
> {
  const fileSystem = yield* FileSystem;
  for (const candidate of candidates) {
    const stat = yield* Effect.result(fileSystem.lstat(candidate));
    if (stat._tag === "Failure") {
      if (stat.failure instanceof FileNotFoundError) {
        continue;
      }
      return yield* Effect.fail(stat.failure);
    }
    if (stat.success.isSymbolicLink === true) {
      return yield* Effect.fail(fixtureSymlinkError(name, candidate));
    }
    if (stat.success.isDirectory) {
      return candidate;
    }
    return yield* Effect.fail(
      fixtureIoError(candidate, `Fixture "${name}" source is not a directory: ${candidate}`),
    );
  }
  return yield* Effect.fail(fixtureNotFoundError(name, candidates));
});

const createFixtureUse = (
  guideId: string,
  testDir: string,
  setWorkingDirectory: (path: string) => void,
  appendFrame: (frame: ScenarioTranscriptFrame) => void,
  repositoryRoot: string,
): ScenarioFixtures["use"] => {
  const copied = new Set<string>();

  return (name) => {
    const target = join(testDir, name);
    if (copied.has(name)) {
      return Effect.sync(() => {
        setWorkingDirectory(target);
        return target;
      });
    }

    const candidates = [
      join(repositoryRoot, "docs", "guides", guideId, "fixtures", name),
      join(repositoryRoot, "docs", "guides", "fixtures", name),
    ];
    return findFixtureSource(name, candidates).pipe(
      Effect.flatMap((source) => copyFixtureDirectory(name, source, target)),
      Effect.as(target),
      Effect.tap(() =>
        Effect.sync(() => {
          copied.add(name);
          setWorkingDirectory(target);
          appendFrame({ kind: "fixture", name, copiedTo: target });
        }),
      ),
      Effect.provide(BunFileSystem.layer),
    );
  };
};

const safeJsonParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

// `<Inspect>` captures read-only state into the transcript and must never change
// pass/fail, so a missing file is recorded as `null` rather than raising.
const createInspect = (
  testDir: string,
  events: LandoEvent[],
  transcriptFrames: ScenarioTranscriptFrame[],
  appendFrame: (frame: ScenarioTranscriptFrame) => void,
): ScenarioContext["inspect"] =>
  Effect.fn("ScenarioContext.inspect")(function* (props) {
    if (props.file !== undefined || props.json !== undefined) {
      const target = props.file !== undefined ? "file" : "json";
      const relativePath = (props.file ?? props.json) as string;
      const file = Bun.file(join(testDir, relativePath));
      const exists = yield* Effect.promise(() => file.exists());
      const text = exists ? yield* Effect.promise(() => file.text()) : undefined;
      const value = text === undefined ? null : target === "json" ? safeJsonParse(text) : text;
      yield* Effect.sync(() => appendFrame({ kind: "inspect", target, value }));
      return;
    }
    if (props.events === true) {
      const value = [...events];
      yield* Effect.sync(() => appendFrame({ kind: "inspect", target: "events", value }));
      return;
    }
    const lastRun = transcriptFrames.findLast((frame) => frame.kind === "run");
    const value = lastRun !== undefined && lastRun.kind === "run" ? lastRun.stdout : "";
    yield* Effect.sync(() => appendFrame({ kind: "inspect", target: "output", value }));
  });

const appendInitAnswers = (
  args: ReadonlyArray<string>,
  answers: Readonly<Record<string, string>> | undefined,
): ReadonlyArray<string> => {
  if (answers === undefined || Object.keys(answers).length === 0) return args;
  if (args[0] !== "init" && args[0] !== "apps:init") return args;
  return [...args, ...Object.entries(answers).map(([name, value]) => `--answer=${name}=${value}`)];
};

type ArgvRunner = (
  args: ReadonlyArray<string>,
  options?: ScenarioRunOptions,
) => Effect.Effect<ScenarioRunResult, unknown>;

// `init` creates the app under a `<name>` subdirectory; advance the scenario cwd
// into it so later commands find the generated `.lando.yml`. Shared by both runners.
const advanceWorkingDirectoryAfterInit = (
  args: ReadonlyArray<string>,
  options: ScenarioRunOptions | undefined,
  exitCode: number,
  cwd: string,
  setWorkingDirectory: (path: string) => void,
): void => {
  if ((args[0] !== "init" && args[0] !== "apps:init") || exitCode !== 0) return;
  const appName = stringFlagValue(args, "name") ?? options?.answers?.name;
  if (appName !== undefined && appName !== "") setWorkingDirectory(join(cwd, appName));
};

// When a scenario `<Run answers>` drives `init`/`apps:init`, route the prompt
// answers through a seeded `TestInteractionService` so the executable-guide
// scenario answer flow is backed by the published test double, not only the
// `--answer=` argv path. Real CLI parsing/rendering is preserved: answers still
// flow as flags too, and any non-init command runs the dispatch unchanged.
const runInitDispatchWithSeededAnswers = (
  args: ReadonlyArray<string>,
  options: ScenarioRunOptions | undefined,
  runDispatch: () => Promise<void>,
): Promise<void> => {
  const answers = options?.answers;
  const isInit = args[0] === "init" || args[0] === "apps:init";
  if (!isInit || answers === undefined || Object.keys(answers).length === 0) return runDispatch();
  const interaction = makeTestInteractionService({ answers });
  return withInteractionServiceOverride(interaction.service, runDispatch);
};

const invokeRealCli = async (
  args: ReadonlyArray<string>,
  options: ScenarioRunOptions | undefined,
  events: LandoEvent[],
  provider: ReturnType<typeof makeScenarioProvider>,
  getWorkingDirectory: () => string,
  setWorkingDirectory: (path: string) => void,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ScenarioRunResult> => {
  // Scenario commands read an empty stdin, never the test runner's.
  const io = createBufferedRendererIO({ stdin: "" });
  let exitCode = 0;
  const cwd = getWorkingDirectory();
  const runEvents: LandoEvent[] = [];
  const context = {
    cwd,
    env,
    io,
    setExitCode: (code: number) => {
      exitCode = code;
    },
    providerRegistry: provider.layer,
    serviceLayers: [provider.hostServices],
    observeEvent: (event: LandoEvent) => {
      runEvents.push(event);
      events.push(event);
    },
  };

  const cli = await import("../cli/index");
  const runDispatch = () =>
    cli.runCli({ argv: args, rootUrl: new URL("../../bin/lando.ts", import.meta.url).href, context });
  await runInitDispatchWithSeededAnswers(args, options, runDispatch);
  const stdoutText = io.stdout();
  const stderrText = io.stderr();
  advanceWorkingDirectoryAfterInit(args, options, exitCode, cwd, setWorkingDirectory);

  const result = {
    command: args,
    stdout: stdoutText,
    stderr: stderrText,
    exitCode,
    events: runEvents,
  } satisfies Omit<ScenarioRunResult, "_tag">;
  const errorTag = errorTagFromStderr(stderrText);
  return errorTag === undefined ? result : { ...result, _tag: errorTag };
};

const createScenarioRunCli = (
  events: LandoEvent[],
  getWorkingDirectory: () => string,
  setWorkingDirectory: (path: string) => void,
  env: Readonly<Record<string, string | undefined>>,
): ArgvRunner => {
  const provider = makeScenarioProvider();
  return (command, options) =>
    Effect.tryPromise(async () => {
      const args = appendInitAnswers(command, options?.answers);
      return invokeRealCli(args, options, events, provider, getWorkingDirectory, setWorkingDirectory, env);
    });
};

const compiledBinaryPath = (): string =>
  process.env.LANDO_SCENARIO_E2E_BINARY ?? fileURLToPath(new URL("../../dist/lando", import.meta.url));

const createE2eRunCli =
  (getWorkingDirectory: () => string, setWorkingDirectory: (path: string) => void): ArgvRunner =>
  (command, options) =>
    Effect.tryPromise(async () => {
      const args = appendInitAnswers(command, options?.answers);
      const binary = compiledBinaryPath();
      if (!(await Bun.file(binary).exists())) {
        return {
          command: args,
          stdout: "",
          stderr: `compiled lando binary not found: ${binary}\n`,
          exitCode: 127,
          events: [],
        } satisfies ScenarioRunResult;
      }

      const cwd = getWorkingDirectory();
      const proc = Bun.spawn({
        cmd: [binary, ...args],
        cwd,
        env: {
          ...process.env,
          BUN_BE_BUN: undefined,
          LANDO_DISALLOW_BUN_BE_BUN_REENTRY: undefined,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      advanceWorkingDirectoryAfterInit(args, options, exitCode, cwd, setWorkingDirectory);

      const result = {
        command: args,
        stdout,
        stderr,
        exitCode,
        events: [],
      } satisfies Omit<ScenarioRunResult, "_tag">;
      const errorTag = errorTagFromStderr(stderr);
      return errorTag === undefined ? result : { ...result, _tag: errorTag };
    });

const selectRunner = (
  runnerKind: ScenarioRunnerKind,
  events: LandoEvent[],
  getWorkingDirectory: () => string,
  setWorkingDirectory: (path: string) => void,
  env: Readonly<Record<string, string | undefined>>,
): ArgvRunner => {
  if (runnerKind === "e2e") return createE2eRunCli(getWorkingDirectory, setWorkingDirectory);
  return createScenarioRunCli(events, getWorkingDirectory, setWorkingDirectory, env);
};

const createRunCli = (
  events: LandoEvent[],
  appendFrame: (frame: ScenarioTranscriptFrame) => void,
  getWorkingDirectory: () => string,
  setWorkingDirectory: (path: string) => void,
  runnerKind: ScenarioRunnerKind,
  env: Readonly<Record<string, string | undefined>>,
  override?: (command: ReadonlyArray<string>, options?: ScenarioRunOptions) => Promise<ScenarioRunResult>,
): ScenarioContext["runCli"] => {
  const runner: ArgvRunner =
    override === undefined
      ? selectRunner(runnerKind, events, getWorkingDirectory, setWorkingDirectory, env)
      : (args, options) => Effect.tryPromise(() => override(args, options));

  return Effect.fn("ScenarioContext.runCli")(function* (command, options) {
    const started = yield* Clock.currentTimeMillis;
    const result = yield* runner(yield* parseCommand(command), options);
    const durationMs = Math.max(0, (yield* Clock.currentTimeMillis) - started);
    yield* Effect.sync(() => {
      appendFrame({
        kind: "run",
        command: result.command,
        stdout: result.stdout,
        stderr: result.stderr,
        exit: result.exitCode,
        durationMs,
      });
    });
    return result;
  });
};

const makeScenarioContext = (
  options: WithScenarioContextOptions,
  testDir: string,
  runnerKind: ScenarioRunnerKind,
): ScenarioContext => {
  const runtime = options.runtime ?? makeTestRuntime({ bootstrap: "provider" });
  const events: LandoEvent[] = [];
  const transcriptFrames: ScenarioTranscriptFrame[] = [];
  let hiddenDepth = 0;
  const appendFrame = (frame: ScenarioTranscriptFrame): void => {
    if (hiddenDepth > 0) return;
    transcriptFrames.push(frame);
  };
  const hidden = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        hiddenDepth += 1;
      }),
      () => effect,
      () =>
        Effect.sync(() => {
          hiddenDepth = Math.max(0, hiddenDepth - 1);
        }),
    );
  let workingDirectory = testDir;
  const getWorkingDirectory = () => workingDirectory;
  const setWorkingDirectory = (path: string) => {
    workingDirectory = path;
  };

  return ScenarioContext.of({
    guideId: options.guideId,
    scenarioId: options.scenarioId,
    layer: runnerKind === "e2e" ? "e2e" : "scenario",
    render: options.render ?? true,
    variant: {},
    testDir,
    runtime,
    vars: new Map(options.vars ?? []),
    runCli: createRunCli(
      events,
      appendFrame,
      getWorkingDirectory,
      setWorkingDirectory,
      runnerKind,
      {
        ...process.env,
        LANDO_USER_DATA_ROOT: join(testDir, "host", "data"),
        LANDO_USER_CACHE_ROOT: join(testDir, "host", "cache"),
        LANDO_USER_CONF_ROOT: join(testDir, "host", "config"),
        LANDO_SYSTEM_PLUGIN_ROOT: join(testDir, "host", "system-plugins"),
      },
      options.runCli,
    ),
    shell: (command) => Effect.fail(shellNotImplemented(command)),
    inspect: createInspect(testDir, events, transcriptFrames, appendFrame),
    hidden,
    events,
    transcript: {
      frames: transcriptFrames,
      append: (frame) => Effect.sync(() => appendFrame(frame)),
    },
    fixtures: {
      use: createFixtureUse(
        options.guideId,
        testDir,
        setWorkingDirectory,
        appendFrame,
        options.repositoryRoot ?? repoRoot,
      ),
    },
  });
};

const withScenarioContextInternal = <A, E, R>(
  options: WithScenarioContextOptions,
  runnerKind: ScenarioRunnerKind,
  body: (context: ScenarioContext) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Cause.UnknownError, Exclude<Exclude<R, ScenarioContext>, Scope.Scope>> =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.tryPromise(() =>
        mkdtemp(join(tmpdir(), `lando-scenario-${options.guideId}-${options.scenarioId}-`)),
      ),
      (testDir) => {
        if (process.env.KEEP_SCENARIO_DIRS !== "1") {
          return Effect.promise(() => rm(testDir, { recursive: true, force: true }));
        }
        return process.env.LANDO_DOCS_SCENARIO_KEEP === "1"
          ? Console.log(`Scenario temp dir: ${testDir}`)
          : Effect.void;
      },
    ).pipe(
      Effect.flatMap(
        Effect.fnUntraced(function* (testDir) {
          const context = makeScenarioContext(options, testDir, runnerKind);
          const startedAt = DateTime.formatIso(yield* DateTime.now);
          // Inner Effect.scoped is load-bearing: it closes the body's scope
          // (running `addFinalizer` callbacks that push cleanup frames) BEFORE
          // Effect.onExit fires persistTranscript. Do not remove.
          return yield* Effect.scoped(
            body(context).pipe(Effect.provideService(ScenarioContext, context)),
          ).pipe(
            Effect.onExit((exit) =>
              persistTranscript(context, startedAt, exit, options.repositoryRoot ?? repoRoot),
            ),
          );
        }),
      ),
    ),
  );

/**
 * Runs a scenario body with a temporary context that dispatches the real CLI in process against
 * the scenario's own in-memory provider.
 * The temp directory is cleaned up unless scenario preservation environment variables are set, and a transcript is persisted after the body exits.
 * @param options Context creation options for the guide scenario.
 * @param body Effectful scenario body that receives the created context.
 * @returns The body effect with the scenario context service provided.
 */
export const withScenarioContext = <A, E, R>(
  options: WithScenarioContextOptions,
  body: (context: ScenarioContext) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Cause.UnknownError, Exclude<Exclude<R, ScenarioContext>, Scope.Scope>> =>
  withScenarioContextInternal(options, "testOnlyFake", body);

/**
 * Factory for running scenario bodies against each supported runner.
 * All methods create a temp scenario context, provide the `ScenarioContext` service, and persist a transcript on exit.
 */
export const ScenarioContextFactory = {
  /**
   * Runs with the source in-process scenario runner.
   * @param options Context creation options for the guide scenario.
   * @param body Effectful scenario body that receives the created context.
   * @returns The body effect with source-mode scenario CLI behavior.
   */
  scenario: <A, E, R>(
    options: WithScenarioContextOptions,
    body: (context: ScenarioContext) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Cause.UnknownError, Exclude<Exclude<R, ScenarioContext>, Scope.Scope>> =>
    withScenarioContextInternal(options, "scenario", body),
  /**
   * Runs with the compiled binary e2e runner.
   * @param options Context creation options for the guide scenario.
   * @param body Effectful scenario body that receives the created context.
   * @returns The body effect with compiled-binary CLI behavior.
   */
  e2e: <A, E, R>(
    options: WithScenarioContextOptions,
    body: (context: ScenarioContext) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Cause.UnknownError, Exclude<Exclude<R, ScenarioContext>, Scope.Scope>> =>
    withScenarioContextInternal(options, "e2e", body),
  /**
   * Runs the real CLI in process against the scenario's in-memory provider, as generated guides do.
   * @param options Context creation options for the guide scenario.
   * @param body Effectful scenario body that receives the created context.
   * @returns The body effect with fake scenario CLI behavior.
   */
  testOnlyFake: <A, E, R>(
    options: WithScenarioContextOptions,
    body: (context: ScenarioContext) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Cause.UnknownError, Exclude<Exclude<R, ScenarioContext>, Scope.Scope>> =>
    withScenarioContextInternal(options, "testOnlyFake", body),
} as const;
