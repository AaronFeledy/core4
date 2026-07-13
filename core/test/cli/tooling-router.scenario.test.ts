import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";

import { writeAppCommandCacheStrict } from "../../src/cache/command-index-writer.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const sourceCli = resolve(repoRoot, "core/bin/lando.ts");
const runCliPath = resolve(repoRoot, "core/src/cli/run.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RouterFixture {
  readonly root: string;
  readonly cacheRoot: string;
  readonly env: Record<string, string>;
  readonly cleanup: () => Promise<void>;
}

const makeFixture = async (name: string): Promise<RouterFixture> => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), `lando-tooling-router-${name}-`));
  const root = join(fixtureRoot, "app");
  const cacheRoot = join(fixtureRoot, "cache");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, ".lando.yml"), `name: router-${name}\n`);
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    root,
    cacheRoot,
    env: {
      ...inheritedEnv,
      PATH: "/no-such-path",
      LANDO_USER_CACHE_ROOT: cacheRoot,
      LANDO_USER_DATA_ROOT: join(fixtureRoot, "data"),
      LANDO_USER_CONF_ROOT: join(fixtureRoot, "conf"),
    },
    cleanup: () => rm(fixtureRoot, { recursive: true, force: true }),
  };
};

const writeTask = async (
  fixture: RouterFixture,
  name: string,
  body: ReadonlyArray<string>,
): Promise<void> => {
  const scripts = join(fixture.root, ".lando", "scripts");
  await mkdir(scripts, { recursive: true });
  await writeFile(
    join(scripts, `${name}.bun.sh`),
    ["# ---", `# desc: Router test ${name}`, "# ---", ...body, ""].join("\n"),
  );
};

const writeFreshCache = async (fixture: RouterFixture, taskName: string): Promise<void> => {
  await Effect.runPromise(
    writeAppCommandCacheStrict({
      landofile: { name: `router-${taskName}` },
      entries: [{ id: `app:${taskName}`, summary: `Router test ${taskName}`, hidden: false }],
      cwd: fixture.root,
      cacheRoot: fixture.cacheRoot,
      now: () => 100,
    }),
  );
};

const runProcess = async (command: ReadonlyArray<string>, fixture: RouterFixture): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [...command],
    cwd: fixture.root,
    env: fixture.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const runSource = (fixture: RouterFixture, argv: ReadonlyArray<string>): Promise<RunResult> =>
  runProcess([process.execPath, sourceCli, ...argv], fixture);

const runCompiledDispatcher = async (
  fixture: RouterFixture,
  argv: ReadonlyArray<string>,
): Promise<RunResult> => {
  const runner = join(fixture.root, "compiled-dispatch-runner.ts");
  await writeFile(
    runner,
    [
      `import { runCli } from ${JSON.stringify(runCliPath)};`,
      "await runCli({ argv: Bun.argv.slice(2), rootUrl: new URL('./lando', import.meta.url).href });",
      "",
    ].join("\n"),
  );
  return runProcess([process.execPath, runner, ...argv], fixture);
};

const lastEnvelope = (output: string): Record<string, unknown> => {
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .findLast((entry) => entry.startsWith("{") && entry.endsWith("}"));
  if (line === undefined) throw new Error(`No JSON envelope in output: ${output.slice(0, 200)}`);
  const parsed: unknown = JSON.parse(line);
  if (parsed === null || typeof parsed !== "object") throw new Error("Expected a JSON object envelope");
  return Object.fromEntries(Object.entries(parsed));
};

test("Given separate fresh fixtures, when bare and canonical tasks run, then source and compiled return truthful JSON", async () => {
  const source = await makeFixture("source-success");
  const compiled = await makeFixture("compiled-success");
  try {
    // Given
    await writeTask(source, "greet", ["echo -n router-ok"]);
    await writeTask(compiled, "greet", ["echo -n router-ok"]);
    await writeFreshCache(source, "greet");
    await writeFreshCache(compiled, "greet");

    // When
    const [sourceResult, compiledResult] = await Promise.all([
      runSource(source, ["greet", "--format=json"]),
      runCompiledDispatcher(compiled, ["app:greet", "--format=json"]),
    ]);

    // Then
    expect(sourceResult.exitCode, sourceResult.stderr).toBe(0);
    expect(compiledResult.exitCode, compiledResult.stderr).toBe(0);
    const expected = {
      command: "app:greet",
      ok: true,
      result: {
        tool: "app:greet",
        service: ":host",
        exitCode: 0,
        stdout: "router-ok",
        stderr: "",
      },
    };
    expect(lastEnvelope(sourceResult.stdout)).toMatchObject(expected);
    expect(lastEnvelope(compiledResult.stdout)).toMatchObject(expected);
  } finally {
    await Promise.all([source.cleanup(), compiled.cleanup()]);
  }
}, 30_000);

test("Given separate failing tasks, when routed, then both dispatchers propagate the task exit code", async () => {
  const source = await makeFixture("source-failure");
  const compiled = await makeFixture("compiled-failure");
  try {
    // Given
    await writeTask(source, "fail", ["exit 7"]);
    await writeTask(compiled, "fail", ["exit 7"]);
    await writeFreshCache(source, "fail");
    await writeFreshCache(compiled, "fail");

    // When
    const [sourceResult, compiledResult] = await Promise.all([
      runSource(source, ["fail", "--format=json"]),
      runCompiledDispatcher(compiled, ["app:fail", "--format=json"]),
    ]);

    // Then
    expect(sourceResult.exitCode, sourceResult.stderr).toBe(7);
    expect(compiledResult.exitCode, compiledResult.stderr).toBe(7);
    const expectedFailure = {
      command: "app:fail",
      ok: false,
      error: {
        _tag: "ToolingExecError",
        remediation: expect.stringContaining("tooling task"),
      },
    };
    expect(lastEnvelope(sourceResult.stdout)).toMatchObject(expectedFailure);
    expect(lastEnvelope(compiledResult.stdout)).toMatchObject(expectedFailure);
  } finally {
    await Promise.all([source.cleanup(), compiled.cleanup()]);
  }
}, 30_000);

test("Given missing caches, when a script name is invoked, then neither dispatcher bypasses policy or runs it", async () => {
  const source = await makeFixture("source-missing");
  const compiled = await makeFixture("compiled-missing");
  const sourceMarker = join(source.root, "task-ran");
  const compiledMarker = join(compiled.root, "task-ran");
  try {
    // Given
    await writeTask(source, "offline", [`echo ran > ${sourceMarker}`]);
    await writeTask(compiled, "offline", [`echo ran > ${compiledMarker}`]);

    // When
    const [sourceResult, compiledResult] = await Promise.all([
      runSource(source, ["offline", "--format=json"]),
      runCompiledDispatcher(compiled, ["offline", "--format=json"]),
    ]);

    // Then
    expect(sourceResult.exitCode).not.toBe(0);
    expect(compiledResult.exitCode).not.toBe(0);
    expect(`${sourceResult.stdout}\n${sourceResult.stderr}`).toContain("lando app cache refresh");
    expect(`${compiledResult.stdout}\n${compiledResult.stderr}`).toContain("lando app cache refresh");
    expect(await Bun.file(sourceMarker).exists()).toBe(false);
    expect(await Bun.file(compiledMarker).exists()).toBe(false);
  } finally {
    await Promise.all([source.cleanup(), compiled.cleanup()]);
  }
}, 30_000);

test("Given fresh caches without a match, when an unknown task is invoked, then both return tagged remediation", async () => {
  const source = await makeFixture("source-unknown");
  const compiled = await makeFixture("compiled-unknown");
  try {
    // Given
    await writeFreshCache(source, "known");
    await writeFreshCache(compiled, "known");

    // When
    const [sourceResult, compiledResult] = await Promise.all([
      runSource(source, ["unknown-router-task", "--format=json"]),
      runCompiledDispatcher(compiled, ["unknown-router-task", "--format=json"]),
    ]);

    // Then
    expect(sourceResult.exitCode).toBe(1);
    expect(compiledResult.exitCode).toBe(1);
    expect(lastEnvelope(sourceResult.stdout)).toMatchObject({
      command: "app:unknown-router-task",
      ok: false,
      error: {
        _tag: "ToolingCompileError",
        remediation: expect.stringContaining("lando app cache refresh"),
      },
    });
    expect(lastEnvelope(compiledResult.stdout)).toEqual(lastEnvelope(sourceResult.stdout));
  } finally {
    await Promise.all([source.cleanup(), compiled.cleanup()]);
  }
}, 30_000);

test("Given a directory outside an app, when a source command is unknown, then OCLIF retains exit 127", async () => {
  const source = await makeFixture("source-outside-app");
  try {
    // Given
    await rm(join(source.root, ".lando.yml"));

    // When
    const result = await runSource(source, ["unknown-outside-app"]);

    // Then
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("command unknown-outside-app not found");
  } finally {
    await source.cleanup();
  }
}, 30_000);
