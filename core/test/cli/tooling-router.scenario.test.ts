import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { appToolingCompilationCachePath } from "@lando/engine/cache/paths";
import { ToolingInputRevision } from "@lando/sdk/schema";
import { Effect } from "effect";
import {
  type RouterFixture,
  type RunResult,
  lastEnvelope,
  makeFixture,
  runProcess,
  runSource,
  sourceCli,
} from "./subprocess-support";

const repoRoot = resolve(import.meta.dirname, "../../..");
const runCliPath = resolve(repoRoot, "core/src/cli/run.ts");

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
      entries: [
        {
          id: `app:${taskName}`,
          summary: `Router test ${taskName}`,
          _tag: "Ready",
          sourceKind: "bun-script",
          visibility: "public",
          input: emptyToolingInput(),
        },
      ],
      cwd: fixture.root,
      cacheRoot: fixture.cacheRoot,
      now: () => 100,
    }),
  );
};

const writeFreshDeclaredInputCache = async (fixture: RouterFixture, taskName: string): Promise<void> => {
  await Effect.runPromise(
    writeAppCommandCacheStrict({
      landofile: { name: `router-${taskName}` },
      entries: [
        {
          id: `app:${taskName}`,
          summary: "Greet a target environment",
          _tag: "Ready",
          sourceKind: "tooling",
          visibility: "public",
          service: "web",
          input: {
            acceptsArguments: true,
            revision: ToolingInputRevision.make("fixture-revision"),
            flags: [
              {
                name: "name",
                alias: "n",
                boolean: false,
                sensitive: false,
                required: false,
                default: "world",
                description: "Who to greet",
              },
            ],
            args: [
              {
                name: "target",
                order: 0,
                sensitive: false,
                required: true,
                choices: ["dev", "prod"],
                description: "Environment to greet",
              },
            ],
          },
        },
      ],
      cwd: fixture.root,
      cacheRoot: fixture.cacheRoot,
      now: () => 100,
    }),
  );
};

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

for (const [command, commandId] of [
  ["start", "app:start"],
  ["hello", "cli:alias-resolution"],
] as const) {
  test(`${command} reports a tagged conflict without a stack for dual-form Landofiles`, async () => {
    // Given
    const fixture = await makeFixture(`dual-${command}`);
    try {
      await writeFile(
        join(fixture.root, ".lando.yml"),
        "name: conflict\ntooling:\n  hello:\n    cmd: echo hello\n",
      );
      await writeFile(join(fixture.root, ".lando.ts"), 'export default { name: "conflict" };\n');
      // When
      const result = await runSource(fixture, [command, "--format=json"]);
      // Then
      expect(result.exitCode, result.stderr).toBe(1);
      expect(lastEnvelope(result.stdout)).toMatchObject({
        command: commandId,
        ok: false,
        error: { _tag: "LandofileFormConflictError", remediation: expect.stringMatching(/\S/u) },
      });
      expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/\n\s+at |"stack"\s*:/u);
    } finally {
      await fixture.cleanup();
    }
  }, 30_000);
}

test("stop reports unchanged for a never-started dual-form app", async () => {
  // Given
  const fixture = await makeFixture("dual-stop");
  try {
    await writeFile(join(fixture.root, ".lando.ts"), 'export default { name: "conflict" };\n');
    // When
    const result = await runSource(fixture, ["stop", "--format=json"]);
    // Then
    expect(result.exitCode, result.stderr).toBe(0);
    expect(lastEnvelope(result.stdout)).toMatchObject({ ok: true, result: { outcome: "unchanged" } });
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/\n\s+at |"stack"\s*:/u);
  } finally {
    await fixture.cleanup();
  }
}, 30_000);

test("Given fresh app caches, when global help heads are dispatched, then both paths render root help", async () => {
  const source = await makeFixture("source-root-help");
  const compiled = await makeFixture("compiled-root-help");
  try {
    // Given
    await writeFreshCache(source, "known");
    await writeFreshCache(compiled, "known");

    // When
    const [sourceResult, compiledResult] = await Promise.all([
      runSource(source, ["--help"]),
      runCompiledDispatcher(compiled, ["-h"]),
    ]);

    // Then
    expect(sourceResult.exitCode, `${sourceResult.stderr}\n${sourceResult.stdout}`).toBe(0);
    expect(compiledResult.exitCode, `${compiledResult.stderr}\n${compiledResult.stdout}`).toBe(0);
    expect(sourceResult.stdout).toContain("COMMON");
    expect(compiledResult.stdout).toContain("COMMON");
    expect(sourceResult.stdout).toContain("lando <command>");
    expect(compiledResult.stdout).toContain("lando <command>");
    expect(`${sourceResult.stdout}\n${sourceResult.stderr}`).not.toContain("ToolingCompileError");
    expect(`${compiledResult.stdout}\n${compiledResult.stderr}`).not.toContain("ToolingCompileError");
  } finally {
    await Promise.all([source.cleanup(), compiled.cleanup()]);
  }
}, 30_000);

test("Given cached scripts and unparseable Landofiles, when tasks run, then both dispatchers use the script hot path", async () => {
  const source = await makeFixture("source-success");
  const compiled = await makeFixture("compiled-success");
  try {
    // Given
    await writeTask(source, "greet", ["echo -n router-ok"]);
    await writeTask(compiled, "greet", ["echo -n router-ok"]);
    await writeFile(join(source.root, ".lando.yml"), "name: [invalid\n");
    await writeFile(join(compiled.root, ".lando.yml"), "name: [invalid\n");
    await writeFreshCache(source, "greet");
    await writeFreshCache(compiled, "greet");

    // When
    const [sourceResult, compiledResult] = await Promise.all([
      runSource(source, ["greet", "--format=json"]),
      runCompiledDispatcher(compiled, ["app:greet", "--format=json"]),
    ]);

    // Then
    expect(sourceResult.exitCode, sourceResult.stderr).toBe(0);
    expect(compiledResult.exitCode, `${compiledResult.stderr}\n${compiledResult.stdout}`).toBe(0);
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

test.each([{ separator: [] }, { separator: ["--"] }])(
  "forwards script positionals with separator $separator",
  async ({ separator }) => {
    // Given
    const fixture = await makeFixture("script-args");
    try {
      await writeTask(fixture, "probe", ['echo "<$1>"', 'echo "<$2>"', 'echo "<$3>"']);
      await writeFreshCache(fixture, "probe");
      // When
      const result = await runSource(fixture, [
        "probe",
        "--format=json",
        ...separator,
        "a",
        "b c",
        "$(echo injected)",
      ]);
      // Then
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      expect(lastEnvelope(result.stdout)).toMatchObject({
        ok: true,
        result: { stdout: "<a>\n<b c>\n<$(echo injected)>\n" },
      });
    } finally {
      await fixture.cleanup();
    }
  },
  30_000,
);

test.each(["lando", "plain"])(
  "streams script output before exit with the %s renderer",
  async (renderer) => {
    // Given
    const fixture = await makeFixture("script-live");
    const gate = Promise.withResolvers<void>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        await gate.promise;
        return new Response("released");
      },
    });
    let proc: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await writeTask(fixture, "probe", [
        "echo first",
        "echo diagnostic 1>&2",
        `${JSON.stringify(process.execPath)} -e 'await fetch("http://127.0.0.1:${server.port}");'`,
        "echo second",
        "exit 3",
      ]);
      await writeFreshCache(fixture, "probe");
      // When
      const child = Bun.spawn([process.execPath, sourceCli, "probe", `--renderer=${renderer}`], {
        cwd: fixture.root,
        env: fixture.env,
        stdout: "pipe",
        stderr: "pipe",
      });
      proc = child;
      let stdout = "";
      let stderr = "";
      const firstLines = Promise.withResolvers<void>();
      const read = async (stream: ReadableStream<Uint8Array>, kind: "stdout" | "stderr") => {
        const decoder = new TextDecoder();
        for await (const chunk of stream) {
          const text = decoder.decode(chunk, { stream: true });
          if (kind === "stdout") stdout += text;
          else stderr += text;
          if (stdout.includes("first\n") && stderr.includes("diagnostic\n")) firstLines.resolve();
        }
      };
      const readers = Promise.all([read(child.stdout, "stdout"), read(child.stderr, "stderr")]);
      await Effect.runPromise(Effect.promise(() => firstLines.promise).pipe(Effect.timeout("5 seconds")));
      expect(child.exitCode).toBeNull();
      gate.resolve();
      const [exitCode] = await Promise.all([child.exited, readers]);
      // Then
      expect(exitCode, stderr).toBe(3);
      expect(stdout.match(/first\n/g)).toHaveLength(1);
      expect(stdout.match(/second\n/g)).toHaveLength(1);
      expect(stderr.match(/diagnostic\n/g)).toHaveLength(1);
      expect(stdout + stderr).not.toContain("ToolingExecError");
    } finally {
      gate.resolve();
      proc?.kill();
      if (proc !== undefined) await proc.exited;
      server.stop(true);
      await fixture.cleanup();
    }
  },
  30_000,
);

test.each([true, false])(
  "Given a cached task with wrapper=%s, when compiled dispatch receives version, then ownership applies before global version",
  async (wrapper) => {
    const compiled = await makeFixture("compiled-version-argv");
    try {
      // Given
      await writeFile(
        join(compiled.root, ".lando.yml"),
        `name: version-task\ntooling:\n  inspect-argv:\n    service: ":host"\n    cmd: echo dynamic-version-ok\n    wrapper: ${wrapper}\n`,
      );

      // When
      const compiledResult = await runCompiledDispatcher(compiled, [
        "inspect-argv",
        "--version",
        "--format=json",
      ]);

      // Then
      if (wrapper) {
        expect(compiledResult.exitCode, `${compiledResult.stderr}\n${compiledResult.stdout}`).toBe(0);
        expect(compiledResult.stdout).toBe("dynamic-version-ok --version --format=json\n");
      } else {
        expect(compiledResult.exitCode, `${compiledResult.stderr}\n${compiledResult.stdout}`).toBe(2);
        expect(lastEnvelope(compiledResult.stdout)).toMatchObject({
          command: "app:inspect-argv",
          ok: false,
          error: { _tag: "ToolingInputError", field: "version", tool: "app:inspect-argv" },
        });
      }
    } finally {
      await compiled.cleanup();
    }
  },
  30_000,
);

test("Given a cached raw script, when help is in its tail, then native dispatch answers help", async () => {
  const compiled = await makeFixture("compiled-help-argv");
  try {
    // Given
    await writeTask(compiled, "inspect-argv", ["echo -n dynamic-help-ok"]);
    await writeFreshCache(compiled, "inspect-argv");

    // When
    const compiledResult = await runCompiledDispatcher(compiled, ["inspect-argv", "--help", "--format=json"]);

    // Then
    expect(compiledResult.exitCode, `${compiledResult.stderr}\n${compiledResult.stdout}`).toBe(0);
    expect(lastEnvelope(compiledResult.stdout)).toMatchObject({
      command: "cli:help",
      ok: true,
      result: { target: { canonicalId: "app:inspect-argv", source: "tooling" } },
    });
    expect(compiledResult.stdout).not.toContain("dynamic-help-ok");
  } finally {
    await compiled.cleanup();
  }
}, 30_000);

test("Given corrupted app caches, when a custom task is resolved, then both dispatchers render CacheError envelopes", async () => {
  const source = await makeFixture("source-corrupt-cache");
  const compiled = await makeFixture("compiled-corrupt-cache");
  try {
    // Given
    await writeFreshCache(source, "broken");
    await writeFreshCache(compiled, "broken");
    const sourceCachePath = appToolingCompilationCachePath(source.cacheRoot, source.root);
    const compiledCachePath = appToolingCompilationCachePath(compiled.cacheRoot, compiled.root);
    await Promise.all([rm(sourceCachePath), rm(compiledCachePath)]);
    await Promise.all([mkdir(sourceCachePath), mkdir(compiledCachePath)]);

    // When
    const [sourceResult, compiledResult] = await Promise.all([
      runSource(source, ["broken", "--format=json"]),
      runCompiledDispatcher(compiled, ["broken", "--format=json"]),
    ]);

    // Then
    expect(sourceResult.exitCode).toBe(1);
    expect(compiledResult.exitCode).toBe(1);
    expect(lastEnvelope(sourceResult.stdout)).toMatchObject({
      command: "cli:alias-resolution",
      ok: false,
      error: {
        _tag: "CacheError",
        key: "app-command",
      },
    });
    expect(lastEnvelope(compiledResult.stdout)).toEqual(lastEnvelope(sourceResult.stdout));
  } finally {
    await Promise.all([source.cleanup(), compiled.cleanup()]);
  }
}, 30_000);

test("Given separate failing tasks, when routed, then both dispatchers propagate the task exit code", async () => {
  const source = await makeFixture("source-failure");
  const compiled = await makeFixture("compiled-failure");
  try {
    // Given
    const body = ["echo first", "echo second", "echo diagnostic 1>&2", "exit 7"];
    await writeTask(source, "fail", body);
    await writeTask(compiled, "fail", body);
    await writeFreshCache(source, "fail");
    await writeFreshCache(compiled, "fail");

    // When
    const [sourceResult, compiledResult] = await Promise.all([
      runSource(source, ["fail", "--format=json"]),
      runCompiledDispatcher(compiled, ["app:fail", "-j"]),
    ]);

    // Then
    expect(sourceResult.exitCode, sourceResult.stderr).toBe(7);
    expect(compiledResult.exitCode, compiledResult.stderr).toBe(7);
    const expectedFailure = {
      command: "app:fail",
      ok: false,
      error: {
        _tag: "LandoCommandError",
        commandId: "app:fail",
        exitCode: 7,
        remediation: expect.any(String),
      },
      result: {
        service: ":host",
        exitCode: 7,
        stdout: "first\nsecond\n",
        stderr: "diagnostic\n",
      },
    };
    expect(JSON.parse(sourceResult.stdout)).toMatchObject(expectedFailure);
    expect(JSON.parse(compiledResult.stdout)).toMatchObject(expectedFailure);
    expect(sourceResult.stderr).toBe("");
    expect(compiledResult.stderr).toBe("");
  } finally {
    await Promise.all([source.cleanup(), compiled.cleanup()]);
  }
}, 30_000);

test("Given missing caches, when a script name is invoked, then both dispatchers rebuild and run it silently", async () => {
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
    for (const result of [sourceResult, compiledResult]) {
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        command: "app:offline",
        result: { exitCode: 0, stderr: "" },
      });
      expect(result.stderr).toBe("");
    }
    expect(await Bun.file(sourceMarker).text()).toBe("ran\n");
    expect(await Bun.file(compiledMarker).text()).toBe("ran\n");
    expect(await Bun.file(appToolingCompilationCachePath(source.cacheRoot, source.root)).exists()).toBe(true);
    expect(await Bun.file(appToolingCompilationCachePath(compiled.cacheRoot, compiled.root)).exists()).toBe(
      true,
    );
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
    expect(sourceResult.exitCode).toBe(2);
    expect(compiledResult.exitCode).toBe(2);
    expect(lastEnvelope(sourceResult.stdout)).toMatchObject({
      command: "cli:unknown-command",
      ok: false,
      error: { _tag: "UnknownCommandError", commandToken: "unknown-router-task" },
    });
    expect(lastEnvelope(compiledResult.stdout)).toEqual(lastEnvelope(sourceResult.stdout));
  } finally {
    await Promise.all([source.cleanup(), compiled.cleanup()]);
  }
}, 30_000);

test("Given a directory outside an app, when a source command is unknown, then native dispatch exits 1", async () => {
  const source = await makeFixture("source-outside-app");
  try {
    // Given
    await rm(join(source.root, ".lando.yml"));

    // When
    const result = await runSource(source, ["unknown-outside-app"]);

    // Then
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('Unknown command "unknown-outside-app".');
  } finally {
    await source.cleanup();
  }
}, 30_000);

test("Given a cached task that declares input, when help is in its tail, then both dispatchers render its declared help", async () => {
  const source = await makeFixture("source-declared-help");
  const compiled = await makeFixture("compiled-declared-help");
  try {
    // Given
    await writeFreshDeclaredInputCache(source, "greet");
    await writeFreshDeclaredInputCache(compiled, "greet");

    // When
    const [sourceResult, compiledResult] = await Promise.all([
      runSource(source, ["greet", "--help"]),
      runCompiledDispatcher(compiled, ["greet", "-h"]),
    ]);

    // Then — declared input means Lando owns argv, so help renders instead of reaching the task
    for (const result of [sourceResult, compiledResult]) {
      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(result.stdout).toContain("USAGE");
      expect(result.stdout).toContain("lando greet [flags] <TARGET>");
      expect(result.stdout).toContain("--name=<value>, -n");
      expect(result.stdout).toContain("[default: world]");
      expect(result.stdout).toContain("ARGUMENTS");
      expect(result.stdout).toContain("target");
      expect(result.stdout).toContain("(dev, prod)");
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("ToolingInputError");
    }
  } finally {
    await Promise.all([source.cleanup(), compiled.cleanup()]);
  }
}, 30_000);

import { emptyToolingInput } from "../_support/tooling-input.ts";

const writeFlagOwnershipTasks = async (fixture: RouterFixture): Promise<void> => {
  await writeFile(
    join(fixture.root, ".lando.yml"),
    [
      "name: flag-ownership",
      "tooling:",
      "  build:",
      '    service: ":host"',
      "    cmd: echo ARGV",
      "    flags:",
      "      verbose:",
      "        boolean: true",
      "  report:",
      '    service: ":host"',
      "    cmd: echo ARGV",
      "    flags:",
      "      format:",
      "        description: Task format",
      "  release:",
      '    service: ":host"',
      "    cmd: echo ARGV",
      "    flags:",
      "      label:",
      "        description: Release label",
      "  stamp:",
      '    service: ":host"',
      "    cmd: echo ARGV",
      "    flags:",
      "      version:",
      "        description: Version to stamp",
      "      help:",
      "        description: Help topic",
      "  wrap:",
      '    service: ":host"',
      "    cmd: echo WRAP",
      "    wrapper: true",
      "  plain:",
      '    service: ":host"',
      "    cmd: echo PLAIN",
      "",
    ].join("\n"),
  );
  const scripts = join(fixture.root, ".lando", "scripts");
  await mkdir(scripts, { recursive: true });
  await writeFile(
    join(scripts, "probe.bun.sh"),
    [
      "# ---",
      "# desc: Probe declared flags",
      '# service: ":host"',
      "# flags:",
      "#   format:",
      "#     description: Script format",
      "# ---",
      'echo "SCRIPT $1"',
      "",
    ].join("\n"),
  );
};

test.each([
  {
    name: "a task-declared verbose flag reaches the task after its name",
    argv: ["build", "--verbose"],
    expected: { command: "app:build", result: { stdout: "ARGV --verbose\n" } },
  },
  {
    name: "a verbose flag before the task name stays Lando's",
    argv: ["--verbose", "build"],
    expected: { command: "app:build", result: { stdout: "ARGV\n" } },
  },
  {
    name: "a task-declared format flag reaches the task instead of Lando",
    argv: ["report", "--format=csv"],
    expected: { command: "app:report", result: { stdout: "ARGV --format=csv\n" } },
  },
  {
    name: "a task flag and Lando's envelope apply when the task does not declare format",
    argv: ["build", "--verbose", "--format=json"],
    expected: { command: "app:build", result: { stdout: "ARGV --verbose\n" } },
  },
  {
    name: "a wrapper task receives every token after its name",
    argv: ["wrap", "status", "--format=csv", "--verbose"],
    expected: { command: "app:wrap", result: { stdout: "WRAP status --format=csv --verbose\n" } },
  },
  {
    name: "a leading -- is dropped once for a declared task",
    argv: ["build", "--", "--verbose"],
    expected: { command: "app:build", result: { stdout: "ARGV --verbose\n" } },
  },
  {
    name: "a .bun.sh script owns a declared format flag",
    argv: ["probe", "--format=csv"],
    expected: { command: "app:probe", result: { stdout: "SCRIPT --format=csv\n" } },
  },
  {
    name: "help for a declared-format task stays Lando's",
    argv: ["help", "report", "--format=json"],
    expected: {
      command: "cli:help",
      result: { target: { canonicalId: "app:report", source: "tooling" } },
    },
  },
])(
  "$name",
  async ({ argv, expected }) => {
    const fixture = await makeFixture("flag-ownership");
    try {
      await writeFlagOwnershipTasks(fixture);
      const result = await runSource(fixture, ["--renderer=plain", "--format=json", ...argv]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(lastEnvelope(result.stdout)).toMatchObject({ ok: true, ...expected });
    } finally {
      await fixture.cleanup();
    }
  },
  60_000,
);

test("a declared value flag followed by a Lando flag is a missing value, not the next word", async () => {
  const fixture = await makeFixture("flag-missing-value");
  try {
    await writeFlagOwnershipTasks(fixture);
    const result = await runSource(fixture, ["--format=json", "report", "--format", "--trace", "csv"]);
    expect(result.exitCode).toBe(1);
    expect(lastEnvelope(result.stdout)).toMatchObject({
      ok: false,
      command: "app:report",
      error: { _tag: "ToolingInputError", field: "format" },
    });
  } finally {
    await fixture.cleanup();
  }
}, 60_000);

test("an undeclared format flag still rejects an unsupported Lando result format", async () => {
  const fixture = await makeFixture("flag-task-and-envelope");
  try {
    await writeFlagOwnershipTasks(fixture);
    const rejected = await runSource(fixture, ["build", "--verbose", "--format=csv"]);
    expect(rejected.exitCode).toBe(2);
    expect(`${rejected.stdout}\n${rejected.stderr}`).toContain(
      'Unsupported result format value "csv" from flag',
    );
  } finally {
    await fixture.cleanup();
  }
}, 60_000);

test("a declared string flag owns --help as its value slot", async () => {
  const fixture = await makeFixture("flag-label-help");
  try {
    await writeFlagOwnershipTasks(fixture);
    const result = await runSource(fixture, ["--format=json", "release", "--label", "--help"]);
    expect(result.exitCode).toBe(1);
    expect(lastEnvelope(result.stdout)).toMatchObject({
      ok: false,
      command: "app:release",
      error: { _tag: "ToolingInputError", field: "label" },
    });
  } finally {
    await fixture.cleanup();
  }
}, 60_000);

test.each([
  { argv: ["stamp", "--version", "--renderer=bogus"], field: "version" },
  { argv: ["stamp", "--help", "--format=csv"], field: "help" },
])(
  "a declared value flag named like a Lando control owns $argv.2 as its value slot",
  async ({ argv, field }) => {
    const fixture = await makeFixture(`flag-${field}-slot`);
    try {
      await writeFlagOwnershipTasks(fixture);
      const result = await runSource(fixture, ["--format=json", ...argv]);
      expect(result.exitCode).toBe(1);
      expect(lastEnvelope(result.stdout)).toMatchObject({
        ok: false,
        command: "app:stamp",
        error: { _tag: "ToolingInputError", field },
      });
    } finally {
      await fixture.cleanup();
    }
  },
  60_000,
);

test("machine tooling help carries flag placement for ordinary, declaring, and wrapper tasks", async () => {
  const fixture = await makeFixture("flag-placement");
  try {
    await writeFlagOwnershipTasks(fixture);
    const cases = [
      { task: "plain", afterName: "until-separator", includes: ["--version", "-v"] },
      { task: "report", afterName: "until-separator", includes: ["--format", "--version", "-v"] },
      { task: "wrap", afterName: "none", includes: [] },
    ] as const;
    for (const entry of cases) {
      const result = await runSource(fixture, ["--renderer=plain", "--format=json", "help", entry.task]);
      expect(result.exitCode, result.stderr).toBe(0);
      const target = (
        lastEnvelope(result.stdout) as {
          result: { target: { landoFlags: { afterName: string; commandOwned: ReadonlyArray<string> } } };
        }
      ).result.target;
      expect(target.landoFlags.afterName).toBe(entry.afterName);
      if (entry.task === "wrap") expect(target.landoFlags.commandOwned).toEqual([]);
      for (const spelling of entry.includes) expect(target.landoFlags.commandOwned).toContain(spelling);
    }
  } finally {
    await fixture.cleanup();
  }
}, 60_000);

test("a flag typed after a task name explains Lando's ownership", async () => {
  const fixture = await makeFixture("flag-ownership-guidance");
  try {
    await writeFlagOwnershipTasks(fixture);
    const cases = [
      {
        argv: ["--format=json", "build", "--format=csv"],
        tag: "RendererSelectionError",
        typed: "--format=csv",
        original: "Use --format=<value>",
        machine: true,
      },
      {
        argv: ["--format=json", "build", "--format=table"],
        tag: "RendererSelectionError",
        typed: "--format=table",
        original: "does not support result format",
        machine: false,
      },
      {
        argv: ["--format=json", "build", "--renderer=bogus"],
        tag: "RendererSelectionError",
        typed: "--renderer=bogus",
        original: "Use --renderer=<value>",
        machine: true,
      },
      {
        argv: ["--format=json", "build", "--log-level=bogus"],
        tag: "LogLevelSelectionError",
        typed: "--log-level=bogus",
        original: "Use --log-level=<value>",
        machine: true,
      },
    ] as const;
    for (const entry of cases) {
      const result = await runSource(fixture, entry.argv);
      expect(result.exitCode, result.stderr).not.toBe(0);
      const output = `${result.stdout}\n${result.stderr}`;
      const remediation = entry.machine
        ? String((lastEnvelope(result.stdout).error as { remediation?: unknown }).remediation)
        : output;
      if (entry.machine) expect(lastEnvelope(result.stdout).error).toMatchObject({ _tag: entry.tag });
      else expect(output).toContain(entry.tag);
      expect(remediation).toContain(entry.original);
      expect(remediation).toContain(`\`${entry.typed.split("=")[0]}\` after \`build\``);
      expect(remediation).toContain(`lando build -- ${entry.typed}`);
      expect(remediation).toContain("wrapper: true");
      expect(remediation).toContain(`lando ${entry.typed.split("=")[0]}=<value> build`);
    }
  } finally {
    await fixture.cleanup();
  }
}, 120_000);

test("a task's later selection flag wins attribution and env/config failures stay unexplained", async () => {
  const fixture = await makeFixture("flag-ownership-attribution");
  try {
    await writeFlagOwnershipTasks(fixture);

    const both = await runSource(fixture, ["--format=json", "build", "--format=bogus", "--renderer=bogus"]);
    const bothRemediation = String(
      (lastEnvelope(both.stdout).error as { remediation?: unknown }).remediation,
    );
    expect(bothRemediation).toContain("`--renderer` after `build`");
    expect(bothRemediation).not.toContain("`--format` after `build`");

    fixture.env.LANDO_RENDERER = "bogus";
    const viaEnv = await runSource(fixture, ["--format=json", "build", "--jq=x"]);
    expect(viaEnv.exitCode).toBe(2);
    expect(lastEnvelope(viaEnv.stdout).error).toMatchObject({ _tag: "RendererSelectionError" });
    const envRemediation = String(
      (lastEnvelope(viaEnv.stdout).error as { remediation?: unknown }).remediation,
    );
    expect(envRemediation).not.toContain("wrapper: true");
    fixture.env.LANDO_RENDERER = "lando";

    const beforeName = await runSource(fixture, ["--format=json", "--renderer=bogus", "build"]);
    expect(beforeName.exitCode).toBe(2);
    expect(lastEnvelope(beforeName.stdout).error).toMatchObject({ _tag: "RendererSelectionError" });
    expect(`${beforeName.stdout}\n${beforeName.stderr}`).not.toContain("wrapper: true");

    const wrapper = await runSource(fixture, ["--format=json", "wrap", "--renderer=bogus"]);
    expect(wrapper.exitCode, wrapper.stderr).toBe(0);
    expect(lastEnvelope(wrapper.stdout)).toMatchObject({ ok: true });
  } finally {
    await fixture.cleanup();
  }
}, 120_000);
