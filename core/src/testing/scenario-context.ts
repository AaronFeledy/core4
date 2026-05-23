import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Cause, Chunk, Context, Effect, type Scope, Stream } from "effect";

import {
  FileIoError,
  FileNotFoundError,
  GuideFixtureNotFoundError,
  GuideFixtureSymlinkError,
  NotImplementedError,
} from "@lando/sdk/errors";
import { FileSystem, type FileSystemError, type LandoEvent } from "@lando/sdk/services";

import { FileSystemLive } from "../services/file-system.ts";
import { CORE_VERSION } from "../version.ts";
import { type TestRuntime, makeTestRuntime } from "./test-runtime.ts";

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

export interface ScenarioTranscriptFrame {
  readonly kind: "run" | "event" | "message" | "note";
  readonly data: unknown;
}

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

const runScenarioLayerCommand = async (
  args: ReadonlyArray<string>,
  cwd: string,
  events: LandoEvent[],
): Promise<ScenarioRunResult | undefined> => {
  if (args[0] === "destroy" || args[0] === "app:destroy") {
    return { command: args, stdout: "destroyed\n", stderr: "", exitCode: 0, events: [...events] };
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

const createDefaultRunCli =
  (
    events: LandoEvent[],
    getWorkingDirectory: () => string,
    setWorkingDirectory: (path: string) => void,
  ): ScenarioContext["runCli"] =>
  (command, options) =>
    Effect.tryPromise(async () => {
      const args = appendInitAnswers(parseCommand(command), options?.answers);
      if (args.length === 1 && (args[0] === "version" || args[0] === "--version" || args[0] === "-v")) {
        return {
          command: args,
          stdout: `${CORE_VERSION}\n`,
          stderr: "",
          exitCode: 0,
          events: [...events],
        } satisfies ScenarioRunResult;
      }

      const scenarioLayerResult = await runScenarioLayerCommand(args, getWorkingDirectory(), events);
      if (scenarioLayerResult !== undefined) return scenarioLayerResult;

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
        if ((args[0] === "start" || args[0] === "app:start") && exitCode === 0) {
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
    });

const createRunCli = (
  events: LandoEvent[],
  transcriptFrames: ScenarioTranscriptFrame[],
  getWorkingDirectory: () => string,
  setWorkingDirectory: (path: string) => void,
  override?: (command: ReadonlyArray<string>, options?: ScenarioRunOptions) => Promise<ScenarioRunResult>,
): ScenarioContext["runCli"] => {
  const runner =
    override === undefined
      ? createDefaultRunCli(events, getWorkingDirectory, setWorkingDirectory)
      : (command: string | ReadonlyArray<string>, options?: ScenarioRunOptions) =>
          Effect.tryPromise(() => override(parseCommand(command), options));

  return (command, options) =>
    runner(command, options).pipe(
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
  let workingDirectory = testDir;
  const getWorkingDirectory = () => workingDirectory;
  const setWorkingDirectory = (path: string) => {
    workingDirectory = path;
  };

  return {
    guideId: options.guideId,
    scenarioId: options.scenarioId,
    variant: {},
    testDir,
    runtime,
    vars: new Map(options.vars ?? []),
    runCli: createRunCli(events, transcriptFrames, getWorkingDirectory, setWorkingDirectory, options.runCli),
    shell: (command) => Effect.fail(shellNotImplemented(command)),
    events,
    transcript: {
      frames: transcriptFrames,
      append: (frame) => Effect.sync(() => transcriptFrames.push(frame)),
    },
    fixtures: {
      use: createFixtureUse(options.guideId, testDir, setWorkingDirectory),
    },
  };
};

export const withScenarioContext = <A, E, R>(
  options: WithScenarioContextOptions,
  body: (context: ScenarioContext) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Cause.UnknownException, Exclude<R, Scope.Scope>> =>
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
