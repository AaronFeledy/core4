import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import { globalConfig } from "../../../src/cli/commands/meta/global-config.ts";
import type { EditorRunner } from "../../../src/recipes/prompts/editor-command.ts";

let dir = "";
const filePath = (): string => join(dir, ".lando.yml");
const seed = (content: string): Promise<void> => writeFile(filePath(), content, "utf8");
const readFileText = (): Promise<string> => readFile(filePath(), "utf8");

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A, E, never>);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lando-gcfg-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("meta global config set", () => {
  test("creates and writes the user Landofile from scratch", async () => {
    const result = await run(
      globalConfig({
        subcommand: "set",
        key: "services.web.type",
        value: "php",
        userLandofilePath: filePath(),
      }),
    );
    expect(result.subcommand).toBe("set");
    expect(result.changed).toBe(true);
    expect(await readFileText()).toContain("php");
  });

  test("--dry-run does not create the file", async () => {
    await run(
      globalConfig({
        subcommand: "set",
        key: "services.web.type",
        value: "php",
        userLandofilePath: filePath(),
        dryRun: true,
      }),
    );
    expect(existsSync(filePath())).toBe(false);
  });

  test("schema violation is rejected, existing file untouched", async () => {
    await seed("name: global\nruntime: 4\n");
    const before = await readFileText();
    const exit = await Effect.runPromiseExit(
      globalConfig({ subcommand: "set", key: "runtime", value: "nope", userLandofilePath: filePath() }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(await readFileText()).toBe(before);
  });
});

describe("meta global config unset", () => {
  test("removes a key", async () => {
    await run(
      globalConfig({
        subcommand: "set",
        key: "services.web.type",
        value: "phpval",
        userLandofilePath: filePath(),
      }),
    );
    const result = await run(
      globalConfig({ subcommand: "unset", key: "services.web.type", userLandofilePath: filePath() }),
    );
    expect(result.changed).toBe(true);
    expect(await readFileText()).not.toContain("phpval");
  });
});

describe("meta global config validate", () => {
  test("valid file returns valid:true", async () => {
    await seed("name: global\nruntime: 4\n");
    const result = await run(globalConfig({ subcommand: "validate", userLandofilePath: filePath() }));
    expect(result.valid).toBe(true);
  });

  test("invalid file fails", async () => {
    await seed("name: global\nruntime: 4\nbogus: nope\n");
    const exit = await Effect.runPromiseExit(
      globalConfig({ subcommand: "validate", userLandofilePath: filePath() }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("meta global config edit via injected editor seam", () => {
  const runner =
    (transform: (content: string) => string): EditorRunner =>
    async ({ content }) => ({ kind: "edited", content: transform(content) });

  test("saves an edited valid Landofile", async () => {
    await seed("name: global\nruntime: 4\n");
    const result = await run(
      globalConfig({
        subcommand: "edit",
        userLandofilePath: filePath(),
        editorRunner: runner((c) => `${c}services:\n  web:\n    type: php\n`),
      }),
    );
    expect(result.changed).toBe(true);
    expect(await readFileText()).toContain("php");
  });
});
