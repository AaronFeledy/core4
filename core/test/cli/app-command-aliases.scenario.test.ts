import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";

import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";

const repoRoot = resolve(import.meta.dirname, "../../..");
const sourceCli = resolve(repoRoot, "core/bin/lando.ts");
const runCliPath = resolve(repoRoot, "core/src/cli/run.ts");

type RunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const run = async (
  command: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string>,
): Promise<RunResult> => {
  const process = Bun.spawn({ cmd: [...command], cwd, env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const envelope = (output: string): Record<string, unknown> => {
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .findLast((entry) => entry.startsWith("{") && entry.endsWith("}"));
  if (line === undefined) throw new Error("Expected a JSON command envelope");
  const parsed: unknown = JSON.parse(line);
  if (parsed === null || typeof parsed !== "object") throw new Error("Expected a JSON object envelope");
  return Object.fromEntries(Object.entries(parsed));
};

const makeEntryFixture = async (commandAliases: {
  readonly enabled?: boolean;
  readonly disabled?: ReadonlyArray<string>;
  readonly custom?: Readonly<Record<string, string>>;
}): Promise<{
  readonly appRoot: string;
  readonly env: Record<string, string>;
  readonly cleanup: () => Promise<void>;
}> => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "lando-command-alias-entry-"));
  const appRoot = join(fixtureRoot, "app");
  const cacheRoot = join(fixtureRoot, "cache");
  await mkdir(join(appRoot, ".lando", "scripts"), { recursive: true });
  await writeFile(join(appRoot, ".lando.yml"), "name: alias-entry\n");
  await writeFile(
    join(appRoot, ".lando", "scripts", "greet.bun.sh"),
    ["# ---", "# desc: Greet", "# ---", "echo -n entry-alias-ok", ""].join("\n"),
  );
  await Effect.runPromise(
    writeAppCommandCacheStrict({
      landofile: { name: "alias-entry", commandAliases },
      entries: [{ id: "app:greet", summary: "Greet", hidden: false, source: "bun-script" }],
      cwd: appRoot,
      cacheRoot,
    }),
  );
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  return {
    appRoot,
    env: {
      ...inheritedEnv,
      LANDO_USER_CACHE_ROOT: cacheRoot,
      LANDO_USER_DATA_ROOT: join(fixtureRoot, "data"),
      LANDO_USER_CONF_ROOT: join(fixtureRoot, "conf"),
    },
    cleanup: () => rm(fixtureRoot, { recursive: true, force: true }),
  };
};

test("custom aliases preserve resolved canonical JSON identity in source and compiled dispatch", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "lando-command-alias-scenario-"));
  const appRoot = join(fixtureRoot, "app");
  const cacheRoot = join(fixtureRoot, "cache");
  try {
    // Given
    await mkdir(join(appRoot, ".lando", "scripts"), { recursive: true });
    await writeFile(
      join(appRoot, ".lando.yml"),
      ["name: alias-scenario", "commandAliases:", "  custom:", "    start: app:greet", ""].join("\n"),
    );
    await writeFile(
      join(appRoot, ".lando", "scripts", "greet.bun.sh"),
      ["# ---", "# desc: Greet", "# ---", "echo -n alias-ok", ""].join("\n"),
    );
    await Effect.runPromise(
      writeAppCommandCacheStrict({
        landofile: { name: "alias-scenario", commandAliases: { custom: { start: "app:greet" } } },
        entries: [{ id: "app:greet", summary: "Greet", hidden: false, source: "bun-script" }],
        cwd: appRoot,
        cacheRoot,
      }),
    );
    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const env = {
      ...inheritedEnv,
      PATH: "/no-such-path",
      LANDO_USER_CACHE_ROOT: cacheRoot,
      LANDO_USER_DATA_ROOT: join(fixtureRoot, "data"),
      LANDO_USER_CONF_ROOT: join(fixtureRoot, "conf"),
    };
    const runner = join(fixtureRoot, "compiled-dispatch-runner.ts");
    await writeFile(
      runner,
      [
        `import { runCli } from ${JSON.stringify(runCliPath)};`,
        "await runCli({ argv: Bun.argv.slice(2), rootUrl: new URL('./lando', import.meta.url).href });",
        "",
      ].join("\n"),
    );

    // When
    const [source, compiled] = await Promise.all([
      run([process.execPath, sourceCli, "start", "--format=json"], appRoot, env),
      run([process.execPath, runner, "start", "--format=json"], appRoot, env),
    ]);

    // Then
    expect(source.exitCode).toBe(0);
    expect(compiled.exitCode).toBe(0);
    expect(envelope(source.stdout)).toMatchObject({ command: "app:greet", ok: true });
    expect(envelope(compiled.stdout)).toMatchObject({ command: "app:greet", ok: true });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}, 30_000);

test("shipping entry aliases honor app custom remaps before fast paths", async () => {
  const fixture = await makeEntryFixture({
    custom: { version: "app:greet", shellenv: "app:greet", recipes: "app:greet" },
  });
  try {
    // Given / When
    const results = await Promise.all(
      ["version", "shellenv", "recipes"].map((token) =>
        run([process.execPath, sourceCli, token], fixture.appRoot, fixture.env),
      ),
    );

    // Then
    for (const result of results) {
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("entry-alias-ok");
    }
  } finally {
    await fixture.cleanup();
  }
}, 30_000);

test("shipping entry aliases honor app disablement before fast paths", async () => {
  const fixture = await makeEntryFixture({ disabled: ["version", "shellenv", "recipes"] });
  try {
    // Given / When
    const results = await Promise.all(
      ["version", "shellenv", "recipes"].map((token) =>
        run([process.execPath, sourceCli, token], fixture.appRoot, fixture.env),
      ),
    );

    // Then
    for (const result of results) {
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("UnknownCommandError");
    }
  } finally {
    await fixture.cleanup();
  }
}, 30_000);

test("shipping entry classifies passthrough from the app alias target", async () => {
  const fixture = await makeEntryFixture({
    custom: { runtime: "meta:bun", execute: "meta:x" },
  });
  try {
    // Given / When
    const [bunResult, xResult, aliasRendererResult, canonicalRendererResult] = await Promise.all([
      run([process.execPath, sourceCli, "runtime", "--version"], fixture.appRoot, fixture.env),
      run([process.execPath, sourceCli, "execute", "--help"], fixture.appRoot, fixture.env),
      run(
        [process.execPath, sourceCli, "runtime", "--renderer=json", "--version"],
        fixture.appRoot,
        fixture.env,
      ),
      run(
        [process.execPath, sourceCli, "meta:bun", "--renderer=json", "--version"],
        fixture.appRoot,
        fixture.env,
      ),
    ]);

    // Then
    expect(bunResult.exitCode).toBe(0);
    expect(bunResult.stdout.trim()).toBe(Bun.version);
    expect(xResult.exitCode).toBe(0);
    expect(xResult.stdout).toContain("meta:x, x");
    expect(aliasRendererResult.exitCode).toBe(canonicalRendererResult.exitCode);
    expect(aliasRendererResult.stderr).toBe(canonicalRendererResult.stderr);
  } finally {
    await fixture.cleanup();
  }
}, 30_000);

test("alias policy failures use the pre-command identity", async () => {
  const fixture = await makeEntryFixture({ custom: { broken: "app:missing" } });
  try {
    // Given / When
    const result = await run(
      [process.execPath, sourceCli, "broken", "--format=json"],
      fixture.appRoot,
      fixture.env,
    );

    // Then
    expect(result.exitCode).toBe(1);
    expect(envelope(result.stdout).command).toBe("cli:alias-resolution");
  } finally {
    await fixture.cleanup();
  }
}, 30_000);
