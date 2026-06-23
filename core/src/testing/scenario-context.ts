import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Cause, Chunk, Console, Context, Effect, Exit, Schema, type Scope, Stream } from "effect";

import { Transcript, type TranscriptFrame } from "@lando/sdk/docs/components";
import {
  FileIoError,
  FileNotFoundError,
  GuideFixtureNotFoundError,
  GuideFixtureSymlinkError,
  NotImplementedError,
} from "@lando/sdk/errors";
import { FileSystem, type FileSystemError, type LandoEvent } from "@lando/sdk/services";

import { redactDetails } from "../cli/redact.ts";
import { withInteractionServiceOverride } from "../interaction/testing-override.ts";
import { FileSystemLive } from "../services/file-system.ts";
import { CORE_VERSION } from "../version.ts";
import { makeTestInteractionService } from "./interaction.ts";
import { type TestRuntime, makeTestRuntime } from "./test-runtime.ts";

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
  /** Events recorded for the run. */
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
   * Events captured by the scenario context.
   * Only the `testOnlyFake` runner records events here, since the other runners don't bridge the real event service.
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
export const ScenarioContext = Context.GenericTag<ScenarioContext>("@lando/core/ScenarioContext");

/**
 * Options used to create a scenario context.
 * Callers identify the guide and scenario, then may override rendering, variables, runtime, or CLI execution.
 */
export interface WithScenarioContextOptions {
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

const parseCommand = (command: string | ReadonlyArray<string>): ReadonlyArray<string> => {
  const parsed = typeof command === "string" ? command.trim().split(/\s+/).filter(Boolean) : command;
  return parsed[0] === "lando" ? parsed.slice(1) : parsed;
};

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
    message: `<Run shell=\"${command}\"> is not implemented in Alpha 2`,
    commandId: "guide.run.shell",
    remediation: 'Use `<Run command="…">` for guide scenarios. Shell runners are not available yet.',
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

const fixtureIoError = (path: string, message: string): FileIoError => new FileIoError({ message, path });

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
  const redacted = redactDetails(value);
  const sanitize = (input: unknown, key?: string): unknown => {
    if (typeof input === "string") {
      const withPath = input.split(testDir).join("<testDir>");
      const lowerKey = key?.toLowerCase() ?? "";
      return lowerKey === "stdout" || lowerKey === "stderr" || lowerKey.includes("stdout")
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

const transcriptPath = (guideId: string, scenarioId: string): string =>
  join(process.cwd(), "dist", "transcripts", "guides", guideId, `${scenarioId}.json`);

const persistTranscript = (
  context: ScenarioContext,
  startedAt: string,
  exit: Exit.Exit<unknown, unknown>,
): Effect.Effect<void> =>
  Effect.tryPromise(async () => {
    const finishedAt = new Date().toISOString();
    const transcript = Schema.encodeSync(Transcript)({
      guideId: context.guideId,
      scenarioId: context.scenarioId,
      render: context.render,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime()),
      exitStatus: Exit.isSuccess(exit) ? "pass" : "fail",
      frames: context.transcript.frames,
    });
    const sanitized = sanitizeTranscriptValue(transcript, context.testDir);
    const output = transcriptPath(context.guideId, context.scenarioId);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(stable(sanitized), null, 2)}\n`);
  }).pipe(Effect.orDie);

const readBytes = (path: string): Effect.Effect<Uint8Array, FileSystemError, FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem;
    const chunks = yield* Stream.runCollect(fileSystem.read(path));
    const arrays = Chunk.toReadonlyArray(chunks);
    const total = arrays.reduce((size, chunk) => size + chunk.byteLength, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of arrays) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  });

const copyFixtureDirectory = (
  name: string,
  source: string,
  target: string,
): Effect.Effect<void, GuideFixtureSymlinkError | FileSystemError, FileSystem> =>
  Effect.gen(function* () {
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

const findFixtureSource = (
  name: string,
  candidates: ReadonlyArray<string>,
): Effect.Effect<
  string,
  GuideFixtureNotFoundError | GuideFixtureSymlinkError | FileSystemError,
  FileSystem
> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem;
    for (const candidate of candidates) {
      const stat = yield* Effect.either(fileSystem.lstat(candidate));
      if (stat._tag === "Left") {
        if (stat.left instanceof FileNotFoundError) {
          continue;
        }
        return yield* Effect.fail(stat.left);
      }
      if (stat.right.isSymbolicLink === true) {
        return yield* Effect.fail(fixtureSymlinkError(name, candidate));
      }
      if (stat.right.isDirectory) {
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
      join(process.cwd(), "docs", "guides", guideId, "fixtures", name),
      join(process.cwd(), "docs", "guides", "fixtures", name),
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
      Effect.provide(FileSystemLive),
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
const createInspect =
  (
    testDir: string,
    events: LandoEvent[],
    transcriptFrames: ScenarioTranscriptFrame[],
    appendFrame: (frame: ScenarioTranscriptFrame) => void,
  ): ScenarioContext["inspect"] =>
  (props) =>
    Effect.gen(function* () {
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
      const lastRun = [...transcriptFrames].reverse().find((frame) => frame.kind === "run");
      const value = lastRun !== undefined && lastRun.kind === "run" ? lastRun.stdout : "";
      yield* Effect.sync(() => appendFrame({ kind: "inspect", target: "output", value }));
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

const appendInitAnswers = (
  args: ReadonlyArray<string>,
  answers: Readonly<Record<string, string>> | undefined,
): ReadonlyArray<string> => {
  if (answers === undefined || Object.keys(answers).length === 0) return args;
  if (args[0] !== "init" && args[0] !== "apps:init") return args;
  return [...args, ...Object.entries(answers).map(([name, value]) => `--answer=${name}=${value}`)];
};

const staticRootFromLandofile = (content: string): string | undefined => {
  if (!/^\s*type:\s*static(?::\w+)?\s*$/m.test(content)) return undefined;
  const root = /^\s*root:\s*(\S+)\s*$/m.exec(content)?.[1];
  return root === undefined || root === "" || root === "/"
    ? "."
    : root.replace(/^\/+/, "").replace(/\/+$/, "");
};

const runScenarioLayerCommand = async (
  args: ReadonlyArray<string>,
  cwd: string,
  events: LandoEvent[],
): Promise<ScenarioRunResult | undefined> => {
  if (args[0] === "destroy" || args[0] === "app:destroy") {
    return { command: args, stdout: "destroyed\n", stderr: "", exitCode: 0, events: [...events] };
  }
  if (args[0] === "curl") {
    const landofile = Bun.file(join(cwd, ".lando.yml"));
    if (!(await landofile.exists())) return undefined;

    const root = staticRootFromLandofile(await landofile.text());
    if (root === undefined) return undefined;

    const requestPath = (args[1] ?? "index.html").replace(/^\/+/, "");
    if (requestPath.split("/").includes("..")) {
      return {
        command: args,
        stdout: "",
        stderr: "path traversal is not allowed\n",
        exitCode: 1,
        events: [...events],
      };
    }

    const file = Bun.file(join(cwd, root, requestPath));
    if (!(await file.exists())) {
      return {
        command: args,
        stdout: "",
        stderr: `not found: ${requestPath}\n`,
        exitCode: 1,
        events: [...events],
      };
    }

    return { command: args, stdout: await file.text(), stderr: "", exitCode: 0, events: [...events] };
  }
  if (args[0] !== "start" && args[0] !== "app:start") return undefined;

  const landofile = Bun.file(join(cwd, ".lando.yml"));
  if (!(await landofile.exists())) {
    return {
      _tag: "LandofileNotFoundError",
      command: args,
      stdout: "",
      stderr: "code: LandofileNotFoundError\nNo .lando.yml or .lando.ts found.\n",
      exitCode: 1,
      events: [...events],
    };
  }

  const content = await landofile.text();
  if (content.includes("totally-not-a-service")) {
    return {
      _tag: "LandofileValidationError",
      command: args,
      stdout: "",
      stderr:
        "code: LandofileValidationError\nUnsupported service type totally-not-a-service for service cache. Registered service types: node:lts, postgres.\n",
      exitCode: 1,
      events: [...events],
    };
  }

  events.push({ _tag: "post-start" } as LandoEvent);
  return { command: args, stdout: "ready\n", stderr: "", exitCode: 0, events: [...events] };
};

const isVersionCommand = (args: ReadonlyArray<string>): boolean =>
  args.length === 1 && (args[0] === "version" || args[0] === "--version" || args[0] === "-v");

const versionResult = (args: ReadonlyArray<string>, events: LandoEvent[]): ScenarioRunResult => ({
  command: args,
  stdout: `${CORE_VERSION}\n`,
  stderr: "",
  exitCode: 0,
  events: [...events],
});

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
  getWorkingDirectory: () => string,
  setWorkingDirectory: (path: string) => void,
): Promise<ScenarioRunResult> => {
  const previousCwd = process.cwd();
  const previousExitCode = process.exitCode;
  const stdout = captureWrite(process.stdout);
  const stderr = captureWrite(process.stderr);
  const cwd = getWorkingDirectory();

  try {
    process.chdir(cwd);
    process.exitCode = undefined;
    const cli = await import("../cli/index.ts");
    const runDispatch = () =>
      cli.runCli({ argv: args, rootUrl: new URL("../../bin/lando.ts", import.meta.url).href });
    await runInitDispatchWithSeededAnswers(args, options, runDispatch);
    const stdoutText = stdout.content();
    const stderrText = stderr.content();
    const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
    advanceWorkingDirectoryAfterInit(args, options, exitCode, cwd, setWorkingDirectory);

    const result = {
      command: args,
      stdout: stdoutText,
      stderr: stderrText,
      exitCode,
      events: [...events],
    } satisfies Omit<ScenarioRunResult, "_tag">;
    const errorTag = errorTagFromStderr(stderrText);
    return errorTag === undefined ? result : { ...result, _tag: errorTag };
  } finally {
    process.chdir(previousCwd);
    process.exitCode = previousExitCode;
    stdout.restore();
    stderr.restore();
  }
};

const createTestOnlyFakeRunCli =
  (
    events: LandoEvent[],
    getWorkingDirectory: () => string,
    setWorkingDirectory: (path: string) => void,
  ): ScenarioContext["runCli"] =>
  (command, options) =>
    Effect.tryPromise(async () => {
      const args = appendInitAnswers(parseCommand(command), options?.answers);
      if (isVersionCommand(args)) return versionResult(args, events);

      const scenarioLayerResult = await runScenarioLayerCommand(args, getWorkingDirectory(), events);
      if (scenarioLayerResult !== undefined) return scenarioLayerResult;

      return invokeRealCli(args, options, events, getWorkingDirectory, setWorkingDirectory);
    });

// Source-mode OCLIF calls `process.exit` on any erroring command, which would
// terminate the surrounding test runner. The in-process scenario runner is
// therefore restricted to commands that succeed; everything else must run
// through the compiled binary via `ScenarioContextFactory.e2e`.
const SCENARIO_INPROCESS_COMMANDS: ReadonlySet<string> = new Set(["init", "apps:init"]);

const unsupportedInProcessResult = (
  args: ReadonlyArray<string>,
  events: LandoEvent[],
): ScenarioRunResult => ({
  command: args,
  stdout: "",
  stderr: `command "${args[0] ?? ""}" is not supported by the in-process scenario runner because source-mode OCLIF calls process.exit on errors and would kill the test runner; use ScenarioContextFactory.e2e to run it against the compiled binary\n`,
  exitCode: 1,
  events: [...events],
});

const createScenarioRunCli =
  (
    events: LandoEvent[],
    getWorkingDirectory: () => string,
    setWorkingDirectory: (path: string) => void,
  ): ScenarioContext["runCli"] =>
  (command, options) =>
    Effect.tryPromise(async () => {
      const args = appendInitAnswers(parseCommand(command), options?.answers);
      if (isVersionCommand(args)) return versionResult(args, events);
      if (args[0] === undefined || !SCENARIO_INPROCESS_COMMANDS.has(args[0])) {
        return unsupportedInProcessResult(args, events);
      }

      return invokeRealCli(args, options, events, getWorkingDirectory, setWorkingDirectory);
    });

const compiledBinaryPath = (): string =>
  process.env.LANDO_SCENARIO_E2E_BINARY ?? fileURLToPath(new URL("../../dist/lando", import.meta.url));

const createE2eRunCli =
  (
    events: LandoEvent[],
    getWorkingDirectory: () => string,
    setWorkingDirectory: (path: string) => void,
  ): ScenarioContext["runCli"] =>
  (command, options) =>
    Effect.tryPromise(async () => {
      const args = appendInitAnswers(parseCommand(command), options?.answers);
      const binary = compiledBinaryPath();
      if (!(await Bun.file(binary).exists())) {
        return {
          command: args,
          stdout: "",
          stderr: `compiled lando binary not found: ${binary}\n`,
          exitCode: 127,
          events: [...events],
        } satisfies ScenarioRunResult;
      }

      const cwd = getWorkingDirectory();
      const proc = Bun.spawn({
        cmd: [binary, ...args],
        cwd,
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
        events: [...events],
      } satisfies Omit<ScenarioRunResult, "_tag">;
      const errorTag = errorTagFromStderr(stderr);
      return errorTag === undefined ? result : { ...result, _tag: errorTag };
    });

const selectRunner = (
  runnerKind: ScenarioRunnerKind,
  events: LandoEvent[],
  getWorkingDirectory: () => string,
  setWorkingDirectory: (path: string) => void,
): ScenarioContext["runCli"] => {
  if (runnerKind === "e2e") return createE2eRunCli(events, getWorkingDirectory, setWorkingDirectory);
  if (runnerKind === "scenario")
    return createScenarioRunCli(events, getWorkingDirectory, setWorkingDirectory);
  return createTestOnlyFakeRunCli(events, getWorkingDirectory, setWorkingDirectory);
};

const createRunCli = (
  events: LandoEvent[],
  appendFrame: (frame: ScenarioTranscriptFrame) => void,
  getWorkingDirectory: () => string,
  setWorkingDirectory: (path: string) => void,
  runnerKind: ScenarioRunnerKind,
  override?: (command: ReadonlyArray<string>, options?: ScenarioRunOptions) => Promise<ScenarioRunResult>,
): ScenarioContext["runCli"] => {
  const runner =
    override === undefined
      ? selectRunner(runnerKind, events, getWorkingDirectory, setWorkingDirectory)
      : (command: string | ReadonlyArray<string>, options?: ScenarioRunOptions) =>
          Effect.tryPromise(() => override(parseCommand(command), options));

  return (command, options) =>
    Effect.gen(function* () {
      const started = Date.now();
      const result = yield* runner(command, options);
      const durationMs = Math.max(0, Date.now() - started);
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

  return {
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
      use: createFixtureUse(options.guideId, testDir, setWorkingDirectory, appendFrame),
    },
  };
};

const withScenarioContextInternal = <A, E, R>(
  options: WithScenarioContextOptions,
  runnerKind: ScenarioRunnerKind,
  body: (context: ScenarioContext) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Cause.UnknownException, Exclude<R, Scope.Scope>> =>
  Effect.scoped(
    Effect.acquireRelease(
      Effect.tryPromise(() =>
        mkdtemp(join(tmpdir(), `lando-scenario-${options.guideId}-${options.scenarioId}-`)),
      ),
      (testDir) =>
        process.env.KEEP_SCENARIO_DIRS === "1"
          ? process.env.LANDO_DOCS_SCENARIO_KEEP === "1"
            ? Console.log(`Scenario temp dir: ${testDir}`)
            : Effect.void
          : Effect.promise(() => rm(testDir, { recursive: true, force: true })),
    ).pipe(
      Effect.flatMap((testDir) => {
        const context = makeScenarioContext(options, testDir, runnerKind);
        const startedAt = new Date().toISOString();
        // Inner Effect.scoped is load-bearing: it closes the body's scope
        // (running `addFinalizer` callbacks that push cleanup frames) BEFORE
        // Effect.onExit fires persistTranscript. Do not remove.
        return Effect.scoped(body(context).pipe(Effect.provideService(ScenarioContext, context))).pipe(
          Effect.onExit((exit) => persistTranscript(context, startedAt, exit)),
        );
      }),
    ),
  );

/**
 * Runs a scenario body with a temporary context backed by the test-only fake runner.
 * The temp directory is cleaned up unless scenario preservation environment variables are set, and a transcript is persisted after the body exits.
 * @param options Context creation options for the guide scenario.
 * @param body Effectful scenario body that receives the created context.
 * @returns The body effect with the scenario context service provided.
 */
export const withScenarioContext = <A, E, R>(
  options: WithScenarioContextOptions,
  body: (context: ScenarioContext) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Cause.UnknownException, Exclude<R, Scope.Scope>> =>
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
  ): Effect.Effect<A, E | Cause.UnknownException, Exclude<R, Scope.Scope>> =>
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
  ): Effect.Effect<A, E | Cause.UnknownException, Exclude<R, Scope.Scope>> =>
    withScenarioContextInternal(options, "e2e", body),
  /**
   * Runs with the deterministic fake runner used by unit tests.
   * @param options Context creation options for the guide scenario.
   * @param body Effectful scenario body that receives the created context.
   * @returns The body effect with fake scenario CLI behavior.
   */
  testOnlyFake: <A, E, R>(
    options: WithScenarioContextOptions,
    body: (context: ScenarioContext) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Cause.UnknownException, Exclude<R, Scope.Scope>> =>
    withScenarioContextInternal(options, "testOnlyFake", body),
} as const;
