import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";

import { Effect } from "effect";

import type { PromptBatchOptions, PromptSpec } from "@lando/sdk/schema";
import type { ConfirmSpec, PromptAnswers } from "@lando/sdk/services";

import { initApp } from "../../src/cli/commands/init.ts";
import type { InteractionPrompter } from "../../src/interaction/prompter.ts";
import { makeInteractionService } from "../../src/interaction/service.ts";

const scriptedStdin = (lines: ReadonlyArray<string>): NodeJS.ReadableStream =>
  Readable.from(lines.map((line) => `${line}\n`));

const capturingWritable = () => {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => text };
};

// Forcing mode:"interactive" lets scripted stdin drive the real line engine without a real tty.ReadStream.
const serviceBackedPrompter = (
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): InteractionPrompter => {
  const service = makeInteractionService({ stdin, stdout, stderr });
  return {
    promptAll: (specs: ReadonlyArray<PromptSpec>, options?: PromptBatchOptions) =>
      Effect.runPromise(Effect.scoped(service.promptAll(specs, { ...options, mode: "interactive" }))),
    confirm: (spec: ConfirmSpec) =>
      Effect.runPromise(Effect.scoped(service.confirm({ ...spec, mode: "interactive" }))),
  };
};

const fakePrompter = (answersByName: Readonly<Record<string, string>>) => {
  const calls: Array<{ specs: ReadonlyArray<PromptSpec>; options?: PromptBatchOptions }> = [];
  const prompter: InteractionPrompter = {
    promptAll: async (specs, options) => {
      calls.push({ specs, options });
      const out: Record<string, string> = {};
      for (const spec of specs) {
        const explicit = options?.answers?.[spec.name];
        out[spec.name] = explicit ?? answersByName[spec.name] ?? String(spec.default ?? "");
      }
      return out as PromptAnswers;
    },
    confirm: async () => true,
  };
  return { prompter, calls };
};

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-init-recipe-")));
  const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
  process.env.LANDO_USER_DATA_ROOT = join(dir, "lando-data");
  try {
    return await run(dir);
  } finally {
    if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
    await rm(dir, { recursive: true, force: true });
  }
};

interface RunOptions {
  readonly stdin?: string;
}

const runCli = async (
  args: ReadonlyArray<string>,
  cwd: string,
  options: RunOptions = {},
): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
    env: { ...process.env, LANDO_USER_DATA_ROOT: join(cwd, "lando-data") },
    stdout: "pipe",
    stderr: "pipe",
    stdin: options.stdin === undefined ? "ignore" : "pipe",
  });
  if (options.stdin !== undefined && proc.stdin !== undefined) {
    const writer = proc.stdin;
    writer.write(options.stdin);
    writer.end();
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

describe("lando init — interactive recipe selection (US-031 AC1)", () => {
  test("subprocess: scripted stdin picks recipe by id then answers prompts", async () => {
    await withTempCwd(async (dir) => {
      const scriptedStdin = "empty\nci-empty-app\n";
      const result = await runCli(["init", "--interactive"], dir, { stdin: scriptedStdin });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Pick a recipe");
      expect(result.stdout).toContain("Empty Landofile");
      expect(result.stdout).toContain("Created ci-empty-app at");
      expect(await Bun.file(join(dir, "ci-empty-app", ".lando.yml")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "ci-empty-app", "server.js")).exists()).toBe(false);
    });
  });

  test("subprocess: scripted stdin picks recipe by index", async () => {
    await withTempCwd(async (dir) => {
      const scriptedStdin = "17\nidx-pick-app\n";
      const result = await runCli(["init", "--interactive"], dir, { stdin: scriptedStdin });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created idx-pick-app at");
      expect(await Bun.file(join(dir, "idx-pick-app", ".lando.yml")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "idx-pick-app", "server.js")).exists()).toBe(false);
    });
  });

  test("subprocess: blank input picks the default recipe (node-postgres)", async () => {
    await withTempCwd(async (dir) => {
      const scriptedStdin = "\ndefault-app\n";
      const result = await runCli(["init", "--interactive"], dir, { stdin: scriptedStdin });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Created default-app at");
      expect(await Bun.file(join(dir, "default-app", ".lando.yml")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "default-app", "server.js")).exists()).toBe(true);
    });
  });

  test("service-backed prompter: invalid recipe re-prompts and then accepts a valid one", async () => {
    await withTempCwd(async (dir) => {
      const stdout = capturingWritable();
      const stderr = capturingWritable();
      const interaction = serviceBackedPrompter(
        scriptedStdin(["totally-bogus", "empty", "valid-app"]),
        stdout.stream,
        stderr.stream,
      );
      const result = await initApp({
        cwd: dir,
        full: false,
        interaction,
        postInitIO: { out: () => {}, err: () => {} },
      });
      expect(result.appName).toBe("valid-app");
      expect(await Bun.file(join(dir, "valid-app", ".lando.yml")).exists()).toBe(true);
      expect(stderr.text()).toContain('no choice matches "totally-bogus"');
      expect(stdout.text()).toContain("Pick a recipe");
      expect(stdout.text()).toContain("Empty Landofile");
    });
  });

  test("fake prompter: explicit --recipe bypasses the recipe-selection prompt", async () => {
    await withTempCwd(async (dir) => {
      const { prompter, calls } = fakePrompter({ name: "bypass-app" });
      const result = await initApp({
        cwd: dir,
        full: false,
        recipe: "empty",
        interaction: prompter,
        postInitIO: { out: () => {}, err: () => {} },
      });
      expect(result.appName).toBe("bypass-app");
      const promptedNames = calls.flatMap((call) => call.specs.map((spec) => spec.name));
      expect(promptedNames).not.toContain("__recipe__");
    });
  });
});

describe("lando init — non-interactive recipe selection (US-031 AC2)", () => {
  test("subprocess: --no-interactive --recipe with --answer scaffolds without any prompt", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(
        ["init", "--no-interactive", "--recipe=empty", "--answer=name=ci-app"],
        dir,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("Pick a recipe");
      expect(result.stdout).toContain("Created ci-app at");
      expect(await Bun.file(join(dir, "ci-app", ".lando.yml")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "ci-app", "server.js")).exists()).toBe(false);
    });
  });

  test("subprocess: --no-interactive without --recipe defaults to node-postgres", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["init", "--no-interactive", "--answer=name=default-ci"], dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("Pick a recipe");
      expect(result.stdout).toContain("Created default-ci at");
      expect(await Bun.file(join(dir, "default-ci", ".lando.yml")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "default-ci", "server.js")).exists()).toBe(true);
    });
  });

  test("subprocess: --yes without --recipe accepts the default recipe", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["init", "--yes", "--answer=name=yes-app"], dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("Pick a recipe");
      expect(result.stdout).toContain("Created yes-app at");
      expect(await Bun.file(join(dir, "yes-app", ".lando.yml")).exists()).toBe(true);
    });
  });
});
