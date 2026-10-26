import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import {
  globalConfigEdit,
  globalConfigSet,
  globalConfigUnset,
  globalConfigValidate,
} from "../../../src/cli/commands/meta/global-config.ts";
import type { EditorRunner } from "../../../src/recipes/prompts/editor-command.ts";

let dir = "";
const filePath = (): string => join(dir, ".lando.yml");
const seed = (content: string): Promise<void> => writeFile(filePath(), content, "utf8");
const readFileText = (): Promise<string> => readFile(filePath(), "utf8");

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lando-gcfg-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("meta global config set", () => {
  test.each(["set", "unset"] as const)("keeps comments through global config %s", async (verb) => {
    // Given
    await seed("# global\nname: global\nruntime: 4\nrouter: # ports\n  httpPort: 8080 # chosen\n# tail\n");
    // When
    await run(
      verb === "set"
        ? globalConfigSet({ key: "router.httpPort", value: "8081" }, filePath())
        : globalConfigUnset({ key: "router.httpPort" }, filePath()),
    );
    // Then
    expect(await readFileText()).toBe(
      verb === "set"
        ? "# global\nname: global\nruntime: 4\nrouter: # ports\n  httpPort: 8081 # chosen\n# tail\n"
        : "# global\nname: global\nruntime: 4\nrouter: {} # ports\n# tail\n",
    );
  });

  test("infers a number when type is omitted", async () => {
    // Given
    await seed("name: global\nruntime: 4\n");
    // When
    const result = await run(globalConfigSet({ key: "router.httpPort", value: "8080" }, filePath()));
    // Then
    expect(result.value).toBe(8080);
    expect(Bun.YAML.parse(await readFileText())).toMatchObject({ router: { httpPort: 8080 } });
  });

  test("creates and writes the user Landofile from scratch", async () => {
    const result = await run(
      globalConfigSet(
        {
          subcommand: "set",
          key: "services.web.type",
          value: "php",
        },
        filePath(),
      ),
    );
    expect(result.subcommand).toBe("set");
    expect(result.changed).toBe(true);
    expect(await readFileText()).toContain("php");
  });

  test("--path is honored when no positional key is given", async () => {
    const result = await run(
      globalConfigSet({ subcommand: "set", path: "services.web.type", value: "php" }, filePath()),
    );
    expect(result.key).toBe("services.web.type");
    expect(await readFileText()).toContain("php");
  });

  test("--dry-run does not create the file", async () => {
    await run(
      globalConfigSet(
        {
          subcommand: "set",
          key: "services.web.type",
          value: "php",
          dryRun: true,
        },
        filePath(),
      ),
    );
    expect(existsSync(filePath())).toBe(false);
  });

  test("schema violation is rejected, existing file untouched", async () => {
    await seed("name: global\nruntime: 4\n");
    const before = await readFileText();
    const exit = await Effect.runPromiseExit(
      globalConfigSet({ subcommand: "set", key: "runtime", value: "nope" }, filePath()),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(await readFileText()).toBe(before);
  });

  test("serializer rejections fail with LandofileWriteValidationError, existing file untouched", async () => {
    await seed("name: global\nruntime: 4\nservices:\n  web:\n    type: php\n");
    const before = await readFileText();
    const exit = await Effect.runPromiseExit(
      globalConfigSet(
        {
          subcommand: "set",
          key: "services.web.environment",
          value: '{"bad key":"x"}',
          type: "json",
        },
        filePath(),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain("LandofileWriteValidationError");
    expect(await readFileText()).toBe(before);
  });
});

describe("meta global config unset", () => {
  test("removes a key", async () => {
    await run(
      globalConfigSet(
        {
          subcommand: "set",
          key: "services.web.type",
          value: "phpval",
        },
        filePath(),
      ),
    );
    const result = await run(
      globalConfigUnset({ subcommand: "unset", key: "services.web.type" }, filePath()),
    );
    expect(result.changed).toBe(true);
    expect(await readFileText()).not.toContain("phpval");
  });

  test("--path is honored when no positional key is given", async () => {
    await run(globalConfigSet({ subcommand: "set", key: "services.web.type", value: "phpval2" }, filePath()));
    const result = await run(
      globalConfigUnset({ subcommand: "unset", path: "services.web.type" }, filePath()),
    );
    expect(result.changed).toBe(true);
    expect(await readFileText()).not.toContain("phpval2");
  });
});

describe("meta global config validate", () => {
  test("valid file returns valid:true", async () => {
    await seed("name: global\nruntime: 4\n");
    const result = await run(globalConfigValidate(filePath()));
    expect(result.valid).toBe(true);
  });

  test("invalid file fails", async () => {
    await seed("name: global\nruntime: 4\nbogus: nope\n");
    const exit = await Effect.runPromiseExit(globalConfigValidate(filePath()));
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
      globalConfigEdit(
        {
          subcommand: "edit",
          editorRunner: runner((c) => `${c}services:\n  web:\n    type: php\n`),
        },
        filePath(),
      ),
    );
    expect(result.changed).toBe(true);
    expect(await readFileText()).toContain("php");
  });

  test("invokes the editor runner with the user Landofile's parent directory as cwd", async () => {
    await seed("name: global\nruntime: 4\n");
    let capturedCwd = "";
    await run(
      globalConfigEdit(
        {
          subcommand: "edit",
          editorRunner: async ({ content, cwd }) => {
            capturedCwd = cwd;
            return { kind: "edited", content };
          },
        },
        filePath(),
      ),
    );
    expect(capturedCwd).toBe(dirname(filePath()));
  });
});
