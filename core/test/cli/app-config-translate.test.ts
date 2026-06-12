import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Exit } from "effect";

import type { ConfigTranslatorShape } from "@lando/sdk/services";

import {
  appConfigTranslate,
  renderConfigTranslateResult,
} from "../../src/cli/commands/app-config-translate.ts";
import { parseLandofile } from "../../src/landofile/parser.ts";

const dirs: Array<string> = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const makeAppDir = async (landofile: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-translate-"));
  dirs.push(dir);
  await Bun.write(join(dir, ".lando.yml"), landofile);
  return dir;
};

const makeTranslator = (id: string, fragment: Record<string, unknown>): ConfigTranslatorShape => ({
  id,
  summary: `${id} translator`,
  inputKinds: ["lando-v3"],
  detect: () => Effect.succeed([{ translator: id, files: [], confidence: "likely" as const }]),
  translate: () =>
    Effect.succeed({
      fragment,
      diagnostics: [{ kind: "generated" as const, message: `${id} added keys` }],
    }),
});

const runExit = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromiseExit(effect);

describe("appConfigTranslate", () => {
  test("fails with a plugin-install remediation when no translators are registered", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    const exit = await runExit(appConfigTranslate({ cwd }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        const error = failure.value as { _tag: string; remediation?: string };
        expect(error._tag).toBe("ConfigTranslateNoTranslatorsError");
        expect(error.remediation ?? "").toContain("plugin");
      }
    }
  });

  test("writes a canonical Landofile next to the input by default", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    const translators = [makeTranslator("v3", { services: { db: { type: "mysql:8.0" } } })];
    const result = await Effect.runPromise(appConfigTranslate({ cwd, translators }));
    expect(result.mode).toBe("canonical");
    expect(result.outputPath).toBe(join(cwd, ".lando.yml.canonical"));
    expect(result.backupPath).toBeUndefined();

    const input = await readFile(join(cwd, ".lando.yml"), "utf8");
    expect(input).toBe("name: demo\nruntime: 4\n");

    const canonicalText = await readFile(result.outputPath, "utf8");
    const parsed = (await Effect.runPromise(
      parseLandofile({ file: result.outputPath, content: canonicalText, cwd }),
    )) as Record<string, unknown>;
    expect(parsed).toEqual({
      name: "demo",
      runtime: 4,
      services: { db: { type: "mysql:8.0" } },
    });
    expect(result.diagnostics.length).toBe(1);
  });

  test("--write overwrites the input and keeps a .bak backup of the original", async () => {
    const original = "name: demo\nruntime: 4\n";
    const cwd = await makeAppDir(original);
    const translators = [makeTranslator("v3", { services: { cache: { type: "redis:7" } } })];
    const result = await Effect.runPromise(appConfigTranslate({ cwd, write: true, translators }));
    expect(result.mode).toBe("write");
    expect(result.outputPath).toBe(join(cwd, ".lando.yml"));
    expect(result.backupPath).toBe(join(cwd, ".lando.yml.bak"));

    const backup = await readFile(join(cwd, ".lando.yml.bak"), "utf8");
    expect(backup).toBe(original);

    const written = await readFile(join(cwd, ".lando.yml"), "utf8");
    const parsed = (await Effect.runPromise(
      parseLandofile({ file: result.outputPath, content: written, cwd }),
    )) as Record<string, unknown>;
    expect(parsed).toEqual({
      name: "demo",
      runtime: 4,
      services: { cache: { type: "redis:7" } },
    });
  });

  test("rejects unsupported tooling flag metadata before translation", async () => {
    const cwd = await makeAppDir(
      [
        "name: demo",
        "runtime: 4",
        "tooling:",
        "  echo:",
        "    cmd: echo hi",
        "    flags:",
        "      verbose:",
        "        type: boolean",
        "",
      ].join("\n"),
    );
    const translators = [makeTranslator("v3", { services: { db: { type: "mysql:8.0" } } })];

    const exit = await runExit(appConfigTranslate({ cwd, translators }));

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect((failure.value as { _tag: string; message: string })._tag).toBe("NotImplementedError");
        expect((failure.value as { message: string }).message).toContain('Tooling flags field "type"');
      }
    }
  });

  test("fails with LandofileNotFoundError when there is no Landofile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-translate-empty-"));
    dirs.push(dir);
    const exit = await runExit(appConfigTranslate({ cwd: dir, translators: [makeTranslator("v3", {})] }));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      if (failure._tag === "Some") {
        expect((failure.value as { _tag: string })._tag).toBe("LandofileNotFoundError");
      }
    }
  });

  test("renderConfigTranslateResult emits text and json forms", async () => {
    const cwd = await makeAppDir("name: demo\nruntime: 4\n");
    const translators = [makeTranslator("v3", { services: { db: { type: "mysql:8.0" } } })];
    const result = await Effect.runPromise(appConfigTranslate({ cwd, translators }));
    const text = renderConfigTranslateResult(result, "text");
    expect(text).toContain(".lando.yml.canonical");
    const json = JSON.parse(renderConfigTranslateResult(result, "json")) as { mode: string };
    expect(json.mode).toBe("canonical");
  });
});
