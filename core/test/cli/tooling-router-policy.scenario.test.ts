import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";

import type { LandofileShape } from "@lando/sdk/schema";

import { writeAppCommandCacheStrict } from "../../src/cache/command-index-writer.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const sourceCli = resolve(repoRoot, "core/bin/lando.ts");
const runCliPath = resolve(repoRoot, "core/src/cli/run.ts");

interface PolicyFixture {
  readonly root: string;
  readonly cacheRoot: string;
  readonly env: Record<string, string>;
  readonly cleanup: () => Promise<void>;
}

const makeFixture = async (name: string): Promise<PolicyFixture> => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), `lando-tooling-policy-${name}-`));
  const root = join(fixtureRoot, "app");
  const cacheRoot = join(fixtureRoot, "cache");
  await mkdir(join(root, ".lando", "scripts"), { recursive: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    root,
    cacheRoot,
    env: {
      ...env,
      LANDO_USER_CACHE_ROOT: cacheRoot,
      LANDO_USER_DATA_ROOT: join(fixtureRoot, "data"),
      LANDO_USER_CONF_ROOT: join(fixtureRoot, "conf"),
    },
    cleanup: () => rm(fixtureRoot, { recursive: true, force: true }),
  };
};

const writeTask = async (fixture: PolicyFixture, name: string, marker: string): Promise<void> => {
  await writeFile(
    join(fixture.root, ".lando", "scripts", `${name}.bun.sh`),
    ["# ---", `# desc: Policy test ${name}`, "# ---", `touch ${marker}`, ""].join("\n"),
  );
};

const writeFreshCache = async (
  fixture: PolicyFixture,
  taskName: string,
  landofile: LandofileShape,
): Promise<void> => {
  await Effect.runPromise(
    writeAppCommandCacheStrict({
      landofile,
      entries: [{ id: `app:${taskName}`, summary: `Policy test ${taskName}`, hidden: false }],
      cwd: fixture.root,
      cacheRoot: fixture.cacheRoot,
      now: () => 100,
    }),
  );
};

const run = async (
  fixture: PolicyFixture,
  mode: "source" | "compiled",
  argv: ReadonlyArray<string>,
): Promise<{ readonly exitCode: number; readonly stdout: string }> => {
  const runner = join(fixture.root, "compiled-dispatch-runner.ts");
  if (mode === "compiled") {
    await writeFile(
      runner,
      `import { runCli } from ${JSON.stringify(runCliPath)};\nawait runCli({ argv: Bun.argv.slice(2), rootUrl: new URL('./lando', import.meta.url).href });\n`,
    );
  }
  const command =
    mode === "source" ? [process.execPath, sourceCli, ...argv] : [process.execPath, runner, ...argv];
  const proc = Bun.spawn({
    cmd: command,
    cwd: fixture.root,
    env: fixture.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return { exitCode, stdout };
};

const errorEnvelope = (output: string): Record<string, unknown> => {
  const line = output.split("\n").findLast((entry) => entry.startsWith("{"));
  if (line === undefined) throw new Error(`Missing JSON envelope: ${output.slice(0, 200)}`);
  const value: unknown = JSON.parse(line);
  if (value === null || typeof value !== "object") throw new Error("Expected object envelope");
  return Object.fromEntries(Object.entries(value));
};

test("Given a fresh cached task with an unsatisfied version constraint, command-not-found cannot execute it", async () => {
  const source = await makeFixture("version-source");
  const compiled = await makeFixture("version-compiled");
  const sourceMarker = join(source.root, "task-ran");
  const compiledMarker = join(compiled.root, "task-ran");
  try {
    const landofile: LandofileShape = { name: "version-policy", lando: ">=99" };
    for (const [fixture, marker] of [
      [source, sourceMarker],
      [compiled, compiledMarker],
    ] as const) {
      await writeFile(join(fixture.root, ".lando.yml"), "name: version-policy\nlando: '>=99'\n");
      await writeTask(fixture, "guarded", marker);
      await writeFreshCache(fixture, "guarded", landofile);
    }

    const [sourceResult, compiledResult] = await Promise.all([
      run(source, "source", ["guarded", "--format=json"]),
      run(compiled, "compiled", ["app:guarded", "--format=json"]),
    ]);

    expect(sourceResult.exitCode).toBe(1);
    expect(compiledResult.exitCode).toBe(1);
    expect(errorEnvelope(sourceResult.stdout)).toMatchObject({
      command: "app:guarded",
      error: { _tag: "ToolingCompileError", remediation: expect.any(String) },
    });
    expect(errorEnvelope(compiledResult.stdout)).toMatchObject({
      command: "app:guarded",
      error: { _tag: "ToolingCompileError", remediation: expect.any(String) },
    });
    expect(await Bun.file(sourceMarker).exists()).toBe(false);
    expect(await Bun.file(compiledMarker).exists()).toBe(false);
  } finally {
    await Promise.all([source.cleanup(), compiled.cleanup()]);
  }
}, 30_000);

test("Given a remote include and no command cache, command-not-found performs no network or task action", async () => {
  const source = await makeFixture("network-source");
  const compiled = await makeFixture("network-compiled");
  const sourceMarker = join(source.root, "task-ran");
  const compiledMarker = join(compiled.root, "task-ran");
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      requests += 1;
      return new Response("name: remote\n");
    },
  });
  try {
    for (const [fixture, marker] of [
      [source, sourceMarker],
      [compiled, compiledMarker],
    ] as const) {
      await writeFile(
        join(fixture.root, ".lando.yml"),
        `name: network-policy\nincludes:\n  - http://127.0.0.1:${server.port}/remote.yml\n`,
      );
      await writeTask(fixture, "offline", marker);
    }

    const [sourceResult, compiledResult] = await Promise.all([
      run(source, "source", ["offline", "--format=json"]),
      run(compiled, "compiled", ["offline", "--format=json"]),
    ]);

    expect(sourceResult.exitCode).toBe(1);
    expect(compiledResult.exitCode).toBe(1);
    expect(errorEnvelope(sourceResult.stdout)).toMatchObject({
      command: "app:offline",
      error: { _tag: "ToolingCompileError", remediation: expect.any(String) },
    });
    expect(errorEnvelope(compiledResult.stdout)).toMatchObject({
      command: "app:offline",
      error: { _tag: "ToolingCompileError", remediation: expect.any(String) },
    });
    expect(requests).toBe(0);
    expect(await Bun.file(sourceMarker).exists()).toBe(false);
    expect(await Bun.file(compiledMarker).exists()).toBe(false);
  } finally {
    server.stop(true);
    await Promise.all([source.cleanup(), compiled.cleanup()]);
  }
}, 30_000);
