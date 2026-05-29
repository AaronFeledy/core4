import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Cause, Chunk, Context, Effect, Exit, Schema, type Scope, Stream } from "effect";

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
import { FileSystemLive } from "../services/file-system.ts";
import { CORE_VERSION } from "../version.ts";
import { type TestRuntime, makeTestRuntime } from "./test-runtime.ts";

export type ScenarioContextLayer = "scenario" | "e2e";

type ScenarioRunnerKind = "scenario" | "e2e" | "testOnlyFake";

export interface ScenarioVariable {
  readonly value: string;
  readonly display?: string;
}

export interface ScenarioRunResult {
  readonly _tag?: string;
  readonly command: ReadonlyArray<string>;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly events: ReadonlyArray<LandoEvent>;
}

export interface ScenarioRunOptions {
  readonly answers?: Readonly<Record<string, string>>;
}

export type ScenarioTranscriptFrame = TranscriptFrame;

export interface ScenarioTranscript {
  readonly frames: ReadonlyArray<ScenarioTranscriptFrame>;
  readonly append: (frame: ScenarioTranscriptFrame) => Effect.Effect<void>;
}

export interface ScenarioFixtures {
  readonly use: (
    name: string,
  ) => Effect.Effect<string, GuideFixtureNotFoundError | GuideFixtureSymlinkError | FileSystemError>;
}

export interface ScenarioContext {
  readonly guideId: string;
  readonly scenarioId: string;
  readonly layer: ScenarioContextLayer;
  readonly render: boolean;
  readonly variant: Readonly<Record<string, never>>;
  readonly testDir: string;
  readonly runtime: TestRuntime;
  readonly vars: Map<string, ScenarioVariable>;
  readonly runCli: (
    command: string | ReadonlyArray<string>,
    options?: ScenarioRunOptions,
  ) => Effect.Effect<ScenarioRunResult, unknown>;
  readonly shell: (command: string) => Effect.Effect<never, NotImplementedError>;
  readonly events: ReadonlyArray<LandoEvent>;
  readonly transcript: ScenarioTranscript;
  readonly fixtures: ScenarioFixtures;
}

export const ScenarioContext = Context.GenericTag<ScenarioContext>("@lando/core/ScenarioContext");

export interface WithScenarioContextOptions {
  readonly guideId: string;
  readonly scenarioId: string;
  readonly render?: boolean;
  readonly vars?: ReadonlyMap<string, ScenarioVariable>;
  readonly runtime?: TestRuntime;
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
    specSection: "§19.4",
    remediation:
      'Use `<Run command="…">` for Alpha 2 guide scenarios. Shell runners ship in Phase 3 Beta — see `spec/ROADMAP.md`.',
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
  transcriptFrames: ScenarioTranscriptFrame[],
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
          transcriptFrames.push({ kind: "fixture", name, copiedTo: target });
        }),
      ),
      Effect.provide(FileSystemLive),
    );
  };
};

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

const invokeRealCli = async (
  args: ReadonlyArray<string>,
  options: ScenarioRunOptions | undefined,
  events: LandoEvent[],
  getWorkingDirectory: () => string,
  setWorkingDirectory: (path: string) => void,
  emitStartEvent: boolean,
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
    await cli.runCli({ argv: args, rootUrl: new URL("../../bin/lando.ts", import.meta.url).href });
    const stdoutText = stdout.content();
    const stderrText = stderr.content();
    const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
    if ((args[0] === "init" || args[0] === "apps:init") && exitCode === 0) {
      const appName = stringFlagValue(args, "name") ?? options?.answers?.name;
      if (appName !== undefined && appName !== "") setWorkingDirectory(join(cwd, appName));
    }
    if (emitStartEvent && (args[0] === "start" || args[0] === "app:start") && exitCode === 0) {
      events.push({ _tag: "post-start" } as LandoEvent);
    }

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

      return invokeRealCli(args, options, events, getWorkingDirectory, setWorkingDirectory, true);
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

      return invokeRealCli(args, options, events, getWorkingDirectory, setWorkingDirectory, false);
    });

const compiledBinaryPath = (): string =>
  process.env.LANDO_SCENARIO_E2E_BINARY ?? fileURLToPath(new URL("../../dist/lando", import.meta.url));

const createE2eRunCli =
  (events: LandoEvent[], getWorkingDirectory: () => string): ScenarioContext["runCli"] =>
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

      const proc = Bun.spawn({
        cmd: [binary, ...args],
        cwd: getWorkingDirectory(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);

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
  if (runnerKind === "e2e") return createE2eRunCli(events, getWorkingDirectory);
  if (runnerKind === "scenario")
    return createScenarioRunCli(events, getWorkingDirectory, setWorkingDirectory);
  return createTestOnlyFakeRunCli(events, getWorkingDirectory, setWorkingDirectory);
};

const createRunCli = (
  events: LandoEvent[],
  transcriptFrames: ScenarioTranscriptFrame[],
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
        transcriptFrames.push({
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
      transcriptFrames,
      getWorkingDirectory,
      setWorkingDirectory,
      runnerKind,
      options.runCli,
    ),
    shell: (command) => Effect.fail(shellNotImplemented(command)),
    events,
    transcript: {
      frames: transcriptFrames,
      append: (frame) => Effect.sync(() => transcriptFrames.push(frame)),
    },
    fixtures: {
      use: createFixtureUse(options.guideId, testDir, setWorkingDirectory, transcriptFrames),
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
          ? Effect.sync(() => {
              if (process.env.LANDO_DOCS_SCENARIO_KEEP === "1") {
                process.stdout.write(`Scenario temp dir: ${testDir}\n`);
              }
            })
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

export const withScenarioContext = <A, E, R>(
  options: WithScenarioContextOptions,
  body: (context: ScenarioContext) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Cause.UnknownException, Exclude<R, Scope.Scope>> =>
  withScenarioContextInternal(options, "testOnlyFake", body);

export const ScenarioContextFactory = {
  scenario: <A, E, R>(
    options: WithScenarioContextOptions,
    body: (context: ScenarioContext) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Cause.UnknownException, Exclude<R, Scope.Scope>> =>
    withScenarioContextInternal(options, "scenario", body),
  e2e: <A, E, R>(
    options: WithScenarioContextOptions,
    body: (context: ScenarioContext) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Cause.UnknownException, Exclude<R, Scope.Scope>> =>
    withScenarioContextInternal(options, "e2e", body),
  testOnlyFake: <A, E, R>(
    options: WithScenarioContextOptions,
    body: (context: ScenarioContext) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | Cause.UnknownException, Exclude<R, Scope.Scope>> =>
    withScenarioContextInternal(options, "testOnlyFake", body),
} as const;
